import { PeerSession } from './session.js'
import { follow, liveAdapter, unfollow } from './live.js'
import { SessionStore } from './session-store.js'
import { readInvite } from './session-protocol.js'
import * as store from './store.js'
import { formatSize, uniqueName } from './paths.js'
import { h, icon, modal, toast, download, confirmIn } from './ui.js'

const button = (label, run, primary = false) => h('button', { type:'button', class:`pg-btn${primary ? ' pg-primary' : ''}`, onclick:run }, label)
const color = id => `hsl(${parseInt(id.slice(0, 6), 16) % 360} 65% 60%)`
const total = files => [...new Map(files.map(f => [f.asset, f])).values()].reduce((n,f)=>n+f.size,0)
const LIVE = { live:'Live editing', 'read-only':'Viewing live edits', paused:'Paused: the owner is offline. Your edits stay here until they return.', 'catching up':'Catching up on edits' }

export async function mountShare(bar, app, here) {
  if (app.slug === 'outlook') return
  let invite, issue
  try { invite = readInvite(location.href); if (invite && invite.app !== here.path) throw new Error('This invitation belongs to another app or build') }
  catch(e) { issue = e.message; invite = null }
  const config = await fetch('/api/session/config', {cache:'no-store'}).then(r=>r.ok?r.json():{}).catch(()=>({}))
  if (!config.enabled && !invite && !issue && !(await SessionStore.list(here.path).catch(()=>[])).length) return
  let session, dialogOpen = false
  const count = h('span', {class:'pg-share-count'}, 'Share')
  const progress = h('progress', {class:'pg-share-progress',max:'1',value:'0',hidden:true,'aria-label':'File sync progress'})
  const control = h('button', {class:'pg-bar-btn pg-share',type:'button','aria-label':'Share files',onclick:()=>show()}, icon('people'), count, progress)
  bar.querySelector('.pg-files').before(control)
  const update = () => {
    const active = session && !session.stopped
    const people = active ? session.peers.size+1 : 0
    count.textContent = people ? `${people} ${people===1?'person':'people'}` : 'Share'
    control.setAttribute('aria-label', people ? `Session: ${count.textContent}` : 'Share files')
    const states = active ? [{...session.progress,status:session.status}, ...[...session.peers.values()].map(p=>p.progress??{status:'connecting'})] : []
    progress.hidden = !states.length || states.every(p=>p.status==='ready')
    progress.value = states.length ? Math.min(...states.map(p=>p.total ? p.received/p.total : p.status==='ready'?1:0)) : 0
  }
  const use = next => {
    session?.removeEventListener('change',update); session=next; session.addEventListener('change',update); update()
    follow(next).then(live => live?.addEventListener('change', () => next.changed())).catch(e => { next.error = e.message; next.changed() })
  }
  const end = () => { unfollow(session); session.leave() }
  const clearLink = () => {
    const url = new URL(location.href), hash = new URLSearchParams(url.hash.slice(1)); hash.delete('pg-session'); url.hash=hash.toString(); history.replaceState(history.state,'',url)
  }
  async function show() {
    if (dialogOpen) return
    dialogOpen = true
    try {
      await modal(done => {
        let busy=false, renderSession=()=>{}
        const error = h('p', {class:'pg-share-error',role:'alert'}, issue || '')
        const attempt = async fn => {
          if (busy) return
          busy=true; error.textContent=''; view.setAttribute('aria-busy','true')
          try { await fn() } catch(e) { error.textContent=e.message || 'Could not complete this action. Local files are unchanged.' }
          finally { busy=false; view.removeAttribute('aria-busy') }
        }
        const name = h('input', {class:'pg-input',maxlength:'40','aria-label':'Your name',value:session?.name || localStorage.getItem('pg-share-name') || 'Guest'})
        name.addEventListener('change',()=>attempt(async()=>{
          localStorage.setItem('pg-share-name',name.value)
          if (session) {
            session.name=name.value.trim().slice(0,40)||'Guest'; await session.remember()
            for (const peer of session.peers.values()) if (peer.channel?.readyState==='open') await session.send(peer,{type:'hello',name:session.name})
            renderSession()
          }
        }))
        const body = h('div', {class:'pg-share-body'})
        const view = h('div', {class:'pg-choice pg-sharing'},
          h('div', {class:'pg-share-heading'}, h('h2', {class:'pg-title'}, liveAdapter() ? 'Live session' : 'File sharing'), button('Close',()=>done())),
          h('p', {class:'pg-hint'}, liveAdapter() ? `${app.name} · Edits to this project are shared live. Added samples are not shared yet; Undo reverts only your own edits.` : `${app.name} · Files are copied between participants. Live edits are not shared in this build.`),
          h('label',{},'Your name',name), body, error)
        function live() {
          body.replaceChildren()
          const status = h('p',{role:'status'}), members = h('div',{class:'pg-share-members'}), files=h('div',{class:'pg-share-files'})
          const rows=new Map(), fileRows=new Map()
          const receive=button('Receive files',()=>attempt(()=>session.receive()),true)
          const reconnect=button('Reconnect',()=>attempt(async()=>{ session.leave(); await session.connect() }))
          const leave=button('Leave session',()=>{ end(); invite=null; clearLink(); done() })
          const forget=button('Remove local copy',()=>attempt(async()=>{
            if (!await confirmIn(view,'Remove this session’s files from this browser? Other participants keep their copies.','Remove',{danger:true})) return
            end(); await session.store.remove(); session=null; invite=null; clearLink(); update(); done()
          }))
          const warning=h('p',{class:'pg-hint'})
          let link, lock
          if (session.config.owner) {
            const role=h('select',{class:'pg-input','aria-label':'Invitation access'},h('option',{value:'editor'},liveAdapter()?'Can edit':'Can share files'),h('option',{value:'viewer'},liveAdapter()?'Can view':'Can receive files'))
            link=h('input',{class:'pg-input',readonly:true,'aria-label':'Invitation link'})
            const refreshLink=()=>{link.value=session.invite(role.value)}; role.onchange=refreshLink; refreshLink()
            lock=button('Lock invitations',()=>attempt(async()=>{await session.admin({lock:!session.locked})}))
            body.append(h('div',{class:'pg-share-invite'},role,link,button('Copy link',()=>attempt(async()=>{await navigator.clipboard.writeText(link.value);toast('Invitation copied')}))),lock)
          }
          const add = h('input',{type:'file',multiple:true,'aria-label':'Share more files'})
          const addLabel = h('label',{},'Add files',add)
          add.onchange=()=>attempt(async()=>{await session.share([...add.files]);add.value=''})
          body.append(status,warning,members,files,receive,addLabel,h('div',{class:'pg-actions'},forget,reconnect,leave))
          renderSession = () => {
            status.textContent=`${session.live ? `${LIVE[session.live.status]} · ` : ''}${session.files.length} ${session.files.length===1?'file':'files'} · ${formatSize(total(session.files))}`
            warning.textContent=session.live?.error || session.error || session.relayWarning || (session.peers.size ? '' : 'Waiting for another participant. A person with a local copy must be online to send files.')
            addLabel.hidden=session.role==='viewer' || session.stopped
            receive.hidden=session.accepted; receive.disabled=!session.files.length
            reconnect.hidden=!['failed','reconnecting','left','displaced'].includes(session.status)
            if (lock) {lock.textContent=session.locked?'Unlock invitations':'Lock invitations';link.value=session.invite(body.querySelector('select').value)}
            const offline=session.members.filter(p=>p.id!==session.id&&!session.peers.has(p.id)).map(p=>({...p,name:session.config.names?.[p.id]||`Participant ${p.id.slice(0,8)}`,progress:{status:'offline'}}))
            const peers=[{id:session.id,name:`${session.name} (you)`,role:session.role,progress:{...session.progress,status:session.status}},...session.peers.values(),...offline]
            for (const peer of peers) {
              let row=rows.get(peer.id)
              if (!row) {
                const label=h('strong'), detail=h('small'), dot=h('span',{class:'pg-person-dot','aria-hidden':'true',style:`background:${color(peer.id)}`})
                row=h('div',{class:'pg-share-person'},dot,h('span',{},label,detail)); row.label=label;row.detail=detail
                if (session.config.owner && peer.id!==session.id) {
                  const access=h('select',{class:'pg-input'},h('option',{value:'editor'},'editor'),h('option',{value:'viewer'},'viewer'))
                  access.onchange=()=>attempt(()=>session.admin({member:peer.id,role:access.value}));row.access=access
                  row.append(access,button('Remove',()=>attempt(async()=>{
                    if (await confirmIn(view,`Remove ${row.label.textContent}? Old invitation links will stop working. Their downloaded files cannot be erased.`,'Remove',{danger:true})) await session.admin({remove:peer.id})
                  })))
                }
                rows.set(peer.id,row);members.append(row)
              }
              row.label.textContent=peer.name; row.detail.textContent=`${peer.role} · ${peer.progress?.status||'connecting'}${peer.progress?.total ? ` · ${formatSize(peer.progress.received)} / ${formatSize(peer.progress.total)}`:''}`
              if (row.access) {row.access.value=peer.role;row.access.setAttribute('aria-label',`Access for ${peer.name}`)}
            }
            for(const [id,row] of rows) if(!peers.some(p=>p.id===id)){row.remove();rows.delete(id)}
            for(const entry of session.files) {
              let row=fileRows.get(entry.id)
              if(!row) {
                const save=button('Save a copy to Files',()=>attempt(async()=>{
                  const file=await session.store.file(entry.asset)
                  await navigator.locks.request('playground-session-export',async()=>{
                    const name=uniqueName(entry.name,new Set((await store.list('/')).map(f=>f.name)))
                    await store.write(`/${name}`,file);toast(`Saved ${name} to Files`)
                  })
                }))
                const get=button('Download',()=>attempt(async()=>download(entry.name,await session.store.file(entry.asset))))
                row=h('div',{class:'pg-share-file'},h('span',{},entry.name),h('small',{},formatSize(entry.size)),h('div',{class:'pg-actions'},save,get))
                row.buttons=[save,get];fileRows.set(entry.id,row);files.append(row)
              }
              for(const b of row.buttons)b.disabled=!session.available.has(entry.asset)
            }
          }
          renderSession();session.addEventListener('change',renderSession)
        }
        async function start() {
          if (session) {live();return}
          if (invite) {
            body.append(h('p',{},'Join to see the shared file list and download size. Nothing is received until you accept.'),button('Join session',()=>attempt(async()=>{use(await PeerSession.join(invite,{name:name.value}));live()}),true))
            return
          }
          const selection=h('div',{class:'pg-share-pick'}), picks=[]
          for(const entry of (await store.list('/')).filter(f=>f.kind==='file')) {
            const checkbox=h('input',{type:'checkbox','aria-label':entry.name});picks.push({entry,checkbox})
            selection.append(h('label',{},checkbox,h('span',{},entry.name),h('small',{},formatSize(entry.size))))
          }
          const computer=h('input',{type:'file',multiple:true,'aria-label':'Add files from computer'})
          body.append(h('p',{},'Choose the saved project and its assets. Your other files stay private.'),selection,computer,button('Create session',()=>attempt(async()=>{
            const files=[...computer.files]
            for(const {entry,checkbox} of picks)if(checkbox.checked)files.push(await store.file(entry.path))
            if(!files.length && !liveAdapter())throw new Error('Choose at least one file')
            use(await PeerSession.create({app:here.path,name:name.value,files}));live()
          }),true))
          for(const room of await SessionStore.list(here.path)) {
            body.append(button(`Local copy: ${room.name}`,()=>attempt(async()=>{use(await PeerSession.restore(room.id));live()})))
          }
        }
        start().catch(e=>error.textContent=e.message)
        return {el:view,focus:()=>name.focus(),destroy:()=>session?.removeEventListener('change',renderSession)}
      },{label:'File sharing',className:'pg-share-dialog'})
    } finally { dialogOpen=false;control.focus() }
  }
  if(invite || issue) show()
}

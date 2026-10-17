import { PeerSession, setPage } from './session.js'
import { follow, liveAdapter, unfollow } from './live.js'
import { SessionStore } from './session-store.js'
import { readInvite } from './session-protocol.js'
import * as store from './store.js'
import { formatSize, uniqueName } from './paths.js'
import { h, icon, modal, toast, download, confirmIn } from './ui.js'

const button = (label, run, primary = false) => h('button', { type:'button', class:`pg-btn${primary ? ' pg-primary' : ''}`, onclick:run }, label)
const color = id => `hsl(${parseInt(id.slice(0, 6), 16) % 360} 65% 60%)`
const total = files => [...new Map(files.map(f => [f.asset, f])).values()].reduce((n,f)=>n+f.size,0)
const when = time => new Date(time).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})
const LIVE = { live:'Live editing', 'read-only':'Viewing live edits', paused:'Paused: the owner is offline. Your edits stay here until they return.', 'catching up':'Catching up on edits', incompatible:'Not live: another app version' }
// The session this browser is in: it follows the person from app to app (each app page resumes it).
const active = {
  get() { try { return localStorage.getItem('pg-active-session') } catch { return null } },
  set(room) { try { room ? localStorage.setItem('pg-active-session', room) : localStorage.removeItem('pg-active-session') } catch {} },
}

export async function mountShare(bar, app, here, groups = []) {
  if (app.slug === 'outlook') return
  setPage(here.path)
  const appName = path => groups.flatMap(g=>g.apps).find(a=>a.release?.path===path||a.head?.path===path)?.name ?? path
  let invite, issue
  try { invite = readInvite(location.href); if (invite && invite.app !== here.path) throw new Error('This invitation belongs to another app or build') }
  catch(e) { issue = e.message; invite = null }
  const config = await fetch('/api/session/config', {cache:'no-store'}).then(r=>r.ok?r.json():{}).catch(()=>({}))
  if (!config.enabled && !invite && !issue && !active.get() && !(await SessionStore.list().catch(()=>[])).length) return
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
    active.set(next.room)
    follow(next).then(live => live?.addEventListener('change', () => next.changed())).catch(e => { next.error = e.message; next.changed() })
    // Removed, ended, or opened in another tab: this page no longer takes part, so Undo is the app's own again.
    next.addEventListener('change', () => {
      if (['removed','displaced','ended'].includes(next.status)) unfollow(next)
      if (['removed','ended'].includes(next.status) && active.get() === next.room) active.set(null)
    })
  }
  const end = () => { unfollow(session); session.leave(); active.set(null) }
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
          h('p', {class:'pg-hint'}, liveAdapter() ? `${app.name} · Edits to this project are shared live, with the media they use; Undo reverts only your own edits.` : `${app.name} · Files are copied between participants. Live edits are not shared in this build.`),
          h('label',{},'Your name',name), body, error)
        function live() {
          body.replaceChildren()
          const status = h('p',{role:'status'}), members = h('div',{class:'pg-share-members'}), files=h('div',{class:'pg-share-files'}), drafts=h('div',{class:'pg-share-files'})
          const rows=new Map(), fileRows=new Map()
          // Local work live editing could not keep (session-store.js): opened, it is proposed as this person's edit.
          let kept=[], opens=[]
          const showDrafts=()=>{
            opens=kept.map(d=>[d,button('Open as my version',()=>attempt(async()=>{await session.live.restoreDraft(await session.store.readDraft(d.name));toast('Draft opened as your version')}))])
            drafts.replaceChildren(...(kept.length?[h('p',{class:'pg-hint'},'Kept drafts')]:[]),...opens.map(([d,open])=>h('div',{class:'pg-share-file'},h('span',{},when(d.time)),h('small',{},[d.app&&`from ${appName(d.app)}`,formatSize(d.size)].filter(Boolean).join(' · ')),h('div',{class:'pg-actions'},open,button('Remove',()=>attempt(async()=>{
              if (await confirmIn(view,'Remove this draft from this browser? It cannot be recovered.','Remove',{danger:true})) {await session.store.removeDraft(d.name);renderSession()}
            }))))))
          }
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
          body.append(status,warning,members,files,drafts,receive,addLabel,h('div',{class:'pg-actions'},forget,reconnect,leave))
          renderSession = () => {
            const away=session.live?.status==='paused' && session.live.ownerElsewhere
            status.textContent=`${session.live ? `${away ? `Paused: ${away.name} (owner) is in ${appName(away.page)}. Your edits stay here until they open ${app.name}.` : LIVE[session.live.status]} · ` : ''}${session.files.length} ${session.files.length===1?'file':'files'} · ${formatSize(total(session.files))}${kept.length ? ` · ${kept.length} kept ${kept.length===1?'draft':'drafts'}` : ''}`
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
              const where=peer.id===session.id ? here.path : peer.page
              row.label.textContent=peer.name; row.detail.textContent=`${peer.role}${where ? ` · in ${appName(where)}` : ''} · ${peer.progress?.status||'connecting'}${peer.progress?.total ? ` · ${formatSize(peer.progress.received)} / ${formatSize(peer.progress.total)}`:''}`
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
            for(const [d,open] of opens) open.hidden=!(session.live?.editable && d.app===session.live.app)
            session.store.drafts().then(list=>{if(list!==kept){kept=list;showDrafts();renderSession()}},()=>{})
          }
          renderSession();session.addEventListener('change',renderSession)
        }
        async function start() {
          if (session) {live();return}
          if (invite) {
            body.append(h('p',{},liveAdapter()?'Joining opens the shared project here, live, with the media it uses. Other shared files wait until you accept them.':'Join to see the shared file list and download size. Nothing is received until you accept.'),button('Join session',()=>attempt(async()=>{use(await PeerSession.join(invite,{name:name.value}));live()}),true))
            return
          }
          const selection=h('div',{class:'pg-share-pick'}), picks=[]
          for(const entry of (await store.list('/')).filter(f=>f.kind==='file')) {
            const checkbox=h('input',{type:'checkbox','aria-label':entry.name});picks.push({entry,checkbox})
            selection.append(h('label',{},checkbox,h('span',{},entry.name),h('small',{},formatSize(entry.size))))
          }
          const computer=h('input',{type:'file',multiple:true,'aria-label':'Add files from computer'})
          body.append(h('p',{},liveAdapter()?'The project open here is shared live once the session starts. You can also add files to send along; your other files stay private.':'Choose the saved project and its assets. Your other files stay private.'),selection,computer,button('Create session',()=>attempt(async()=>{
            const files=[...computer.files]
            for(const {entry,checkbox} of picks)if(checkbox.checked)files.push(await store.file(entry.path))
            if(!files.length && !liveAdapter())throw new Error('Choose at least one file')
            use(await PeerSession.create({app:here.path,name:name.value,files}));live()
          }),true))
          // Sessions this browser was in, to rejoin or clear: auto-resume covers the current one.
          const earlier=(await SessionStore.list()).filter(room=>room.id!==active.get())
          if (earlier.length) body.append(h('p',{class:'pg-hint'},'Earlier sessions in this browser'))
          for(const room of earlier) {
            const detail=[when(room.modified), room.app!==here.path ? `started in ${appName(room.app)}` : '', room.files ? `${room.files} ${room.files===1?'file':'files'}` : ''].filter(Boolean).join(' · ')
            const row=h('div',{class:'pg-share-file'},h('span',{},room.owner?'Your session':'Session you joined'),h('small',{},detail),h('div',{class:'pg-actions'},
              button('Rejoin',()=>attempt(async()=>{const s=await PeerSession.restore(room.id);use(s);await s.connect();live()})),
              button('Remove',()=>attempt(async()=>{
                if (!await confirmIn(view,room.owner?'Remove this session from this browser? You can no longer host it; the others keep their copies.':'Remove this session’s copy from this browser? The others keep theirs.','Remove',{danger:true})) return
                await new SessionStore(room.id).remove(); row.remove()
              }))))
            body.append(row)
          }
        }
        start().catch(e=>error.textContent=e.message)
        return {el:view,focus:()=>name.focus(),destroy:()=>session?.removeEventListener('change',renderSession)}
      },{label:'File sharing',className:'pg-share-dialog'})
    } finally { dialogOpen=false;control.focus() }
  }
  if(invite || issue) show()
  // Resume the session this browser is in, whichever app it was started from.
  else if (config.enabled && active.get()) {
    const resumed = await PeerSession.restore(active.get()).catch(() => null)
    if (!resumed) active.set(null)
    else { use(resumed); resumed.connect().catch(e => { resumed.error = e.message; resumed.changed() }) }
  }
}

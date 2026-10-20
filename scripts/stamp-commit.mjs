// Records in our builds (out/<id>.zip, made by build.mjs) the Playground commit whose patches made them, as
// <id>/.playground-commit: the bar's Source menu links the patches at that commit. build.yml runs it just before
// publishing, after a patch repair is committed. (Not build.mjs: any change to it rebuilds every app.)
//   node scripts/stamp-commit.mjs out/<id>.zip...
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { COMMIT_FILE, head } from './releases.mjs'

const commit = head() ?? (console.error('stamp-commit: not in a git checkout'), process.exit(1))
for (const zip of process.argv.slice(2)) {
  const id = basename(zip, '.zip')
  const tmp = mkdtempSync(join(tmpdir(), 'stamp-'))
  try {
    mkdirSync(join(tmp, id))
    writeFileSync(join(tmp, id, COMMIT_FILE), `${commit}\n`)
    execFileSync('zip', ['-q', resolve(zip), `${id}/${COMMIT_FILE}`], { cwd: tmp })
    console.log(`${zip}: Playground ${commit}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

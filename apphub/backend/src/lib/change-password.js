import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../config.js'
import { HttpError } from './http.js'
import { setDrivePassword } from './drive-password.js'

const pexec = promisify(execFile)
const USERNAME_RE = /^[a-z_][a-z0-9._-]{0,31}$/

// Change the user's lab password. Updates BOTH the LDAP login password (userPassword,
// changed by the user themselves via the Password Modify exop -- self-write is allowed by
// the directory ACL) AND the Samba drive hash (sambaNTPassword), so one password works for
// sign-in and for network drives. The user proves identity by supplying the current password;
// no admin sees it, secrets go in 0600 files, never argv.
export async function changePassword(username, currentPassword, newPassword) {
  const dp = config.drivePassword
  if (!dp.enabled || !dp.pwsyncPassword) {
    throw new HttpError(503, 'The password service is not configured on this server.')
  }
  if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Invalid username')
  if (typeof currentPassword !== 'string' || currentPassword.length < 1) {
    throw new HttpError(400, 'Your current password is required.')
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 256) {
    throw new HttpError(400, 'Your new password must be at least 8 characters.')
  }
  if (newPassword === currentPassword) {
    throw new HttpError(400, 'The new password must be different from your current one.')
  }

  const userDN = `uid=${username},${dp.peopleBase}`
  const dir = await mkdtemp(join(tmpdir(), 'apphub-cp-'))
  const curFile = join(dir, 'cur')
  const newFile = join(dir, 'new')
  try {
    await writeFile(curFile, currentPassword, { mode: 0o600 })
    await writeFile(newFile, newPassword, { mode: 0o600 })

    // 1) Verify the current password by binding as the user.
    try {
      await pexec('ldapwhoami', ['-x', '-H', dp.ldapUri, '-D', userDN, '-y', curFile], { timeout: 10000 })
    } catch {
      throw new HttpError(401, 'Your current password is incorrect.')
    }

    // 2) Change the LDAP login password (bind as the user; self-service password modify).
    try {
      await pexec(
        'ldappasswd',
        ['-x', '-H', dp.ldapUri, '-D', userDN, '-y', curFile, '-t', curFile, '-T', newFile],
        { timeout: 10000 },
      )
    } catch (e) {
      throw new HttpError(502, `Could not update your password: ${e.stderr || e.message}`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  // 3) Sync the Samba/drive hash to the new password. setDrivePassword re-verifies by binding
  //    with the new password (which now works) and writes sambaNTPassword via samba-pwsync.
  //    If this step fails, the login password is already changed; the user can re-run "Enable
  //    drive access" to finish, so surface a clear message.
  try {
    await setDrivePassword(username, newPassword)
  } catch (e) {
    throw new HttpError(
      502,
      'Your login password was changed, but syncing network-drive access failed. Open Settings and use "Enable drive access" to finish.',
    )
  }
}

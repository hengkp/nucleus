import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../config.js'
import { HttpError } from './http.js'
import { ntHash } from './nthash.js'

const pexec = promisify(execFile)
const USERNAME_RE = /^[a-z_][a-z0-9._-]{0,31}$/

// Self-service drive-password: the user proves their identity by binding with the password
// they type, and we seed sambaNTPassword = NT(that password). No rotation, no admin sees the
// password, and the write uses the least-privilege samba-pwsync bind (ADR-001 / Q3).
export async function setDrivePassword(username, password) {
  const dp = config.drivePassword
  if (!dp.enabled || !dp.pwsyncPassword) {
    throw new HttpError(503, 'The drive-password service is not configured on this server.')
  }
  if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Invalid username')
  if (typeof password !== 'string' || password.length < 1 || password.length > 256) {
    throw new HttpError(400, 'Password is required')
  }

  const userDN = `uid=${username},${dp.peopleBase}`
  const dir = await mkdtemp(join(tmpdir(), 'apphub-dp-'))
  const userPwFile = join(dir, 'u')
  const syncPwFile = join(dir, 's')
  const ldifFile = join(dir, 'm.ldif')
  try {
    // Secrets go in 0600 files, never argv.
    await writeFile(userPwFile, password, { mode: 0o600 })
    await writeFile(syncPwFile, dp.pwsyncPassword, { mode: 0o600 })

    // 1) Verify the password by binding as the user.
    try {
      await pexec('ldapwhoami', ['-x', '-H', dp.ldapUri, '-D', userDN, '-y', userPwFile], { timeout: 10000 })
    } catch {
      throw new HttpError(401, 'That lab password is incorrect.')
    }

    // 2) Does the entry already have sambaSamAccount? Also fetch uidNumber for sambaSID.
    let hasSamba = false
    let uidNumber = ''
    try {
      const { stdout } = await pexec(
        'ldapsearch',
        ['-x', '-LLL', '-H', dp.ldapUri, '-b', userDN, '-s', 'base', '(objectClass=*)', 'objectClass', 'uidNumber'],
        { timeout: 10000 },
      )
      hasSamba = /objectClass:\s*sambaSamAccount/i.test(stdout)
      const m = stdout.match(/uidNumber:\s*(\d+)/i)
      uidNumber = m ? m[1] : ''
    } catch {
      throw new HttpError(502, 'Could not read your directory entry.')
    }

    const nt = ntHash(password)
    const now = Math.floor(Date.now() / 1000)

    let ldif
    if (hasSamba) {
      ldif = [
        `dn: ${userDN}`,
        'changetype: modify',
        'replace: sambaNTPassword',
        `sambaNTPassword: ${nt}`,
        '-',
        'replace: sambaPwdLastSet',
        `sambaPwdLastSet: ${now}`,
        '',
      ].join('\n')
    } else {
      if (!dp.domainSid) {
        throw new HttpError(503, 'First-time setup needs the Samba domain SID (APPHUB_SAMBA_DOMAIN_SID).')
      }
      if (!uidNumber) throw new HttpError(502, 'Could not determine your uid number.')
      const rid = Number(uidNumber) * 2 + 1000
      ldif = [
        `dn: ${userDN}`,
        'changetype: modify',
        'add: objectClass',
        'objectClass: sambaSamAccount',
        '-',
        'add: sambaSID',
        `sambaSID: ${dp.domainSid}-${rid}`,
        '-',
        'add: sambaAcctFlags',
        'sambaAcctFlags: [U          ]',
        '-',
        'add: sambaNTPassword',
        `sambaNTPassword: ${nt}`,
        '-',
        'add: sambaPwdLastSet',
        `sambaPwdLastSet: ${now}`,
        '',
      ].join('\n')
    }
    await writeFile(ldifFile, ldif, { mode: 0o600 })

    // 3) Write via the least-privilege samba-pwsync bind.
    try {
      await pexec('ldapmodify', ['-x', '-H', dp.ldapUri, '-D', dp.pwsyncDN, '-y', syncPwFile, '-f', ldifFile], { timeout: 10000 })
    } catch (e) {
      throw new HttpError(502, `Could not set the drive password: ${e.stderr || e.message}`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

# MapDrive → CIFS Gateway Refactor

Implements ADR-004. Moves lab file access from **direct Infortrend NAS mounts** to a
**single CIFS gateway** that authenticates against OpenLDAP and stamps correct ownership,
ending the stale-session permission churn (Problem A).

## The problem, precisely

Today every client mounts `\\192.168.0.103\<share>` as `SIRIRAJ\username`. Windows caches
that SMB credential **per server**. On a shared HPC workstation:
- if a previous user didn't disconnect, the next user hits **error 1219** ("multiple
  connections to a server by the same user with different credentials"), or
- worse, files get written under the lingering session's identity → ownership drift the
  admin team fixes by hand with ACLs.

## The fix

**One door.** Clients connect to `nas.sisp.com` (the gateway node), never the NAS directly.
The gateway:
1. authenticates each user against **OpenLDAP** (Samba `ldapsam`), and
2. runs `smbd` as the user's **real LDAP uid/gid** (resolved by SSSD),

so every file is owned by the writing user *by construction* — identical to what a SLURM job
writes. Plus the client **purges stale sessions** before connecting and at logon, so nothing
lingers for the next person.

```
 Before:  Windows ──SMB(SIRIRAJ\user)──▶ Infortrend NAS 192.168.0.103   (ownership drifts)
 After:   Windows ──SMB(ldap user)──▶ nas.sisp.com (gateway) ──NFS──▶ Infortrend NAS
                                         │ smbd runs as the user's uid/gid
                                         ▼ ownership always correct
```

## What changed — client

`windows-app/SISPDriveMapper.ps1`
- Targets `nas.sisp.com` (a DNS name, so admins choose node2/node1 without touching the
  client). Share presets re-pointed to the gateway.
- Login default is now the **plain LDAP username** (no `SIRIRAJ\` prefix); the gateway is
  LDAP, not AD. (`SIRIRAJ\username` / UPN remain available for edge cases.)
- New `Clear-GatewaySession` runs **before every connect**: `net use \\server /delete` +
  `cmdkey /delete` so a prior user's session/credential can't bleed into the new mapping.

`windows-app/Clear-GatewaySession.ps1` + `Install-SessionCleanupTask.ps1`
- Standalone purge + a scheduled task that runs it **at logon**, so a shared PC is cleaned
  before the next person maps their drive. Optional GPO logoff script documented.

`web/` portal
- `share-presets.json` re-pointed to `nas.sisp.com`, default login `username only`.
- Generated `net use` command now **non-persistent** and **prefixed with a purge**
  (`net use \\server /delete /y`), so the portal teaches the safe pattern.

`macos/SISPDriveMapper.command`
- Targets `nas.sisp.com`; unmounts any existing gateway mount first; Keychain hint.

## What changed — server (new `gateway/` bundle)

- `smb.conf` — Samba gateway: per-user `[sisplockers]` at `path = .../%U` with
  `valid users = %U` and 0700 isolation; LDAP `ldapsam` auth; oplocks/leases off for
  ownership coherence.
- `sssd.conf` — uid/gid from OpenLDAP so SMB and SLURM agree on identity.
- `provision-lockers.sh` — pre-create/repair the 55 lockers with correct uid/gid.
- `s1-ownership-spike.sh` — **the Phase-0 gate.**

## Rollout (each step human-confirmed; nothing autonomous on the cluster)

1. **GATE S1 — run `gateway/s1-ownership-spike.sh` live first.** It writes a file as a real
   uid through the gateway and asserts it `stat`s back as that uid (not `nobody`), plus an
   xattr round-trip. **If S1 is RED, stop** — the re-export premise changes (NFSv4 idmap or
   no per-host `no_root_squash`); fall back to a NAS-side provisioning API. This is the one
   test that decides whether the whole approach is viable, which is why it runs before any
   build effort.
2. Stand up the gateway: NFS backhaul → SSSD → Samba schema + NT-hash → `smb.conf` (see
   `gateway/README.md` for order and the node2-vs-node1 recommendation).
3. `provision-lockers.sh --dry-run`, then for real; remediate the legacy mis-owned folders
   in a maintenance window.
4. Joint smoke: user A's file owned by A and unreadable by B; macOS metadata survives.
5. Distribute the retargeted client + run `Install-SessionCleanupTask.ps1` on shared PCs.
6. Keep the old direct-NAS path **read-only** as rollback for ≥1 week.

## Open items (carried to the build plan)
- **Q2/Q3** SMB password path (NT-hash vs Kerberos) and how existing passwords seed
  `sambaNTPassword` without a mass reset.
- **Q4/Q5** NAS NFS version + `no_root_squash` + xattr support — answered by S1.
- AppHub already mounts the same lockers into job containers; the gateway and AppHub share
  the one identity, so a file made in a notebook and one made via the drive are owned the same.

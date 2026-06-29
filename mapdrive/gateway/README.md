# SISP CIFS Gateway

Server-side of the MapDrive refactor (ADR-004). Turns one node into the **single SMB door**
to lab storage so file ownership is always correct and stale Windows sessions can no longer
scramble it (Problem A).

## Why this fixes the ownership problem

Today clients mount the Infortrend NAS (`192.168.0.103`) directly with `SIRIRAJ\username`.
Windows caches that SMB credential per *server*, so when a previous user doesn't disconnect,
the next user on the same workstation either gets error **1219** (multiple credentials to one
server) or, worse, writes files under the lingering session's identity → ownership drift that
admins hand-fix with ACLs.

The gateway removes the direct mount. Clients connect to **`nas.sisp.com`** (this node),
which:
1. authenticates each user against **OpenLDAP** (Samba `ldapsam`), and
2. runs `smbd` as the user's **real LDAP uid/gid** (resolved by SSSD).

So every file is owned by the user *by construction*, identical to what a SLURM job on a
compute node would write. The client also purges sessions before/after use (see the client
refactor), so nothing lingers for the next person.

## Where to run it

Run on a **dedicated gateway node — node2 recommended** (ADR-004 / RISKS #2): node1 already
carries OpenLDAP + nginx + the AppHub control plane, and combining files there recreates the
overload (Problem B) and a single blast radius. `nas.sisp.com` is a DNS name so the client
never hard-codes which node — point it at the gateway you chose. node1 is acceptable for a
small lab if node2 can't be spared; the config is identical.

## Deploy order (each step is a human-confirmed maintenance action)

0. **GATE — run `s1-ownership-spike.sh` first.** If ownership doesn't round-trip, STOP; the
   whole premise changes (fall back to a NAS-side provisioning API).
1. **NFS backhaul.** On the NAS, export `sisplockers` (it already has NFS enabled) to the
   gateway IP with `no_root_squash` scoped to that one host, firewalled to 192.168.0.25-28.
   Prefer **NFSv3 AUTH_SYS** (raw integer ownership); NFSv4 only with
   `nfs4_disable_idmapping=Y` and only if S1 stays green. Mount at `/srv/nas/sisplockers`
   (and `/srv/nas/shared`, department shares as needed).
2. **Identity.** Install `sssd.conf` (needs LDAPS + the internal CA from BUILD_PLAN Phase 1).
   Verify `getent passwd <user>` returns the LDAP uid/gid.
3. **Samba.** Load the Samba schema into OpenLDAP and give each user
   `sambaSamAccount`/`sambaNTPassword` (BUILD_PLAN Phase 1, Path A). Install `smb.conf`,
   `testparm`, start `smbd`.
4. **Provision lockers.** `sudo ./provision-lockers.sh --dry-run` then for real — creates the
   55 lockers with correct uid/gid and fixes the legacy mis-owned ones.
5. **Verify gate.** Joint smoke: user A's file is owned by A and unreadable by B; macOS
   Finder metadata survives. Only then distribute the retargeted client.
6. **Rollback.** Keep the old direct-NAS path read-only for ≥1 week as fallback.

## Files
- `s1-ownership-spike.sh` — **the Phase-0 gate.** Run first, run live.
- `sssd.conf` — uid/gid resolution from OpenLDAP.
- `smb.conf` — Samba gateway (per-user `%U` lockers, LDAP auth, oplocks off).
- `provision-lockers.sh` — pre-create/repair lockers with correct ownership.

The client side (retarget + session cleanup) lives in `../windows/` and is described in
`../../docs/CIFS_GATEWAY_REFACTOR.md`.

# Live Cluster Pre-flight — Findings (read-only, 2026-06-27)

Read-only inventory of node1–4 over SSH. **No production changes were made.** This is the
ground truth the deployment must match; several items differ from the original assumptions
and are corrected in code where offline-safe.

## Actual cluster state

| Fact | Reality | vs. assumption |
|---|---|---|
| Per-node size | **112 cores / 515600 MB (~503 GiB)** each | Prompt said "112 CPU / 512 GB **total**" — that was per-node |
| Cluster total | **~448 cores / ~2 TB RAM** | 4× larger than assumed |
| Users | **47** posix accounts, uid ≥ 10000, primary group `sisp` (gid 100000) | "55" was the locker **dir** count (`/mnt/sisplockers` has 55 entries) |
| OS | node1 Ubuntu 22.04.5, node2–4 22.04.1 | — |
| SLURM | **21.08.5**, `cons_res` / `CR_CORE_MEMORY`, `SlurmctldHost=node1` | text parser correct; no json data_parser (needs ≥23.02) |
| Partitions | **`small*` (default), `large`, `UNLIMITED`** | designed names were `inter`/`persistent` — now mapped to small/UNLIMITED |
| node1 | runs slurmctld **and** slurmd but is **`drng` (draining)** | control-plane reservation already underway (matches ADR-002) |
| Container runtime | **Singularity present** on node2–4; **Apptainer absent** | runtime must use `singularity` (Apptainer-CLI-compatible) |
| Samba | **`smbd` absent on all nodes** | gateway requires installing Samba |
| Identity (NSS) | node1 `passwd: files systemd ldap sss` via **direct libnss-ldap** (sssd **inactive** on node1); **sssd present+used on node2–4** | gateway SSSD plan must coexist with existing libnss-ldap |
| LDAP | OpenLDAP (`slapd`) live on node1:389; base `dc=siriraj,dc=local` (cn shows `siriraj`) | — |
| Storage | NAS `192.168.0.103`, **NFSv4.2 sec=sys**, `sisplockers` at `/mnt/sisplockers`, homes `/mnt/sisplockers/<user>`; ownership already resolves correctly | strong signal that **S1 will pass**, but still must be run |
| NFS exports | sisplockers + research/CRCproject/galaxy-app/… exported to `*` (no per-host rule shown → default root_squash) | per-host `no_root_squash` for root-side provisioning is a NAS-side change |
| Public apps | nginx on node1:80/443 fronting **`*.sisp.freeddns.org`** (+ some `.sisp.com`): jitsi, ldap, columbus, node1-3, zulip(live), … | real domain is `sisp.freeddns.org`; revisit the `*.app.sisp.com` choice (Q1) |
| Existing AppHub | **old scaffold live on node1:127.0.0.1:8792**, slurmMode=slurm, run as user `apphub`; mapdrive support server at `/opt/sisp-mapdrive/server` (www-data) | the rebuild replaces the scaffold; cutover, don't double-run |
| Postgres | 17.7 active on node1:5432 (loopback) | ready for the control-plane DB |
| Node.js | v22 on node1 | ready to run the rebuilt backend |

## 🛑 CRITICAL — broken LDAP migration (duplicate local accounts) [BLOCKER]
Discovered during the live deploy (2026-06-27). **node1 has local `/etc/passwd` accounts that
shadow LDAP users**, and nsswitch is `files`-first, so `getent` returns the **legacy local uid**
(1000–1018), not the LDAP uid (10000+). The lockers are owned by a mix of legacy and LDAP uids.

Examples: `ryanr` local **1015** / LDAP **10037** / locker owned **10037** (so on node1 ryanr is
1015 and cannot open their own 10037 locker); `dianap` local **1005**, locker **1005**; `tenxr`
no local entry, LDAP **10035**, locker owned **1000** (generic). ~15 users affected
(`ryanr,dianap,sarunt,thanaphonl,chanetteej,pasithp,abdifetaho,punyapornn,monthiras,waratchananj,supawanj,khinsusuh,hpcteama,…`).

**This is the true root cause of "ownership keeps getting mixed up"** — not just stale Windows
sessions. It blocks BOTH:
- **Locker remediation** — `getent`-based chown would target wrong uids and lock users out.
- **AppHub launches** — the sbatch wrapper's `uid≥10000` + `getent` agreement check refuses
  shadowed users.

**Must be reconciled (human-led) BEFORE remediation or cutover:**
1. Choose the canonical identity = LDAP (uid 10000+). 
2. Remove/renumber the duplicate local accounts on node1 (and audit node2–4); fix nsswitch so
   LDAP is authoritative for these users.
3. Per affected user, **recursively** chown their locker tree from {legacy uid | 1000} → their
   LDAP uid, then chmod `0700`. Record prior owner/mode first (reversible).
4. Re-run the audit; only then run `provision-lockers.sh` for the clean remainder.

No chown/chmod was applied — live data untouched.

## S1 gate (read path) — GREEN
Read-only ownership check across node1–4: lockers resolve to the correct LDAP uid (e.g.
kriengkraip=10000, ryanr=10037), **identical on all four nodes**, never `nobody` (65534).
NFSv4.2/sec=sys preserves numeric ownership cluster-wide — the core gateway premise holds.
(The write/provisioning path — root chown via `no_root_squash` — is still a maintenance-window test.)

## Locker storage audit (read-only) — TOP REMEDIATION ITEM
`/mnt/sisplockers`, 53 directories:

| Metric | Count | Meaning |
|---|---|---|
| **Other-writable (`*777`)** | **51 / 53** | Any user can read/write anyone's locker — live confidentiality breach |
| Group-writable | 52 / 53 | — |
| **Owned by legacy uid `<10000`** | **31 / 53** | Not LDAP accounts; uid 1000 = local user → `UNKNOWN` on node2–4 |
| Wrong primary gid (`!=100000`) | 0 | group is fine |

Only `ryanr` (`2700`) is correctly private. Two distinct problems:
- **Stranded user lockers** — real users whose folders never got chowned during the uid→10000+
  migration: `thanaphonl`(1011), `monthiras`(1014), `punyapornn`(1013), `sarunt`(1007),
  `supawanj`(1017), `dianap`(1005). These users can't own their own files.
- **Shared data/app dirs owned by uid 1000** (e.g. `DATA_PSOM`, `gdc`, `ngi-igenomes`,
  `seurat_tutorials`, `vitessce`, `zulip`, `leantime`, `training`, `tutorials`) — these are not
  user lockers and should move to a `_shared/` tree with group ACLs, not be force-chowned to a user.

Remediation (maintenance window): `gateway/provision-lockers.sh` already fixes *user* lockers
(chown to the LDAP uid, chmod `0700`) and correctly skips non-user dirs. The shared dirs need a
separate `_shared/` decision. **Do this in a window with comms** — some shared dirs may rely on
the open perms today, and chmod during active jobs can disrupt running workflows.

## Applied now (offline, no cluster impact)
- `apphub/backend/src/config.js` + `apphub/frontend/src/lib/mockApi.ts` — node topology corrected to 112c / 515600 MB each (dashboard gauges + cluster math now real).
- `apphub/backend/scripts/apphub-sbatch-as-user.sh` — partitions mapped to the real `small`/`UNLIMITED`; runtime note switched to Singularity.

## Deferred to the maintenance window (each human-confirmed; gate first)
1. **GATE S1** — run `gateway/s1-ownership-spike.sh` on a compute node against `/mnt/sisplockers`. Ownership already resolves through NFSv4.2/sec=sys, so this is expected GREEN, but it is the go/no-go.
2. **Install Singularity-based runtime** + build the app images (jupyterlab/rstudio/…); provide an `apptainer`→`singularity` shim or use `singularity` directly in the runner.
3. **Install Samba** on the gateway node (node2 recommended) + load the Samba LDAP schema and seed NT-hashes (Q2/Q3) for the SMB gateway.
4. **Reconcile identity**: keep node1's libnss-ldap; ensure SSSD on the gateway resolves the same uid/gid; verify `getent` agreement (the sbatch wrapper already asserts this).
5. **SLURM**: confirm node1 fully drained/`--exclude=node1`; decide whether `small` or a new `inter` partition backs interactive apps; set per-user QOS caps.
6. **Cutover AppHub**: stop the old scaffold on :8792, deploy the rebuilt backend (unix socket + proxy secret), point nginx at it, serve the new frontend.
7. **Domain/TLS**: decide `*.app.sisp.com` vs `*.app.sisp.freeddns.org`; issue the wildcard cert; wire per-instance routing.
8. **Credentials**: rotate the reused `[redacted]` (currently accepted-risk) before the trust boundary goes live.

## Access used
SSH from the workstation via PuTTY `plink` (password auth; node1 host key pre-cached, node2–4 pinned by fingerprint). All commands were read-only inventory (`getent`, `sinfo`, `mount`, `ss -tln`, `showmount`, `systemctl is-active`, `ps`).

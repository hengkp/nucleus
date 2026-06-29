# SISP AppHub + Gateway — Maintenance-Window Deploy Runbook

Concrete, ordered procedure for THIS cluster, grounded in the live pre-flight
(`PREFLIGHT_FINDINGS.md`). Every step is a **human-confirmed** action; run them in order and
stop at any red gate. Legend: **[you]** human/vendor only, **[drive]** the assistant can run
with your confirmation, **[gate]** go/no-go.

## Preconditions
- [ ] Maintenance window announced; researchers asked to save & log off (47 users).
- [ ] **Backups verified**: `pg_dump` of any existing apphub DB; snapshot of `/etc/nginx`,
      `/etc/samba` (new), `/etc/sssd`; note current `routes.map`/scaffold state.
- [ ] **[you] Credentials rotated** off `[redacted]` (accepted-risk today) → per-account
      secrets; generate `APPHUB_PROXY_SECRET`, Postgres password, `cn=samba-pwsync` secret.
- [ ] **[you] Vendor/DNS prep**: Infortrend export of `sisplockers` to the gateway IP with
      `no_root_squash` (firewalled to .25–.28); DNS for `nas.sisp.com` and the app domain
      (decide `*.app.sisp.com` vs `*.app.sisp.freeddns.org`); wildcard TLS cert.
- [ ] Keep the **old direct-NAS path + the :8792 scaffold** intact until cutover verified.

## Step 0 — GATE S1 write/provisioning test  [drive][gate]
Read path is already GREEN (ownership round-trips, see PREFLIGHT). This tests the **root
chown / `no_root_squash`** path the provisioner needs.
```
# on the gateway node (node2), against a scratch path on the export
sudo MOUNT=/mnt/sisplockers bash gateway/s1-ownership-spike.sh --uid 10000 --gid 100000
```
- GREEN → continue. RED (chown denied / owner=nobody) → the export lacks `no_root_squash`;
  get the vendor rule (Preconditions) before Step 3. Do NOT proceed to remediation without it.

## Step 1 — Container runtime  [drive]
Compute nodes have **Singularity, not Apptainer**.
- [ ] Provide an `apptainer`→`singularity` shim on node2–4 (or set runner to call `singularity`):
      `sudo ln -sf "$(command -v singularity)" /usr/local/bin/apptainer` (idempotent).
- [ ] Build images into the shared image dir (`/opt/sisp-apphub/images`, quota'd): start with
      `jupyterlab.sif`, `rstudio.sif`, `python-apps.sif` from `apphub/runtime/definitions/`
      (convert .def via `singularity build`). Verify each runs loopback-only with a token.
- **Reversible:** images are additive; remove the shim/sifs to undo.

## Step 2 — CIFS gateway on node2  [you for schema/hashes, drive for config]
- [ ] Install Samba: `sudo apt-get install -y samba` (absent today).
- [ ] **[you]** Load the Samba LDAP schema into OpenLDAP; add `sambaSamAccount` +
      `sambaNTPassword` per user (Path A) — seed via the supervised "set my drive password"
      flow (Q3). Never ship NT-hash before LDAPS is on.
- [ ] Install `gateway/sssd.conf` (coexists with node1's libnss-ldap) and `gateway/smb.conf`;
      `sudo testparm`; `sudo systemctl enable --now sssd smbd`.
- [ ] Verify: `getent passwd kriengkraip` resolves on node2; `smbclient -L //localhost -U kriengkraip`.
- **Reversible:** stop smbd; clients still have the old direct-NAS path.

## Step 3 — Identity reconciliation + locker remediation  [drive][gate-with-comms]
Fixes the broken migration + world-writable lockers (`docs/IDENTITY_AUDIT.md`). Use
**`reconcile-identity.sh`** — it resolves uids **authoritatively from LDAP** (not the buggy
`getent`), so it correctly handles the shadowed users. Dry-run verified live (2026-06-27):
**8 chowns, 30 chmods, 16 new lockers, 13 shadow accounts queued.** **Disruptive — do with comms.**
```
sudo bash gateway/reconcile-identity.sh                  # dry-run: review the plan
sudo bash gateway/reconcile-identity.sh --apply          # apply + write journal + rollback
# full rollback if needed:
sudo bash /var/log/apphub/identity-rollback-<ts>.sh
# review, then run separately to drop the local shadow accounts:
sudo bash /var/log/apphub/remove-shadows-<ts>.sh
```
- Recursive `chown --from=<old> <ldap-uid>` (precise + reversible) + `chmod 0700`; provisions
  missing lockers; **emits** (does not auto-run) the local-account removals; **never touches
  orphan/shared dirs**.
- **[you] decide** the 24 shared data/app dirs (`DATA_PSOM`, `gdc`, `ngi-igenomes`, `vitessce`,
  `zulip`, `leantime`, …): move under `/srv/nas/shared/<name>` with group ACLs, or leave.
- (`gateway/provision-lockers.sh` is superseded by this for the shadowed cases.)

## Step 4 — SLURM  [drive]
- [ ] Confirm node1 fully drained / `--exclude=node1` is honored (it's `drng` today).
- [ ] Decide interactive partition: reuse `small` (default) or create `inter`; set per-user
      QOS caps (e.g. MaxJobs, cpu/mem, walltime). `persistent` apps → `UNLIMITED` partition.
- [ ] Install `apphub/backend/scripts/apphub-sbatch-as-user.sh` to `/opt/sisp-apphub/bin/`
      (0755 root) + the sudoers rule (`apphub/deploy/sudoers-apphub`, scoped). `visudo -c`.

## Step 5 — AppHub cutover  [drive][gate]
- [ ] Deploy the rebuilt backend (`apphub/backend`): `npm ci --omit=dev`; `.env` with
      `APPHUB_DEV_AUTH=0`, `APPHUB_SLURM_MODE=slurm`, `DATABASE_URL`, `APPHUB_PROXY_SECRET`,
      `APPHUB_LISTEN=/run/apphub/apphub.sock`, `APPHUB_NGINX_RELOAD`, app domain. Boot guard
      will refuse if misconfigured (that's the safety net).
- [ ] systemd unit (adapt `apphub/deploy/apphub.service`) → unix socket.
- [ ] Build the frontend: `cd apphub/frontend && npm ci && npm run build`; serve `dist/` via nginx.
- [ ] nginx: auth_request gateway, header overwrite, app-vhost cookie isolation, WS upgrade,
      reload. Then **stop the old scaffold on :8792** (the cutover moment).
- **Rollback:** restart the :8792 scaffold + restore nginx snapshot (kept from Preconditions).

## Step 6 — Verification  [drive]
- [ ] `curl --unix-socket /run/apphub/apphub.sock http://x/healthz` → ok.
- [ ] One real launch end-to-end: appears → routes → opens over WSS as the user's uid on
      node2–4 → unreachable by a co-tenant → autosaves on stop.
- [ ] Joint ownership smoke: user A's new file owned by A, unreadable by B; macOS Finder OK.
- [ ] Drive mapping: retargeted client maps `\\nas.sisp.com\sisplockers`; logoff purge works.
- [ ] Watch load/memory on node1 (control plane) and the gateway under a few concurrent sessions.

## Keep for ≥1 week
Old direct-NAS path **read-only** as rollback; monitor; then decommission.

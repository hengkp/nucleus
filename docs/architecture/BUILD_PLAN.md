# SISP AppHub — Build Plan & Milestones

We are rebuilding SISP AppHub from scratch and refactoring the "MapDrive" file-access model so that ~55 non-technical wet-lab researchers get one identity, one password, reliable file storage, and on-demand analysis apps (Jupyter, RStudio, Galaxy, plus no-code templates) that no longer hang the shared server.

Two real problems drive the project. (A) Windows mapped network drives connect users straight to the Infortrend NAS, leaving stale SMB sessions and scrambled file ownership that admins constantly hand-fix with ACLs. (B) JupyterHub/RStudio/Galaxy all run on node1 and fall over under concurrent load. The fix for (A) is to stop pointing clients at the NAS and instead route all file traffic through a single CIFS gateway on the cluster that stamps every file with the correct LDAP user/group, so ownership is always right by construction. The fix for (B) is to schedule each researcher's app as an isolated SLURM job spread across node2-4, while node1 is protected as control-plane-only and never runs user jobs.

The architecture is deliberately security-first. Identity is unified at the directory (one LDAP account, with an added Samba/NT-hash so the same password works for the file gateway), but the web login and the file-share login remain two separate credential channels by design - conflating them was the central flaw in the prior design. A small in-house auth service gates all web traffic and fails closed. Each launched app runs as the real user's UID, binds only to loopback, is reached through a per-job tunnel, and is isolated so co-located jobs cannot reach each other. The whole AppHub portal is being rebuilt cleanly (Node backend + a polished Vite/React frontend on the approved "Linear bones, Stripe warmth" SISP design language), informed by the existing Codex scaffold but replacing it.

The honest constraints the director should know: node1 stays a single point of failure (acceptable for a 4-node lab, with verified nightly restores rather than full HA); memory, not CPU, caps us at roughly 6-10 heavy single-cell sessions at once, so some queuing is intrinsic; and three foundational unknowns must be confirmed on the live cluster before broad rollout - whether the NAS preserves numeric ownership through the gateway, whether SLURM-hosted web apps can be locked to loopback safely, and whether dynamic per-app routing holds under concurrency. The build plan front-loads exactly those unknowns so we fail fast and cheap rather than late and expensive. Every node-touching change requires a human confirmation step; nothing in this plan assumes autonomous production changes.

## Build Plan — Sequenced by Dependency, Risk-Front-Loaded

Legend: **[OFFLINE]** = code/config buildable without touching production; **[LIVE]** = requires a human-confirmed action on node1-4 or the NAS; **[GATE]** = a go/no-go checkpoint that blocks downstream work.

The three highest-risk unknowns — (1) CIFS/NFS idmap correctness, (2) SLURM-as-web-host loopback isolation, (3) dynamic routing under concurrency — are pulled into Phase 0/1 as spikes BEFORE any dependent build effort is committed.

---

### Phase 0 — De-risking Spikes (week 0-2, runs in parallel, no user impact)
Goal: convert the three load-bearing unknowns from assumptions into measured facts.

- **Spike S1 — NAS ownership round-trip [LIVE][GATE].** On a scratch export, write a file owned by uid 10012 via the proposed gateway path and `stat` it back from node2-4. Test NFSv3 AUTH_SYS first; only try NFSv4 with `nfs4_disable_idmapping=Y`. Also test `setfattr/getfattr user.*` round-trip and per-host `no_root_squash`. **Verifiable:** `10012 == 10012` end-to-end, not `nobody:nobody`; xattr survives. **If this fails, the entire re-export premise changes** (fall back to NAS-side provisioning API) — so it must clear first.
- **Spike S2 — Loopback app isolation [LIVE][GATE].** Launch a throwaway Jupyter bound to 127.0.0.1 on node2 under a real UID; from a second job on the same node, confirm the port is NOT reachable. Confirm Apptainer mode (userns vs setuid) on node2-4. **Verifiable:** co-tenant fetch is refused; native token still required even if netns is absent.
- **Spike S3 — Routing under churn [OFFLINE→LIVE].** Prototype squeue-%N→IP derivation + debounced route-map swap (flock, fsync, `nginx -t`, exit 75) in isolation; replay a burst of 30 simultaneous launches. **Verifiable:** no duplicate ports, no divergent map, no reload storm.
- **Spike S4 — SLURM version/parse [LIVE].** Record `sinfo --version`, confirm text-format column layout, confirm node1 is control-plane-only (no slurmd). Pin text parser.

Exit: S1, S2, S3 green (or documented fallback chosen). These are cheap to run and catastrophic to discover late.

---

### Phase 1 — Trust Foundation: PKI + Identity (week 2-5)
Everything downstream depends on TLS and a working dual-plane identity. Mostly offline build, gated live cutovers.

1. **Internal CA + wildcard certs [LIVE].** Stand up the internal CA (for LDAP StartTLS) and issue the public wildcard cert with SAN = `sisp.com` + `*.sisp.com` + the chosen app-domain (`*.app.sisp.com` OR `*.app.sisp-user.net` — **blocked on Open Question Q1**). ACME/DNS-01 with CNAME challenge delegation; ownership + 14-day expiry alert assigned. **Verifiable:** browser-valid cert on a two-label `foo.app.<domain>` host; LDAPS handshake succeeds.
2. **OpenLDAP hardening [LIVE].** Enable StartTLS (`reqcert=demand` target; `reqcert=allow` only as a dated bootstrap), firewall 389/636 to the cluster subnet, create read-only `svc-apphub` bind DN, configure syncrepl consumer on the gateway node.
3. **Samba schema + NT-hash backfill [LIVE][GATE].** Load `sambaSamAccount`/`sambaSID` AFTER LDAPS is live (hard ordering — never ship NT-hash over plaintext). Unify all password changes to write `userPassword` + `sambaNTPassword` transactionally through one set-password action. **Decide Path A (NT-hash in LDAP) vs Path B (Kerberos) — Open Question Q2.** Run the supervised "change password once" rollout to seed hashes (Q3). **Verifiable:** audit shows every active user has both attributes; NTLM bind succeeds.
4. **sisp-sso daemon [OFFLINE→LIVE].** Build the in-repo auth service: unix-socket bind (0660 sso:nginx), in-memory ACL mirrored to Redis, 5s micro-cache, short-TTL (sessionId,host) authz cache, fail-closed circuit breaker, `/healthz`, IP-keyed exponential backoff (X-Real-User from nginx only). Ignores all inbound X-Remote-* headers. **Verifiable:** load test >100 concurrent sessions stays off LDAP/Postgres on the hot path; revoke honored within the documented ≤5s SLA; daemon-down = closed, not open.

Exit: a user can authenticate once at the web edge AND mount the file gateway with the same password.

---

### Phase 2 — Storage Gateway (week 4-7, overlaps Phase 1)
Depends on Phase 1 identity + S1. This is the heart of the MapDrive fix.

1. **Gateway node stand-up [LIVE].** Mount the NAS on the chosen gateway (recommended **node2**, NOT node1) via the S1-validated backhaul. Scope `no_root_squash` to that one host, firewalled to 192.168.0.25-28; keep root_squash everywhere else.
2. **Per-user Samba shares [OFFLINE→LIVE].** `valid users=%U`, mode 2700/0600 owner-only isolation, `oplocks=no`/leases off, group-write confined to an explicit `_shared/` tree. Samba passdb reads the local syncrepl replica, not the node1 primary.
3. **Home pre-creation + remediation [LIVE].** Pre-create the 55 homes out-of-band as correct LDAP uid/gid (NO pam_mkhomedir). Quiesce-and-remediate the 6 legacy mis-owned folders in a maintenance window (length per Q on cutover window).
4. **SMB enrollment flow [OFFLINE].** Self-service "set my drive password" page + admin fallback (required because the web front door is header-trust and never sees cleartext).
5. **Client retargeting [OFFLINE].** Updated `SISPDriveMapper.ps1`/`.command`, SMB signing, logoff net-use cleanup task. Distribute AFTER gateway is proven.

**Verifiable [GATE]:** joint ownership smoke test — user A's file is owned by A's uid and is unreadable by user B; macOS Finder metadata survives; stale-session cleanup works on logoff. This gate must pass before SLURM is enabled on node2-4 (homes must exist with correct ownership first).

---

### Phase 3 — Compute Orchestration + Container Runtime (week 6-10)
Depends on Phase 1 (uid resolution), Phase 2 (workspaces/homes), and S2.

1. **SLURM partitions/associations [LIVE].** Drop the burst partition; `--exclude=node1` everywhere; `persistent` partition (MaxTime=UNLIMITED) for always-on apps, `inter` with finite default + 24h max, a network-restricted partition for untrusted apps, a standing small-lane reservation on node4. Event-driven first-login association provisioning (never pass LDAP password via -w). Honest defaults: 4 CPU/32 GB single-cell with opt-up, whole-node pin for >64 GB.
2. **Control-plane protection [LIVE].** systemd cgroups (CPUAffinity, MemoryMin/High/Max) pinning nginx/LDAP/Postgres/sisp-sso on node1 — the real protection, not SLURM CoreSpec.
3. **App-as-job runtime [OFFLINE→LIVE].** Loopback-only bind + native token (never `--auth-none`/empty token — CI gate on templates.json), per-job SSH local-forward from node1, host firewall denying 31000-31999 from LAN, per-job netns where available. `run_manifest.py` SIGTERM→apptainer child handler so autosave runs.
4. **Container profiles [OFFLINE].** `--contain` standard profile (passwd injection + private HOME + XDG, libnss-wrapper in sisp-base), centralized image-symlink→versioned-path resolution via images.lock.json, stage-time sha256 verify + `.verified` marker (no per-launch rehash), security fields injected via privileged wrapper env (not the group-writable manifest), refcount-aware GC.
5. **Galaxy reclassified [LIVE].** Modeled as a persistent service with its own allocation + DRMAA backend, NOT an idle-culled ephemeral job.

**Verifiable [GATE]:** a real launch runs as the user's uid, is reachable ONLY via the node1 tunnel, is unreachable from a co-tenant, survives a reconcile, and autosaves on SIGTERM. CI asserts no template can regress to 0.0.0.0/empty-token.

---

### Phase 4 — Routing + Backend Control Plane (week 9-13)
Depends on Phases 1-3 and S3. Backend and routing co-evolve.

1. **nginx edge [OFFLINE→LIVE].** auth_request enforcement, header overwrite/inject on every location, micro-cache, app-vhost cookie isolation (do NOT forward SSO cookie to app upstreams), WebSocket Upgrade headers, single-label vhost handling per Q1, worker_connections/rlimit sizing for hundreds of long-lived proxies.
2. **Per-app authorization [OFFLINE].** :8888/sisp-sso returns 403 unless session user is owner/share/admin for the requested X-Apphub-Host. Identity probe without an open token-echo endpoint.
3. **Backend rebuild [OFFLINE].** Fail-closed sbatch-as-user wrapper (refuse uid<10000 or gid≠100000, assert getent agreement, block reserved usernames, no head/fallback chains, APPHUB_DEV_AUTH=0). Cached non-reconciling GET /api/apps + single-flight reconcile + one batched squeue per tick + debounced nginx reload. Atomic port allocator (partial-unique index ON CONFLICT retry). Idempotent wrapper + job adoption on recovery. squeue-%N→IP routing (never trust job-written status.json host). Reject over-length names (HTTP 400, no silent truncation). Boot-time route reconciliation + reverse-reconcile (adopt/propose-cancel orphan jobs). Status/heartbeat on local /var/lib, NOT CIFS; readiness via TCP probe, not file mtime.
4. **Confirmation model [OFFLINE].** Split infra/agent actions (mandatory human confirm) from routine in-envelope user launches (audit-only). Cancel branch verifies ownership before scancel.

**Verifiable [GATE]:** a launch from the SPA appears, routes, opens over WSS with a valid app-domain cert, and a second user cannot open it; 30-way concurrent launch produces no duplicate ports, no reload storm, no cross-user misroute.

---

### Phase 5 — Frontend (week 11-15, overlaps Phase 4)
Depends on the Phase 4 read-path contract.

1. **Read-path contract honored [OFFLINE].** Adaptive state-aware polling behind one `live.ts` seam; aggressive cadence gated behind `VITE_APPS_READ_IS_CHEAP` (default OFF → 30s/60s), so the frontend can never pace SLURM reconcile.
2. **Auth bootstrap [OFFLINE].** Always-200 /api/session → full-page redirect to configured gateway login URL (Q on exact module). Hashed theme-boot asset for no-FOUC under strict CSP (script-src 'self', no inline).
3. **Honest resource UX [OFFLINE].** Clamp client-side, seed cache from the returned/granted app object; private/team only at launch (no public). Queued/starting/route-pending/forbidden branded states. StaleBadge when data age >2× interval.
4. **Design system [OFFLINE].** Inter + JetBrains Mono subset (self-hosted), ~25 tree-shaken inline ri-* SVGs, SISP teal #11695f, light-default/dark-available; separate JS/font/CSS budgets.

**Verifiable:** schema-contract fixture test green; UI smoke through the deploy harness; "Open" CTA derives strictly from app.url and shows degraded (not "running") when the route is not yet reachable.

---

### Phase 6 — Observability, Ops, Hardening (week 13-16, then continuous)
Cross-cutting; lands last but instrumented earlier where cheap.

1. **Monitoring [LIVE].** node_exporter/Prometheus for real per-host load (node1 load from node_exporter, NOT scontrol). Timeout-wrapped child-process CIFS/status reads; watchdog gated on reconcile-cycle completion. Out-of-band critical alerting (external SMTP + non-node1 channel + Prometheus deadman's switch). Persisted firstSeenInState/stuckReason in Postgres.
2. **Backups [LIVE].** Restore-verified nightly custom-format pg_dump + off-node copy (NO WAL-to-CIFS). Config snapshots. Documented rebuild runbook + instant dir-swap rollback.
3. **Security finish [LIVE].** Relocate executable runtime to root-owned /opt/sisp-apphub (0444/0555) off the 2775 NAS; per-job nftables; append-only audit; SIF signing key escrow; Vault scoped OUT of boot path (systemd LoadCredential sealed file, no non-technical PIs in unseal quorum).

**Verifiable:** restore drill rebuilds the control plane from dump; deadman's switch fires on simulated node1 loss; firewall/authz smoke tests pass in the deploy gate.

---

### Realism notes for a small admin team
- Phases 0-2 are strictly serial on the critical path and owned by the storage/identity lead; Phases 3-5 can overlap once the Phase 2 gate clears. Don't parallelize ahead of a red gate.
- Every [LIVE] step is a scheduled, human-confirmed maintenance action — budget confirmation/operator availability, especially the Samba password rollout and the NAS remediation window.
- Keep the old direct-NAS path available read-only as rollback until the Phase 2 gate is proven in production for at least one week.
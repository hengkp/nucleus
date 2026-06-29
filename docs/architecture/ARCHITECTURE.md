# SISP AppHub + MapDrive — System Architecture

> Adversarially verified architecture (design -> skeptic -> revise per subsystem). Phase 2 deliverable of the clean rebuild.
> Status: Draft for approval. Live-cluster actions still require human confirmation.

## Table of contents

1. [Identity, Authentication & Authorization](#identity-auth)
2. [Storage, CIFS Gateway & File Ownership](#storage-ownership)
3. [Compute Orchestration & SLURM Job Model](#slurm-orchestration)
4. [Container Runtime & App Images](#container-runtime)
5. [Networking, Reverse Proxy & Routing](#networking-routing)
6. [AppHub Backend & Control Plane](#backend-services)
7. [Frontend Architecture](#frontend-architecture)
8. [Security & Multi-Tenancy](#security-tenancy)
9. [Observability, Deployment & Operations](#observability-ops)

---

<a id="identity-auth"></a>

## Identity, Authentication & Authorization

### 0. Purpose & scope (sharpened)

This subsystem owns *who a request is* and *what they may do*. It hands the storage, slurm, and container subsystems one verified tuple — `(username, uidNumber, gidNumber, groups[])` — and nothing else. It does **not** own file ACLs, job execution, or container internals.

**Hard scope boundary (review issue #1).** This subsystem gates **two distinct credential planes that do not share a token**:

- **HTTP plane** — `apphub.sisp.com`, `mapdrive.sisp.com`, and every `*.app.sisp.com` per-user vhost. Authenticated by the `nginxauth` web cookie via nginx `auth_request`. This is "web SSO."
- **SMB plane** — the node1 CIFS gateway re-export (`\\node1\sisplockers`, port 445). Authenticated by **Samba**, which speaks NTLM/Kerberos and **cannot consume an HTTP cookie**. Windows mapped drives and macOS `smb://` live here.

These are deliberately separate and the document never claims the web cookie authenticates the drive. What makes them *one identity* is that both planes resolve the same LDAP `uidNumber/gidNumber` through SSSD/Samba, so a file written via the drive and a file written by a SLURM job have identical ownership. "Single sign-on" in this design means **single identity and single password**, not a single token across protocols.

Components (all on node1 / 192.168.0.25 unless noted):
- **OpenLDAP** (`slapd`, `dc=siriraj,dc=local`) — identity source of truth. `ou=People` uid 10000–10054, primary group `sisp` gid 100000.
- **sisp-sso** — NEW daemon (Node native `http`, no framework) bound to a **unix socket** `/run/sisp-sso/sso.sock` (mode 0660, owner `sso:nginx`), *not* a TCP port. Owns `/auth/*` and `/check`.
- **sisp-sso session cache** — in-memory authoritative map + Redis (`127.0.0.1:6379`, unix socket) for cross-restart durability; Postgres `sisp_sso` only for audit and revocation log (see §3.4).
- **SSSD** — on node1–node4. NSS+PAM resolution so `getent passwd <username>` returns the one-true LDAP uid/gid cluster-wide. This feeds the existing `apphub-sbatch-as-user.sh` wrapper.
- **Samba** (`smbd`) — node1 CIFS gateway, authenticated against LDAP via the NT-hash path described in §2.
- **nginx** — the single enforcement edge for the HTTP plane.
- **AppHub backend** — consumes trusted headers, maps groups→roles.

The split: **sisp-sso authenticates the web; Samba authenticates SMB; SSSD resolves POSIX numbers; AppHub authorizes.** Each is independently testable.

---

### 1. LDAP — source of truth plus the groups and accounts it is missing

Existing (unchanged): `ou=People`, 55 `posixAccount` users uid 10000–10054, primary group `sisp` gid 100000.

Add `ou=Groups` and three `posixGroup`s so SSSD `rfc2307` resolves supplementary groups by `memberUid`:

```ldif
dn: ou=Groups,dc=siriraj,dc=local
objectClass: organizationalUnit
ou: Groups

dn: cn=sisp,ou=Groups,dc=siriraj,dc=local
objectClass: posixGroup
gidNumber: 100000

dn: cn=apphub-power,ou=Groups,dc=siriraj,dc=local
objectClass: posixGroup
gidNumber: 100100
memberUid: kriengkraip

dn: cn=sisp-admins,ou=Groups,dc=siriraj,dc=local
objectClass: posixGroup
gidNumber: 100200
memberUid: nodeadmin
```

**Group-cn naming rule (review missing #7).** Because cn values flow into the `X-Authenticated-Groups` header (comma+space joined) and AppHub splits on `/[,\s]+/` (`server.js:40`), every group cn used for authorization **must match `^[a-z0-9-]{1,32}$`** — no commas, no whitespace. sisp-sso validates this at session-mint time and **drops any non-conforming group from the snapshot** (logged as `group.dropped`), so a malformed directory entry can never split into or inject a privileged token like `sisp-admins`. The three role cns above are conformant by construction.

Service accounts:
- `cn=apphub-ro,dc=siriraj,dc=local` — read-only bind for SSSD, sisp-sso search phase, and Samba search. ACL: read on `ou=People`/`ou=Groups`, no write.
- `cn=admin` (root DN) — reserved for break-glass only; password **rotated off** the documented default `[redacted]` as step 0 of deploy and stored in the ops vault, never placed in any service config.

---

### 2. SMB authentication — the NT-hash gap (review issue #1, missing #1)

`posixAccount` stores only `userPassword` (crypt). It has **no `sambaNTPassword`**, so NTLM bind against it fails outright. The CIFS gateway cannot work without resolving this. Two viable paths; we choose **Path A** for this lab and document Path B as the upgrade:

**Path A (chosen) — extend the directory with `sambaSamAccount`.**
1. Load the Samba LDAP schema into slapd; add the `sambaSamAccount` auxiliary objectClass to each of the 55 users (`sambaSID`, `sambaNTPassword`, `sambaAcctFlags`).
2. Configure `smbd` with `passdb backend = ldapsam:ldap://127.0.0.1`, `ldap admin dn = cn=apphub-ro` (read) plus a **dedicated write-capable bind** `cn=samba-pwsync` scoped to write only the `sambaNTPassword` attribute, used solely by `smbpasswd`/password-change.
3. **Password unification:** drive NT-hash population through a single password-set path. New/changed passwords go through a small "set my password" action that writes *both* `userPassword` (for LDAP bind / SSSD) **and** `sambaNTPassword` (for NTLM) in one transaction. Until a user changes their password once post-migration, seed `sambaNTPassword` from the existing known credential during the supervised migration window.
4. Windows users keep typing `SIRIRAJ\username` + password at the drive mapper; Samba maps the realm prefix to the bare uid (the same normalization sisp-sso does, §3.2 step 2) and authenticates against `sambaNTPassword`. Ownership of written files is the LDAP `uidNumber/gidNumber` because smbd resolves the user through the same NSS/SSSD stack.

**Path B (documented upgrade) — Kerberos/AD.** Stand up an MIT KDC or Samba AD-DC, join node1, and let SMB use Kerberos tickets (no NT hash at rest). Larger blast radius; deferred. Recorded as an open question for the human because it changes the whole password story.

**Stale-session / ownership-drift fix (Problem A) is structural here**, not cosmetic: clients connect only to node1's re-export, smbd assigns ownership from LDAP uid/gid via SSSD, and there is exactly one `username→uid` authority. The old failure mode (clients mounting the NAS directly, Windows caching SMB credentials, ACLs drifting) is removed by *eliminating the direct NAS mount*, coordinated with the storage subsystem.

---

### 3. SSSD — uid/gid resolution on every node

`/etc/sssd/sssd.conf` (0600, root) — identical on node1–node4 except `ldap_uri`:

```ini
[sssd]
config_file_version = 2
services = nss, pam
domains = siriraj

[domain/siriraj]
id_provider  = ldap
auth_provider = ldap
access_provider = ldap
ldap_uri = ldap://127.0.0.1:389          # node2-4: ldap://192.168.0.25:389
ldap_search_base = dc=siriraj,dc=local
ldap_user_search_base  = ou=People,dc=siriraj,dc=local
ldap_group_search_base = ou=Groups,dc=siriraj,dc=local
ldap_schema = rfc2307
ldap_default_bind_dn = cn=apphub-ro,dc=siriraj,dc=local
ldap_default_authtok = <ro-secret>
ldap_access_filter = (objectClass=posixAccount)
cache_credentials = true                 # node2-4 keep resolving if node1 LDAP blips
enumerate = false
# TLS: bootstrap value is 'allow'; steady state below (see §8)
ldap_id_use_start_tls = true
ldap_tls_reqcert = demand                # was 'allow'; pin once CA deployed (review #7)
ldap_tls_cacert = /etc/pki/sisp-ca/ca.pem
# homes pre-created out-of-band; do NOT use pam_mkhomedir on CIFS (see §3.1)
override_homedir = /mnt/sisphome/%u
fallback_homedir = /home/%u
```

`/etc/nsswitch.conf`: `passwd: files sss` / `group: files sss` / `shadow: files sss`.

**Anti-drift rule:** no local `/etc/passwd` accounts in the 10000–100xxx range on any node. Audit: `getent passwd | awk -F: '$3>=10000 && $3<100000'` — every hit must come from `sss`.

#### 3.1 Home directories — do NOT pam_mkhomedir on the CIFS re-export (review issue #9)

`with-mkhomedir` runs `pam_mkhomedir` as root; the CIFS gateway squashes root and node2–4 reach `$HOME` through a double hop (node2-4 → node1 re-export → Infortrend NAS). First login or first SLURM job would either fail to create `$HOME` or create it root-squashed → exactly the uid/gid drift we exist to kill.

Resolution, coordinated with the storage subsystem:
- Homes are **pre-created out-of-band** by a one-shot provisioning script that, for each LDAP user, `mkdir`s `/mnt/sisphome/<uid>` and `chown <uidNumber>:<gidNumber>` **on the gateway host where idmap/no-root-squash is in effect**, not via PAM on a remote node.
- `authselect select sssd` is applied **without** `with-mkhomedir`.
- The deploy smoke test asserts `stat -c '%u:%g' /mnt/sisphome/<user>` equals the LDAP `uidNumber:gidNumber` on **every** node before SLURM is allowed to schedule jobs that need `$HOME`.

#### 3.2 Bootstrap order — breaking the chicken-and-egg (review missing #4)

`cn=apphub-ro` must exist before SSSD can bind; SSSD must resolve before the "no local accounts" rule is meaningful; the `ro` secret must reach both `sssd.conf` and sisp-sso without a window where `cn=admin` is the daily bind. Ordered, human-confirmed sequence:

1. **Rotate `cn=admin`** off the default password; store in vault.
2. `ldapadd` `ou=Groups`, the three groups, `cn=apphub-ro`, `cn=samba-pwsync` — performed once over loopback as `cn=admin`.
3. **Generate the `ro` secret once**, write it to the ops vault, and template it into `/etc/sssd/sssd.conf` (0600) and the sisp-sso systemd `EnvironmentFile` (0600, owner `sso`) in the same provisioning step. Neither service ever uses `cn=admin`.
4. Bring up SSSD on node1, verify `getent passwd dianap` → `dianap:*:10012:100000:...` and `id dianap` shows supplementary groups, then roll to node2–4.

---

### 4. sisp-sso daemon

Runtime: systemd `sisp-sso.service`, user `sso`, **listens on a unix socket** `/run/sisp-sso/sso.sock` (0660 `sso:nginx`). No TCP port — this removes the entire "any node1 process curls 8888" surface and means the only client able to reach it is nginx (review issue #2).

#### 4.1 Endpoints

| Method/Path | Purpose | Auth |
|---|---|---|
| `GET /auth/login?service=<url>` | Split-panel login (design contract: teal `#11695f`, self-hosted Inter + JetBrains Mono, Remix Icons, light-default; left brand hero / right LDAP form). Sets `sso_csrf` pre-auth cookie + hidden `csrf_token`. | none |
| `POST /auth/login` | CSRF → normalize → throttle → LDAP search+bind → mint session → `Set-Cookie nginxauth` → 302 to validated `service`. | CSRF |
| `POST /auth/logout` | Delete session, expire cookie (exact mint attributes), 302 to apphub. | session |
| `GET /check` | nginx `auth_request` backend. 200 + identity headers if valid, else 401. | cookie |
| `GET /healthz` | Liveness for nginx + monitoring (see §9). | none |
| `POST /auth/admin/revoke` | Admin-gated session kill by username. | admin session |

#### 4.2 `POST /auth/login` sequence
1. Verify `csrf_token` form field == `sso_csrf` cookie (synchronizer token; honours the `auth-smoke` contract).
2. **Normalize username:** strip `SIRIRAJ\`, `siriraj.local\`, `@siriraj.local`; lowercase; whitelist `^[a-z0-9_.-]{1,64}$` — identical to the wrapper's whitelist so identity is consistent end to end.
3. **Throttle (IP-keyed, not username-keyed — review issue #3).** Key on **client IP only**, with exponential backoff; ≥5 failures → increasing delay + 429, never a per-username hard lock. Usernames are publicly enumerable (the `SIRIRAJ\username` convention), so a username-keyed lock is a trivial targeted-DoS and we do not build one. Client IP is taken **only** from the nginx-written `X-Real-IP` (see §4.5).
4. **Search** as `cn=apphub-ro` `(uid=<username>)` → DN, `uidNumber`, `gidNumber`; group search `(&(objectClass=posixGroup)(memberUid=<username>))` → cns (filtered by the §1 cn rule).
5. **Bind** as the user DN against `ldap://127.0.0.1:389` (loopback cleartext acceptable on the LDAP host). Failure → throttle++, generic 401 "Invalid username or password" (no enumeration distinction).
6. On success: **session-fixation defence** — fresh 256-bit id `crypto.randomBytes(32)` base64url, minted *after* bind. Write to cache (and Redis + audit). `Set-Cookie: nginxauth=<id>; Path=/; Domain=.sisp.com; HttpOnly; Secure; SameSite=Lax`.
7. **Open-redirect guard:** `service` must match `^https://([a-z0-9-]+\.)*sisp\.com(/|$)`; else default `https://apphub.sisp.com/`. 302.
8. Audit `login.success`.

#### 4.3 `GET /check` — hot path, decoupled from shared Postgres (review issue #5, missing #5)

This fires on *every* request and sub-resource. It must **not** touch the shared `sisp_apphub` Postgres — that is precisely the contention that hung the apps (Problem B). Design:

1. Read `nginxauth` cookie.
2. Validate against the **in-memory session map** (O(1), no I/O). Reject if missing / `expires_at<now` / idle `last_seen<now-idleTtl`.
3. **Sliding window** updates `last_seen` in memory, flushed to Redis at most once/60s per session (lazy, batched).
4. Return `200` with `X-Authenticated-User: dianap` and `X-Authenticated-Groups: sisp, apphub-power`.
5. Invalid → `401`.

**nginx micro-cache on `/check`:** `proxy_cache` keyed on the cookie value, **TTL = 5s**. This collapses the sub-resource fan-out of a single page load into one upstream call.

**Revocation-latency SLA (the explicit trade we are forced to name).** "Instant revocation" and per-request caching cannot both be absolute. We commit to: **admin revoke / disable takes effect within 5 seconds** (the micro-cache TTL) at the HTTP edge, and immediately (next request) if the micro-cache is bypassed for sensitive admin routes. Revoke deletes the in-memory entry, the Redis entry, and writes a `revoke` audit row. We accept ≤5s of residual access on already-issued sub-resources as the documented cost of surviving concurrent load. Admin `/api/admin/*` and `/auth/admin/*` locations set `auth_request` with **no cache** so privilege changes there are first-request.

#### 4.4 Session durability across restart (review missing #6)

The authoritative map is in memory, mirrored to Redis (AOF persistence). On `sisp-sso` start it **reloads live sessions from Redis**, including the last flushed `last_seen`. Worst case after a crash, a session's `last_seen` is stale by ≤60s (the flush interval) — meaning idle expiry can fire up to 60s *early*, never late. The 8h idle promise therefore holds to within one flush interval, which we document rather than claim exact. If Redis is unavailable at boot, sisp-sso starts with an empty map (all users re-login once) rather than fabricating sessions — fail toward re-auth.

#### 4.5 Trusted client IP (review issue #4)

nginx sets `X-Real-IP` from `$remote_addr` and **strips any client-supplied `X-Forwarded-For`** at the public edge. sisp-sso trusts **only** `X-Real-IP` and ignores inbound XFF entirely; `set_real_ip_from 127.0.0.1` is configured so the proxy hop is explicit. Attackers cannot spoof the throttle key, and the bucket is never collapsed to a single `127.0.0.1`.

#### 4.6 Session store (Postgres `sisp_sso`) — audit & revocation only

```sql
CREATE TABLE login_audit (
  id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT now(),
  username TEXT, client_ip INET, event TEXT,   -- login.success|login.fail|logout|revoke|group.dropped
  detail JSONB
);
CREATE TABLE revocations (                      -- durable revoke log, replayed on boot
  username TEXT, revoked_at TIMESTAMPTZ DEFAULT now(), by_admin TEXT
);
```

Session rows live in Redis (`sess:<id>` → JSON `{username, uid, gid, groups, created_at, expires_at, last_seen}`), **not** in the hot SQL path. Postgres is durable audit + revocation only, off the request path. Why opaque server-side sessions over JWT: instant revocation, no signing-key rotation/leak surface, no forgeable claims; JWT's statelessness is irrelevant on a single control-plane node.

---

### 5. Session lifecycle & timeouts
- **Idle TTL = 8h** (sliding `last_seen`) — a normal lab workday without re-login.
- **Absolute TTL = 12h** (fixed `expires_at`) — forces daily re-auth, bounds stolen-cookie value.
- **Logout** = delete (memory + Redis) + `Set-Cookie: nginxauth=; Path=/; Domain=.sisp.com; HttpOnly; Secure; SameSite=Lax; Max-Age=0` — **identical attributes to mint** so the browser actually evicts the cookie (review issue #6: the original `Max-Age=0` without `Path=/` defaulted to `/auth` and never cleared the `Path=/` cookie).
- **Admin revoke** = `POST /auth/admin/revoke {username}` → delete all matching sessions + audit; effective within the §4.3 SLA.
- **Long-running app tabs:** a Jupyter tab open past the 12h absolute cap 401s; the vhost redirects to login and bounces back via `service=`. The notebook on disk is untouched because it runs under SLURM independent of the browser session. User-facing copy: "you may need to log in again once a day."

---

### 6. nginx integration — concrete patches to the existing conf

The scaffold conf (`apphub-nginx.conf`) is structurally right (auth_request → `/check`, `.sisp.com` cookie, `service=` round-trip) but has the exact header-trust hole the reviewer flagged. Fixes:

**(a) Inject — never forward — identity headers, on every proxied location (review issue #2).** AppHub trusts `X-Remote-User`/`X-Remote-Groups` unconditionally (`server.js:34,39`). Today the `/api/` location forwards `X-Remote-User $apphub_user` but hardcodes `X-Remote-Groups ""` (`apphub-nginx.conf:30`), and the `*.app.sisp.com` upstream sets **neither** header — so a client (or a co-located process) can send its own. Fix in *both* server blocks:

```nginx
auth_request_set $apphub_user   $upstream_http_x_authenticated_user;
auth_request_set $apphub_groups $upstream_http_x_authenticated_groups;
proxy_set_header X-Remote-User   $apphub_user;     # always overwrite
proxy_set_header X-Remote-Groups $apphub_groups;   # was "" — now real groups
proxy_set_header X-Auth-Proxy    $apphub_proxy_secret;  # shared secret, see (d)
```

`proxy_set_header` replaces any client-supplied value, so inbound forgeries are overwritten. Unauthenticated locations explicitly clear both (`proxy_set_header X-Remote-User ""`).

**(b) Defence-in-depth at the backend socket (review issue #2, missing #9).** Two layers so a forged header from *any* origin (a node1 loopback process **or** a malicious app on node2–4 calling node1 over the LAN) cannot mint admin:
- AppHub binds to a **unix socket** `/run/apphub/apphub.sock` (0660 `apphub:nginx`) instead of `127.0.0.1:8792`. Off-host LAN callers and unrelated local users cannot reach it at all.
- AppHub additionally **requires `X-Auth-Proxy: <secret>`** (32-byte random, shared only between nginx and AppHub via their `EnvironmentFile`s) on every request and rejects (403) any request lacking it. Even a process that gained socket access cannot forge identity without the secret.

**(c) Per-app cookie isolation — header-only, no shared bearer (review issue #10).** The original `map`-based cookie-strip regex is fragile (greedy match, edge cases at string ends). We drop it. For `*.app.sisp.com` upstreams we **do not pass `nginxauth` at all** — apps receive only the injected `X-Remote-User`/`X-Remote-Groups` and a separate, narrowly-scoped per-app cookie if the app needs its own session. The bearer cookie never crosses into a per-user (potentially hostile) app container:

```nginx
# *.app.sisp.com  location /
proxy_set_header Cookie "";                 # app gets no nginxauth, ever
proxy_set_header X-Remote-User   $apphub_user;
proxy_set_header X-Remote-Groups $apphub_groups;
```

(The `auth_request` subrequest to `/_apphub_auth` still forwards the cookie to `/check`, so authentication runs; only the *upstream app* is denied the secret.)

**(d) Add the auth blocks to `mapdrive.sisp.com`.** Same `auth_request` + `@apphub_login` + `/auth/` + `.sisp.com` cookie → one web login covers apphub, mapdrive (the status page), and app vhosts. (This is the *web* status surface; the SMB drive credential is §2.)

---

### 7. Per-app SSO requires per-app trusted-header config (review missing #2)

Injecting `X-Remote-User` is necessary but **not sufficient** — Jupyter/RStudio/Galaxy ignore it out of the box. For each, the rebuild ships explicit config and **disables the app's own token/login**:
- **JupyterHub:** `c.JupyterHub.authenticator_class = 'jupyterhub.auth.RemoteUserAuthenticator'` (or `jupyterhub-nativeauthenticator` disabled), trust `X-Remote-User`, single-user token auth off.
- **RStudio (Workbench/proxy):** `auth-proxy=1`, `auth-proxy-user-header-name=X-Remote-User`, sign-in page disabled.
- **Galaxy:** `use_remote_user: true`, `remote_user_header: HTTP_X_REMOTE_USER`, `remote_user_maildomain` set.
- Apps with their own irreducible account model (Zulip, Leantime) are gated only at the edge (reachability) and receive `X-Remote-User` for optional pre-fill; their internal authz is out of scope and documented as such.

---

### 8. Role model & authorization

Three roles, resolved by AppHub from injected groups (no SSO involvement — clean boundary):

| Role | Identity rule | Capabilities |
|---|---|---|
| **researcher** (default, all 55) | member of `sisp` / gid 100000 | launch templated apps within `maxCpus/maxMem/maxTime`; private visibility; default nodes node2–4; *request* persistence/public → admin queue. |
| **power-user** | `memberUid` of `cn=apphub-power` | higher per-app ceiling (`APPHUB_POWER_MAX_CPUS`); target `allowedNodes` subset; auto-approved persistence (config flag). |
| **admin** = nodeadmin | username in `APPHUB_ADMIN_USERS` **or** group `sisp-admins` | `/api/admin/*`, approve/reject, override resources, edit templates, force reconcile, view audit, **revoke sessions**. |

Enforcement is in `server.js` (`requireAdmin`/`ensureOwnsApp` exist; `isAdmin` derives from `adminUsers` ∪ `adminGroups` at `server.js:43`).

**Correction of the scaffold-bug reference (review issue #8).** The original design wrongly named `server.js:417` as "GET /api/session returns groups:[]". Verified ground truth:
- `GET /api/session` (`server.js:400-407`) already returns the **real** actor with real `groups` and group-derived `isAdmin`. It does **not** need rewriting — only verifying.
- `server.js:417` is the **`POST /api/session/dev-login`** response, which returns `groups: []` and `isAdmin` from username only. That path is gated solely by `config.allowDevLogin`, which defaults to **on** when `NODE_ENV !== 'production'` (`config.js:62`). If `NODE_ENV` is unset at deploy, dev-login lets *anyone* set any username (including an admin) via the cookie (`actorFromRequest` trusts the cookie when `allowDevLogin`, `server.js:36`).

Deploy guards:
- Set **`APPHUB_DEV_AUTH=0` explicitly** in the systemd unit `EnvironmentFile` — do not rely on `NODE_ENV` being present. (`apphub.env.node1` already carries this; the unit must load it and fail closed if absent.)
- Add a smoke assertion that **`POST /api/session/dev-login` returns 404 in production**.

The persistent third-party apps (`cmssight`, `dmmr` — owner `kriengkraip`; `leantime`, `zulip`, `vitessce` — `nodeadmin`) sit behind the same `.sisp.com` web SSO when fronted by nginx; their internal app authz is their own (§7).

---

### 9. Availability — sisp-sso is in the path of everything (review missing #8)

Because `/check` gates every authenticated HTTP request, sisp-sso is a single point of failure and needs an explicit availability contract:
- **Liveness:** `GET /healthz` checks the in-memory map + Redis reachability; systemd `Restart=always`, `WatchdogSec=10`.
- **Fail-closed, by decision.** If sisp-sso is down, nginx `auth_request` returns 500 → users see the login/error page, **not** open access. We choose fail-*closed* over fail-*open* (an auth daemon that fails open is a vulnerability). The mitigation for the resulting outage risk is fast restart + the 5s micro-cache (which keeps already-validated cookies working through a brief blip) + alerting, **not** fail-open.
- **SLO / alerting:** `/check` p99 < 10ms; alert if p99 > 50ms for 1 min, if `login.fail` rate spikes (credential-stuffing signal), or if `/healthz` fails twice. Alerts go to the ops channel (Zulip).

---

### 10. TLS / certificates (review missing #3)

- **Web:** the `nginxauth` cookie is `Secure` and spans many ephemeral `*.app.sisp.com` subdomains, so a single `sisp.com` cert is insufficient. A **one-level wildcard does not cover a second label** — `*.sisp.com` does **not** match `foo.app.sisp.com`. The cert SAN set must be **`sisp.com`, `*.sisp.com`, *and* `*.app.sisp.com`** (issued/renewed via the existing ACME/DNS-01 flow since these are wildcards). Renewal is automated; expiry is alerted 14 days out.
- **LDAP (review issue #7):** internal CA `/etc/pki/sisp-ca/ca.pem`. sisp-sso binds over **loopback** (cleartext acceptable on the LDAP host). SSSD on node2–4 binds over the wire — steady state is `ldap_id_use_start_tls = true` + **`ldap_tls_reqcert = demand`** with the pinned CA. `reqcert = allow` is an explicitly-dated bootstrap value only (before the CA is deployed the LAN is the documented trust boundary), never the steady state.

---

### 11. Security hardening summary
- **No autonomous LDAP lockout** — IP-keyed exponential backoff at sisp-sso; if `ppolicy` is used at all it is `pwdFailureCountInterval` + **alert-only**, never `pwdLockoutDuration` hard-lock (which would also block SSSD/PAM resolution cluster-wide for that user).
- **Header injection** closed at both the edge (overwrite) and backend (unix socket + `X-Auth-Proxy` secret).
- **Bearer cookie** never reaches per-app upstreams (header-only).
- **Open-redirect** guard on `service=`; **CSRF** synchronizer token; **session fixation** (id after bind); **trusted client IP** only.
- **Audit** every `login.*`/`logout`/`revoke`/`group.dropped` to `login_audit`; AppHub `addAudit` continues for app actions.

---

### 12. Interfaces to other subsystems
- **→ Storage (CIFS gateway):** provides the canonical `username→uidNumber:gidNumber` via SSSD that smbd uses to stamp file ownership; depends on storage for no-root-squash/idmap on the gateway and for out-of-band home pre-creation (§3.1). Joint smoke test: `stat` ownership equals LDAP numbers on all nodes.
- **→ SLURM / job launch:** AppHub passes `actor.username` (from `X-Remote-User`) to `sudo -n apphub-sbatch-as-user.sh submit <username>`; the wrapper's `getent passwd` (SSSD) yields the same uid/gid. Identity agrees because both derive from one LDAP and normalize the username string identically (§4.2 step 2 == wrapper whitelist).
- **→ AppHub / app vhosts:** delivers `X-Remote-User` + `X-Remote-Groups`; consumes nothing back except the admin-revoke call.
- **→ Monitoring (Zulip):** emits the SLO alerts of §9.

---

### 13. Deploy & verify (human-confirmed, per no-autonomous-change rule)
1. Rotate `cn=admin`; vault it.
2. `ldapadd` `ou=Groups` + 3 groups + `cn=apphub-ro` + `cn=samba-pwsync`; confirm with `ldapsearch -x -b ou=Groups,...`.
3. Provision the `ro` secret into `sssd.conf` and the sisp-sso `EnvironmentFile` in one step (§3.2).
4. SSSD node1 → verify `getent`/`id` → roll node2–4.
5. Pre-create homes out-of-band; assert `stat` ownership per node (§3.1).
6. Samba: load schema, extend users to `sambaSamAccount`, seed NT hashes, `smbclient` auth test as `SIRIRAJ\dianap` (§2).
7. Redis up; `psql -f sql/sso-audit.sql`.
8. Deploy `sisp-sso.service` (unix socket); `curl --unix-socket /run/sisp-sso/sso.sock http://x/check` → 401.
9. Patch nginx (header injection, socket upstream, `X-Auth-Proxy`, app cookie isolation, mapdrive block, wildcard cert), `apphub-nginx-reload`.
10. Set `APPHUB_DEV_AUTH=0` in the unit; assert `POST /api/session/dev-login` → 404.
11. Run **`auth-smoke-node1.py`** unchanged (acceptance gate: GET-login→csrf→POST→`nginxauth`→`/`→`/api/session`, `user.username==username`). Add assertions: `/api/session` returns expected `groups`+`isAdmin` for a `sisp-admins` member; dev-login is 404; a request with a forged `X-Remote-User` but no `X-Auth-Proxy` is 403.
12. Manual SSO proof: log into apphub, hit mapdrive — no second prompt.

---

### 14. What we keep from the Codex scaffold
- The **auth_request → `/check` → header-injection** architecture and `.sisp.com` cookie domain — sound; we implement the missing daemon to that contract (now over a unix socket).
- The **CSRF login-form shape** `auth-smoke` expects — preserved.
- The wrapper's **getent-based uid/gid resolution** (`preferred_gid=100000`, `preferred_uid_min=10000`) — correct; SSSD feeds it, plus the "no conflicting local accounts" rule.
- `APPHUB_ADMIN_USERS`/`APPHUB_ADMIN_GROUPS` + `isAdmin` derivation (`server.js:43`) — reused as the admin half of the role model; we add `apphub-power`, the group-cn safety rule, and the dev-login deploy guard.

**Dependencies:** storage-cifs-gateway: no-root-squash/idmap on the node1 re-export, out-of-band home pre-creation, and elimination of direct client NAS mounts; joint stat-ownership smoke test, slurm-job-execution: apphub-sbatch-as-user.sh wrapper consuming SSSD getent uid/gid; identical username normalization contract, apphub-backend: consumes X-Remote-User/X-Remote-Groups, enforces roles, honors X-Auth-Proxy secret and unix-socket binding, ships APPHUB_DEV_AUTH=0 guard, nginx-edge: auth_request enforcement, header overwrite/injection, micro-cache, app-vhost cookie isolation, wildcard TLS termination, tls-pki: internal CA for LDAP StartTLS and the sisp.com + *.sisp.com + *.app.sisp.com wildcard certificate issuance/renewal, monitoring: Zulip alert channel for sisp-sso SLO, login-failure spikes, and cert-expiry warnings, per-app-config: JupyterHub/RStudio/Galaxy trusted-remote-user authenticator configuration with native login disabled

**Open questions:** 
- SMB password strategy: confirm Path A (sambaSamAccount/NT-hash in OpenLDAP) vs Path B (Kerberos/AD-DC). Path A is assumed in this design; Path B changes the entire password story and should be a conscious human decision.
- During Samba migration, how are existing user passwords obtained to seed sambaNTPassword without forcing a mass reset? Is a supervised 'change password once' rollout acceptable, or must NT hashes be backfilled from a known source?
- Confirm storage subsystem can guarantee no-root-squash/idmap on the gateway and pre-create homes as LDAP uid/gid before SLURM scheduling is enabled on node2-4.
- Is a 5s revocation-latency SLA at the HTTP edge acceptable to security, or must high-sensitivity routes be fully uncached (first-request revoke only)?
- Approve adding Redis as a new control-plane dependency on node1, or prefer an alternative in-memory durability mechanism?
- Should the *.app.sisp.com wildcard be issued via the same ACME/DNS-01 account as sisp.com, and who owns renewal automation and the 14-day expiry alert?
- For edge-gated-only apps (Zulip, Leantime), is a second internal login acceptable to users, or is deeper identity federation (e.g. Zulip LDAP/SAML) in scope for a later phase?


---

<a id="storage-ownership"></a>

## Storage, CIFS Gateway & File Ownership

### 0. Purpose and scope

Move clients off direct Infortrend NAS access (`\\192.168.0.103`, `SIRIRAJ\user`) and put a single LDAP-backed SMB gateway in front of it, so every desktop write and every AppHub job write land on the NAS as the **authenticated LDAP uid**, with deterministic, *per-user-isolated* permissions. This kills the Windows stale-session ownership drift (problem A) at the server, and gives AppHub jobs an identical `/mnt/sisplockers` path resolving to the same uid. This revision keeps the scaffold's shape (`/mnt/sisplockers`, `workspaceBase`, the `sbatch --uid/--gid` wrapper, the `/api/drives` "planned" placeholder) but corrects the ownership-transport, isolation, privilege, and availability assumptions the review found unsafe.

> **Build-on, don't rebuild.** Unchanged scaffold facts I rely on: every node-touching path is `/mnt/sisplockers/...`; `apphub-sbatch-as-user.sh` resolves the target uid/gid from `getent passwd` using the rule `gid==100000 OR uid>=10000` (line 74-87) — note the **OR**, which is why the isolation change below needs *no wrapper code change*; `config.js` authenticates via a trusted reverse-proxy header `x-remote-user` (line 58) — which is why SMB credential capture **cannot** live in the Node app (see §8).

### 1. What changed from the original design (decision summary)

1. **Backhaul ownership transport is no longer assumed.** Primary = **NFSv3 AUTH_SYS** (numeric uid/gid on the wire, no idmap). NFSv4 is a fallback only with `nfs4_disable_idmapping=Y` on all four nodes *and* a matching `idmapd.conf` Domain, and only after a pilot proves a NAS file owned `10012` reads back as `10012`, not `nobody`.
2. **No shared group-write on per-user lockers.** Isolation is enforced by **mode** (`0600`/`2700`, owner-only) plus a per-user Samba share rooted at the user's own folder. `sisp` (gid 100000) remains a *supplementary* group used only on an explicit `_shared/` collaboration tree. POSIX ACLs provide opt-in sharing.
3. **The gateway is a dedicated role, not piled onto the control plane.** Recommended placement: **node2** (`files.sisp.com → 192.168.0.26`), cgroup/slice-isolated with a SLURM reservation, so node1 stays purely OpenLDAP + nginx control plane and a NAS stall cannot cascade into identity/public vhosts.
4. **SMB auth survives an OpenLDAP blip** via a local read-only syncrepl consumer that `passdb` binds to.
5. **TLS on LDAP is a hard prerequisite gate** before the Samba schema is even loaded (`sambaNTPassword` is password-equivalent and replayable).
6. **chown/provisioning squash policy is explicit**: a `no_root_squash` export scoped to the gateway node only; compute nodes stay `root_squash`.

### 2. Topology and data flow

```
Windows/macOS client ──SMB3 (signed+encrypted)──> GATEWAY node2 smbd  (files.sisp.com:445, internal DNS only)
                                                      │ auth: passdb=ldapsam -> ldap://127.0.0.1 (local syncrepl consumer)
                                                      │ identity (NSS): SSSD -> uid 10012, primary group = own UPG, supp. group sisp(100000)
GATEWAY node2 ──NFSv3 AUTH_SYS (no_root_squash, firewalled to node2)──> Infortrend NAS 192.168.0.103
node1, node3, node4 ──NFSv3 AUTH_SYS (root_squash)──────────────────> same export, SAME mountpoint /mnt/sisplockers
OpenLDAP primary: node1:636 (LDAPS)  ─syncrepl→  node2:127.0.0.1 read-only consumer
all nodes: SSSD over LDAPS so getent passwd <user> -> uid/gid everywhere
```

Two write paths, one identity model, but **separate subtrees** to avoid dual-writer coherence corruption:
- **Desktop browse/copy** → gateway smbd (session = LDAP uid) → NFS → NAS, under `/mnt/sisplockers/<user>` (private locker) or `/mnt/sisplockers/_shared/<project>`.
- **AppHub job** → Apptainer on node2/3/4 binds `/mnt/sisplockers/apphub/workspaces/<user>/...`, `slurmd` runs as `--uid 10012 --gid <user-gid>`. Job output lands in the **workspace subtree**, treated as *read-after-completion* from the desktop (see §7 oplocks).

### 3. NFS backhaul — numeric ownership, proven not assumed

`/etc/systemd/system/mnt-sisplockers.mount` (gateway = `no_root_squash` export; compute nodes use an otherwise-identical unit pointing at the `root_squash` export):

```ini
[Unit]
Description=SISP lockers (NFS from Infortrend)
After=network-online.target
Wants=network-online.target

[Mount]
What=192.168.0.103:/Pool-1/Columbus-Storage/sisplockers
Where=/mnt/sisplockers
Type=nfs
# PRIMARY: NFSv3 AUTH_SYS guarantees numeric uid/gid on the wire (no idmap).
Options=vers=3,nolock,hard,proto=tcp,nconnect=8,_netdev,noatime,rsize=1048576,wsize=1048576
TimeoutSec=30

[Install]
WantedBy=remote-fs.target
```

- **Why NFSv3 primary (resolves the critical idmap issue):** NFSv4 transports owner/group as `user@domain` strings through `idmapd`/`nfsidmap`; if the NAS and gateway disagree on the v4 domain, every file becomes `nobody:nobody` — the inverse of the goal. NFSv3 AUTH_SYS carries raw integers, so `10012` *is* `dianap` because SSSD resolves the same number. If only v4 is licensed, the fallback is `vers=4.1,sec=sys` **plus** `echo Y > /sys/module/nfs/parameters/nfs4_disable_idmapping` on all four nodes (persisted via `/etc/modprobe.d/nfs.conf`) **plus** a matching `[General] Domain=` in `/etc/idmapd.conf` on every node and (where configurable) the NAS. Either way, **cutover is gated** on `check-storage-node1.py` asserting `stat -c %u /mnt/sisplockers/.apphub-health == 10000` (and a pilot user's real file == their uid), never just file-exists.
- **AUTH_SYS is trust-the-host, so the host set is the trust boundary (resolves the forge-uid issue):** firewall the NAS export to **node1-4 source IPs only** (`192.168.0.25-28`); keep `root_squash` on node3/node4 and node1; reserve `no_root_squash` for the **single gateway node** behind the firewall. Apptainer jobs run with `--no-privs`, `no_new_privs`, `--containall`, no setuid, dropped capabilities, so an escaping job cannot reach host root to forge a uid. Use `sec=krb5` if Infortrend supports it; otherwise the residual assumption "any host root in 192.168.0.25-28 is trusted" is documented and accepted.
- **Quotas (missing item):** NAS per-uid quotas continue to apply because the NAS sees the real numeric uid over NFS; AUTH_SYS forging is bounded by the host firewall above, so a user cannot write under another user's quota from a client.
- **`hard` blast-radius (resolves the multi-role stall issue):** because the gateway is **off** the control plane, a NAS stall freezes smbd D-state on node2 only — node1's slapd/nginx never sit behind this mount. The gateway smbd runs in its own `systemd` slice with `Restart=` limits, and monitoring watches NFS RPC timeout counters (`/proc/net/rpc/nfs`), not just mountpoint presence.

### 4. Identity: SSSD over LDAPS + local read-only LDAP consumer

Cluster-wide NSS via SSSD (no winbind: WORKGROUP, no AD/SIDs). `/etc/sssd/sssd.conf` (0600), **LDAPS from day one**:

```ini
[domain/siriraj]
id_provider = ldap
auth_provider = ldap
ldap_uri = ldaps://node1.sisp.internal:636        # TLS mandatory; see §9
ldap_search_base = dc=siriraj,dc=local
ldap_user_search_base = ou=People,dc=siriraj,dc=local
ldap_schema = rfc2307
ldap_id_use_start_tls = false                      # using LDAPS (636), not StartTLS-on-389
ldap_tls_reqcert = demand
ldap_tls_cacert = /etc/pki/sisp/ca.crt
enumerate = false
cache_credentials = true
```

`cache_credentials=true` covers the **NSS/PAM** path only. It does **not** cover Samba's `passdb`. So the gateway node additionally runs a **local syncrepl consumer** of the OpenLDAP primary, and `smb.conf`'s `passdb backend = ldapsam:ldap://127.0.0.1` binds the consumer. An OpenLDAP-primary blip on node1 then leaves SMB auth fully serviceable from the local replica (resolves the "ldapsam needs slapd up / cache doesn't cover it" issue). The replica is read-only; `ldap passwd sync` writes go to the primary, with the consumer being momentarily stale being acceptable.

### 5. Ownership and isolation model (the security correction)

The original `force group = sisp` + `0660`/`2770` made all 55 lockers group-readable and group-writable by all 55 users — a confidentiality regression. Revised model:

| Tree | Owner:Group | Dir mode | File mode | Sharing |
|---|---|---|---|---|
| `/mnt/sisplockers/<user>` (private locker) | `<uid>:sisp` | `2700` | `0600` | none — owner only |
| `/mnt/sisplockers/_shared/<project>` | `<owner>:sisp` | `2770` | `0660` | group `sisp` + POSIX ACLs |
| `/mnt/sisplockers/apphub/workspaces/<user>` | `<uid>:sisp` | `2700` | `0600` | owner + job (same uid) |

- Group `sisp` (100000) stays the **supplementary** group on lockers but mode `2700` makes that membership inert — isolation comes from **mode, not group**, so no LDAP UPG migration is required and the scaffold's `gid==100000 OR uid>=10000` resolver is unaffected (it still selects the user by `uid>=10000`).
- Opt-in sharing is explicit: a user (or admin action) places/links data under `_shared/<project>` or runs `setfacl -m u:<colleague>:rX` on a locker subfolder. The "admins fix ACLs often" pain is replaced by *deterministic default deny* + *intentional grant*, not per-client negotiation.
- **Restore safety (missing item):** because defaults are owner-only, a NAS snapshot restore re-materializes data at `0600/<uid>` — it cannot widen exposure the way a group-write default would. NAS snapshot schedule is unchanged; the gateway is a stateless re-export and needs no separate backup.

### 6. Gateway placement and isolation

Recommended: gateway smbd on **node2**, not node1. Rationale and controls:
- node1 remains OpenLDAP + public nginx control plane; identity and files are decoupled so neither is a SPOF for the other.
- `files.sisp.com` → **internal DNS only** → `192.168.0.26`; **445 is never internet-reachable** (firewall drop on the WAN edge; split-horizon so the public `*.sisp.com` zone has no `files` record). (Resolves the public-445 exposure item.)
- smbd runs in `system-smb.slice` with `CPUQuota=`, `MemoryMax=`, and a **SLURM reservation** carving its cores out so research jobs cannot starve the gateway; `MaxStartups`/`max smbd processes` cap concurrent SMB sessions. Document the throughput ceiling vs the old direct-NAS path (single 10GbE NIC now carries NAS→gateway and gateway→client for the same bytes; `nconnect=8` helps only the NAS leg).
- If the human decides the gateway must live on node1 after capacity planning, the same slice isolation + session caps + RPC-timeout monitoring apply, and the `hard`-mount caveat in §3 is the accepted tradeoff.

### 7. Samba configuration (revised — deterministic, isolated, coherence-safe)

**Pre-flight before this stack ships (resolves the xattr issue):** on the gateway, `setfattr -n user.t -v 1 /mnt/sisplockers/.probe && getfattr -n user.t /mnt/sisplockers/.probe`. If `user.*`/`security.*` xattrs do **not** round-trip through the NAS NFS export, drop `streams_xattr`, `acl_xattr`, and `store dos attributes=yes`, and use `fruit:metadata = netatalk` (sidecar files) instead. The smb.conf below is the **xattr-confirmed** variant; the reduced variant is the documented fallback. This check is a permanent smoke assertion.

```ini
[global]
   workgroup = SISP
   netbios name = FILES
   security = user
   passdb backend = ldapsam:ldap://127.0.0.1        # local syncrepl consumer (§4)
   ldap suffix = dc=siriraj,dc=local
   ldap user suffix = ou=People
   ldap admin dn = cn=admin,dc=siriraj,dc=local      # secret in secrets.tdb
   ldap ssl = start tls                              # mandatory; gated on §9
   ldap passwd sync = yes
   idmap config * : backend = tdb
   idmap config * : range = 9000-9999                # builtin/unknown SIDs only; real users via NSS

   # Windows 11 24H2 hardening (resolves the SMB-hardening item)
   server min protocol = SMB3_00
   server signing = mandatory
   smb encrypt = required
   restrict anonymous = 2
   map to guest = Never                              # no guest fallback to strand on

   # macOS interop (xattr-confirmed variant)
   vfs objects = catia fruit streams_xattr
   fruit:metadata = stream
   fruit:posix_rename = yes
   fruit:nfs_aces = no

[locker]
   path = /mnt/sisplockers/%U                        # per-user root => isolation by share
   valid users = %U                                  # only the authenticated user; sidesteps @sisp primary-group ambiguity
   read only = no
   browseable = no
   # mask-deterministic model ONLY (resolves inherit-permissions/acls contradiction):
   create mask = 0600
   directory mask = 2700
   force create mode = 0600
   force directory mode = 2700
   # external NFS writers exist -> disable all oplocks/leases (resolves dual-writer coherence)
   oplocks = no
   level2 oplocks = no
   kernel oplocks = no
   veto files = /.DS_Store/._*/

[shared]
   path = /mnt/sisplockers/_shared
   valid users = @sisp
   read only = no
   force group = sisp
   create mask = 0660
   directory mask = 2770
   force create mode = 0660
   force directory mode = 2770
   oplocks = no
   level2 oplocks = no
   kernel oplocks = no
```

- **`valid users = %U` on `[locker]`** means each user only ever sees and traverses their own folder — genuine isolation, and it removes the open question of whether Samba honors a *primary*-group `@sisp` (it consults the supplementary member list; `%U` avoids depending on that). Pilot still verifies one user end-to-end.
- **No `inherit permissions` / `inherit acls`.** Behavior is fully determined by `create/directory mask` + `force ... mode` (resolves the contradiction). On `_shared`, default POSIX ACLs (set once with `setfacl -d`) plus `acl_xattr` are used **only if** the xattr pre-flight passed.
- **All oplocks/leases off** on shares with external NFS writers, and job output lives in the separate `workspaces` subtree treated as read-after-completion, so a desktop-open file and an in-progress job write can't silently diverge.

### 8. SMB credential enrollment (honest, header-trust-aware)

`config.js` shows AppHub trusts `x-remote-user` from nginx and **never sees the cleartext LDAP password** — so `pam_smbpass` in the Node app is impossible (resolves the unworkable-mitigation issue). NT-hash capture is moved to where cleartext actually exists:

1. **At the LDAP-bind point.** If front-door auth is nginx `auth_request` against a PAM/login form that performs the LDAP *bind* with the user's cleartext password, install `pam_smbpass.so` in **that** PAM stack with `ldap passwd sync = yes`. The first portal sign-in transparently writes `sambaNTPassword` next to the user's `userPassword`. No mass reset.
2. **If the front door is header-trust/SSO only** (no cleartext anywhere the gateway controls), there is **no transparent path** — state it plainly. Ship a **self-service SMB enrollment** page in mapdrive: the user authenticates, sets/confirms an SMB password once (`smbpasswd`-style write to LDAP via the admin DN over LDAPS), and a 55-user rollout is budgeted as an explicit, communicated enrollment campaign with an admin "set SMB password" fallback for drive-only users. This is the realistic cost; the design does not pretend it away.

The deterministic `sambaSID` assignment is unchanged and idempotent: one domain SID via `net getlocalsid` stored as `sambaDomainName=SISP`; per user `sambaSID = <domainSID>-<2*uidNumber+1000>`; script iterates `uidNumber 10000..10054`, adding `objectClass: sambaSamAccount`.

### 9. TLS prerequisite gate (hard, sequenced first)

Because `sambaNTPassword` is a replayable password equivalent, **LDAPS/StartTLS precedes Samba enablement**:
1. Issue the internal CA + slapd cert; enable LDAPS on node1:636 and StartTLS on 389.
2. Bind slapd cleartext (389 without TLS) to `127.0.0.1` only; all node-to-node LDAP uses 636.
3. SSSD (`ldaps://...:636`, `tls_reqcert=demand`) and `smb.conf` (`ldap ssl = start tls`) verify certs.
4. **Verification gate:** `tcpdump -i any port 389 or port 636` during a login proves no `sambaNTPassword`/`userPassword` crosses the wire in clear. Only then load the Samba schema and bring up smbd. (Resolves the plaintext-389 issue.)

### 10. Provisioning, remediation, and squash policy

**Squash policy (resolves the chown-impossible issue):** `chown`/`install -d -o <uid>` to arbitrary uids requires `CAP_CHOWN` un-squashed. Therefore **all provisioning and remediation run on the gateway node only**, against the **`no_root_squash` export scoped to that node by the NAS export ACL + firewall**. node1/node3/node4 keep `root_squash` (they never chown). The pilot validates `install -d -o 10012` actually succeeds before anything relies on it; if the NAS forbids `no_root_squash` entirely, provisioning falls back to a NAS-side script invoked over the NAS admin API (documented alternative).

`runtime/wrappers/apphub-provision-workspace.sh <username>` (idempotent, runs on gateway as root via sudoers, **uid≥10000 guard** refuses legacy/system range):

```bash
user="$1"; case "$user" in ""|*[!a-zA-Z0-9_.-]*) exit 65;; esac
entry="$(getent passwd "$user")" || exit 67
uid="$(cut -d: -f3 <<<"$entry")"; [ "$uid" -ge 10000 ] || exit 68
ws="/mnt/sisplockers/apphub/workspaces/$user"
install -d -o "$uid" -g 100000 -m 2700 "$ws"      # owner-only; mode 2700 keeps it private
```
sudoers: `apphub ALL=(root) NOPASSWD: /opt/sisp-apphub/runtime/wrappers/apphub-provision-workspace.sh *`.

**Reconciler/crash correctness (resolves the half-owned-state item):** `launchApp()` calls provision **before** `buildWorkspacePath()`/submit. The wrapper is idempotent (`install -d` is a no-op if the dir already exists at the right owner/mode), so: provision-then-submit-fails leaves a harmless empty workspace; reconciler re-running provision after a crash re-converges ownership; there is no partial-chown window because each `install -d` either creates the dir fully-owned or leaves an already-correct dir untouched. Provision is also re-asserted on persistence-approval.

**One-time remediation of the 6 broken folders** (gateway, human-confirmed, dry-run first, idempotent) — explicit mapping from `nas_acl_audit_needed.json`:

```bash
declare -A FIX=( [dianap]=10012 [monthiras]=10027 [punyapornn]=10036
                 [sarunt]=10004 [supawanj]=10026 [thanaphonl]=10032 )
for u in "${!FIX[@]}"; do
  d="/mnt/sisplockers/$u"; [ -d "$d" ] || continue
  echo "FIX $u : $(stat -c '%u:%g' "$d") -> ${FIX[$u]}:100000"
  [ "$DRYRUN" = 1 ] && continue
  chown -R "${FIX[$u]}:100000" "$d"
  find "$d" -type d -exec chmod 2700 {} +           # private, not 2770
  find "$d" -type f -exec chmod 0600 {} +
done
```
Followed by a **whole-share drift audit**: `find /mnt/sisplockers -xdev \( -uid -10000 -o ! -gid 100000 \) -printf '%u:%g %p\n'` → CSV surfaced in AppHub admin, re-run weekly by `check-storage-node1.py`.

### 11. AppHub workspace / home / scratch (resolves SQLite-on-NFS and subid collision)

- **Do NOT relocate HOME to NFS.** The original `homeBase → /mnt/sisplockers/apphub/home` change is **reverted** — Jupyter's SQLite state (`~/.local/share/jupyter`) over NFS reintroduces "database is locked" hangs (problem B). Instead, templates set `JUPYTER_RUNTIME_DIR`, `JUPYTER_DATA_DIR`, and SQLite/cache dirs onto **node-local `/scratch/$SLURM_JOB_ID`** (epilog-cleaned), and bind **only user content** under the NFS workspace (`{workspace} -> /workspace`). RStudio's existing `/workspace/.rstudio` redirect stays. `homeBase` remains local.
- **Heavy-I/O scratch:** `--bind /scratch/$SLURM_JOB_ID:/scratch` on node-local disk for temp churn so concurrent jupyter/rstudio/galaxy don't hammer NFS.
- **subuid/subgid collision (resolves the gid-100000 footgun):** confirm Apptainer exec mode. The scaffold's `sbatch --uid/--gid` path implies setuid-Apptainer (not rootless userns). If any template uses userns, set `/etc/subuid` and `/etc/subgid` bases to **500000** (well clear of 100000) cluster-wide, and add a smoke assertion that a file written in `/workspace` reads back on the host as the real uid and gid `100000`, not a remapped value.
- **Bind ownership** is otherwise unchanged: job runs as `--uid/--gid`, Apptainer preserves host uid in `--bind`, so `/workspace` files are owned by the real LDAP uid on the NAS and visible verbatim from the user's locker share.

### 12. Client retargeting and `/api/drives`

DNS: `files.sisp.com` is **internal-only** `A 192.168.0.26`. `windows-app/SISPDriveMapper.ps1`: `$NasServer = 'files.sisp.com'`; shares collapse to `\\files.sisp.com\locker` (the per-user `%U` share) and `\\files.sisp.com\shared`; `$DefaultLoginFormat` → bare `username` (no `SIRIRAJ\`); run stale-cleanup (`cmdkey /delete`, `net use /delete`) for **both** `192.168.0.103` and `files.sisp.com` on every launch; default persistence **off** on shared lab PCs with a logoff scheduled task `net use /delete`; ship `Set-SmbClientConfiguration -RequireSecuritySignature $true`. macOS: `smb://<user>@files.sisp.com/locker`.

`/api/drives` replaces the hardcoded `\\192.168.0.103` strings and the `sambaGateway:{status:"planned"}` block:
```json
{ "windowsPath": "\\\\files.sisp.com\\locker",
  "macPath": "smb://files.sisp.com/locker",
  "linuxPath": "/mnt/sisplockers",
  "login": "your LDAP username (no SIRIRAJ\\ prefix)",
  "gateway": { "status": "live", "host": "files.sisp.com",
               "ownership": "Files save as your cluster user; only you can read your locker." } }
```

### 13. Monitoring (beyond a sentinel stat)

`check-storage-node1.py` asserts, on every run: (a) mountpoint present; (b) **owner==expected-uid** on a per-user sentinel (catches idmap→`nobody`); (c) `user.*` xattr round-trip survives (catches silent xattr loss); (d) NFS RPC timeout/retrans counters under threshold (`/proc/net/rpc/nfs`); (e) smbd session count under cap; (f) the whole-share drift audit (§10). Failures page before users notice.

### 14. Interfaces to other subsystems

- **Identity/LDAP subsystem:** depends on LDAPS:636, the Samba schema extension, `sambaSamAccount`/`sambaSID` provisioning, and the syncrepl consumer. TLS gate (§9) is owned jointly.
- **AppHub orchestration:** consumes `apphub-provision-workspace.sh`, the unchanged `apphub-sbatch-as-user.sh`, `workspaceBase`, and the `/api/drives` payload; provides the Apptainer `--no-privs`/`no_new_privs` hardening contract (§3).
- **Networking/DNS/firewall:** internal-only `files.sisp.com`, WAN drop on 445, NAS-export source-IP firewall to `192.168.0.25-28`.
- **Persistent nodeadmin apps (zulip, leantime, vitessce, dmmr, cmssight):** if any read/write NAS storage, they get a **service account** with explicit ACLs on a dedicated `_shared/<app>` subtree (never per-user lockers), and inherit the no-oplock coherence rules; an inventory of their storage use is an open item (§ openQuestions).

### 15. Cutover sequence (human-gated at every node touch)

1. **TLS first:** enable LDAPS/StartTLS; verify via tcpdump (§9). Stand up SSSD over 636 on all nodes; verify `getent passwd dianap → 10012` everywhere.
2. Stand up the local syncrepl consumer on the gateway node.
3. Mount NFS **read-only** on the gateway; run xattr pre-flight (§7) and the idmap stat-gate (§3); run drift audit + remediation **dry-run**.
4. **Quiesce direct NAS access** (announce window; set the NAS `sisplockers` share read-only so no client writes during remediation — this also resolves the rollback/remediation conflict: there is no concurrent direct write while chown runs). Remount the `no_root_squash` export rw on the gateway; apply remediation; validate `install -d -o 10012` succeeds.
5. Mount rw on node3/node4 (`root_squash`); run a job on node3 writing `/workspace`, assert `stat` uid == real uid (extend `real-slurm-smoke-node1.py`).
6. Load Samba schema + `sambaSID`; bring up smbd; enroll one pilot user's SMB password (§8); end-to-end test: desktop write → `stat` on gateway shows their uid, `0600`, invisible to a second pilot user.
7. Ship retargeted clients to the pilot group; keep the NAS direct path **read-only** as rollback (consistent with step 4 — no writes there).
8. Flip `/api/drives` to `gateway.status=live`; broadcast; **firewall direct client→NAS 445** once adoption is confirmed; lift the NAS read-only freeze for the gateway path only.

**Dependencies:** identity-ldap: LDAPS:636 + internal CA, Samba schema extension, sambaSamAccount/sambaSID provisioning, local syncrepl consumer on the gateway node, apphub-orchestration: apphub-provision-workspace.sh wrapper + sudoers, unchanged apphub-sbatch-as-user.sh, workspaceBase/homeBase config, /api/drives payload, Apptainer --no-privs/no_new_privs hardening contract, networking-dns-firewall: internal-only files.sisp.com A record, WAN drop on TCP 445, NAS-export source-IP firewall (192.168.0.25-28), no_root_squash export scoped to the gateway node, slurm-scheduling: core/RAM reservation carving out the gateway smbd slice; epilog cleanup of /scratch/$SLURM_JOB_ID, client-tooling: retargeted SISPDriveMapper.ps1 / .command, Set-SmbClientConfiguration signing, logoff net-use cleanup task, auth-front-door: confirmation of where cleartext LDAP bind occurs (nginx auth_request / PAM form vs header-trust SSO) to place pam_smbpass or the enrollment flow

**Open questions:** 
- Does the Infortrend NAS license NFSv3, or NFSv4 only? And does it support per-host no_root_squash export rules and sec=krb5? These determine the backhaul and provisioning path.
- Where is the cleartext LDAP password actually validated at the front door — an nginx auth_request/PAM login form (transparent pam_smbpass possible) or header-trust SSO only (explicit enrollment required)?
- Will the NFS export survive a setfattr/getfattr user.* xattr round-trip? Determines whether the full or reduced macOS/ACL vfs stack ships.
- Is the gateway-on-node2 placement acceptable given node2 is also a SLURM compute node, or should a different host/role own it? Confirm the core reservation budget.
- Do any nodeadmin persistent apps (zulip, leantime, vitessce, dmmr, cmssight) read or write \\192.168.0.103\sisplockers today? If so, which paths, so they can be migrated to a service-account _shared subtree.
- Confirm Apptainer's exec mode cluster-wide (setuid vs rootless userns) so the /etc/subuid /etc/subgid base relocation (clear of 100000) is applied only where needed.
- Are existing NAS per-uid quotas defined, and should the gateway surface quota usage to users in AppHub?
- What is the acceptable maintenance-window length for the quiesce-and-remediate step (step 4), given 55 users and the read-only freeze on direct NAS writes?


---

<a id="slurm-orchestration"></a>

## Compute Orchestration & SLURM Job Model

### Purpose
Run every interactive research web app (JupyterLab, RStudio, scRNA-seq notebooks, Streamlit/Shiny/Dash/Gradio, planemo tool-dev) as a SLURM batch job whose payload is a long-lived HTTP server, scheduled across node2–4, while node1 stays reserved for the control plane and persistent vhosts. The job model is built for a non-technical wet-lab audience: no 502s on launch, no silent wall-clock kills, no idle hoarding, honest queue feedback — and, critically, **no path by which one researcher can reach another researcher's session or data**. Every node-touching admin action is a previewed, human-confirmed command; only two operations run autonomously and bounded: per-app submit/cancel through a single validated wrapper, and first-login base-association provisioning.

This revision resolves all twelve review issues (3 critical, 5 high, 3 medium, 1 low) and the eight MISSING items. The most consequential change is the **security model for the payload listener** (issues 1 + 3 + MISSING WebSocket/cold-start), since the open `0.0.0.0`, auth-disabled listeners confirmed in `runtime/templates.json` defeated the entire LDAP/uid rebuild.

---

### 0. Cluster capacity model (verify with `scontrol show node`)
112 CPU / 512 GB over node1..4 ≈ **28 CPU / 128 GB per node**. node1 (192.168.0.25) runs the control plane (OpenLDAP, nginx, Postgres, slurmctld, slurmdbd, AppHub) AND the persistent non-SLURM apps (cmssight, dmmr, leantime, zulip, vitessce, and the real Galaxy). node1 is therefore **not** an interactive workhorse. node2/3/4 (.26/.27/.28) carry interactive load: **84 CPU / ~375 GB schedulable**.

**Honest concurrency ceiling (stated, not hidden).** Memory is the binding constraint, not CPU. With ~375 GB schedulable and heavy single-cell sessions, the cluster supports **roughly 6–10 concurrent heavy (32–96 GB) sessions** before queueing, alongside many light (2–8 GB) sessions. This is communicated to admins in the cluster-health view and to users via the queue UI; the design lowers heavy defaults and pins large jobs whole-node (§7) so we do not re-create the memory-thrash hang the rebuild exists to fix.

Node→IP map (shared with Networking): `node1=192.168.0.25 node2=.26 node3=.27 node4=.28`. The reconciler uses this to turn a SLURM `%N` hostname into a tunnel endpoint (§3a).

---

### 1. SLURM cluster config (`/etc/slurm/slurm.conf`)
```
ClusterName=sisp
SlurmctldHost=node1(192.168.0.25)
SelectType=select/cons_tres
SelectTypeParameters=CR_Core_Memory,CR_LLN        # CR_LLN = least-loaded-node => spread, not pack (issue 9)
SchedulerType=sched/backfill
SchedulerParameters=bf_continue,bf_max_job_test=200,default_queue_depth=200
PriorityType=priority/multifactor
PriorityWeightFairshare=100000
PriorityWeightQOS=10000
PriorityWeightAge=1000
AccountingStorageType=accounting_storage/slurmdbd
AccountingStorageEnforce=associations,limits,qos
GresTypes=                                        # no GPUs in this cluster
Prolog=/opt/sisp-apphub/runtime/slurm/prolog.sh
Epilog=/opt/sisp-apphub/runtime/slurm/epilog.sh

# node1: leave headroom only (see §6 for the REAL control-plane protection via cgroups)
NodeName=node1 NodeAddr=192.168.0.25 CPUs=28 RealMemory=128000 CoreSpecCount=12 MemSpecLimit=49152 Weight=100
NodeName=node2 NodeAddr=192.168.0.26 CPUs=28 RealMemory=128000 Weight=10
NodeName=node3 NodeAddr=192.168.0.27 CPUs=28 RealMemory=128000 Weight=10
NodeName=node4 NodeAddr=192.168.0.28 CPUs=28 RealMemory=128000 Weight=10

# Default interactive partition — node2-4 only, least-loaded spread, FINITE default wall
PartitionName=inter Nodes=node2,node3,node4 Default=YES LLN=YES \
  DefaultTime=08:00:00 MaxTime=24:00:00 State=UP PriorityTier=100 OverSubscribe=NO
# Truly-unlimited / always-on user vhosts (admin-approved) — MaxTime=UNLIMITED so QOS MaxWall=-1 is effective
PartitionName=persistent Nodes=node2,node3,node4 LLN=YES MaxTime=UNLIMITED State=UP PriorityTier=200 OverSubscribe=NO
# Standing small/fast lane reservation lives inside `inter` (see §2 reservation), not a separate partition.
```
**Changes from the original and why:**
- **`burst` partition DROPPED (issue 10).** It scheduled user jobs onto node1 (the control plane), its preemption was non-functional (no `Preempt=` relationships, no shared nodes), and a 4h burst job could pin node1's cores regardless of demand. No user job ever runs on node1.
- **`CR_LLN` added (issue 9).** Default cons_tres packs the lowest-index node; LLN spreads interactive sessions across node2–4. Verify placement under load with `squeue -o "%N %C %m"`.
- **`inter` gets `DefaultTime=08:00:00` and keeps `MaxTime=24:00:00` (issue 4).** Truly-unlimited apps are routed to `persistent` (MaxTime=UNLIMITED), because **partition MaxTime overrides QOS MaxWall** — `qos_unlimited` on `inter` would still TIMEOUT at 24h. Effective wall = `min(partition MaxTime, QOS MaxWall, --time)`; verify with `scontrol show partition`.
- **CoreSpec/MemSpec on node1 is reframed as "prevent over-allocation / leave headroom" only — it is NOT control-plane protection** (issue 6, see §6).

---

### 2. QOS, fair-share, and the small-lane reservation (`sacctmgr`)
QOS is the **authoritative** wall; AppHub pre-flight checks are friendly early fences (§8).

| QOS | MaxWall | MaxTRES/user | MaxJobs/user | Partition | Granted to |
|---|---|---|---|---|---|
| `qos_interactive` (default) | 08:00:00 | cpu=16,mem=64G | 2 | inter | every LDAP user (auto, first login) |
| `qos_long` | 24:00:00 | cpu=24,mem=96G | 1 | inter | every user (self-serve) |
| `qos_unlimited` | UNLIMITED | cpu=16,mem=64G | 1 | **persistent** | approved users |
| `qos_persistent` | UNLIMITED | cpu=8,mem=32G | 2 | persistent | admin-approved vhosts |

```
sacctmgr -i add qos qos_interactive set MaxWall=08:00:00 MaxTRESPerUser=cpu=16,mem=64G MaxJobsPerUser=2 Priority=100
sacctmgr -i add qos qos_long        set MaxWall=24:00:00 MaxTRESPerUser=cpu=24,mem=96G MaxJobsPerUser=1 Priority=80
sacctmgr -i add qos qos_unlimited   set MaxWall=-1       MaxTRESPerUser=cpu=16,mem=64G MaxJobsPerUser=1 Priority=120
sacctmgr -i add qos qos_persistent  set MaxWall=-1       MaxTRESPerUser=cpu=8,mem=32G  MaxJobsPerUser=2 Priority=200
sacctmgr -i add account sisp Description="SISP wet-lab" Fairshare=parent
```
`qos_unlimited`/`qos_persistent` are deliberately bound to the `persistent` partition (issue 4). The `burst` QOS is removed with its partition.

**Guaranteed-fast "small" lane (issue 2).** A standing SLURM reservation pins a slice of one node for light sessions so a researcher opening a 4 GB notebook is never stuck behind heavy single-cell jobs:
```
scontrol create reservation ReservationName=smalllane Nodes=node4 \
  StartTime=now Duration=UNLIMITED Flags=ANY_NODES,FLEX \
  PartitionName=inter Users=-root TRES=cpu=12,mem=48G
```
Light templates (≤8 GB) submit with `--reservation=smalllane`; heavy templates do not. Tune the slice from observed light-session demand.

**Fair-share** is flat (one share per user under `sisp`); add a per-lab account tier later if a PI hogs the cluster.

---

### 3. The hard part: a long-running, **isolated, authenticated** web service on a batch scheduler

The scaffold's shape (sbatch payload + status publication + reconciler + nginx route map) is kept. We harden the **five** places it breaks, the first of which is a critical security hole.

#### 3a. Payload isolation & authentication (issue 1 — CRITICAL — the open listener)
Confirmed in `runtime/templates.json`: Jupyter `--ip=0.0.0.0 --ServerApp.token=` (empty), RStudio `--www-address=0.0.0.0 --auth-none=1`, and Streamlit/Shiny/Dash/Gradio/planemo all bind `0.0.0.0`. On a shared cluster any co-scheduled user can `srun`/ssh to the allocated node and reach `node:31xxx`, landing in the victim's session as the victim's uid with full NAS read/write. **nginx + LDAP is not an auth gate when the listener is reachable directly.** Three defenses, all required (defense in depth):

1. **Bind to loopback only.** Every template is rewritten to bind `127.0.0.1:{port}` inside the job's container/network namespace — never `0.0.0.0`. A co-tenant on the same node cannot reach another job's loopback.
2. **Reach it only via an authenticated tunnel from node1.** Because nginx runs on node1 and the payload listens on a compute-node loopback, the reconciler establishes a per-job **SSH local-forward** from node1 to the compute node, owned by the `apphub` account:
   `ssh -N -L 127.0.0.1:<proxyPort>@node1 -> 127.0.0.1:<port>@<computeNode>`.
   nginx's upstream for `slug-owner.sisp.com` points at `127.0.0.1:<proxyPort>` on node1. The **only** network path to a session is node1→tunnel→loopback; nothing is exposed on the LAN.
3. **Per-job secret + host firewall (belt and suspenders).** The runner injects a per-job secret into the payload — Jupyter `--ServerApp.token=$APPHUB_JOB_TOKEN`, RStudio PAM one-time secret instead of `--auth-none` — and the nginx route presents it, so even a hypothetical direct hit fails auth. `nftables`/`firewalld` on node2–4 default-denies inbound `31000–31999` from `192.168.0.0/24`, allowing only node1's address (and loopback). Where available, `job_container/tmpfs` + a per-job network namespace removes peer reachability entirely.

This makes the LDAP/uid rebuild meaningful: a session is reachable only through the identity-checked nginx front door.

#### 3b. Readiness race → no more launch 502s
New status `pending-route`: when `squeue=RUNNING` and the loopback port answers, the reconciler probes `GET http://127.0.0.1:<proxyPort><healthPath>` (template field, default `/`). Only on 200/3xx does it upsert the nginx route + flip to `running`. Until then the UI shows "Starting…". A `bootBudgetSeconds` (template, default 120) bounds it; exceeding it → `failed` with a logs link.

#### 3c. Wall-clock kills → graceful save + in-place extend
- **Graceful pre-kill that actually works (issue 11).** `#SBATCH --signal=B:TERM@120` warns 120 s before SIGKILL. The original `exec runner.sh -> exec run_manifest.py` chain delivered SIGTERM to a Python process with **no handler** (confirmed in `apphub-runner.sh:16` and `run_manifest.py` — no trap/atexit), so nothing reached the container. Fixed: `run_manifest.py` installs a SIGTERM handler that forwards SIGTERM to the `apptainer` child and `wait()`s up to the grace window, so RStudio/Jupyter autosave. `apphub-runner.sh` no longer `exec`-replaces the handler-holder. Verified by the smoke test (§10): submit → `scancel --signal=TERM` with grace → assert autosave file written.
- **`expiring` status + Extend.** Reconciler computes `EndTime - now` from `scontrol`; < 15 min and not persistent → `expiring`, amber banner + **Extend** button. `POST /api/apps/{id}/extend` → if QOS headroom allows, the privileged reconciler (§6) runs `scontrol update jobid=<id> TimeLimit=+120`; the HTTP server keeps running, only the clock moves.
- **Active-job auto-extend (MISSING #8).** The 8h default is a hard cliff for a job that is *busy but not idle*. When the activity probe (§3d) reports a **busy** kernel/session and the user's QOS has wall headroom, the reconciler auto-issues the `+TimeLimit` extension and notifies the user, rather than letting an actively-computing analysis TIMEOUT. Extension stops at the QOS MaxWall; near that ceiling the user is told to move to `qos_long`/`qos_unlimited`.
- **Truly-unlimited option** maps to `qos_unlimited`/`qos_persistent` **on the `persistent` partition** and omits `#SBATCH --time` (issue 4). Gated by the approval workflow.

#### 3d. Idle sessions → cull on **app-level** activity, never on proxy logs (issue 5)
The original signal (nginx access-log timestamps) is wrong: JupyterLab/RStudio hold one long-lived WebSocket, so a 3-hour scanpy/Seurat run produces **no new access-log lines** and would be wrongly `scancel`led mid-computation. Corrected signal hierarchy:
- **Jupyter:** poll `GET /api/status` → never cull if any kernel `execution_state == "busy"`; use `last_activity` for idleness.
- **RStudio:** poll the session-active endpoint; treat an executing R session as busy.
- **Generic apps:** the runner samples container CPU (`apptainer`/cgroup `cpu.stat`) and active WS/byte-transfer; nonzero compute or live WS ⇒ not idle.
- Access-log time is used only as a **coarse floor**, and only when "no active WS / kernel idle" already holds.

When genuinely idle past `template.idleTimeoutMinutes` (default 60; 0 = never for persistent): status→`stopped`, `scancel`, tunnel torn down, route removed, port freed, friendly message ("paused after 60 min idle — relaunch to resume; your files are saved on MapDrive"). This is the single biggest utilization lever for a tab-never-closing audience.

#### 3e. Queue waits → honest UI
Small defaults (most templates 2 CPU / 4–8 GB), backfill, the small-lane reservation, and queue position from `squeue --start` (`%S`): "3rd in line, ~2 min" instead of a frozen spinner. The UI also states the concurrency reality ("heavy single-cell jobs may queue") so expectations match capacity (issue 2).

---

### 4. Job lifecycle (AppHub status ↔ SLURM state)
| AppHub status | Trigger | SLURM | Frontend |
|---|---|---|---|
| `queued` | sbatch returned jobid | PENDING | "In queue (pos N, ~Xm)" |
| `starting` | RUNNING, container booting, probe not green | RUNNING | skeleton |
| `pending-route` | loopback port answers, awaiting HTTP 200 + tunnel up | RUNNING | "Almost ready…" |
| `running` | probe green + tunnel + nginx route active | RUNNING | green dot + Open |
| `expiring` | EndTime−now < 15 min, not persistent | RUNNING | amber + Extend |
| `stopped` | user stop / idle-cull / expiry / extend denied | CANCELLED/TIMEOUT | grey + relaunch |
| `failed` | exit≠0, FAILED/NODE_FAIL/OOM, probe never green within boot budget | FAILED/OOM | red + logs |

**Cleanup (terminal):** tear down SSH tunnel, remove nginx route + reload (Networking), free port to the 31000–31999 pool via the atomic allocator (§5), write `stoppedAt`/`lastError`, retain workspace/home on NAS, prune node-local scratch. A SLURM **Epilog** kills any orphaned `apptainer instance` tagged `apphub:<appId>` and clears `$TMPDIR`, so a crashed reconciler cannot leak compute or tunnels (the tunnel dies with its `ssh` parent on node1; the reconciler reaps survivors on cold start, §5).

---

### 5. Submission flow, status transport, port allocation, cold-start

**Script staging — TOCTOU-safe (issue 3, CRITICAL).** The original mixed two needs in one dir: apphub writes `job.sh` and the user job writes `status.json` into the same `appJobRoot` (scaffold `02775`, setgid, group-writable, no sticky). Because every user shares `gid=100000`, any user could `unlink` a peer's `job.sh` and drop a replacement before `sbatch --uid` read it → code execution as the victim. Fixed by separating the two:
- `job.sh` lives under `/opt/sisp-apphub/jobscripts/<appId>/` — **apphub-owned `0700`, NOT group-writable, not on the shared NAS tree**. Users cannot create, unlink, or replace anything there. `sbatch` reads from here.
- The job **does not write a shared `status.json`.** The runner **POSTs status back** to AppHub over the node1 loopback control API (`POST http://127.0.0.1:<ctrlPort>/internal/jobs/<appId>/status` with the per-job token), eliminating the shared-file write entirely. Where a file is still convenient, it is written under the job user's **own** `0700` scratch, never a shared group dir.

This keeps the wrapper's uid asserts meaningful and removes the cross-user replace path.

**Generated `#SBATCH` block** (AppHub embeds directives; wrapper surface stays tiny):
```
#SBATCH --partition=<template.partition|inter>
#SBATCH --qos=<resolved from time choice + grant>
#SBATCH --signal=B:TERM@120
#SBATCH --comment=apphub:<appId>          # job<->app mapping for epilog, control-wrapper auth, cold-start
#SBATCH --open-mode=append
#SBATCH [--reservation=smalllane]         # light templates only
#SBATCH [--exclusive | --mem=<wholeNode>] # heavy templates, see §7
# --time omitted only for persistent-partition unlimited jobs
```
Body: write loopback token env → POST `state:starting` → `exec apphub-runner.sh manifest.json` → `run_manifest.py` (now with SIGTERM handler) → `apptainer exec` binding `{workspace}`/`{home}`, with the template command bound to `127.0.0.1:{port}`. Runner sets `TMPDIR=/scratch/$SLURM_JOB_ID` (node-local, Prolog-created) so heavy scRNA-seq temp I/O stays off the network (MISSING storage, §11).

**Port allocation atomicity (MISSING #4).** Ports 31000–31999 are issued by a Postgres allocator with a `UNIQUE(port) WHERE state='allocated'` constraint inside the same transaction that creates the app row (or a `pg_advisory_xact_lock`), so two concurrent `POST /api/apps` can never collide. Ports are reclaimed on terminal state and on reconciler cold-start sweep.

**Reconciler cold-start reconstruction (MISSING #3).** On AppHub/node1 restart the reconciler rebuilds truth from three sources and reconciles: (1) `squeue -O comment,jobid,state` filtered to `apphub:*` for live jobs; (2) Postgres app rows for intended state and port leases; (3) last reported status via the loopback API. It then: re-establishes SSH tunnels for `running` jobs, re-asserts nginx routes (and **reaps stale routes** whose jobs are gone), frees ports for dead jobs, and marks jobs missing from `squeue` as `stopped`/`failed`. The nginx route-map is treated as derived state, never authoritative.

---

### 6. The sudo/privilege boundary (issue 7 — do NOT give the web tier Operator)
Granting the **internet-facing** `apphub` web process `AdminLevel=Operator` would let a compromise of `apphub.sisp.com` `scancel`/retime/hold **every** user's jobs cluster-wide — a larger blast radius, not smaller. Corrected split:

- **Web tier (public, `apphub.sisp.com`): no SLURM privilege at all.** It only writes intents to Postgres and calls the local control daemon.
- **Control/reconciler daemon (separate systemd unit, bound to node1 loopback, NOT internet-facing):** owns all SLURM mutations. Control ops go through a **tightly-scoped privileged wrapper** `apphub-jobctl.sh {cancel|hold|extend} <appId> <requesting_user>` that:
  1. resolves the SLURM job by `--comment=apphub:<appId>`,
  2. asserts the job's owner == the requesting user (or an admin), refusing otherwise,
  3. only then runs `scancel` / `scontrol update TimeLimit` / `scontrol hold` for that one job.
  No blanket Operator; the daemon can only ever touch `apphub:`-tagged jobs it owns the mapping for.
- **Submit is the one verb that runs as the user.** `apphub-sbatch-as-user.sh submit <owner> <script>` resolves uid/gid via `getent` (LDAP/NSS), **asserts `uid >= 10000` and `gid == 100000` and refuses otherwise** (neutralizes the 6 legacy-mis-owned NAS folders, uid 1005–1017), validates `target_user` charset, and validates the script path is under the apphub-owned `0700` jobscripts root via `readlink -f`.
- **sudoers (node1):** `apphub ALL=(root) NOPASSWD: /opt/sisp-apphub/runtime/wrappers/apphub-sbatch-as-user.sh submit *`, the scoped `apphub-jobctl.sh *`, and the nginx-reload validator — nothing else.

**Control-plane protection is cgroups, not CoreSpec (issue 6).** `CoreSpecCount`/`MemSpecLimit` only stop SLURM from *over-allocating* node1; they do **not** pin nginx/Postgres/LDAP/slurmctld/slurmdbd or the persistent apps onto those cores, and do not cap the persistent apps' RAM. Real enforcement is added in systemd:
- control-plane units (`nginx`, `postgresql`, `slapd`, `slurmctld`, `slurmdbd`, `apphub`) get `CPUAffinity=` to the spec cores and `MemoryMin=`/`MemoryHigh=` reservations;
- persistent apps (cmssight, dmmr, leantime, zulip, vitessce, Galaxy) get `MemoryHigh`/`MemoryMax` caps so a zulip/Galaxy spike cannot OOM node1.
`MemSpecLimit` is sized from measured RSS but understood as a SLURM-side headroom number only.

**Live-cluster guardrail.** Every node-touching admin action (slurm.conf change, sacctmgr QOS/limit edit, reservation change, image prewarm, manual `scancel` of someone else's job) is surfaced as a previewed command requiring human confirmation. The only autonomous SLURM calls are (a) per-app submit/cancel/extend through the validated wrappers, bounded by QOS, and (b) first-login base-association add (§ below).

**User provisioning — no cron, no lockout (issue 8).** The original "cron every 15 min AND human-confirmed" was self-contradictory, and `enforce=associations` hard-blocks a brand-new LDAP user from launching anything. Resolved:
- **Auto-provision on first login** (event-driven, not cron): when an authenticated LDAP user with no SLURM association launches their first app, the control daemon adds the *base* association autonomously — bounded and safe:
  `sacctmgr -i add user <u> account=sisp defaultqos=qos_interactive qos=qos_interactive,qos_long fairshare=1`.
- **QOS limit *changes* (granting `qos_unlimited`/`qos_persistent`, raising caps) stay human-confirmed** via a previewed diff in the admin UI.
- LDAP bind **never passes the password as `-w` on the command line** (visible in `ps`); credentials come from a `0600` env file / `-y` cred file read by the daemon.

---

### 7. Templates (extend the schema; right-size for memory; isolate Galaxy)
New template fields: `partition`, `qos`, `idleTimeoutMinutes`, `healthPath`, `bootBudgetSeconds`, `bindHost` (always `127.0.0.1`), `wholeNode` (bool), `activityProbe` (`jupyter`|`rstudio`|`cpu`). All templates rewritten to **bind loopback + per-job secret** (§3a).

Heavy single-cell templates default **smaller, with explicit opt-up**, and pin **whole-node** when large to avoid memory thrash (issue 2):

`runtime/definitions/rstudio-seurat.def` → `rstudio-seurat.sif` (RStudio + Seurat, SingleCellExperiment, Bioconductor, harmony, presto):
```json
{ "id":"rstudio-seurat","name":"RStudio — Seurat (scRNA-seq)","category":"Single-cell",
  "image":"rstudio-seurat.sif","partition":"inter","qos":"qos_long",
  "defaultCpus":4,"defaultMemoryMb":32768,"defaultTimeMinutes":480,
  "maxCpus":24,"maxMemoryMb":98304,"maxTimeMinutes":1440,
  "wholeNode":true,"idleTimeoutMinutes":90,"activityProbe":"rstudio",
  "healthPath":"/auth-sign-in","bootBudgetSeconds":120,"bindHost":"127.0.0.1",
  "command":["bash","-lc","rserver --www-address=127.0.0.1 --www-port={port} --auth-pam-helper-path=... (PAM one-time secret, NOT --auth-none) ..."],
  "volumes":[{"source":"{workspace}","target":"/workspace","mode":"rw"},
             {"source":"{home}","target":"/home/{user}","mode":"rw"}],
  "enabled":true }
```
`runtime/definitions/jupyter-scrnaseq.def` → `jupyter-scrnaseq.sif` (scanpy, anndata, leidenalg, igraph), default **4 CPU / 32 GB** (opt-up to 96 GB), `qos_long`, `idleTimeout 90`, `activityProbe:"jupyter"`, `healthPath:/api`, `--ip=127.0.0.1 --ServerApp.token=$APPHUB_JOB_TOKEN`. When a user opts a heavy session above ~64 GB, `wholeNode` adds `--exclusive` so a 96 GB job does not share a 125 GB node and thrash a co-tenant.

**scvi-tools scoped OUT (MISSING #6).** No GPU exists; scVI training on CPU is impractically slow and would set false expectations. It is excluded from the default scRNA-seq image; if requested it ships in a clearly-labeled "CPU-only, slow" optional image, not the headline template.

**Galaxy is NOT an interactive job (issue 12).** The real multiuser Galaxy is a persistent multi-process app (web + handlers + its own DB) that itself submits to SLURM; idle-culling it would corrupt histories and nest schedulers. Galaxy is modeled as a **persistent service on node1** alongside the nodeadmin apps (§9), never idle-culled. Only lightweight **planemo tool-dev sandboxes** live in the interactive lane.

**Image pipeline.** Build `.sif` to `imageRoot` on NAS, then **sync to node-local** `/opt/apphub/images` on node2–4 and prewarm page cache via `srun ... apptainer exec` so a 30+ GB single-cell image's cold start is not gated on the network filesystem.

---

### 8. AppHub pre-flight governance (UX layer)
A per-user quota row (concurrent apps, aggregate CPU/mem) is checked in `POST /api/apps` **before** submit, returning a friendly 409 ("you already have 2 sessions running; stop one or request a higher limit") instead of a silent PENDING. This deliberately duplicates the QOS caps: QOS is the wall, AppHub is the early human-readable fence. Template `maxCpus/maxMemoryMb/maxTimeMinutes` and cluster caps clamp the wizard sliders; the wizard also shows live cluster free-memory so a researcher sees *why* a 96 GB request may queue. Admin approval can raise allowed QOS / per-app caps via the human-confirmed diff (§6).

---

### 9. Persistent non-SLURM apps
cmssight/dmmr (kriengkraip), leantime/zulip/vitessce (nodeadmin), and the real **Galaxy** stay as systemd/container services on node1 — not under SLURM — with systemd cgroup caps (§6). AppHub registers them as `external`/`unmanaged` entries so the cluster-health view and Networking route map include them read-only; AppHub never schedules or kills them. If a PI later wants one SLURM-managed it moves to the `persistent` partition under `qos_persistent`.

---

### 10. Monitoring & ops
- **Metrics:** `squeue` depth, PENDING age p95, per-node alloc CPU/mem (frontend gauges), idle-cull count/day, false-cull guard (culls where probe said idle but kernel later resumed — should be ~0), failed-launch rate, mean time-to-`running`, tunnel count vs running count.
- **Smoke tests** (extend `real-slurm-smoke-node1.py`): launch a static-html app, assert `running` with a **loopback-bound** listener and a working tunnel/route; assert the port is NOT reachable from a non-node1 LAN address (security regression test for issue 1); hit `/extend`; `scancel --signal=TERM` and assert autosave ran (issue 11); drive an idle vs busy kernel and assert busy is never culled (issue 5). `check-nginx-node1.py` validates route map vs running set and reaps stragglers.
- **Prolog** (`prolog.sh`): create `/scratch/$SLURM_JOB_ID` owned by job user. **Epilog** (`epilog.sh`): kill orphan apptainer instances tagged `apphub:<appId>`, remove scratch.
- **Node-failure mitigation (MISSING #7).** A node failure still loses an in-flight session (inherent to batch; no CRIU/DMTCP). Partial guards: Jupyter/RStudio autosave to the NAS-backed `{workspace}` is enabled by default, and the runner triggers a periodic state flush cadence (e.g. every 10 min) so at most minutes of unsaved work are lost. This is documented to users; checkpoint/restore is an open question (§ below).

---

### Interfaces to other subsystems
- **Networking / nginx:** consumes the route map `{slug-owner.sisp.com → node1 127.0.0.1:<proxyPort>}` (loopback-only upstreams fronting the per-job SSH tunnels — see §3a). **WebSocket headers are mandatory in the route template** (MISSING #2): `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_read_timeout 86400; proxy_buffering off;` — without these, Jupyter/RStudio/Galaxy/Streamlit silently drop. Networking emits coarse per-route activity only as a floor, never as the cull signal. **Naming uses single-label `slug-owner.sisp.com`** (issue 13) to reuse the existing `*.sisp.com` wildcard cert/DNS; `*.app.sisp.com` is avoided because a single-label wildcard does not match it. Confirm cert with Networking before launch.
- **Storage:** jobs bind `{workspace}`/`{home}`. node2–4 obtain user data by **node1 re-exporting the CIFS-mounted NAS as NFSv4** with LDAP uid/gid identity mapping (MISSING #1), so ownership is correct and consistent. To avoid re-funneling all I/O through node1 (the SPOF/bottleneck the rebuild targets), heavy/temp I/O uses node-local `/scratch` (Prolog) and prewarmed node-local images; only the user's durable workspace traverses node1. The mount/identity-mapping contract is owned by the Storage subsystem; throughput on the node1 gateway is an open question (below).
- **Identity (OpenLDAP):** uid 10000–10054 / gid 100000; first-login auto-provisions the base SLURM association (§6).
- **AppHub web/API:** owns Postgres app rows, port-lease allocator, pre-flight quotas, approval workflow; holds **no** SLURM privilege (§6).

### How each review issue was resolved (index)
1. Open `0.0.0.0`/no-auth listener → §3a (loopback bind + node1 SSH tunnel + per-job token + host firewall). 2. Capacity ceiling → §0/§2/§7 (stated 6–10 heavy ceiling, lower defaults+opt-up, whole-node pinning, small-lane reservation). 3. Job-dir TOCTOU → §5 (apphub-owned `0700` jobscripts, status via loopback API not shared file). 4. Unlimited capped at 24h → §1/§2 (route unlimited to `persistent` MaxTime=UNLIMITED; `inter` gets DefaultTime). 5. Idle-cull kills computing jobs → §3d (app-level busy probe; access-log only a floor). 6. CoreSpec ≠ protection → §6 (systemd cgroup CPUAffinity/MemoryMin/Max). 7. Operator on web tier → §6 (no SLURM priv on web; scoped jobctl wrapper on a non-public daemon). 8. cron-vs-confirm + new-user lockout → §6 (auto base-provision on first login; QOS changes confirmed; no `-w` password). 9. cons_tres packs → §1 (CR_LLN / LLN=YES). 10. burst mis-wired → §1 (partition dropped). 11. graceful shutdown not implemented → §3c (SIGTERM handler in run_manifest.py, no exec-replace, tested). 12. Galaxy doesn't fit → §7/§9 (persistent service; only planemo in lane). 13. `*.app.sisp.com` cert → Interfaces (single-label `slug-owner.sisp.com`). MISSING #1–8 → Interfaces/§5/§10/§7 as annotated.

**Dependencies:** Networking (nginx route map, WebSocket-upgrade headers, single-label *.sisp.com wildcard cert/DNS, per-route activity floor, SSH-tunnel loopback upstreams), Storage (node1 CIFS mount of Infortrend NAS, NFSv4 re-export to node2-4 with LDAP uid/gid identity mapping, fixing the 6 legacy-mis-owned folders, node-local /scratch provisioning), Identity / OpenLDAP (posixAccount uid 10000-10054, gid 100000, NSS on all nodes, bind credentials for first-login provisioning), AppHub web/API + Postgres (app rows, atomic port-lease allocator, pre-flight quotas, approval workflow, loopback control API), SLURM control plane (slurmctld + slurmdbd/MariaDB on node1, cons_tres/CR_LLN, QOS/associations, reservations), Apptainer image build/prewarm pipeline (rstudio-seurat.sif, jupyter-scrnaseq.sif, node-local /opt/apphub/images sync), Host firewall (nftables/firewalld on node2-4 denying 31000-31999 from the LAN) and SSH key trust from node1 to compute nodes for the apphub account

**Open questions:** 
- Confirm the actual TLS wildcard and DNS: does only *.sisp.com exist (forcing single-label slug-owner.sisp.com), or can Networking provision *.app.sisp.com? Needed before launch.
- Measured RSS of the five persistent apps + real Galaxy + control plane on node1 to size MemSpecLimit and the systemd MemoryHigh/Max caps accurately.
- node1 NIC speed and NFSv4 gateway throughput under concurrent heavy sessions: is direct-through-node1 acceptable, or do we need per-node NAS mounts / a faster path?
- Should slurmdbd/MariaDB stay on node1 (simpler, but adds SPOF/load to the protected node) or move to node2? Depends on measured accounting load.
- Is per-job network-namespace isolation (job_container/tmpfs) available/enabled on this SLURM build, or do we rely on loopback-bind + firewall + token alone?
- Confirm SSH key-based trust from the apphub account on node1 to node2-4 is acceptable to security, vs an alternative transport (e.g. socat over an existing channel) for the per-job tunnels.
- Target small-lane reservation size (cpu/mem on node4) and idle-timeout defaults per template, to be tuned from observed light-vs-heavy session mix.
- Policy decision: maximum auto-extend headroom for actively-computing jobs before forcing a manual move to qos_long/qos_unlimited, and who approves qos_unlimited/qos_persistent grants.


---

<a id="container-runtime"></a>

## Container Runtime & App Images

### 0. Purpose and one-line model

This subsystem owns everything between "the AppHub backend decided to run something" and "a process is serving HTTP on `targetHost:port`": the Apptainer image taxonomy and `.def` sources, the build/publish/prewarm pipeline, the on-disk image registry/cache, the runtime invocation (`run_manifest.py`), the EPHEMERAL vs PERSISTENT lifecycle, the "host my own app" on-ramps, and container isolation. It builds on the real scaffold at `sisp-mapdrive/apphub` (`apphub-runner.sh` → `run_manifest.py`, `build-runtime-images-node2.sh`, `prewarm-runtime-images.sh`, `slurm.js` `resolveImage()/buildManifest()`, the atomic `.tmp`+`mv` publish, `apphub-sbatch-as-user.sh`) and hardens the parts that are unsafe, missing, or contradicted by the actual template/manifest data.

Apptainer (not Docker) stays: it runs **unprivileged and daemonless**, executes as the **invoking LDAP uid/gid** (matching `apphub-sbatch-as-user.sh`, which prefers gid `100000` / uid ≥ `10000`), reads images as a single SIF, and never needs a root daemon. SLURM cgroups (`--cpus-per-task`, `--mem`, `--time` from `buildJobScript()`) provide the resource cage; Apptainer provides filesystem/namespace isolation. They compose because the job already runs as the user's real uid.

Every node-touching action in this subsystem (`apptainer build`, symlink flip, prewarm `srun`, systemd unit install, per-node dir provisioning) is a **human-confirmed operation per the live-access policy**. The pipeline emits the exact command set; an operator approves.

---

### 1. Image taxonomy — base + task layers (and the honest dedup story)

**Tier 0 — base** `runtime/definitions/sisp-base.def` (`debian:12-slim`). Built once, referenced by `Bootstrap: localimage` from task defs that can rebase onto it. Its job is the cross-cutting fixes the review flagged, **not** web fonts:

```
Bootstrap: docker
From: debian:12-slim
%post
    apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates locales tzdata tini procps curl \
        python3 python3-venv libnss-wrapper gosu
    sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen
    # NSS fallback so getpwuid(geteuid()) NEVER throws for an LDAP uid that
    # has no /etc/passwd entry inside the container (streamlit/jupyter/R/pip
    # all call it). Combined with apptainer.conf passwd-injection (see below).
    printf 'apphubuser:x:0:0:AppHub User:/workspace:/usr/sbin/nologin\n' > /etc/passwd.apphub-fallback
    install -d /etc/apphub
    apt-get clean && rm -rf /var/lib/apt/lists/*
%environment
    export LANG=en_US.UTF-8 TZ=Asia/Bangkok
    export HOME=/workspace
    export XDG_CACHE_HOME=/workspace/.cache XDG_CONFIG_HOME=/workspace/.config
    export XDG_DATA_HOME=/workspace/.local/share MPLCONFIGDIR=/workspace/.cache/mpl
    export APPHUB_BASE=1
```

> **Fonts correction (MISSING item).** The original base def only `install -d`'d an empty fonts dir. In-container fonts are **irrelevant for headless HTTP apps** — the Inter/JetBrains Mono "self-hosted Google Fonts" requirement belongs entirely to the **web/UI subsystem** (served by nginx to the browser), not to container internals. The base installs `fontconfig`+`fonts-dejavu-core` **only** so Matplotlib/Cairo backends inside scientific apps don't error on a missing default font; the design no longer claims to ship the brand fonts in the SIF.

**Tier 1 — task images:**

| image | def | rebased on sisp-base? | templates | enabled |
|---|---|---|---|---|
| `python-apps.sif` | `python-apps.def` **(NEW — authored here)** | yes | streamlit, dash, fastapi, gradio, static-html | **yes** |
| `jupyterlab.sif` | `jupyterlab.def` | **no** (keeps `quay.io/jupyter/datascience-notebook`) | jupyterlab | no |
| `rstudio.sif` | `rstudio.def` | **no** (keeps `rocker/rstudio`) | rstudio, shiny | no |
| `galaxy-tool-dev.sif` | `galaxy-tool-dev.def` | no | galaxy-tool | no |

**Honest dedup scope (review issue 11).** Only `python-apps` rebases onto `sisp-base`. `jupyterlab.def` (mamba/scanpy) and `rstudio.def` (`BiocManager::install(DESeq2,…)`, hours of source compilation) bootstrap heavy upstreams and **do not** get the base dedup — forcing them onto `debian:12-slim` would mean re-deriving the entire conda/rocker stack. We accept that and budget NAS/stage capacity for their 4–8 GB SIFs accordingly (§7). To stop those builds competing with user jobs, the build identity's node is **drained from the ephemeral pool during a build** via a build reservation (§2).

**The critical gap, fixed.** Five of nine templates are `enabled:true` and every one points at `python-apps.sif`, but the scaffold ships **no `python-apps.def`** and `build-runtime-images-node2.sh` builds only jupyterlab/rstudio/galaxy. In real-SLURM mode `run_manifest.py` hits `fail("container image does not exist", 66)` → HTTP 503. The default product is non-functional until this exists. `runtime/definitions/python-apps.def`:

```
Bootstrap: localimage
From: {{BASE_SIF_PINNED}}        # rendered to store/sisp-base-<ver>.sif — NEVER the 'current' symlink
%post
    apt-get update && apt-get install -y --no-install-recommends python3-pip
    pip3 install --no-cache-dir --break-system-packages \
        streamlit dash "fastapi[standard]" uvicorn gunicorn gradio flask \
        pandas numpy plotly altair
    apt-get clean && rm -rf /var/lib/apt/lists/*
%labels
    org.sisp.apphub.layer task
    org.sisp.apphub.image python-apps
```

`build-runtime-images-node2.sh` is extended to build `sisp-base` first, resolve its versioned path + digest, render `{{BASE_SIF_PINNED}}` into the task def, then build task images in dependency order.

---

### 2. Build / publish / prewarm pipeline

**Where & how.** Builds run on **node2** (RAM headroom, off the node1 control plane), driven by `deploy/build-runtime-images-node2.sh`. Unprivileged `apptainer build` with userns; `--fakeroot` only for defs that run `apt` (the Debian base does), so node2 needs one-time `/etc/subuid`/`/etc/subgid` fakeroot mappings for the `apphub` build identity — the single privileged prerequisite, configured once by ops in `install-node2.sh`. The build step is **human-confirmed**.

**Build isolation from the user pool (review issue 11).** Before a build, ops places a SLURM reservation that removes the builder node from `APPHUB_DEFAULT_NODES` (`node[2-4]`) scheduling for the build window, so a multi-hour Bioconductor compile never contends with ephemeral user jobs. Reservation create/release is part of the confirmed build procedure.

**Versioned, immutable publish (extends `.tmp`+`mv`):**

```
/mnt/sisplockers/apphub/images/
  store/
    sisp-base-2026.06.1.sif        + .sha256
    python-apps-2026.06.1.sif      + .sha256
  python-apps.sif -> store/python-apps-2026.06.1.sif   # 'current' symlink (operator convenience only)
  images.lock.json                                     # SINGLE SOURCE OF TRUTH for "current"
```

- Build → `store/<name>-<ver>.sif.tmp` → `sha256sum` → `chmod 0644` → `mv` (atomic within dir) → update `images.lock.json` → flip the symlink last.
- `images.lock.json` is the registry manifest. Provenance is recorded with **whatever is actually available** (review of `defGitSha` aspiration): `defGitSha` for defs that live in git on node2, and `defSha256` (content hash of the exact `.def`) for **generated Mode B/C user defs that are never in git** — so the images that most need provenance still have a verifiable source hash. The resolved base digest is pinned per task image:

```json
{ "schemaVersion": 1, "builtAt": "2026-06-27T03:00:00Z", "builderNode": "node2",
  "images": {
    "sisp-base":   { "version": "2026.06.1", "sif": "store/sisp-base-2026.06.1.sif",   "sha256": "…", "defSha256": "…" },
    "python-apps": { "version": "2026.06.1", "sif": "store/python-apps-2026.06.1.sif", "sha256": "…",
                     "defGitSha": "…", "baseVersion": "2026.06.1", "baseSha256": "…", "sizeBytes": … } } }
```

**Task images build against the pinned versioned base, never the symlink (review issue 6).** `{{BASE_SIF_PINNED}}` resolves to `store/sisp-base-<ver>.sif`; the resolved base sha is written to `baseSha256`. A base rebuild can no longer silently change what task images compile against, and a mid-flip symlink can no longer cause a torn read during a build.

**Central version resolution kills the cross-node symlink race AND the name-mismatch bug (review issues 2 & 7).** `resolveImage()` in `slurm.js` is changed so the **backend on node1 dereferences the symlink once via `images.lock.json`** and writes the **concrete versioned store path** into `manifest.image` (e.g. `…/store/python-apps-2026.06.1.sif`), plus a new `manifest.imageVersion`/`manifest.imageSha256`. Consequences:
- Compute nodes **never resolve the `current` symlink themselves**, so NFS/CIFS symlink attribute caching (`actimeo`) can no longer make node3 launch version N-1 while node1 sees N. We additionally mount the image path with low `actimeo` and **quiesce new launches during the publish window**.
- The staged node-local filename now **matches** what the manifest references (both are the versioned basename), so node-local staging actually engages instead of silently falling back to NFS on every launch.

**Prewarm / node-local staging — the real "slow/hung under load" fix.** Reading a multi-GB SIF over the CIFS-gateway/NFS on every job start is the I/O storm behind the hangs. `prewarm-runtime-images.sh` is extended: after publish, `srun` across `node[2-4]` to stage onto node-local NVMe and **verify the sha once**, writing a marker:

```
srun -N1 -w "$node" bash -lc '
  install -d /var/lib/apphub/images &&
  rsync -a --inplace "$SRC/store/python-apps-2026.06.1.sif" /var/lib/apphub/images/ &&
  computed=$(sha256sum /var/lib/apphub/images/python-apps-2026.06.1.sif | cut -d" " -f1) &&
  [ "$computed" = "$EXPECTED_SHA" ] &&
  stat -c "%s %Y" /var/lib/apphub/images/python-apps-2026.06.1.sif > /var/lib/apphub/images/python-apps-2026.06.1.sif.verified.$computed &&
  apptainer exec /var/lib/apphub/images/python-apps-2026.06.1.sif true'   # warm page cache + smoke
```

**No per-launch re-hashing (review issue 3).** `run_manifest.py` does **not** sha a multi-GB SIF at every job start (that would recreate the stall). At launch it: (1) looks for the versioned basename in `APPHUB_LOCAL_IMAGE_DIR`; (2) checks the `.verified.<sha>` marker's recorded `size mtime` against the file's current `stat` — a cheap O(1) check; (3) on match, uses the local copy and trusts the staged sha; (4) only on marker miss/mismatch falls back to the NFS store path (and logs it for ops). `APPTAINER_CACHEDIR` is node-local so layer extraction never touches the locker.

**Per-node dir ownership (MISSING item).** `/var/lib/apphub/images` and `/var/lib/apphub/apptainer-cache` are created and `chown apphub:apphub`'d by a **one-time privileged step in `install-node{2,3,4}.sh`**. Staging `srun`/`run_manifest` then run as a non-root identity that owns those dirs, so no per-launch root is needed. This provisioning is the documented, human-confirmed install step the original omitted.

**NAS capacity / quota (MISSING item).** The image store and per-user `store/users/` live on the **same Infortrend NAS** being re-exported via the CIFS gateway, competing with user locker space. We (a) place the AppHub image tree on its own NAS dataset/share with an explicit quota, (b) cap retention to **last 3 versions per image** under refcount GC (below), and (c) cap per-user custom-image storage. GC and quota headroom are monitored; build is refused if projected store size would breach quota.

**Refcount GC, not blind age (review issue 8).** A persistent P2 app can pin version N-4 for weeks. GC consults every non-`stopped` app's recorded `imageSha256` (now in `runner-status.json`) **and** the seeded persistent records, and refuses to unlink any SIF still referenced. Only unreferenced versions beyond the last-3 window are removed.

---

### 3. Runtime invocation — hardened `run_manifest.py` profiles

The scaffold runner is correct but isolation-naive (`apptainer exec --cleanenv` + binds + `--pwd`). We add an **isolation profile** that the runner translates to flags. **Crucially, the original design's choice of `--containall` as the standard default is rejected — it would crash the 80% path** (review issue 1).

**Why `--containall` breaks the enabled templates (verified in `templates.json`):** the python-apps templates bind only `{workspace}:/workspace` and set no `HOME` (streamlit/static have `environment:None`; dash/gradio set only PORT/host vars). Today they work because Apptainer auto-mounts the host home and injects a `/etc/passwd` entry for the calling uid. `--containall --no-home` suppresses both; `debian:12-slim` has no passwd entry for uid ≥ 10000, so `getpwuid(geteuid())` (called by streamlit/jupyter/R/pip) throws, and with `HOME` unset the app tries to write `~/.streamlit` on a read-only root.

**Resolution — `--contain` for standard, with passwd injection + a writable HOME:**

- **trusted** (admin task images / default templates): `--cleanenv` + explicit binds + `--pwd {workspace}`, plus `HOME=/workspace`. No `--no-home` surprise; behaves like today but with env hygiene.
- **standard** (default for user research apps — `APPHUB_DEFAULT_ISOLATION=standard`): `--contain` (NOT `--containall`) `--cleanenv`, explicit binds only (`{workspace}:rw`, optional `{home}` per template), `--pwd /workspace`. `--contain` gives a private `/tmp`, `/dev`, and home dir while **still allowing `/etc/passwd` injection**. Three required supporting changes, all delivered here:
  1. `apphub.conf`/`apptainer.conf` on every compute node ships with `config passwd = yes` and `config group = yes` so the starter injects the calling uid/gid into the container's `/etc/passwd`/`/etc/group`. (Provisioned by `install-node{2,3,4}.sh`.)
  2. **Every python-apps template gains `HOME=/workspace` and workspace-based XDG dirs in its `environment`** (the templates currently have none) — and `sisp-base.def` also exports them, so it is correct whether the app runs from a template env or not.
  3. `libnss-wrapper` + the `/etc/passwd.apphub-fallback` baked into the base is the belt-and-suspenders path if passwd injection is ever unavailable.
  4. **Gate:** enabling `standard` is conditioned on `deploy/real-slurm-smoke-node1.py` running each enabled template **as a high, non-existent uid** (simulating a fresh LDAP user) and asserting HTTP 200, before rollout.
- **untrusted** (Mode C custom images, §5): `--containall --no-home --writable-tmpfs`-sized, `APPTAINER_ALLOW_SETUID=0`, **no `--fakeroot`, no `--writable`**, a seccomp profile (`--security seccomp:/etc/apphub/seccomp-default.json`), and a **server-fixed bind allowlist** (only the owner's workspace; never another user's locker path, never `imageRoot`, never `/etc`).

**TOCTOU / downgrade fix (review issue 5).** `slurm.js` writes `manifest.json` into a job dir that is `chmod 2775` (group-writable) on the locker and the job runs as the user, so a Mode C user could edit `isolation`/`volumes` between submit and exec. Therefore for **untrusted** apps `run_manifest.py` does **not** trust the manifest for security-relevant fields: the trust level, the seccomp path, and the bind allowlist are injected by the **privileged `apphub-sbatch-as-user.sh` into the job-script environment** (`APPHUB_ENFORCED_ISOLATION`, `APPHUB_ENFORCED_BINDS`) — server-controlled, not group-writable — and the runner **enforce-denies** any bind outside the allowlist. Job dirs are tightened to `0700`-owner where the reconcile/read path allows; the manifest remains advisory for non-security fields only.

**`--writable-tmpfs` OOM correction (review issue 9).** The original applied `--writable-tmpfs` across all profiles. That overlay is RAM-backed and counts against the SLURM `--mem` cgroup, so jupyter/R/pip/matplotlib temp writes silently OOM-kill the job. Fix: standard/trusted apps do **not** get a writable-tmpfs overlay where a writable `/workspace` bind suffices; `TMPDIR`/scratch points at a **disk-backed** node-local `/var/tmp/apphub/<jobid>` (created per job, cleaned on exit) or `/workspace`. Only untrusted gets a writable-tmpfs, **explicitly sized** (`--writable-tmpfs` with a documented overlay size), and the template doc states `--mem` must budget overlay usage.

The runner adds `imageVersion` and `imageSha256` to `runner-status.json` so reconciliation/audit and **refcount GC** can prove which image actually ran.

---

### 4. Instance lifecycle — ephemeral vs persistent

#### 4a. EPHEMERAL (per-user research apps) — the 80% path
Unchanged control flow, scheduled on `node[2-4]`: `POST /api/apps` → `buildManifest` (now injecting the resolved versioned image path + enforced isolation env) → job script → `apphub-sbatch-as-user.sh submit <owner> <script>` (runs as owner uid/gid) → SLURM places on a free node → `apphub-runner.sh` → `run_manifest.py` → `apptainer exec` → app on `:{port}` → status files + reconciliation → nginx map. Bounded by `--time`; SLURM reclaims on expiry → reconciliation flips `running→stopped`, removes route.

**Port reuse guard (MISSING item).** The `31000–31999` allocator must not reassign a port still held on the **same node** within the 30 s reconcile lag (a freed port handed to a new job landing on the same node → bind failure). Allocation records `(node, port, releasedAt)` and **quarantines a released port for > reconcileInterval** before reuse on that node; allocation is keyed on the candidate node when known, else treated as cluster-wide-busy until confirmed free.

#### 4b. PERSISTENT — two genuinely different classes

**Class P1 — always-on infra (nodeadmin: leantime, zulip, vitessce).** Not research apps; **must not** be SLURM-scheduled (time limits/preemption would kill a chat server). They run as **systemd units on node1**, exactly as today. AppHub integrates them as `managed:"external"` records: no template, no job, status from an **HTTP/TCP healthcheck** instead of `squeue`, same route record so they appear in the UI and flow through the nginx map. `deploy/registered-services.yaml` seeds these route+health records on install.

**Class P2 — persistent research apps (kriengkraip: cmssight, dmmr).** App-like but long-lived. Admin chooses per app:
- **P2-systemd**: `apphub-app@<appId>.service` template unit on a chosen node running the **same** `apphub-runner.sh <manifest>` (identical container path as ephemeral) with `Restart=on-failure`, no time limit.
- **P2-slurm-persistent**: a SLURM job in a dedicated `persistent` partition/reservation with very high/unlimited `--time`; reconciliation re-submits on exit.

Approval gets teeth (recon flagged approval not enforcing provisioning): on `PATCH /api/admin/apps/{id}/approval {persistentApproved:true}`, the backend (a) provisions persistent workspace storage *[storage subsystem interface]*, (b) materializes a P2-systemd unit (via the **human-confirmed** node action) or a P2-slurm-persistent job, (c) marks the route persistent so normal reconciliation won't GC it. Stopping requires an explicit admin stop. Persistent P2 work is pinned to a node (or `--exclude`/`allowedNodes`, already supported in `slurm.js`) so it doesn't starve the interactive pool; SLURM backfills ephemeral jobs around it.

**Reload storm + flap protection (review issue, nginx reloads).** `routes.js` currently calls `runReload` on **every** map change — a flapping P1 healthcheck or ephemeral churn at the load that already hangs the cluster would hammer node1. Fixes:
- **Coalesce reloads**: batch route deltas and reload at most once per `APPHUB_NGINX_RELOAD_MIN_INTERVAL_MS` (e.g. 5 s), collapsing N changes into one `nginx -s reload`.
- **Healthcheck hysteresis**: a P1/P2 route is only removed after **N consecutive failures**; a single transient failure marks it `degraded`, not absent.
- **Never auto-drop a seeded P1 route**, and **re-seed all P1 routes from `registered-services.yaml` on AppHub restart** so a crash can't silently drop infra routes.

**Reconcile scalability + latency (MISSING item).** A single 30 s loop means up to ~30 s + reload before a URL works, under the load that already hangs the system. Mitigations: (1) the runner's `runner-status.json` write triggers an **on-demand single-app reconcile** (file-watch/event path) so a newly-`running` app routes in seconds, not at the next tick; (2) the periodic loop is **backpressure-aware** (skips overlapping runs, processes in bounded batches); (3) reconcile work can shard by node if app count grows. The 30 s loop remains the safety net for missed events.

---

### 5. "Host my own app" — three on-ramps

**Mode A — "Bring your code" (default, safe).** Point an existing template at a workspace folder + `{entrypoint}`; runs in the trusted `python-apps.sif` as the user's uid. No custom image, no new attack surface.

**Honest dependency-bottleneck framing (review issue 10).** Mode A only covers apps whose imports are in the baked set (`streamlit/dash/fastapi/gradio/flask/pandas/numpy/plotly/altair`). The SIF is read-only and the tmpfs overlay is ephemeral, so a bioinformatics user needing an extra package would otherwise fall straight to admin-gated Mode B. We therefore add a **per-user writable venv on the locker**: `python -m venv /workspace/.venv` bound into the container and activated by the runner when present, so users can `pip install` extras into persistent locker storage without a rebuild. Mode B is resourced as the **expected common path** (async build queue), not an exception, and the product copy is honest that Mode A's frozen dependency set is a real boundary.

**Mode B — "Custom environment via def" (mediated build).** User supplies a small `%post` via a guided form; AppHub generates a `.def` with `Bootstrap: localimage From: store/sisp-base-<ver>.sif` (pinned, never the symlink), files a build request → **admin reviews the def diff** → built on node2 via the standard pipeline → published as `store/users/<username>/<app>-<ver>.sif`, recorded with `defSha256` (no git for generated defs). User never controls `Bootstrap`/`From`. Tagged `isolation:standard`.

**Mode C — "Run my container image" (untrusted, admin-gated, off by default).** `APPHUB_CUSTOM_IMAGES_ENABLED=0` global kill-switch; enabled per-user by an admin. Admission pipeline: (1) **source allowlist** — `docker://` from approved registries (`quay.io`, `ghcr.io/<approved-orgs>`) or an uploaded SIF; no `docker-daemon`/arbitrary `oras://`. (2) **pull/convert on node2** to SIF, sha, store under `store/users/<username>/`. (3) **scan** — `find -perm /6000` for setuid/setgid + optional Trivy/Grype CVE scan; reject on setuid bins or critical CVEs. (4) **admin approval**, audited (`app.image.approve`). (5) **run with the `untrusted` profile** from §3.

**Egress claim corrected — the honest version (review issue 4).** The original "constrain outbound at the node firewall for untrusted apps" is **unenforceable under unprivileged Apptainer**: per-app `--net` needs setuid/root (violating the no-setuid invariant), and the app runs as the user's **shared** LDAP uid (also used by their interactive sessions), so uid-based firewalling cannot isolate one app. Replacement policy, stated plainly:
- Untrusted apps run on a **dedicated, network-restricted SLURM partition** (`APPHUB_UNTRUSTED_PARTITION`) pinned to a node or node-set whose **egress is restricted by node-level firewall rules independent of uid** (default-deny outbound except what the app needs for its inbound route). This is the only enforcement that actually holds.
- We **document the residual lateral exposure** the uid invariant does *not* cover: on a shared compute node, any co-tenant job can reach the app's `0.0.0.0:port`, and the app can reach `127.0.0.1:other-port` of co-tenant apps. Mitigation is the dedicated partition (don't co-tenant untrusted with interactive jobs) plus admin gating; we do **not** pretend the firewall isolates a single app within a shared uid.
- Option to enable setuid Apptainer + `--net` **only on the untrusted partition** is documented as a deliberate trade-off the operator may opt into, isolated from the rest of the cluster.

**seccomp validated against mount semantics (MISSING item).** The default profile blocks `ptrace`/`add_key`/`keyctl`/`mount`. We confirmed this is safe **because** the locker is bound into the container by the host (the CIFS-gateway re-export is mounted on the node, not Kerberized-per-process inside the container), so blocking `keyctl`/`mount` inside the container does not break credential or mount setup — those happen on the host before exec. The profile is applied **only to untrusted**; standard/trusted apps are unaffected. If a future Kerberized NFS locker is introduced, `keyctl` blocking must be re-validated before reuse.

**Non-negotiable invariant across all modes:** the container process runs as the user's **real LDAP uid/gid** (enforced by `apphub-sbatch-as-user.sh`, not by anything in the container), so a malicious image can never escalate beyond what that wet-lab user can already do on the locker — never root, never the LDAP server, never another user's files. This bounds *filesystem* blast radius; the network caveats above are the explicit exception.

---

### 6. GPU posture (MISSING item — explicit)

**The lab cluster (node1–node4, 112 CPU / 512 GB RAM) has no GPUs.** GPU-accelerated workflows (scanpy/RAPIDS, DESeq2 on GPU, vitessce rendering) are therefore **out of scope today and documented as a known limitation**, not silently omitted. The design is forward-compatible: a `manifest.gpus` field and template `defaultGpus`/`maxGpus` are reserved; when GPU nodes are added, the runner appends `--nv` and `buildJobScript()` appends `#SBATCH --gres=gpu:{n}`. Until then the backend **rejects** any GPU request with a clear "no GPU resources in this cluster" error rather than queuing a job that never schedules.

---

### 7. Config additions (consistent with `config.js` style)

```
APPHUB_IMAGE_ROOT=/mnt/sisplockers/apphub/images
APPHUB_IMAGE_LOCK=/mnt/sisplockers/apphub/images/images.lock.json
APPHUB_LOCAL_IMAGE_DIR=/var/lib/apphub/images            # node-local staged versioned SIFs
APPHUB_APPTAINER_CACHEDIR=/var/lib/apphub/apptainer-cache
APPHUB_DEFAULT_ISOLATION=standard                        # trusted|standard|untrusted
APPHUB_SECCOMP_PROFILE=/etc/apphub/seccomp-default.json  # untrusted only
APPHUB_CUSTOM_IMAGES_ENABLED=0                           # Mode C kill-switch
APPHUB_CUSTOM_REGISTRY_ALLOWLIST=quay.io,ghcr.io
APPHUB_PERSISTENT_PARTITION=persistent
APPHUB_UNTRUSTED_PARTITION=untrusted                     # network-restricted node-set
APPHUB_NGINX_RELOAD_MIN_INTERVAL_MS=5000                 # reload coalescing
APPHUB_HEALTHCHECK_FAIL_THRESHOLD=3                      # P1/P2 hysteresis
APPHUB_IMAGE_RETAIN_VERSIONS=3                           # refcount-aware GC
APPHUB_PORT_QUARANTINE_MS=45000                          # > reconcile interval
```

### 8. End-to-end sequence (ephemeral, real mode)
1. `POST /api/apps {templateId:"streamlit", entrypoint, cpus, memoryMb, time}` → validate vs template `maxCpus/maxMemoryMb/maxTimeMinutes`; reject GPU requests.
2. Backend allocates a non-quarantined port (31000–31999), reads `images.lock.json`, resolves the **concrete versioned** SIF path, builds `manifest.json` (image path, `imageVersion`, `imageSha256`, isolation) under the job dir; writes job script with enforced-isolation env for untrusted.
3. `sudo -n apphub-sbatch-as-user.sh submit <owner> <script>` → uid/gid (gid 100000 / uid ≥ 10000) → `sbatch --uid --gid --parsable` → jobId, status `queued`.
4. SLURM schedules a free `node[2-4]`; job writes `status.json {host,jobId,state:starting}`.
5. `apphub-runner.sh` → `run_manifest.py`: finds versioned SIF in `/var/lib/apphub/images`, validates the `.verified` marker (size+mtime, no re-hash) → `apptainer exec --contain --cleanenv --env HOME=/workspace --bind <workspace>:/workspace:rw --pwd /workspace <versioned.sif> streamlit run app.py --server.port {port} --server.address 0.0.0.0 --server.headless true`.
6. App listens; `runner-status.json {state:running,imageVersion,imageSha256}` write triggers on-demand reconcile.
7. Reconcile: `squeue`/`scontrol` + status files → `running`, upsert route `streamlit-<owner>.app.sisp.com → host:port`, **coalesced** nginx map sync + reload.
8. `--time` expiry → SLURM kills → reconcile → `stopped`, route removed (coalesced), port enters quarantine.


**Dependencies:** storage-subsystem (CIFS gateway re-export on node1, LDAP uid/gid ownership mapping, per-user lockers and apphub workspace/image NAS datasets, persistent P2 workspace provisioning on approval), auth-identity-subsystem (OpenLDAP on node1: uid>=10000/gid 100000 resolution used by apphub-sbatch-as-user.sh and passwd injection), scheduler-subsystem (SLURM: partitions including persistent and untrusted, reservations for build-node draining, cgroup resource caps, --uid/--gid submission), control-plane-routing-subsystem (nginx map on node1, routes.js reload, apphub-nginx-reload wrapper, route records for ephemeral + P1/P2 persistent), backend-api-subsystem (server.js/slurm.js/routes.js: resolveImage change, manifest fields, approval workflow, port allocator, reconcile loop), provisioning-subsystem (install-node{1,2,3,4}.sh: subuid/subgid fakeroot mappings, per-node /var/lib/apphub dirs ownership, apptainer.conf, registered-services.yaml seeding), observability-audit-subsystem (image build/approve audit events, runner-status imageSha for reconciliation and GC refcount)

**Open questions:** 
- Confirm the locker re-export mount semantics on node[2-4]: is the CIFS gateway share mounted on the host before container exec (host-level), or does any per-process credential acquisition happen that the untrusted seccomp profile (keyctl/add_key block) could break?
- Is setuid Apptainer acceptable on a dedicated untrusted partition to get real per-app --net egress isolation, or must we stay fully unprivileged and accept perimeter-firewall-only egress control for Mode C?
- What NAS quota can be allocated to the AppHub image dataset (base + 4 task images x last-3 + per-user store/users)? This sets the retention count and whether Mode C is viable at scale.
- Are the runtime .def files version-controlled in git on node2 (enabling defGitSha provenance), or do they live only on the locker — determining whether we rely on defSha256 content hashes for all images?
- Should jupyterlab/rstudio be rebased onto sisp-base at the cost of re-deriving the conda/rocker stacks, or is retaining their heavy upstreams (no dedup) acceptable given they are disabled by default?
- Confirm there is genuinely no GPU anywhere in the node1-4 cluster now or near-term, so we can finalize hard-rejecting GPU requests rather than building a dormant --gres path.
- For persistent P2 apps, is P2-systemd (node1/chosen-node, auto-restart, outside SLURM accounting) or P2-slurm-persistent (inside accounting, reconcile-resubmit) the preferred default for cmssight/dmmr?


---

<a id="networking-routing"></a>

## Networking, Reverse Proxy & Routing

### Purpose

node1 (192.168.0.25) is the single public ingress for all of `*.sisp.com`. nginx on node1 terminates TLS and is the only box any client ever talks to. It serves three traffic classes from one config tree: the **control plane** (`apphub.sisp.com`, `mapdrive.sisp.com`), the **always-on persistent vhosts** (`cmssight`, `dmmr`, `leantime`, `zulip`, `vitessce`.sisp.com), and **ephemeral per-instance app URLs** `https://<slug>--u-<owner>.app.sisp.com` that proxy to a SLURM job on a dynamic port (31000–31999) on node2/3/4. The backend writes route facts to generated includes; a privileged, validated, audited reload wrapper swaps them; nginx does pure host→upstream data-plane mapping. No autonomous node changes: every reload is confirmed, validated, and logged — except the one explicitly pre-authorized exception (TLS renewal, §4).

This revision keeps the scaffold spine (per-instance subdomain, generated `map $host`, wildcard `*.app.sisp.com`, `auth_request` SSO, sudo-gated reload) and closes every valid hole the review raised — most importantly the **two critical isolation gaps**: (1) the proxy authenticated but did not *authorize* per app, and (2) co-tenant jobs on a shared node could reach each other's tokenless listeners on loopback, bypassing the gateway entirely.

### 1. Naming & URL strategy — per-instance subdomain, collision-proof

Each app gets `https://<slug>--u-<owner>.app.sisp.com`. Subdomain (not path-prefix) routing is retained because Jupyter/RStudio/Shiny assume they own the origin (absolute `/static`, `/api/kernels`, websocket URLs at root) and because each app is then a distinct cookie/`SameSite`/localStorage origin.

Two naming bugs from the scaffold are **fixed at creation, fail-closed**:

- **No silent truncation (was `"${slug}-${owner}".slice(0,50)`).** The backend now *rejects* (HTTP 400, actionable message) any name whose assembled label exceeds the 63-char DNS limit instead of slicing. Truncation produced two distinct `(slug,owner)` pairs mapping to one `routeHost`, and `upsertRoute` keys on host — so B's launch silently overwrote A's route and stole A's URL. Rejection makes that impossible.
- **Unambiguous delimiter.** `slug` (`[a-z0-9-]`, slug may contain `-`) and `owner` are joined with a reserved separator `--u-` that slug is forbidden to contain (slug may not contain `--`). This makes `host → owner` parsing unambiguous; but as defence-in-depth we **never parse owner back out of the hostname** — the route record carries an explicit `owner` field (see §6 authorization).
- **Global uniqueness.** `routeHost` is enforced unique at app-creation time inside the same mutex that allocates the port (§5), so two apps can never claim the same host.

The label is a sub-subdomain of `*.app.sisp.com`, one level below the persistent vhosts at `*.sisp.com`, so an app can never shadow `cmssight.sisp.com` et al. That layering is the coexistence guarantee.

### 2. nginx file layout on node1

```
/etc/nginx/
  nginx.conf                         # http{} core: $connection_upgrade map, worker tuning, includes
  snippets/
    sisp-com-ssl.conf                # Cert A: *.sisp.com  (SNI)
    sisp-app-ssl.conf                # Cert B: *.app.sisp.com (SNI)
    sisp-proxy-headers.conf          # X-Forwarded-*, Host, X-Request-Id
    apphub-proxy-app.conf            # shared per-app proxy block (ws, timeouts)
  sites-enabled/
    00-apphub-control.conf           # apphub.sisp.com + mapdrive.sisp.com
    10-apphub-apps.conf              # wildcard *.app.sisp.com (data plane)
    20-persistent-*.conf             # one hand-written file per persistent vhost
  apphub/
    routes.map                       # GENERATED: map $host -> upstream
    routes.status.map                # GENERATED: map $host -> ready|booting|queued
    routes.map.last-good             # rollback snapshot
    routes.status.map.last-good
```

The persistent vhosts stay 100% hand-authored; AppHub only ever writes under `/etc/nginx/apphub/`. That is the blast-radius boundary — a route-generation bug cannot break cmssight/zulip. **The boundary is now bidirectional (review gap):** because the reload wrapper validates the *whole* config with `nginx -t`, a broken hand-edited `20-persistent-*.conf` would also fail every AppHub reload. The reload wrapper therefore distinguishes the two failure modes (§5) and a scheduled `nginx -t` canary (§9) alarms on persistent-vhost breakage independently of routing churn, so ops is paged on the real cause rather than a wave of "my app won't start."

### 3. The generated data plane

Three route states (not two): `ready`, `booting`, `queued`. The extra `queued` state (review gap) is what a saturated 112-CPU / 512-GB cluster needs — a PENDING SLURM job must tell the user "you're in line," not spin a boot page forever.

`/etc/nginx/apphub/routes.map`:
```nginx
# Generated by SISP AppHub. Do not edit by hand. gen=2026-06-27T..Z rev=8821
map $host $apphub_upstream {
    default "";
    # appId=3f2a owner=dianap node=node2 tok=ab12
    jupyter--u-dianap.app.sisp.com  http://192.168.0.26:31042;
    shiny--u-sarunt.app.sisp.com    http://192.168.0.27:31108;
}
```

`/etc/nginx/apphub/routes.status.map`:
```nginx
map $host $apphub_route_state {
    default "unknown";
    jupyter--u-dianap.app.sisp.com    ready;
    rstudio--u-monthiras.app.sisp.com booting;   # reserved, port not live yet
    galaxy--u-pim.app.sisp.com        queued;     # SLURM PENDING, no node yet
}
```

`10-apphub-apps.conf` (data plane for `*.app.sisp.com`):
```nginx
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name *.app.sisp.com;
    include /etc/nginx/snippets/sisp-app-ssl.conf;   # Cert B

    # Unknown host -> branded 404 (not nginx default)
    if ($apphub_route_state = unknown) { return 404; }

    # Not-yet-live states -> branded boot/queue page that polls AppHub
    location = /_boot   { internal; proxy_pass http://127.0.0.1:8792/internal/boot; }
    if ($apphub_route_state = booting) { rewrite ^ /_boot last; }
    if ($apphub_route_state = queued)  { rewrite ^ /_boot last; }

    location / {
        auth_request /_apphub_auth;
        error_page 401 = @apphub_login;
        error_page 403 = @apphub_forbidden;             # NEW: not the owner
        error_page 502 503 504 = @apphub_unavailable;   # branded, not raw nginx

        proxy_pass $apphub_upstream;
        include /etc/nginx/snippets/apphub-proxy-app.conf;
    }

    location @apphub_unavailable { return 302 /_boot; }
    location @apphub_forbidden   { return 302 https://apphub.sisp.com/denied?host=$host; }

    location = /_apphub_auth {
        internal;
        proxy_pass http://127.0.0.1:8888/check;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header X-Original-URI $request_uri;
        proxy_set_header X-Apphub-Host  $host;          # NEW: WHICH app (authz key)
        proxy_set_header X-Cookie-Name  nginxauth;
        proxy_set_header X-Cookie-Domain .sisp.com;
        proxy_set_header Cookie $http_cookie;
    }
    location /auth/ { proxy_pass http://127.0.0.1:8888/auth/; /* as scaffold */ }
    location @apphub_login {
        return 302 https://apphub.sisp.com/auth/login?service=$scheme://$http_host$request_uri;
    }
}
```

`snippets/apphub-proxy-app.conf` (the websocket / long-poll contract):
```nginx
proxy_http_version 1.1;
include /etc/nginx/snippets/sisp-proxy-headers.conf;
proxy_set_header Upgrade    $http_upgrade;
proxy_set_header Connection $connection_upgrade;   # '' -> close, else upgrade
proxy_buffering off;
proxy_request_buffering off;
proxy_read_timeout 86400s;     # idle kernels / RStudio live all day
proxy_send_timeout 86400s;
client_max_body_size 0;        # large genomics uploads through the gateway
```

Added once in `http{}`:
```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
```

The scaffold hardcoded `Connection "upgrade"` on every request, breaking keepalive for plain HTTP. The `$connection_upgrade` map is the idiomatic fix.

### 4. TLS / certificates

Two independent wildcard certs (a wildcard covers exactly one label level):
- **Cert A:** `sisp.com` + `*.sisp.com` → control plane + persistent vhosts.
- **Cert B:** `*.app.sisp.com` → every per-instance app URL.

Issuance: `certbot` **DNS-01** (wildcards require it) against the `sisp.com` zone. **Secret scoping (review gap):** the DNS API token does **not** get authority to rewrite the production `sisp.com` zone. We use CNAME challenge delegation — `_acme-challenge.sisp.com` and `_acme-challenge.app.sisp.com` are CNAME'd to a dedicated, minimal-privilege ACME zone, and the on-box token can only write TXT in that zone. The token lives in `/etc/letsencrypt/` mode 0600, root-only, referenced from the AppHub backend never.

**Renewal is the one pre-authorized automated node action (review gap).** Cert B expiring breaks *every* app URL at once; a human-in-the-loop 90-day window is an outage waiting to happen. Renewal touches only `/etc/letsencrypt` + a *validated* reload (never routing), so it is carved out as pre-approved: `certbot renew --deploy-hook` calls the same `apphub-nginx-reload reload-certs-only` path (which runs `nginx -t` then reload, no map swap). Alerts fire at 30 and 21 days remaining. Cert A and Cert B renew independently so one failing cannot take both planes down.

DNS data plane: `*.app.sisp.com A 192.168.0.25` plus explicit records for persistent vhosts. The wildcard absorbs every ephemeral host — zero per-instance DNS churn.

### 5. Lifecycle: register, ready-gate, teardown, reload safety

Route state is derived from the app record; nginx is stateless. **Port allocation and reload are no longer in the request's critical path, and allocation is now atomic.**

**Atomic allocation (fixes TOCTOU, review high).** The scaffold `allocatePort` read a global used-set and returned the first free port, with the read-modify-write spanning `await` points and no lock — two concurrent launches got the same port. It also chose the port *before* SLURM picked a node, so the design's "(node,port) quarantine" was incoherent (no node existed yet). Resolution:

- `allocatePort` + `createApp` + `routeHost`-uniqueness run under a **single in-process async mutex** (`postgres-store` uses `UPDATE ... RETURNING` in one transaction; `file-store` uses an `async-mutex` around the load→modify→save). The port reservation row is written before the lock releases, so no double-allocation.
- The allocated port is treated as a **global reservation token**, not a node-bound port. The *authoritative* `targetHost:targetPort` is established only after the job lands (below). Freed port numbers are quarantined globally for one reconcile cycle before reuse.

**Launch sequence:**

1. Backend (under mutex) reserves a port token, computes `routeHost`, asserts uniqueness. App `status=queued`; route published as `queued` in `routes.status.map` only. The HTTP handler **returns immediately** — it does not await a reload (fixes synchronous-reload serialization). The boot page covers the gap.
2. SLURM may sit PENDING. Reconcile reads `squeue -h -j <id> -o '%T|%N|%r'`; while PENDING it surfaces reason/est-start to the boot page as "you're #N in queue." A `maxPendingSeconds` ceiling fails the launch with an actionable message rather than spinning forever.
3. When SLURM reports RUNNING with a node, **`targetHost` is derived from `squeue %N` mapped through a trusted, hard-coded `nodeName → IP` table (node1..node4 → .25...28)** — *not* from the job-written `status.json host` field. This closes the config-injection path (§ below). State → `booting`.
4. **Readiness + identity gate.** Reconcile TCP-probes `targetHost:port`, then `GET /_apphub_id` which must echo the expected `appId+token`. Only on match does it `upsertRoute({host, appId, owner, targetHost, targetPort, status:'active', token})`, flip status `ready`, app `status=running`. A mismatch (port recycled to a different job) means **do not publish** and re-probe.
5. `syncNginxRoutes()` is **fire-and-forget into a debounced syncer** (500 ms–1 s trailing debounce + global in-flight lock), so a burst of 10 launches = 1 reload.

**Startup/crash reconciliation (review gap).** On AppHub boot, before serving traffic, the backend unconditionally regenerates both maps from the store, calls `swap` once, and reconciles orphans. This removes the divergence window where a crash mid-swap left on-disk maps and the store inconsistent.

**Teardown / GC.** On stop/fail/timeout/`--time` kill: `removeRoute(host)` (or flip to `booting` for bookmarked relaunch, §10) → regen → reload. Reconcile GC's any `active` route whose app is gone or whose identity probe fails for >2 cycles (covers node reboot, OOM-kill, `scancel` outside AppHub).

**Hardened reload wrapper.** Backend writes `*.candidate` temp files (same dir, `fsync` file + dir), then `sudo -n /usr/local/sbin/apphub-nginx-reload swap`:

```bash
#!/usr/bin/env bash
set -euo pipefail
D=/etc/nginx/apphub
exec 9>"$D/.swap.lock"; flock 9            # serialize concurrent swaps
cp -f "$D/routes.map"        "$D/routes.map.last-good"
cp -f "$D/routes.status.map" "$D/routes.status.map.last-good"
mv "$D/routes.map.candidate"        "$D/routes.map"
mv "$D/routes.status.map.candidate" "$D/routes.status.map"
sync -f "$D/routes.map"                    # fsync directory entry
if nginx -t; then
    systemctl reload nginx
    exit 0
fi
# rollback path MUST be observable -> no '&&' under set -e
cp -f "$D/routes.map.last-good"        "$D/routes.map"
cp -f "$D/routes.status.map.last-good" "$D/routes.status.map"
if nginx -t; then systemctl reload nginx; fi
echo "ROUTE_RELOAD_ROLLBACK" >&2
exit 75                                     # unconditional, always reached
```

The `&&` chain in the original could trip `set -e` and exit with a generic code before `exit 75`, misclassifying the exact event ops must see. The explicit `if` + unconditional `exit 75` fixes that; `flock` prevents two swaps interleaving the last-good snapshot. Backend maps exit 75 → audit `route.reload.rollback` + ops alert, last-good keeps serving. Sudoers tightened to the exact verb: `apphub ALL=(root) NOPASSWD: /usr/local/sbin/apphub-nginx-reload swap, /usr/local/sbin/apphub-nginx-reload reload-certs-only`.

**Worker-leak bound (review medium).** Graceful reload keeps SIGHUP'd workers alive until their connections close — for day-long Jupyter sockets that is ~never, and node1 also runs LDAP, the CIFS gateway, the auth daemon and the AppHub backend, so leaked workers there can exhaust the whole control plane. Mitigation: `worker_shutdown_timeout 30s` (idle-but-open sockets are cut; Jupyter/Shiny auto-reconnect), debounced + coalesced reloads at a bounded cadence, and a monitor on the count of "worker process is shutting down" processes.

### 6. Per-app authorization at the proxy (critical fix)

The scaffold's `/_apphub_auth` forwarded only the cookie and `X-Original-URI` (the path) — never the host — so the `:8888` daemon could answer only "is this a valid SISP session?" Any logged-in user could open `jupyter--u-dianap.app.sisp.com` and be proxied straight into Diana's notebook (which typically runs token-disabled because "the gateway handles auth"). That is full filesystem access as another user, and it directly contradicts the per-tenant isolation requirement.

Resolution:
- nginx now sends `X-Apphub-Host $host` on the `/_apphub_auth` subrequest.
- The `:8888` daemon resolves `host → route record → owner` (explicit `owner` field, **never** parsed from the hostname) and returns **403 unless** the session user is the owner, an explicit share, or an admin. Authentication (valid session) and authorization (this user may use this app) are now distinct.
- nginx maps 403 → branded `@apphub_forbidden` page.
- The same owner check guards the boot/relaunch endpoint (§10), so visiting someone else's bookmarked URL cannot trigger relaunch of their app.
- **Smoke test added:** user B receives 403 on user A's app URL; user A receives 200; admin receives 200.

### 7. On-node co-tenant isolation (critical fix)

§8's firewall only filters traffic arriving at the compute node *from off-box*. SLURM packs multiple users onto one node, so another job on node2 could reach `http://127.0.0.1:31042` or `http://192.168.0.26:31042` locally and hit a co-tenant's tokenless app — bypassing node1, TLS, `auth_request`, and the §6 authz fix entirely. The proposed `/_apphub_id` token echo made target discovery *easier*. Network ACLs scoped to node1 do nothing against loopback peers.

Resolution — **defence in depth, owned jointly with Containers + Backend:**
1. **Per-job network namespace.** Each Apptainer job runs in its own netns (SLURM job-container `--network` / a netns+veth setup in `apphub-runner.sh`). The app's listener is bound inside the namespace and is reachable only via the veth from node1's gateway hop, **not** from co-located jobs on the host's loopback/host IP. This is the primary control.
2. **Keep each app's native auth as a second gate.** Apps are **not** run token-disabled. Jupyter keeps a per-job token, RStudio keeps `auth-required`; the secret is generated by AppHub, injected into the job env, stored server-side, and **injected by the gateway** (`proxy_set_header Authorization` / token query param from the route record) so the user never sees or needs it. Even if namespace isolation failed, a co-tenant still hits an authenticated listener.
3. **Remove the unauthenticated `/_apphub_id` token echo.** Identity verification (§5 step 4) instead uses a secret the probe already holds, sent as a request header the app reflects only to an authenticated caller, or a control-socket check — never an open endpoint that hands out the app token.

### 8. Config-injection hardening (high fix)

`nginxEscape` only stripped `;` and escaped `\` — not newlines, `{`, or `}` — and `route.targetHost` came from `status.json`'s `host` field written on the compute node where untrusted user code runs. A crafted host with an embedded newline + a *syntactically valid* nginx directive passes `nginx -t` and ships into the root-owned `routes.map`. Resolution:
- **Do not trust job-written host fields.** `targetHost` is derived from `squeue %N` → trusted `nodeName→IP` table (§5 step 3). The container cannot influence the upstream IP.
- **Allowlist, fail-closed.** Before persist/render, `targetHost` must be exactly one of `192.168.0.25–28` or the route is rejected. `targetPort` must be an integer in 31000–31999.
- `nginxEscape` is replaced by a validator that **rejects** (not escapes) any character outside `[A-Za-z0-9._:-]` in host/upstream fields, and the host label is validated against the `<slug>--u-<owner>` grammar.

### 9. Firewalling, observability

- **Firewall (necessary, not sufficient — see §7):** node2/3/4 `nftables` allow `192.168.0.25 → tcp 31000-31999`, drop else. This keeps compute nodes invisible to *external* clients; the LAN hop `http://192.168.0.26:31042` is plaintext, the public hop is TLS. On-node isolation is handled by §7, not this rule.
- Per-class access log with `$host $apphub_upstream $apphub_route_state $request_time $upstream_response_time` → `/var/log/nginx/apphub-apps.access.log`.
- `X-Request-Id` minted at ingress (`map $request_id`), forwarded to apps and AppHub.
- Extended `check-nginx-node1.py` (scheduled + post-reload): wildcard cert validity/expiry for **both** certs; every `active` route has a live map entry that TCP-answers; no orphan map entries; `nginx -t` clean (alarms on persistent-vhost breakage independently); **user-B-gets-403** authz assertion.
- `/api/admin/routes` exposes route count per node for the frontend cluster-health strip.

### 10. Idle handling, time limits & bookmarks

- **Idle cull:** reconcile reads per-host last-activity from the access log; instances idle beyond threshold are flagged and offered for stop, reclaiming node[2-4] capacity.
- **Hard `--time` kill (review gap):** SLURM wall-clock is the ceiling; a scancel mid-session loses unsaved in-memory state. Two mitigations: (a) the launch UI sets `--time` from a profile and the boot/app chrome shows remaining wall-clock + a "extend session" action (re-queues with a fresh allocation, owner-checked); (b) all app working data lives on the LDAP-owned CIFS-gateway home (`sisplockers/<username>`, the storage subsystem) so files survive the kill — only volatile kernel state is lost, and that is communicated up front.
- **Bookmarked/stopped apps:** when an app stops, its host stays in `routes.status.map` as `booting`/relaunch rather than 404, so bookmarks resolve to a "relaunch?" page. **That relaunch endpoint runs the §6 owner check** — visiting another user's stopped URL shows 403, never silently relaunches their app.

### Interfaces to other subsystems

- **Auth/SSO (`:8888` daemon):** now receives `X-Apphub-Host`; must implement `host→owner` ACL (owner/share/admin) and return 403; shared by all AppHub-managed vhosts. Persistent third-party apps keep their own auth.
- **Backend (AppHub `:8792`):** atomic `allocatePort`+`createApp`+uniqueness under mutex; serves `/internal/boot` (queue position from squeue), `/denied`; derives `targetHost` from squeue node map; writes candidate maps + `fsync`; debounced fire-and-forget syncer; startup reconciliation; consumes reload exit 75.
- **Containers/SLURM:** per-job netns isolation; native app token injected from env; identity check without an open token-echo endpoint; job reports state but **not** the trusted upstream IP.
- **Storage (CIFS gateway):** app working dirs on `sisplockers/<username>` so `--time` kills don't lose files.
- **Frontend:** boot page (queued/booting/relaunch/forbidden states), cluster-health strip from `/api/admin/routes`, Design Direction chrome on all branded error/boot pages.

### How each review issue was resolved

| # | Issue (sev) | Resolution |
|---|---|---|
| 1 | No per-app authz (critical) | §6: `X-Apphub-Host`, daemon host→owner ACL, 403 default, smoke test |
| 2 | On-node co-tenant bypass (critical) | §7: per-job netns + native app token pass-through + remove token echo |
| 3 | Port-alloc TOCTOU / incoherent quarantine (high) | §5: single mutex / transactional alloc, global port reservation, node from squeue |
| 4 | nginx config injection via targetHost (high) | §8: derive host from squeue node map, IP allowlist fail-closed, reject bad chars |
| 5 | routeHost truncation collisions (high) | §1: reject (400) over-length, `--u-` delimiter, explicit owner field, global uniqueness |
| 6 | Reload wrapper swallows exit 75 (med) | §5: explicit `if`, unconditional `exit 75`, `flock`, dir fsync |
| 7 | Worker accumulation (med) | §5: `worker_shutdown_timeout 30s`, bounded-cadence reloads, monitor |
| 8 | No queued state / infinite boot (med) | §3/§5: `queued` state from squeue PENDING, queue position, max-pending timeout |
| 9 | Synchronous reload + no startup reconcile (med) | §5: fire-and-forget debounced syncer, boot-time map regeneration + swap |
| 10 | Cert renewal vs confirmation rule + DNS token surface (med) | §4: renewal pre-authorized (validated, non-routing), CNAME challenge delegation, scoped token |


**Dependencies:** auth-sso (the :8888 daemon must implement host->owner ACL returning 403, consume X-Apphub-Host, and remain the shared SSO for AppHub vhosts), backend-apphub (atomic allocatePort/createApp/routeHost-uniqueness under mutex or transaction; squeue node->IP derivation; candidate-map writing + fsync; debounced fire-and-forget syncer; startup reconciliation; /internal/boot and /denied endpoints; exit-75 handling), containers-slurm (per-job network namespace isolation; native app token generation/injection; identity verification without an open token-echo endpoint; jobs report state but not the trusted upstream IP), storage-cifs-gateway (app working dirs on sisplockers/<username> so --time kills do not lose files; LDAP uid/gid ownership mapping), frontend (boot/queue/relaunch/forbidden branded pages per Design Direction; cluster-health strip consuming /api/admin/routes; session wall-clock + extend-session UI), dns-tls-ops (wildcard DNS records, DNS-01 with CNAME challenge delegation, certbot renewal automation, two independent wildcard certs)

**Open questions:** 
- Per-job network namespace: which mechanism is approved on this cluster — SLURM job_container/tmpfs + network plugin, Apptainer --net/--network, or a custom unshare+veth in apphub-runner.sh? This determines the §7 primary isolation control and needs a root-level setup that exceeds the confirmed-reload boundary.
- Capacity: what are the measured limits for node1 as the single websocket funnel (target concurrent long-lived connections), and is moving the CIFS gateway or auth daemon off node1 acceptable if contention shows up under load testing?
- Sharing model: beyond owner/admin, do researchers need to share an app instance with named colleagues or a lab group (LDAP group)? The :8888 ACL design must know whether shares are per-user, per-group, or both.
- DNS provider: which registrar/provider hosts the sisp.com zone and does it support API-based DNS-01 plus CNAME delegation to a dedicated _acme-challenge zone? If not, what is the fallback issuance path for Cert B?
- Session extension policy: should 'extend session' re-queue a fresh SLURM allocation (risking a wait when the cluster is full) or request a --time bump on the running job, and what is the max allowed wall-clock per template?
- maxPendingSeconds: what queue-wait ceiling should fail a launch, and should priority/preemption be used so interactive apps are not starved by long batch jobs on the shared 112-CPU pool?


---

<a id="backend-services"></a>

## AppHub Backend & Control Plane

### Purpose

AppHub Backend & Control Plane is the single stateful brain that turns a non-technical wet-lab researcher's "launch JupyterLab" click into a SLURM job on node[2-4], discovers where it landed, waits until the app is actually serving, and rewires nginx so `https://<slug>-<user>.app.sisp.com` reaches it — then keeps that truth consistent forever via a crash-surviving reconciler. It also folds the always-on third-party services (cmssight, dmmr, leantime, zulip, vitessce) into the same route table and dashboard. It is the load fix for Core Problem B: jupyter/rstudio/galaxy stop being always-on on node1 and become scheduled, TTL-bounded, fairly-quota'd jobs on the 112-CPU/512-GB farm.

The existing Codex scaffold at `sisp-mapdrive/apphub` (Node `http` + `lib/slurm.js` + pluggable store + `routes.map` sync + `apphub-sbatch-as-user.sh`) is the spec for the *shape* — thin API, privileged-wrapper security boundary, a store, a reconcile loop owning the nginx map — but is being fully rebuilt in TypeScript/Fastify/Postgres with the production gaps closed.

### 1. Stack & process model

- **Runtime:** TypeScript (strict, ESM) on Node 20 LTS. **Fastify 4** HTTP surface with Zod schema validation/serialization and `fastify.inject()` tests. The scaffold's hand-rolled `node:http` + regex routing is replaced; its handler logic is the spec.
- **DB:** Postgres-only (file-store was a dev crutch, deleted). `pg` + Kysely for compile-time-checked SQL. SQL migrations under `migrations/NNNN_*.sql`, applied by `apphub-migrate` on deploy. Boot **verifies** `schema_migrations` head and refuses to start on mismatch; it never auto-migrates in prod.
- **Process:** one `apphub.service` systemd unit (user `apphub`) on `127.0.0.1:8792` behind nginx on node1. The API is stateless and can scale later; the **reconciler + command worker run as a single writer** guarded by a Postgres advisory lock (`pg_advisory_lock(0x4150)`). A process that fails to take the lock serves read/write API but performs no node-touching effects.
- **Config:** keep the scaffold env contract verbatim (`APPHUB_SLURM_MODE`, `APPHUB_CLUSTER_NODES`, `DATABASE_URL`, `APPHUB_SBATCH_WRAPPER`, `APPHUB_NGINX_ROUTE_MAP`, `APPHUB_NGINX_RELOAD_CMD`, `APPHUB_WORKSPACE_BASE`, `APPHUB_IMAGE_ROOT`, `APPHUB_PORT_RANGE`, `APPHUB_RECONCILE_INTERVAL_MS`, …) so `deploy/apphub.env.node1` and `install-node1.sh` keep working; validate with Zod at boot; refuse prod start with `slurmMode=mock`. New: `APPHUB_COORD_ROOT` (NFS coordination dir, see §6), `APPHUB_INFRA_CONFIRM=1`, `APPHUB_MAX_QUEUE_WAIT_MIN`, `APPHUB_RELOAD_DEBOUNCE_MS`, `APPHUB_PER_USER_INFLIGHT`.

### 2. Postgres schema (source of truth)

Hot, operationally-critical columns are normalized out of JSONB so the reconciler and quota engine can index/aggregate; `data jsonb` remains the cosmetic escape hatch. Tables: `apphub_users` (LDAP mirror for display + quota, **not** an auth store; adds `workspace_uid`, `migration_state` ∈ `legacy|migrating|ready`, `gpu_quota`), `apphub_templates` (versioned), `apphub_instances` (promotes `status`, `desired_state`, `cpus`, `memory_mb`, `gpus`, `time_limit_min`, `port`, `node`, `target_host`, `slurm_job_id`, `route_host unique`, `persistent`, `ready_at`, `log_dir`; partial-unique index on `port` only while non-terminal), `apphub_commands` (the effect queue — see §3), `apphub_routes` (projection: `host pk`, nullable `instance_id`/`external_id`, `target_host`, `target_port`, `websocket`, check that one of instance/external is set), `apphub_external_apps` (the 5 always-on services, `managed_by='external'`, `health_url`), `apphub_approvals`, `apphub_audit` (no row cap — Postgres, time-indexed), `apphub_support_threads` (carried over unchanged), `schema_migrations`.

### 3. Command queue — idempotency, confirmation, crash recovery

Every node-touching effect is a row in `apphub_commands`, never a direct call from a request handler. The handler validates, writes instance + a `pending` command in one transaction, returns 202. The advisory-locked **command worker** drains the queue with `for update skip locked`, executes via the privileged wrapper, writes `result/done|failed`, and backs off `available_at = now() + min(2^attempts, 300)s`. Poison (attempts ≥ 6) → `failed` + audit + admin alert.

**Confirmation is applied at the correct layer (review fix).** The "human confirms node changes" constraint governs the *build/deploy agent*, not the non-technical end user — gating every researcher's Jupyter launch behind a human approval is operationally unworkable 24/7 and was self-contradicted by the original "auto-approve the common envelope" mitigation. Resolution: two distinct domains.
- **Infrastructure / agent actions** (`requires_confirm=true`, `APPHUB_INFRA_CONFIRM=1`): migrations, structural nginx changes, CIFS-gateway provisioning, template edits, external-app CRUD, deploys, and any **privileged** launch (public-host, persistent, oversized beyond template default, admin-pinned nodes). These sit `awaiting-confirm`, surface in `GET /api/admin/commands?state=awaiting-confirm`, and execute only after `POST /api/admin/commands/{id}/confirm`.
- **Routine in-envelope user launches** (≤ template ceiling, default-node, within quota) flow automatically under SLURM's own limits, **audit-only**. They are still durable queue rows (crash-safe, idempotent) but not human-gated.

**Idempotency that survives the sbatch/persist gap (review fix).** The original `idempotency_key` embedded an `attemptGeneration`, so it changed across retries and did *not* protect a crash between a successful `sbatch` and persisting the job id. Resolution: (a) job name is `apphub-<instanceId>` (exact, not slug); (b) the wrapper is **idempotent-return, not refuse** — if a live `apphub-<instanceId>` job already exists it prints that job id and exits 0; (c) on boot recovery, before re-submitting, the worker runs `squeue --name=apphub-<instanceId>` and **adopts** any existing job id into the instance row. No orphaned allocations, no hard-failing replay.

**Crash recovery:** on boot, commands stuck `running` > `staleMs` reset to `pending`/`approved` (effects are idempotent). Intent is always persisted before execution.

**Backpressure (review fix for unbounded queue):** per-user in-flight cap (`APPHUB_PER_USER_INFLIGHT`, default 3 pending launch commands) rejects double-click/reconcile storms at admission with 429; a global worker concurrency limit bounds simultaneous wrapper executions.

### 4. Instance lifecycle (state machine owned by the reconciler)

```
(create) → queued → submitting → queued@slurm → starting → pending-ready → running
   any → stopping → stopped        starting/running → failed (SLURM FAILED/TIMEOUT/OOM, runner exit≠0, or readiness timeout)
   queued@slurm --(wait > APPHUB_MAX_QUEUE_WAIT_MIN)--> failed("no capacity right now")
```

`desired_state` (running|stopped) is intent; `status` is observed reality; the reconciler drives one toward the other. Stop = set `desired_state=stopped` + enqueue `slurm.cancel`; the route is removed only after SLURM confirms the job is gone.

**Reconciler loop** (`APPHUB_RECONCILE_INTERVAL_MS`, default 15s):
1. Acquire advisory lock (skip tick if not held).
2. Load all non-terminal instances.
3. **One batched SLURM query per tick (review fix for O(N) forks):** `squeue -h -a -o '%i|%T|%N|%j'` (filtered to the `apphub-` name prefix), joined to instances in memory; `scontrol show job <id>` only as a fallback for an instance absent from `squeue`. N RPCs against the single-threaded slurmctld become 1.
4. **Route activation is gated on real readiness (review fix for the 502 window).** The original "two-phase promote" only closed the 404 race, not the 502: the route went live the moment `status.json` reported a host, before JupyterLab/Galaxy was listening (Galaxy needs tens of seconds). Resolution: the runner writes `ready` to `runner-status.json` **only after a successful local TCP connect to its own bound port**, and reports the actual port. The reconciler activates the route and sets `running` **only when** `runner-status=ready` *and* its own TCP connect to `target_host:port` succeeds. Until then `status=starting`, no route, dashboard shows an honest "starting…".
5. Terminal states clear the route and stamp `last_error`.
6. After the batch, render the **entire** route map once (instances + external apps + persistent approved) and reload nginx once. The map file is fully regenerated each sync (idempotent), never patched.
7. **Reverse sweep (review fix for orphans):** any `apphub-*` job in `squeue` with no live instance row is `scancel`'d (audited) so recovery-edge orphans cannot waste node[2-4].
8. **Reload coalescing (review fix for worker pile-up):** route changes set a dirty flag; the actual `nginx -s reload` is debounced (`APPHUB_RELOAD_DEBOUNCE_MS`, default 3s, max one reload/2s). With 1-hour WebSocket `proxy_read_timeout`, frequent reloads would otherwise pile up draining old workers; debouncing plus FD/worker capacity planning (§7) bounds it.

**Hung-job detection is authoritative via TCP + SLURM state, not file mtime (review fix).** Heartbeat files cross the mount and SMB attribute caching makes mtime both false-positive and miss real deaths. Resolution: a job is declared dead only when SLURM still shows it RUNNING **and** a direct TCP connect to `target_host:port` fails across two consecutive ticks. On death: `failed`, clear route, optionally enqueue a confirm-gated `slurm.cancel`.

**Partition-full / preemption policy (review fix for the missing capacity story).** Interactive sessions submit to a dedicated **non-preemptible `interactive` QOS** with a hard concurrency cap, so a researcher's unsaved notebook is never killed mid-analysis by backfill. If a job PENDs longer than `APPHUB_MAX_QUEUE_WAIT_MIN` (default 10 min), AppHub cancels it and returns an honest "the cluster is full right now — try again shortly or ask an admin," instead of an infinite spinner. Time limits are mandatory (default 8 h, max 24 h; longer only via persistent approval) so abandoned notebooks auto-reap.

### 5. API surface (Fastify, `/api`, Zod-validated)

Auth via `X-Remote-User`/`X-Remote-Groups` injected by nginx after the auth gateway; a `preHandler` builds `request.actor`. Admin = `APPHUB_ADMIN_USERS` ∪ group ∈ `APPHUB_ADMIN_GROUPS`. Endpoints preserve the scaffold contract: `GET /api/health` (adds reconciler-lock-held, queue depth, migration head), `/api/session`, `/api/templates`, `GET /api/apps` (read-only — no writes on GET; writes are the loop's job), `POST /api/apps` (quota + ceiling check → instance + `slurm.submit` in one tx → 202; `Idempotency-Key` header), `POST /api/apps/{id}/stop|restart|duplicate|clear`, `GET /api/apps/{id}/logs` (+`?stream=1` SSE tail), `POST /api/apps/{id}/persistence`, `GET /api/drives` (live CIFS-gateway health **and per-user migration state**). Admin: `/api/admin/overview`, `/routes`, `/reconcile`, `/apps/{id}/approval`, `/templates`, `/audit`, **`/commands` + `/{id}/confirm` + `/{id}/cancel`** (confirmation cockpit), **`/external-apps`** (CRUD), **`/nodes`** (live `sinfo`/`scontrol` incl. GPU gres). Error contract: `{error:{code,message,details?}}`; Zod failures → 400 with field paths the launch wizard highlights.

### 6. Security boundary & cross-node coordination

The backend runs unprivileged. The only escalation is two sudoers NOPASSWD entries: the sbatch-as-user wrapper and `apphub-nginx-reload`.

**Wrapper uid-selection is now fail-closed (critical review fix).** The scaffold degraded through `entry_from_owned_path` to `head -n 1` of `getent`, so a forged `X-Remote-User: root` (or any `uid<10000` service account) yielded `sbatch --uid=0 --gid=0 <script>` — arbitrary root code execution on node[2-4]. Resolution:
- **Delete the `head -n 1` fallback and the owned-path heuristic.** The wrapper **REFUSES with non-zero exit** when no passwd entry satisfies `uid >= APPHUB_PREFERRED_UID_MIN` (10000) OR `gid == APPHUB_PREFERRED_GID` (100000).
- AppHub passes the **numeric uid/gid it mirrored from LDAP** (`apphub_users.uid_number/gid_number`); the wrapper asserts `getent passwd <username>` agrees with those numbers and that `uid >= 10000`, rather than re-deriving identity from a username string.
- **Tighten the sudoers glob** so the wrapper cannot be invoked with system usernames — restrict the `submit`/`cancel` argument to the canonical user pattern and reject reserved names (`root`, `nodeadmin`, `daemon`, `bin`, …) in both sudoers and the wrapper.
- Correct LDAP ownership is therefore enforced **purely through `sbatch --uid/--gid`**, not through `chmod 0o2775`/setgid (CIFS without unix extensions silently ignores those — review fix); chmod is treated as best-effort defense-in-depth only.

`apphub-nginx-reload` runs `nginx -t` before `nginx -s reload`; the backend writes only the single generated `routes.map` (`include`d by the static vhost). A bad map cannot take nginx down because `-t` gates the reload.

**Coordination on real POSIX (high review fix).** `status.json`, `runner-status.json`, heartbeats, and logs live under `APPHUB_COORD_ROOT` — an **NFS export from node1**, never the CIFS re-export. User *workspaces* may stay on CIFS, but the control-plane's status/log channel needs proper cross-node mtime/lock semantics; the smoke suite asserts the coord mount honors them.

**Per-user storage migration gate (medium review fix).** A user whose NAS folder is still legacy-owned (uid 1005–1017) would hit EACCES at startup. At launch time AppHub `stat`s that user's workspace/home; if owner `uid<10000` it refuses with "your storage is still being migrated," sets `apphub_users.migration_state`, and surfaces it in `/api/drives`. Cutover is sequenced so the storage subsystem's chown completes (or is verified) before launches are enabled per user — not a single coarse global check.

### 7. Ingress: TLS, DNS, cookie isolation, auth caching, capacity

**Dedicated `*.app.sisp.com` certificate + DNS (critical review fix).** A `*.sisp.com` wildcard cert does **not** match `<slug>-<user>.app.sisp.com` (TLS wildcards cover exactly one label) — every launch would throw a full-page cert error, fatal for non-technical macOS/Windows users. Resolution: provision a dedicated `*.app.sisp.com` certificate (or add it as a SAN), a wildcard DNS record `*.app.sisp.com → 192.168.0.25`, a separate `sisp-app-ssl.conf` snippet referenced by the `*.app.sisp.com` server block, and a deploy smoke check that `curl`s a sample host and asserts a valid chain.

**SSO cookie is stripped before proxying to untrusted upstreams (critical review fix).** gradio/streamlit/dash/fastapi run arbitrary user code at `*.app.sisp.com`; the scaffold forwarded the client `Cookie` (incl. the `.sisp.com`-scoped `nginxauth` SSO cookie) to that upstream, so a malicious app could exfiltrate another user's or an admin's SSO token → cross-`*.sisp.com` account takeover. Resolution: in the `*.app.sisp.com` `location`, `proxy_set_header Cookie "";` — the SSO token never reaches untrusted upstreams; identity is passed only via `X-Remote-User`. `auth_request` still validates the cookie at the edge before stripping.

**Auth-decision caching (high review fix for the relocated bottleneck).** Both server blocks call `auth_request → 127.0.0.1:8888/check` on **every** request; JupyterLab/RStudio/Galaxy XHR polling would hammer the single nginxauth+OpenLDAP service on node1, re-creating the concurrency collapse at the ingress. Resolution: after the first LDAP bind, the gateway issues a **short-lived signed/HMAC session cookie** so `/check` becomes O(crypto), not O(LDAP); plus `proxy_cache` on the auth subrequest keyed on that cookie with a short TTL. The auth path is load-tested at ≥ 50 concurrent live sessions before cutover.

**WebSocket/FD capacity:** with 1-hour `proxy_read_timeout` and reload debouncing (§4.8), node1 nginx `worker_connections` and the systemd `LimitNOFILE` are sized for the target concurrent-session count (planned ceiling documented in deploy notes); each live app holds ≥ 2 sockets through a reload drain window.

### 8. Execution model: templates, isolation, ports, GPU

**Apptainer hardening for untrusted code (medium review fix).** `run_manifest.py` used only `apptainer exec --cleanenv` — default-mounting `$HOME`, `/tmp`, `/proc` and sharing the host PID namespace, so a tenant could read shared mounts and observe other tenants' processes. Untrusted templates (streamlit/dash/fastapi/gradio) now run `apptainer exec --containall --no-home --writable-tmpfs -p -i`, bind **only** the user's workspace, drop host `$HOME`/`/tmp`, and run under SLURM cgroup CPU/memory constraints. Shared-mount POSIX perms are defense-in-depth, not the primary boundary.

**Dynamic port selection (medium review fix).** Pre-assigning a 31000–31999 port before SLURM placed the job risked a bind collision on the landing node. The runner now binds an **ephemeral free port on its actual node**, verifies it, and reports it in `status.json`; AppHub routes to the reported `target_port` (the route table already carries it). Global uniqueness is no longer load-bearing.

**Template execution-model classification (medium review fix).** Templates are tagged by model. Simple single-port servers (jupyterlab, streamlit, dash, fastapi, gradio, static-html) take the ephemeral per-user batch path. **Galaxy is reclassified as an external/persistent app** (like zulip/leantime) or given a dedicated long-lived no-TTL allocation with documented SLURM/DRMAA integration — it is itself a job submitter and must not be wall-clock-killed mid-analysis. **RStudio-server** is verified to run `rserver` in single-user/`auth-none` mode as the mapped non-root uid (`rstudio.def` documented accordingly).

**GPU model (review fix for the missing GPU story).** Templates carry an optional `gpus`/`gres` field; `apphub_users.gpu_quota` clamps concurrency; GPU-bearing nodes are a labeled SLURM gres partition; `/api/admin/nodes` surfaces GPU allocation. Non-GPU templates submit with `--gres=none`.

**Image locality (review fix for cold-CIFS reads).** SIF images on `APPHUB_IMAGE_ROOT` read cold over CIFS would undercut the "snappy Open" goal. Policy: images are prewarmed to a **node-local cache** on node[2-4] (`/opt/apphub/images`), the runner prefers the local copy and falls back to the shared root, and `build-runtime-images` + `prewarm-runtime-images` populate the local cache on deploy.

### 9. Quota, approvals, audit, external apps

AppHub does not bin-pack — SLURM does. It enforces template ceilings (clamp one request) and per-user quotas (`cpu_quota/mem_quota_mb/gpu_quota/max_running`, clamp concurrency); `POST /api/apps` sums the user's active usage and rejects over-quota with a friendly 409. Approvals (`public-host`/`persistent`) flow through `apphub_approvals` → admin `PATCH /approval` (can bump resources within cluster max, set `routeHost`); approved persistent apps are exempt from the reaper but still TCP-heartbeat-monitored. Every state-changing action writes `apphub_audit`. The 5 always-on services live in `apphub_external_apps` (`managed_by=external`): the reconciler routes and health-checks them but never `sbatch`/`scancel`s them, unifying everything at `*.sisp.com` into one control plane and dashboard.

### 10. Interfaces to other subsystems

- **Auth gateway / OpenLDAP (node1, 127.0.0.1:8888):** provides `X-Remote-User`/`X-Remote-Groups` and (new) the signed session cookie AppHub's ingress caches on. AppHub mirrors uid/gid for display/quota only.
- **Storage subsystem (CIFS gateway / NAS chown):** owns the per-user chown from legacy uids to the 10000 range; AppHub gates launches on its per-user `migration_state` and reads CIFS-gateway health for `/api/drives`. Coordination/status/log channel is on AppHub's own NFS export, decoupled from CIFS.
- **SLURM (slurmctld on node1, compute node[2-4]):** AppHub submits via the wrapper, reads truth via one batched `squeue`/tick, depends on the `interactive` QOS and GPU gres partition being configured.
- **nginx (node1 ingress):** AppHub owns the generated `routes.map`; depends on the `*.app.sisp.com` cert/DNS and the cookie-stripping/auth-cache vhost config.
- **Frontend (apphub clean rebuild):** consumes this API contract, the SSE log stream, the commands cockpit, and node/GPU utilization gauges.

### 11. Migration / cutover

`apphub-migrate up` → one-shot `import-legacy.ts` (reads scaffold `server/data/apphub.json`; harmless if empty) → seed `apphub_users` from LDAP (`ldapsearch`) → seed `apphub_external_apps` for the 5 services → boot `slurmMode=mock` to run the contract smoke tests against the new API, then flip to `slurm` and run `real-slurm-smoke-node1.py` (launch → poll target host → **readiness** → nginx route). Cert/DNS smoke check and auth-path load test are cutover gates.

### 12. Single-writer SPOF runbook (review fix)

The advisory-locked reconciler/worker is a deliberate SPOF for *writes*. While it is down, nginx keeps serving the last rendered map (existing apps keep working), but new launches, route changes, external-app health flips, and reaping freeze. Documented degraded behavior + operator runbook: detect via `GET /api/health` (`reconciler-lock-held=false`, rising queue depth) and `/metrics`; recover by restarting `apphub.service` (boot recovery adopts running jobs and rebuilds the map in one tick). Horizontal API scaling is supported; the writer remains singular by design.


**Dependencies:** auth-gateway-ldap, storage-cifs-gateway, slurm-scheduler, nginx-ingress, apphub-frontend, postgres-node1

**Open questions:** 
- What is the planned peak concurrent live-session count (drives nginx worker_connections, LimitNOFILE, and the auth-path load-test target)? Need a number to size node1 FD/memory capacity.
- Are there GPUs in node[2-4] at all, and if so on which nodes and how many — this determines whether the GPU gres partition is real on day one or a forward-looking schema field only.
- For Galaxy: is a dedicated long-lived allocation acceptable, or should it become a fully external persistent app with its own host/Postgres and DRMAA SLURM backend? This changes the cutover and ops ownership.
- Confirm the auth gateway can be extended to issue a signed/HMAC session cookie (or that proxy_cache on /check is acceptable) — if neither is feasible, the per-request LDAP load-test must pass unaided at the target concurrency.
- Which mount hosts user workspaces at launch time during the migration window — pure CIFS re-export, or NFS — and what is the verified per-user chown completion signal AppHub should read for migration_state?
- Who operates the confirmation cockpit for infrastructure actions during off-hours, and what is the escalation/timeout policy for an awaiting-confirm command that no admin approves?
- Is a dedicated *.app.sisp.com certificate obtainable from the existing CA/process, or must app routes share a SAN on the apphub.sisp.com cert (affects renewal automation)?


---

<a id="frontend-architecture"></a>

## Frontend Architecture

### 0. Purpose and grounding

The frontend is a clean-rebuild single-page application (SPA) that replaces the existing `apphub/web/{index.html,app.js,styles.css}` vanilla bundle (verified: ~20KB single file, Arial, light-only, text nav, table rows, all-at-once forms, `alert()` logs, hardcoded hex, 38px hit targets). It is the **primary human surface** for the 80% non-technical wet-lab users to launch and manage cluster apps, and a dense secondary surface for the 15% power/admin users — implementing the approved `docs/design/DESIGN_DIRECTION.md` contract ("Linear bones, Stripe warmth", teal `#11695f`, self-hosted Inter + JetBrains Mono + Remix Icon, light-default with dark, calm-by-default/powerful-on-demand).

**Premise correction from review (critical).** The original overview asserted "backend kept as-is, zero added load." That is **retracted**. Per master decision (1) the whole apphub code is a full clean rebuild, so the frontend and backend are co-designed siblings. What remains true and load-bearing is narrower: **the frontend adds no new long-running runtime to node1** (it ships as static bytes served by the existing nginx). The frontend instead **declares a read-path contract that the Backend subsystem must satisfy** (§5, §6, §11). This is the honest resolution of the reconcile-on-read problem: the cost of `GET /api/apps` is a backend concern, and the frontend is explicitly forbidden from being the pacing source for SLURM reconciliation.

### 1. Stack and repository layout

**Stack:** React 18 + TypeScript + Vite 5 + Tailwind CSS 3 (tokens as CSS variables, not the stock palette) + TanStack Query v5 (server state) + TanStack Router (type-safe routing) + Zustand (tiny UI state: theme, palette open, wizard draft) + `cmdk` (command palette) + Radix UI primitives (Dialog/Popover/Tooltip/Toast — accessible, unstyled, we own the CSS). Icons are imported as **tree-shaken inline SVG React components** (not the full webfont — see §10). Fonts self-hosted and **subset** via `@fontsource-variable/inter` (subset to latin) + `@fontsource/jetbrains-mono` (latin, weights 400/500).

**Why a static SPA, not a meta-framework (Next/Remix):** the artifact must be a hashed static `dist/` served by nginx behind the existing `apphub.sisp.com` vhost — no Node SSR runtime in the request path, no second long-running process competing with the already-overloaded node1 (Core Problem B). SPA + client routing + the existing JSON API is the correct shape.

```
apphub/web/                      # replaces current web/
  index.html                     # Vite entry; CSP meta; loads /theme-boot.<hash>.js synchronously in <head>
  theme-boot.ts                  # externalized no-FOUC theme bootstrap (hashed asset, NOT inline — see §2)
  vite.config.ts                 # base:'/', manualChunks, brotli, build.outDir=dist
  tailwind.config.ts             # colors map to CSS vars; content globs
  src/
    main.tsx                     # QueryClientProvider, RouterProvider, ThemeProvider
    app/router.tsx               # route tree (9 screens)
    config/runtime.ts            # build-time VITE_* config incl. gateway login/logout URLs (§9)
    styles/{tokens.css,base.css}
    lib/
      api.ts                     # typed fetch wrapper: zod parse, structured errors, 401/401-body handling
      queries.ts                 # useApps(cached read), useTemplates, useDrives, useSession, useNodes, useAdmin*
      mutations.ts               # launch/stop/restart/duplicate/clear/persistence/approve
      schemas.ts                 # zod schemas (lenient on optional fields) = runtime contract
      live.ts                    # adaptive polling controller (single seam; §6)
      auth.ts                    # session bootstrap on authenticated===false; full-page redirect to gateway
      errors.ts                  # backend error-body parser ({error} AND {app.lastError})
    components/                  # Button, Card, StatusBadge, Gauge, Skeleton, Field, StaleBadge...
    features/{launch-wizard,command-palette,instances,admin}/
    screens/                     # 9 thin route components
    test/                        # vitest + @testing-library + axe-core + token-contrast unit test
```

### 2. Design tokens and no-FOUC bootstrap

`src/styles/tokens.css` holds **semantic tokens only**; `tailwind.config.ts` maps utilities to the vars (`colors:{ bg:'var(--bg)', brand:'var(--brand)', ... }`) so dark mode is a CSS-var swap with no class duplication.

```css
:root {                              /* light = default */
  --bg:#f7f9f9; --surface:#fff; --surface-2:#eef3f2;
  --ink:#10201d; --ink-muted:#5d6b68; --line:#dde5e3;
  --brand:#11695f; --brand-ink:#fff; --brand-soft:#e6f1ef;
  --accent-blue:#1f78c2; --focus:var(--accent-blue);
  --ok:#1f9d6b; --ok-soft:#e3f4ec; --warn:#c8821a; --warn-soft:#fbeed7;
  --err:#c8443a; --err-soft:#fbe5e3;
  --radius-s:6px; --radius-m:10px; --radius-l:16px; --space:8px;
  --shadow-1:0 1px 2px rgba(16,32,29,.06); --shadow-2:0 12px 30px rgba(16,32,29,.10);
  --t-fast:120ms; --t-panel:200ms; --t-status:400ms; color-scheme:light;
}
[data-theme="dark"]{
  --bg:#0d1413; --surface:#13201d; --surface-2:#172a26;
  --ink:#e8f0ee; --ink-muted:#9bb0ab; --line:#27433d;
  --brand:#2bb3a3; --brand-soft:#10302b; --accent-blue:#5aa6e6;
  --ok:#37c08a; --warn:#e0a13a; --err:#e76b60;
  --shadow-2:0 12px 30px rgba(0,0,0,.45); color-scheme:dark;
}
@media (prefers-reduced-motion:reduce){:root{--t-fast:0ms;--t-panel:0ms;--t-status:0ms}}
```

**Status is never color-alone.** `<StatusBadge>` renders icon + label + color for the **actual backend status vocabulary** (`queued|starting|pending-route|running|stopped|failed`): `running`→`ri-checkbox-circle-fill`+`--ok`; `queued|starting|pending-route`→`ri-loader-4-line` (spin, reduced-motion-safe)+`--warn`; `failed`→`ri-error-warning-fill`+`--err`; `stopped`→`ri-stop-circle-line`+`--ink-muted`.

**No-FOUC theme bootstrap, CSP-safe (fixes review medium #6).** The original inline `<script>` would be blocked by `default-src 'self'` (no inline-script allowance). Instead, `theme-boot.ts` is compiled to a **hashed external asset** `/theme-boot.<hash>.js`, loaded **synchronously in `<head>` before the stylesheet**; it reads `localStorage['apphub-theme']` (or `matchMedia('(prefers-color-scheme:dark)')`) and sets `data-theme` on `<html>` before first paint. CSP therefore stays `script-src 'self'` with no nonce/`unsafe-inline` needed. Theme toggle lives in the user panel and the command palette; persisted to `localStorage` immediately (mirrored to a backend prefs endpoint only if one is later added).

### 3. Routing and the 9 screens

TanStack Router, path-based under `apphub.sisp.com/...`, with nginx `try_files $uri /index.html` SPA fallback. Routes read `['session']`; admin routes additionally require `session.user.isAdmin`.

1. **`/` Dashboard** — cluster status strip (running/queued/failed/approvals from the apps list), "your active instances" preview cards, primary "Launch app" CTA. **Per-node CPU/RAM gauges render only if `GET /api/cluster/nodes` is available** (Backend dependency, §5/§11). If absent in v1, the gauge band **degrades gracefully** to a capacity/queue summary derived from the apps list (no fabricated data) — resolving review high #3 (the original gauges had no data source).
2. **`/launch`** — the 3-step wizard (§4).
3. **`/instances`** — **deployment cards** (not table rows): name, template, `StatusBadge`, JetBrains-Mono node/host, time-remaining ring, **Open** button that deep-links **strictly `app.url`** (which the backend builds as `https://<slug>-<owner>.app.sisp.com`; see §5/review appDomain note), overflow menu (stop/restart/duplicate/logs/persistence/clear).
4. **`/instances/:id`** — detail: live status, granted resource request, route/url, **LogsPanel** tailing `GET /api/apps/{id}/logs` (returns `{logs:{'stdout.log','stderr.log'}}`), JetBrains Mono, stdout/stderr tabs, auto-scroll + copy. Replaces the scaffold `alert()` logs.
5. **`/queue`** — Linear-style dense list of `queued|starting|pending-route` jobs showing **status + elapsed (derived from `createdAt`)** only. **No "queue position"** — the backend never surfaces `squeue --start` ordering and we derive nothing it doesn't provide (resolves review low #12).
6. **`/drives`** — renders `GET /api/drives` exactly (`shares[]` with `windowsPath`/`macPath`/`linuxPath`/`recommended`, `mapDriveUrl`, `uidNotice`, `sambaGateway.status`). Per-OS connection cards with copy-to-clipboard paths and a prominent MapDrive button; **steers users away from raw NAS mapped drives** (Core Problem A). Never auto-mounts.
7. **`/support`** — threads list + composer; reactions (`same/helpful/thanks`), status (`open/admin-needed/solved`), matching the support API shape. Plain-language.
8. **`/admin`** (admin-only) — dense tabbed surface over `GET /api/admin/overview` (apps, routes, counts, supportOpen): all-apps table with bulk stop/approve, approvals queue (`PATCH /api/admin/apps/{id}/approval`), templates manager (`PUT /api/admin/templates/{id}`), audit log, force reconcile. Dark-first density.
9. **`/login`** — split-panel brand hero + sign-in. **In production the gateway owns auth**, so this screen renders "Continue with SISP login" → full-page redirect to the configured gateway login URL (§9). The dev-login form (`POST /api/session/dev-login`) renders **only** when `session.devLogin === true`.

The nav gate is convenience; the security boundary is server-side (`requireAdmin` → 403, `requireActor` → 401).

### 4. Launch wizard — progressive disclosure

Three steps, draft in Zustand, zod-validated, "calm by default":

- **Step 1 — What do you want to run?** Template gallery cards (icon per `category`, plain `description`). One click selects and advances. No SLURM/port/container language.
- **Step 2 — Name it.** Single `name` field (maxlength 80). A subtle slug preview shows the **real route host** `<slug>-<owner>.app.sisp.com` (matching backend `appRouteHost`, `appUrlSuffix='.app.sisp.com'`) — correcting the original prose that said `slug-owner.sisp.com`. Defaults pre-filled from `template.defaultCpus/defaultMemoryMb/defaultTimeMinutes`. A collapsed **"Advanced resources"** disclosure reveals CPU/RAM/time sliders, **clamped client-side to exactly the backend bounds** (`template.maxCpus`/`maxMemoryMb`/`maxTimeMinutes`, falling back to the backend defaults 32 CPU / 131072 MB / 1440 min, and cluster ceilings 112 CPU / ~515 GB). **Visibility offers only `private` and `team`** — `public` is omitted because `launchApp` throws 400 for it (resolves review medium #8); "make public" is routed post-launch through persistence → admin approval.
- **Step 3 — Review & launch.** Human summary ("JupyterLab, 2 CPU, 8 GB, up to 8h, private") → **Launch** → `POST /api/apps`.

**Resource-truth handling (resolves review medium #7).** The backend **silently clamps** `cpus/memoryMb/timeLimit` and returns the **granted** app object (201, or 500 on launch failure). The wizard therefore (a) clamps client-side to the same bounds so the review summary already reflects reality, and (b) **seeds the TanStack Query cache from the app object the POST returns**, never from the typed-in values. The optimistic card shows `starting` and is immediately reconciled to the server's granted resources. There is **no 409 "over-resource" mapping** (it does not exist). 503 (image-not-found in real SLURM mode) and 400 (bad template/name) surface as inline plain-language toasts with an admin-contact CTA.

**Failed-launch handling (resolves review medium #9).** A failed launch returns **HTTP 500 with `{app:{status:'failed', lastError}}`**. `api.ts` treats `POST /api/apps` specially: on 500 it parses the body, and if `body.app` exists it does **not** throw blindly — it seeds the cache with the failed app and surfaces `app.lastError` in the toast (mirroring the scaffold's `data.app?.lastError` read). For all other endpoints, `errors.ts` parses both `{error}` (generic) and `{app.lastError}` shapes so the user-facing reason is never discarded.

### 5. Data/state layer and the typed contract

`src/lib/schemas.ts` defines **zod** schemas for `Session`, `App`, `Template`, `Drives`, `SupportThread`, `AdminOverview`, `NodeMetrics`. They mirror the **verified** `publicApp` shape: `id, owner, name, slug, templateId, templateName, status, visibility, cpus, memoryMb, timeLimitMinutes, workspacePath, entrypoint, port, node, targetHost, slurmJobId, routeHost, url, approvalStatus, persistentRequested, persistentApproved, createdAt, updatedAt` **plus optional** `lastError, startedAt, stoppedAt`.

**Schema leniency (resolves review missing-item #9).** `publicApp` omits `logDir` entirely and frequently emits `undefined`/`""` for `lastError/startedAt/stoppedAt` on idle apps. Schemas therefore mark these `.optional()` and coerce `""`→`undefined` via `.transform`, and the App schema does **not** require `logDir`. To avoid "every idle app fails validation," parsing uses `safeParse`: in **dev/CI** a parse failure throws loudly (contract drift caught early, §11); in **production** a failure logs a structured warning and falls back to the raw object, so a backend additive change never blanks the UI.

`src/lib/api.ts` is a thin typed wrapper over the same call shape as the scaffold (`fetch(path,{headers, credentials:'include'})`), adding: zod parse, structured error `{status, code, message, lastError?}`, the failed-launch special case, an `AbortController` per-request **timeout** (§6), and the single auth handler (§9). Same-origin cookies + gateway-injected `x-remote-user`/`x-remote-groups`; **no tokens in JS, no localStorage auth**.

**Reads used (and the cheap-read contract — see §6):** `useApps` calls the **non-reconciling cached read** the Backend must expose; `useNodes` calls `GET /api/cluster/nodes` (cached `sinfo` aggregation) if present. TanStack Query keys: `['session']`, `['templates']`, `['apps']`, `['app',id]`, `['app',id,'logs']`, `['drives']`, `['nodes']`, `['support']`, `['admin','overview']`. Mutations invalidate `['apps']`/`['app',id]` and use optimistic updates for stop/restart/clear.

### 6. Live job status — adaptive polling (decision: poll, not WS/SSE for v1)

`src/lib/live.ts` is the **single seam** for liveness; the component layer never knows the transport.

**Critical fix — the frontend must not pace SLURM reconcile (resolves review critical #1, high #2, medium #10).** The verified backend runs `reconcileApps` **inside `GET /api/apps`** (server.js:431) — per active app it spawns `squeue`/`scontrol` (slurm.js), and on any status change calls `syncNginxRoutes` which writes the route map and runs `nginx -s reload` (routes.js), with **no single-flight lock**. Polling that endpoint at 5s × 30 users is a `squeue` process storm and an `nginx -s reload` storm — Core Problem B, amplified. Therefore the design **declares two hard Backend dependencies** and the frontend only ever talks to the cheap path:

1. **Cached read endpoint** — `GET /api/apps` (or `?view=cached`) MUST return store rows **without** triggering reconcile. Reconciliation runs **only** on the existing ~30s server timer (and on explicit admin "force reconcile"). The frontend polls this O(1) read; it never triggers `squeue`/`nginx reload`.
2. **Server-side single-flight + debounced reload** — reconcile MUST be serialized behind a mutex and `nginx -s reload` debounced/coalesced, so even timer-driven and admin-driven reconciles cannot thrash. This is a Backend ticket; the frontend assumes it but does not depend on it for correctness, only the cluster does.

Given the cheap read, the **state-aware refetch interval** is:
- Any app in `starting|queued|pending-route` anywhere in the list → poll `['apps']` at **5s**.
- All apps terminal (`running|stopped|failed`) → back off to **20s** heartbeat.
- Tab hidden → pause (`refetchIntervalInBackground:false`).
- LogsPanel open on a running app → poll `['app',id,'logs']` at **3s**, paused when the user scrolls up (reading history).
- Global jitter ±10% to avoid thunder-herd.

**Conservative fallback (resolves review high #2 explicitly):** `live.ts` reads `VITE_APPS_READ_IS_CHEAP` from runtime config. If the Backend has **not** yet shipped the cached read + single-flight, the controller automatically uses a **far more conservative cadence (30s transitional / 60s idle, no log-tail auto-poll)** so the frontend can never be the thing that melts node1. The aggressive 5s/3s cadence is gated on the cheap-read guarantee.

**Backpressure (resolves review medium #10, missing-item #8):** every poll carries an `AbortController` timeout (default 8s); TanStack Query already de-dupes in-flight identical requests, so a slow `/api/apps` cannot stack. When a response is older than `2×interval` or a request times out, the UI shows a non-blocking `<StaleBadge>` ("Live status delayed — last updated 23s ago") rather than implying fresh data.

**Phase-2 upgrade path (documented, not built):** if concurrency demands push, the Backend adds `GET /api/events` (SSE) emitting status deltas; `live.ts` swaps the polling controller for an `EventSource` that feeds the same cache via `queryClient.setQueryData`. Components are unchanged. Kept behind one module so the decision is reversible.

### 7. Command palette (Cmd/Ctrl-K)

`cmdk` in a Radix Dialog. An action registry aggregates: navigation, data actions on *your* instances (open/stop/restart by fuzzy name, sourced from the live `['apps']` cache), "Launch app", "Toggle theme", and admin actions (force reconcile, approvals) when `session.user.isAdmin`. Full keyboard nav, focus-trapped, ESC closes, screen-reader labelled. Serves the 15% without cluttering the 80% surface.

### 8. Accessibility (WCAG 2.1 AA target)

- 40px minimum hit targets (scaffold was 38px; fixed via `--space` sizing).
- Visible theme-aware focus ring on every interactive element: `outline:2px solid var(--focus); outline-offset:2px`.
- Status = icon + text + color, never color-alone. Meaningful icons carry `aria-label`; decorative ones `aria-hidden`.
- Radix primitives provide correct ARIA roles, focus trapping, and ESC for Dialog/Popover/Tooltip.
- `prefers-reduced-motion` zeros transition tokens; skeleton loaders (not spinners) for async.
- Keyboard: full tab order, skip-link to main, palette is keyboard-first.

**Honest enforcement claim (resolves review low #14).** We do **not** claim axe "enforces AA." CI runs three complementary checks: (a) `axe-core` on rendered DOM for the ~30–40% of criteria it can catch, on all 9 screens in light + dark; (b) a **dedicated unit test that computes WCAG contrast for every token pair in `tokens.css`** in both themes (≥4.5:1 text, ≥3:1 large/UI) — this is a static token check, separate from axe; (c) a maintained **manual audit checklist** for criteria neither tool covers. The section claims "AA target enforced by automated subset + token-contrast test + manual audit," not "axe = AA."

### 9. Auth/session interface with the gateway

**Verified backend reality (resolves review high #4):** `GET /api/session` returns `{authenticated, user, devLogin, runtime}` and **always 200** — there is no `actor`, no `allowDevLogin`, and the backend supplies **no login URL**. Data endpoints (`/api/apps`, `/api/templates`, `/api/drives`, …) **do** throw a JSON `401 {error:"Login required."}` via `requireActor` when no `x-remote-user` header/dev cookie is present.

`auth.ts` flow:
1. SPA loads, calls `GET /api/session`.
2. `authenticated === true` → render app using `user.username`, `user.isAdmin`, `user.groups`.
3. `authenticated === false` → **full-page `window.location` redirect** to the **gateway login URL from build/runtime config** (`VITE_GATEWAY_LOGIN_URL`, surfaced via `config/runtime.ts`), preserving `?next=` deep-link. A redirect (not a fetch) is used precisely so we never try to `JSON.parse` an HTML login page.
4. `devLogin === true` only → render the `POST /api/session/dev-login` form.
5. A JSON 401 from any data endpoint is a **backstop** that triggers the same redirect.

**Gateway mechanism — pinned (resolves review high #5, missing-item #1).** The nginx LDAP edge MUST NOT use HTTP Basic (the browser-native 401 popup is hostile to non-technical users and uninterceptable). The required mechanism is **`auth_request` against an authentication subrequest**, configured so that: (a) the **SPA static assets and `GET /api/session` are reachable anonymously** (no forced challenge) — letting the SPA bootstrap and read `authenticated:false`; (b) all other `/api/*` routes require the gateway session and, when satisfied, inject `x-remote-user`/`x-remote-groups`; (c) the **login URL is a real HTML page at a known path** (`VITE_GATEWAY_LOGIN_URL`) that the SPA navigates to. This is an Infra/Gateway dependency and an open question for the human (exact module: `nginx-auth-ldap` vs Authelia/oauth2-proxy in front of OpenLDAP).

**Logout (resolves review missing-item #5).** The backend `POST /api/session/logout` only clears the **dev cookie** — under the trusted-header gateway it does nothing to the gateway session. So in production "Sign out" performs: (1) `POST /api/session/logout` (clears any dev cookie), then (2) a **full-page redirect to the configured gateway logout URL** (`VITE_GATEWAY_LOGOUT_URL`) that terminates the gateway/SSO session. Without (2), sign-out is a no-op; the UI must not pretend otherwise.

**CSRF (resolves review medium #11, missing-item #4).** Mutations rely on ambient auth (gateway-injected header derived from the browser session, or dev cookie). The backend has no CSRF token. Mitigation is a Gateway dependency: session cookies MUST be `SameSite=Lax` (or Strict) **and** the gateway MUST enforce an `Origin`/`Referer` allow-check for mutating methods (POST/PATCH). If that cannot be guaranteed, the Backend adds a double-submit CSRF header that the frontend echoes on mutations. Flagged as an open question.

Admin determination is server-trusted (`APPHUB_ADMIN_USERS`/`APPHUB_ADMIN_GROUPS`); the UI only reflects `user.isAdmin`.

### 10. Build and serve on node1 (static, zero added runtime)

- `npm ci && npm run build` runs in CI / on an admin workstation or node2 (**never** in the request path) → hashed `apphub/web/dist/` (JS/CSS/woff2, fingerprinted; brotli pre-compressed via `vite-plugin-compression`).
- **Icons as SVG, fonts subset (resolves review low #13).** Remix Icon glyphs (~25 used) are imported as **inline SVG React components**, not the full `ri-*` webfont — eliminating tens of KB of unused glyphs. Inter is subset to latin; JetBrains Mono to latin/400+500. **Budgets are tracked separately and honestly:** initial-route JS ≤ 180KB gzip (route-level code-split + `manualChunks`); first-load fonts ≤ ~90KB woff2; CSS ≤ 30KB. "First paint on lab networks" is measured against the **sum**, not the JS number alone.
- Deploy (human-confirmed, per "every node-touching action requires confirmation"): `rsync -a --delete dist/ root@192.168.0.25:/var/www/apphub/` then a confirmed `nginx -t && nginx -s reload` (reuses the existing `deploy/` sudoers path).
- nginx vhost `apphub.sisp.com`: serve `/var/www/apphub` with `try_files $uri /index.html`; `location /api/ { proxy_pass http://127.0.0.1:8888; }`; long-cache hashed assets (`Cache-Control: immutable, max-age=31536000`), `index.html` `no-cache`.
- **CSP** (meta + nginx header): `default-src 'self'; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'`. Theme bootstrap is the hashed `/theme-boot.<hash>.js` (external, §2), so **no inline-script allowance is needed**. All fonts/icons self-hosted → no third-party origins (satisfies the self-hosted-fonts decision and the air-gapped-ish lab posture).
- **Adds no new long-running process to node1** — the SPA is bytes on disk. This is the only "zero added runtime" claim that survives review; the read-path cost is a Backend concern (§6).

### 11. Interfaces to other subsystems

**Backend (apphub server) — consumed contract:** `GET /api/session` (`{authenticated,user,devLogin,runtime}`), `GET /api/templates`, the **cached non-reconciling** `GET /api/apps`, `GET /api/apps/:id` semantics via the list, `GET /api/apps/:id/logs` (`{logs:{...}}`), `POST /api/apps` (201 granted-app / 500 `{app.lastError}`), `POST /api/apps/:id/{stop,restart,clear}`, `POST /api/apps/clear`, persistence/approval, `GET /api/drives`, support endpoints, `GET /api/admin/overview` + admin mutations.
**Backend — new contract the frontend requires (tickets):** (1) cached read decoupled from reconcile; (2) single-flight reconcile + debounced nginx reload; (3) `GET /api/cluster/nodes` cached `sinfo` aggregation for Dashboard gauges (or explicit decision to cut gauges in v1 — frontend degrades gracefully either way).
**Gateway/Infra (node1 nginx + OpenLDAP):** `auth_request` mechanism with anonymous `/api/session`, header injection on authed `/api/*`, machine-navigable login + logout URLs, `SameSite` + `Origin` CSRF posture, and — for the instance **Open** CTA to actually work — **wildcard `*.app.sisp.com` TLS plus WebSocket `Upgrade`/`Connection` proxying** on the generated `$apphub_upstream` map (Jupyter/RStudio need WS). The card's "Open" is hollow without this; the frontend only derives the link from `app.url` and cannot fix cert/WS itself (review missing-items #6, #7).
**Design system:** `docs/design/DESIGN_DIRECTION.md` is the source for tokens, type, and motion.

### 12. Quality gates (CI)

`npm run typecheck` (tsc), `eslint`, `vitest` unit + `@testing-library` component tests, the **token-contrast unit test** (§8), `axe-core` on all 9 screens (light + dark), and `@playwright/test` smoke covering the wizard happy path against the backend in **mock SLURM mode** (`APPHUB_SLURM_MODE=mock`) — mirroring `deploy/smoke-node1.py`. A **schema-contract test** parses recorded backend fixtures through `schemas.ts` so additive/renamed backend fields fail CI rather than production. Separately tracked bundle budgets (§10) fail the build when exceeded.

### 13. Building on the scaffold's good ideas (not its code)

Kept ideas: the `api()` fetch-wrapper pattern (incl. its deliberate `data.app?.lastError` read), the status-strip counts, the per-OS drive cards with copy-paths and MapDrive steering, and the admin reconcile/approval surface. Discarded implementation: Arial, light-only, table rows, all-at-once form, hardcoded hex, text nav, 38px targets, `alert()` logs — rebuilt against the token system, component library, wizard, cards, palette, and dark mode.

**Dependencies:** backend-apphub-api: cached non-reconciling GET /api/apps read; single-flight reconcile + debounced nginx -s reload; existing session/templates/apps/logs/drives/support/admin endpoints unchanged in shape, backend-apphub-api: new cached GET /api/cluster/nodes (sinfo aggregation) for Dashboard gauges, or an explicit decision to cut gauges in v1, gateway-auth (node1 nginx + OpenLDAP): auth_request mechanism, anonymous /api/session + static assets, x-remote-user/x-remote-groups injection, machine-navigable login and logout URLs, SameSite + Origin CSRF posture, infra-routing-tls (node1 nginx): wildcard *.app.sisp.com TLS and WebSocket Upgrade/Connection proxying for the generated $apphub_upstream map so the 'Open' CTA resolves, design-system: docs/design/DESIGN_DIRECTION.md tokens, type, motion, and component contract, deploy: existing deploy/ nginx vhost, sudoers nginx-reload path, and smoke-test harness reused for static deploy and UI smoke

**Open questions:** 
- Which exact gateway auth module sits in front of OpenLDAP (nginx-auth-ldap vs Authelia vs oauth2-proxy), and what are the precise login and logout URLs to bake into VITE_GATEWAY_LOGIN_URL/VITE_GATEWAY_LOGOUT_URL? auth.ts cannot be finalized without this.
- Will the Backend ship the cached non-reconciling /api/apps read plus single-flight reconcile and debounced nginx reload for v1, or must the frontend ship with the conservative 30s/60s cadence as the default?
- Is GET /api/cluster/nodes (cached sinfo) in scope for v1, or do we cut the Dashboard per-node gauges and show only the queue/capacity summary?
- Can the gateway guarantee SameSite + Origin/Referer enforcement on mutating methods, or should the Backend add a double-submit CSRF token for POST/PATCH?
- Is wildcard *.app.sisp.com TLS provisioned and is nginx configured to proxy WebSocket Upgrade for the per-app upstream map? The instance 'Open' CTA depends on it.
- Should theme preference (and later other prefs) persist server-side, or is localStorage-only acceptable for v1 given there is currently no prefs endpoint?


---

<a id="security-tenancy"></a>

## Security & Multi-Tenancy

> Scope: how SISP AppHub safely runs untrusted wet-lab researcher code (Jupyter/RStudio = interactive shells) on the shared node1–4 cluster, isolates tenants from each other and from the third-party persistent apps, and protects the LDAP/NAS/SLURM control plane. Every node-touching step below is written as a **proposed, human-confirmed, reversible** change (Decision 3). Nothing assumes autonomous production mutation.

### 0. Trust zones & threat model

**Principals / boundaries**
- **Internet → nginx (node1, 192.168.0.25)** — only TLS 443/8443 (+80 redirect) exposed for `*.sisp.com`. Public attacker.
- **Authenticated researcher** (LDAP uid ≥ 10000, gid 100000) — the *primary* threat principal: non-malicious-but-curious, plus the assume-breach case of one compromised account. Can (a) launch apps, (b) run arbitrary code inside their container (notebook/RStudio shells), (c) read/write the NAS, (d) browse other users' app URLs.
- **`apphub` service user (node1)** — holds the two-verb sudo grant. Compromise ⇒ "run a SLURM job as any uid ≥ 10000" + nginx reload + DB. High value, but not root (wrapper refuses uid < 10000).
- **`auth-check` service (node1, :8888)** — now treated as **first-class, in-repo code** (see §4), not an opaque reference daemon. It fronts 100 % of app traffic, so its availability and concurrency are security-and-uptime-critical.
- **nodeadmin / root** — full cluster.
- **Third-party persistent apps** (`cmssight`, `dmmr`, `leantime`, `zulip`, `vitessce` on `*.sisp.com`) — semi-trusted neighbours that today receive the same `Domain=.sisp.com` SSO cookie.

**Attack goals to deny:** lateral researcher→researcher (data/session/credential theft, job spoofing, runtime/SIF swap, port-reuse hijack), researcher→root, supply-chain, and external→internal via header spoofing / CSRF / LDAP brute force.

**Logical trust-zone diagram**
```
Internet ─TLS─► nginx(node1) ─┬─ auth_request ─► auth-check :8888  (SSO + per-app authz + cache)
                              │                       │ unix sock /run/sisp-apphub/authz.sock
                              │                       └────► apphub in-mem ACL (no per-hit DB/LDAP)
                              ├─ /api ──────────► apphub :8792  (127.0.0.1, trusts X-Remote-User from proxy only)
                              └─ *.app.sisp-user.net ─► nodeIP:31xxx  (Apptainer job, runs as owner uid)
apphub ── sudo -n (2 verbs) ─► sbatch-as-user.sh ── sbatch --uid ─► SLURM ─► Apptainer (userns, owner uid)
```

### 1. Findings register (fix before go-live)

| # | Finding | Severity | Location |
|---|---------|----------|----------|
| F1 | Plaintext `credentials.txt`; `[redacted]` reused for all 4 `nodeadmin` + LDAP `cn=admin`; several user logins documented in cleartext (redacted) | Critical | `C:\Users\user\credentials.txt` |
| F2 | SSO cookie `Domain=.sisp.com` (cookie name `nginxauth`) shipped to owner-controlled `*.app.sisp.com` **and** third-party `*.sisp.com` apps → session/credential theft | Critical | `apphub-nginx.conf` (`X-Cookie-Domain .sisp.com`) |
| F2b | **Cookie payload undocumented.** If `nginxauth` encodes or is a stable handle to an LDAP-credential-derived token, F2 is *credential* theft, not session replay | Critical (pending §2.5 inspection) | auth-check daemon |
| F3 | `auth_request /_apphub_auth` on `*.app.sisp.com` proves *login only*, not ownership → any authenticated user reaches any private app | Critical | `apphub-nginx.conf` app vhost |
| F4 | Apps ship **auth-disabled in three places**: `rstudio.def` `DISABLE_AUTH=true`; `templates.json` jupyterlab `--ServerApp.token=`/`--ServerApp.password=` (empty); `templates.json` rstudio `--auth-none=1`. With F3 = unauth shell as the owner | Critical | `rstudio.def`, `templates.json` (jupyterlab, rstudio) |
| F5 | Job spool, manifests, logs, workspaces, **SIF images** are `chmod -R 2775` group `sisp`/100000 on NAS → cross-tenant read/tamper; TOCTOU on `job.sh` between write and `sbatch --uid` | High | `install-node1.sh`, `apphub.env.node1` |
| F5b | **Executable runtime on group-writable NAS.** `install-node1.sh` copies `runtime/.` (incl. `apphub-runner.sh`, `run_manifest.py`, `templates.json`) into `/mnt/sisplockers/apphub/runtime` (2775); `apphub.env` points `APPHUB_RUNNER_PATH`/`APPHUB_TEMPLATE_PATH` there. The sbatch'd job execs these as the victim uid → any gid-100000 user gets code-exec as every other launcher (easier than SIF swap, no signing bypass) | High | `install-node1.sh` ll.47-58, `apphub.env.node1` |
| F6 | No SIF signing/verification; `.def` pulls `docker:` floating tags (no digest); image dir group-writable → SIF swap = code-exec as another user | High | defs, `build-runtime-images-node2.sh`, `run_manifest.py` |
| F7 | Apptainer uses host network (no `--net`); same-node jobs can reach each other's `localhost:31xxx` | Medium | `run_manifest.py` |
| F8 | No CSRF defence on `/api` mutating calls; `auth_request` authorises by cookie only | High | `apphub-nginx.conf`, `server.js` |
| F9 | `APPHUB_ADMIN_GROUPS=sisp-admins` is dead — nginx hard-sets `X-Remote-Groups ""` | Medium | `apphub-nginx.conf` |
| F10 | Audit in the same DB the app writes; not append-only, not shipped off-box | Medium | `postgres-store.js`, `schema.sql` |
| F11 | LDAP plaintext `:389`, bind `cn=admin`/`[redacted]`; NSS/Samba gateway will reuse it | High | recon LDAP facts |
| F12 | No account lockout / rate-limit on the login endpoint; a per-request-LDAP-bind daemon is a brute-force amplifier and DoS target | Medium | auth-check daemon |
| F13 | Port-reuse / stale-route hijack: ports 31000–31999 recycled across tenants; edge authz checks the viewer's right to a *host*, not the identity of the backend currently on that port | Medium | `routes.js`, `slurm.js`, reconciler |

### 2. Secrets management (F1, F11, F2b)

**2.1 Rotation runbook (`secrets-rotation.md`, operator-run, ordered).**
1. Generate distinct 24-char secrets (`openssl rand -base64 18`) for: `nodeadmin@node1..4` (4 distinct), LDAP `cn=admin`, the auth-check signing/derivation key (F2b), and the 3 leaked user logins.
2. LDAP admin: `ldappasswd -H ldap://192.168.0.25 -x -D 'cn=admin,dc=siriraj,dc=local' -W -S`. Then create a **dedicated read-only service account** `cn=svc-apphub,ou=Services,dc=siriraj,dc=local` (ACL: `read` on `ou=People` + group attrs only) for the auth-check and the future Samba gateway binds — **never** `cn=admin`.
3. node admins: `passwd` on each node, distinct values; record only in the store.
4. User passwords: force reset via normal LDAP admin reset; notify the 3 users.
5. **Coordinate third-party app owners BEFORE rotating user passwords (M2).** `kriengkraip` (leaked pw `heng`) owns `cmssight.sisp.com` + `dmmr.sisp.com`; `nodeadmin` owns `leantime`/`zulip`/`vitessce`. Rotating these accounts can break app-level LDAP binds / saved service logins. The runbook gates each user/nodeadmin rotation on a confirmed checklist item "owner notified, app re-bind path identified, rollback secret retained for 24 h."
6. **Delete** `credentials.txt`; purge from any backup/git history (`git filter-repo --path credentials.txt --invert-paths` if ever committed); add `credentials.txt`, `*.env`, `*.key`, `*.pem` to `.gitignore` + a `gitleaks` pre-commit hook.

**2.2 Secret store, scoped OUT of the critical boot path (resolves Vault-SPOF review issue).** Run **HashiCorp Vault** (single node, raft storage) on node1 bound to `127.0.0.1:8200`, used for **rotation, dynamic creds and audit only** — *not* as a boot-time dependency for apphub/auth-check/LDAP-bind. Boot-critical secrets are delivered by systemd `LoadCredential=` from a **root-only sealed file** (mode 0400 root:root on local ext4), so a node1 reboot brings apphub/auth/LDAP-bind up with **no human quorum**. Vault unseal uses **auto-unseal** (transit via a second node, or TPM); the Shamir recovery quorum is `nodeadmin + 1 technical admin` — **non-technical PIs are removed from the unseal/recovery path** (they were a load-bearing-human availability risk). Mounts: `kv/apphub/{ldap-bind,auth-signing-key,samba-gateway}`; AppRole roles `apphub`, `auth-check`, `samba-gw`, each policy-scoped to its own paths.

**2.3 Delivery to services.** `apphub.service` gets `LoadCredential=ldap-bind:/etc/sisp-apphub/sealed/ldap.pass` and reads `${CREDENTIALS_DIRECTORY}/ldap-bind`; non-secret config stays in `apphub.env`. No secret lines in `apphub.env`.

**2.4 DB stays passwordless via peer auth** — keep the existing `postgresql://apphub@%2Fvar%2Frun%2Fpostgresql/sisp_apphub` unix-socket peer auth; document `pg_hba.conf`: `local sisp_apphub apphub peer`. Better than any stored password.

**2.5 F2b prerequisite — document the cookie contract.** Before designing the replacement (§5), capture the exact `nginxauth` payload and validation path of the auth daemon (the `auth-smoke` login form has a `csrf_token`, so it is already a customised daemon). If the cookie carries credential-derived material, escalate F2 to "credential theft," rotate the derivation key in the same window, and ensure the replacement token (§5.1) is a *fresh, host-scoped, non-credential* artifact.

### 3. Identity & header-trust boundary (F9 + defense-in-depth)

- **Loopback + firewall.** Assert `HOST=127.0.0.1` for apphub; nftables drops `8792/8888/8200/5432` from anything but `127.0.0.1`.
- **Identity comes only from the proxy subrequest — never from the client (revised).** Drop the wavering `proxy_set_header X-Remote-User ""` and the dependency on the non-stock `headers-more` module. Instead: (a) nginx derives identity *exclusively* via `auth_request_set $apphub_user $upstream_http_x_authenticated_user;` and passes that; (b) the **auth-check service ignores any inbound `X-Remote-*` header entirely** (it authenticates from the cookie, full stop), so a client pre-seeding `X-Remote-User` into the `Cookie $http_cookie` subrequest changes nothing. `headers-more` is documented as an *optional* extra-hardening build dependency with this fallback, not a one-liner requirement.
- **Wire groups for real (F9).** auth-check returns `X-Authenticated-Groups` from an LDAP `memberOf` search (cached, §4.4); nginx `auth_request_set $apphub_groups $upstream_http_x_authenticated_groups; proxy_set_header X-Remote-Groups $apphub_groups;`. Until shipped, admin = `APPHUB_ADMIN_USERS=nodeadmin,admin` only.
- Keep server-side `assertUsername`/`actorFromRequest` regex validation; additionally reject usernames absent from the LDAP/`getent` cache so a future proxy bug cannot mint ghost actors.

### 4. The auth-check service & per-app authorization (F3 + the concurrency review issue — central design)

The whole rebuild exists to fix concurrency (Core problem B). Putting authz + group lookup + token minting **inline, blocking, on every subrequest** to a single daemon would re-create the hang. So the auth-check service is specified as first-class code:

**4.1 Concurrency model.** Async/event-loop (or a bounded worker pool) HTTP service; **never one-bind-per-request blocking I/O on the hot path**. It serves three subrequest routes: `/check` (SSO validity), `/authz/app` (per-app), `/auth/*` (login/logout). It must sustain **> 100 concurrent app sessions** with websocket keep-alives (the app vhost uses `proxy_buffering off`, 3600s timeouts) — a load test at that scale is a **go-live gate** (`authz-load-node1.py`).

**4.2 Per-app authz endpoint `GET /authz/app`.** The app vhost replaces `/_apphub_auth` with `/_apphub_authz`:
```nginx
location = /_apphub_authz {
    internal;
    proxy_pass http://127.0.0.1:8888/authz/app;
    proxy_set_header X-Original-Host $host;       # slug-owner.app.sisp-user.net
    proxy_set_header X-Original-URI  $request_uri;
    proxy_set_header Cookie          $http_cookie;
}
location / {
    if ($apphub_upstream = "") { return 404; }
    auth_request /_apphub_authz;
    error_page 401 = @apphub_login;
    error_page 403 = @apphub_forbidden;
    proxy_pass $apphub_upstream;
    # ... websocket upgrade, 3600s timeouts, proxy_buffering off ...
}
```
Decision: **allow** iff `app.approvalStatus=="approved"` AND (`app.visibility=="public"` OR `username==app.owner` OR (`team` AND `username ∈ team(owner)`) OR actor is admin); else `403`. This makes the data-model `private/team/public` mean something at the network edge.

**4.3 No per-hit DB/LDAP — unix-socket to apphub's in-memory ACL + short-TTL cache.** `/authz/app` does **not** open a fresh Postgres query per request. apphub owns the route/ACL truth and exposes a read-only `GET /internal/route-acl?host=` over a **unix socket** `/run/sisp-apphub/authz.sock` backed by an in-memory map it already maintains when it writes the nginx route map. auth-check keeps a **positive+negative cache keyed on `(sessionId, host)`** (TTL ~10 s positive, ~3 s negative), so the steady-state websocket-heavy load is answered from memory; cache invalidates on app stop/visibility change (apphub pushes an invalidation over the socket). LDAP group results are cached per user (§4.4).

**4.4 Group cache.** `memberOf` lookups cached per username (TTL ~60 s) so group-aware admin (F9) does not add an LDAP bind per request.

**4.5 Circuit-breaker / fail-closed.** If apphub's ACL socket or LDAP is unreachable, `/authz/app` **fails closed (403)** for private apps and serves the friendly `@apphub_forbidden` page; a global breaker prevents thundering-herd retries from amplifying an outage. A dead auth-check is detected by a systemd watchdog + nginx `proxy_next_upstream` to a static maintenance page, so one slow gate degrades gracefully instead of hanging every app.

**4.6 App-level defence-in-depth — fix ALL three auth-disabled spots (F4).** Two independent gates: edge authz (4.2) **and** a per-launch app token. apphub mints a random `APPHUB_APP_TOKEN` at launch, stores it server-side only, and:
- **jupyterlab template:** set `--ServerApp.token={appToken}`, **drop the empty `--ServerApp.password=`**.
- **rstudio template:** replace `--auth-none=1` with the per-launch token gate.
- **`rstudio.def`:** remove `DISABLE_AUTH=true` / `RSTUDIO_DISABLE_AUTH=1` from `%environment`.
auth-check appends the token (as a signed, host-scoped cookie) only *after* the 4.2 check passes. `authz-smoke` asserts: user B `403` on user A's app **and** an unauth direct hit to the kernel/RStudio is rejected — for *both* jupyterlab and rstudio.

**4.7 Bind the token to the job instance, not just the app record (F13).** The app token is bound to `(jobId, allocatedPort, pid)`; the runner presents it and the backend (or a thin per-job sidecar/header check) rejects a mismatch. The **reconciler fails closed**: any route `host` whose backing job is not `Running` with a matching instance token is rewritten to `return 404` *before* the next nginx reload, and a port is **not reusable** while its route-map entry still resolves (apphub removes the map entry and reloads nginx before returning the port to the 31000–31999 pool). This closes "viewer authorised for a stale host is proxied into whoever now holds that port."

### 5. Session, CSRF & user-content domain (F2, F8)

**5.1 Move user apps off the SSO cookie's registrable domain (F2 — the most important structural change).** Serve researcher apps from a **separate registrable domain** `*.app.sisp-user.net` (à la `googleusercontent.com`). The SSO cookie becomes `Domain`-less / host-only to `apphub.sisp.com` and is **never** sent to user content or to third-party `*.sisp.com`. After the §4.2 check, the edge mints a **short-lived, app-scoped, HttpOnly cookie** `apphub_app=<jwt>` with `Domain=<exact app host>`, 15-min TTL — worthless elsewhere. *Interim* mitigation if the domain is not procurable immediately: host-only `__Host-` SSO cookie + strict CSP on app responses — but flag that this does **not** fully close F2 (cookie still same-site to third-party `*.sisp.com`); user-content-domain procurement is a **required dependency**, and it presupposes the auth daemon can issue host-scoped tokens (§2.5/§4.6).

**5.2 SSO cookie hardening.** `Set-Cookie: __Host-apphub_sso=...; Secure; HttpOnly; SameSite=Lax; Path=/` (no `Domain` ⇒ host-only). Lax so the post-login redirect works; idle TTL 8 h, absolute 24 h; signing key rotated in Vault.

**5.3 CSRF on `/api` (F8).** (a) Origin/Referer allowlist on every non-GET `/api/*` (reject if not `https://apphub.sisp.com`) — ~15 lines in `handleApi` before routing mutating verbs. (b) Double-submit token: `__Host-apphub_csrf` set at session start, echoed in `X-CSRF-Token`, compared server-side (extend the existing login-form CSRF idea). (c) Keep `APPHUB_DEV_AUTH=0`.

**5.4 Login lockout & rate-limit (F12).** auth-check enforces per-account lockout (e.g. 5 failures → 15-min backoff) and per-source-IP rate limiting on `/auth/login`, independent of the alerting in §10, so a brute-force is *blocked*, not merely observed. Lockout state is in-memory with a short TTL (no extra LDAP load) and emits `auth.lockout` audit events.

### 6. sudo / sbatch-as-user trust boundary & executable-runtime relocation (F5, F5b)

**6.1 Relocate everything the job executes to root-owned local disk (F5 + F5b).** Today `job.sh`/`manifest.json` (NAS `2775`) and — critically — `apphub-runner.sh`, `run_manifest.py`, `templates.json` (also NAS `2775`, pointed to by `APPHUB_RUNNER_PATH`/`APPHUB_TEMPLATE_PATH`) are writable by every gid-100000 user. Fixes:
- **Job spool → `APPHUB_JOB_ROOT=/var/lib/sisp-apphub/jobs`** (local ext4, `0700 apphub:apphub`); per-app dir `0700`, `job.sh` `0500`, `manifest.json` `0400`. SLURM copies the batch script at submit, so compute nodes need no NAS access to it. Closes the TOCTOU and cross-tenant manifest reads.
- **Executable runtime → `/opt/sisp-apphub/runtime` (`0755 root:root`, files `0444`/`0555`).** Remove the `cp -a runtime/. /mnt/sisplockers/apphub/runtime/` step from `install-node1.sh`; set `APPHUB_RUNTIME_ROOT`/`APPHUB_RUNNER_PATH`/`APPHUB_TEMPLATE_PATH` to the `/opt` paths (the sudo wrapper already lives there). **Invariant: `apphub` cannot write any path it later causes to be executed as a user.** A smoke test asserts `apphub` write-fails on the runner, run_manifest, templates, and SIFs.
- **Logs** stay on NAS for users to read their own: `APPHUB_LOG_ROOT=/mnt/sisplockers/apphub/logs/<owner>/<appId>`, owned `owner:100000` mode `0750`, per-user parent `0700`. Drop the blanket `chmod -R 2775 /mnt/sisplockers/apphub`.

**6.2 Tighten sudoers + hardcode the containment root.** Keep the two-verb shape. Add `Defaults!/opt/sisp-apphub/runtime/wrappers/apphub-sbatch-as-user.sh env_reset, !setenv`, and **hardcode** `job_root=/var/lib/sisp-apphub/jobs`, `preferred_uid_min=10000`, `preferred_gid=100000` as constants in the wrapper (remove the `${APPHUB_JOB_ROOT:-…}` / `${APPHUB_PREFERRED_*}` env overrides) so the security-relevant containment path is not attacker/env-influenced. Verify wrapper is `0755 root:root`, not NAS-resident.

**6.3 Fail closed on uid resolution.** Replace the `head -n 1` passwd fallback (ll.~80-85): if neither the preferred uid≥10000/gid==100000 match nor an owned-path match resolves, `exit 68 "cannot safely resolve uid for $target_user"`. Never run as uid < 10000.

**6.4 SLURM-side guard + concrete fairness caps (also DoS blast-radius, M6).** Set `SlurmUser`/`AllowedSubmitUsers` so only `apphub`/root can `sbatch --uid`. Define a `large` partition QOS with **concrete defaults**: per-user `MaxJobs=4`, `MaxTRESPerUser=cpu=16,mem=64G`, `MaxWall=24:00:00` (≈⅐ of the 112-CPU/512-GB cluster per researcher) — tunable, but defaults exist so one user cannot exhaust the cluster (the starvation that contributes to hangs). `PrologSlurmctld`/`Prolog` re-verify running uid ≥ 10000 and SIF signature (§8). `cgroup.conf`: `ConstrainRAMSpace=yes`, `ConstrainCores=yes` so a runaway notebook cannot OOM a node.

### 7. Container isolation (F4, F7) + privilege-mode verification

- **Verify Apptainer mode first (review gap).** Confirm on node2–4 whether unprivileged user namespaces are enabled (userns ⇒ no in-container root, the assumed baseline) or setuid-mode apptainer is in use (changes the `--net`, `fakeroot`, and per-job nftables threat model). This check is a **precondition** recorded in `RUNTIME.md`; the isolation flags below assume userns and must be revisited if setuid-mode is found.
- **Network (F7).** Don't share `localhost` across jobs: bind each job to its allocated port on the node's routable IP and have the SLURM Prolog install a **per-job nftables rule** allowing only node1's apphub-proxy source IP to reach `31xxx`, dropping peer-job/peer-node access. Residual: same-node jobs share the host netns (documented); revisit with `--net`/CNI if setuid-mode permits.
- **Flags** in `apptainer_command`: add `--containall --writable-tmpfs --no-init --no-umask`; **stop the blanket `--env` passthrough** of arbitrary template env; bind only what's needed (`--bind <workspace>:<target>:rw`, home `nosuid,nodev` via NAS fstab) — **do not bind `/mnt/sisplockers` wholesale**. Set `--pwd` to workspace, `umask 0007` so files land owner-private.
- Remove the auth-disable env (§4.6).

### 8. Image supply chain (F6)

- **Pin by digest** in `.def` (`From: quay.io/jupyter/datascience-notebook@sha256:…`); record in `runtime/definitions/SOURCES.lock`.
- **Sign** SIFs in `build-runtime-images-node2.sh` (`apptainer sign`, Vault-backed key); public key in repo.
- **Verify at run**: `run_manifest.py` runs `apptainer verify` before exec, refuse on failure (`exit 66`); same check in the SLURM Prolog so an unsigned/tampered SIF never runs even if the runner is bypassed.
- **Read-only, non-group-writable image store**: `/mnt/sisplockers/apphub/images` files `0444`, dir `0755 root:sisp`; only the build node (root on node2) writes.
- **Provenance**: emit SBOM (`syft`) + `build-manifest.json` (def/base digest, builder, ts); CI refuses to publish without it; periodic `trivy`/`grype` cron, results to the admin overview.
- Keep the 3 research images disabled until signed+scanned; only `python-apps.sif` enabled.

### 9. Server-side RBAC

- **Roles**: `user` (default), `admin` (`APPHUB_ADMIN_USERS` ∪ proxy-verified `sisp-admins` once F9 lands). No privilege from group headers until proxy-verified (§3).
- **Object invariant**: every `/api/apps/{id}/*` mutating route calls `ensureOwnsApp` (returns 404, not 403, to avoid enumeration). Add a unit test asserting non-owner/non-admin gets 404 for each verb.
- **Visibility transitions admin-gated**: `launchApp` rejects self-asserted `public` and forces approval — keep; `team` cannot be self-asserted to read others' data until the team model exists (open question).
- **Template authoring is privileged config = code**: `PUT /api/admin/templates` admin-only; add server-side validation that `command`/`volumes`/`image` cannot reference paths outside `imageRoot` / an allowed bind allowlist (a malicious template = code-exec for every launcher). Audit + review template edits like code.

### 10. Audit & monitoring (F10) + backup/recovery (review gap)

- Keep `addAudit` on all major actions. Make `apphub_audit_events` **append-only**: trigger denying `UPDATE`/`DELETE`, revoke those from role `apphub` (grant `INSERT`/`SELECT` only).
- **Off-box, tamper-evident**: sidecar tails new rows → syslog/journald → `zulip.sisp.com` stream `#apphub-audit` **and** a write-once `/var/log/sisp-apphub/audit.ndjson` (`chattr +a`).
- **New security events**: `authz.deny`, `wrapper.reject`, `image.verify.fail`, `csrf.reject`, `auth.lockout`, admin-role use.
- **Alerting → Zulip**: >N failed logins/user/5 min, any `wrapper.reject`/`image.verify.fail`, AIDE/`tripwire` checksum drift on `/opt/sisp-apphub`, `/etc/sudoers.d/apphub`.
- **Backup & key recovery (review gap).** Documented `restore` runbook for: Vault raft snapshots (encrypted, off-node, with the auto-unseal recovery keys held by `nodeadmin + 1 technical admin`), SIF signing key (offline escrow copy — loss ⇒ re-sign all images), and the audit sinks. **Append-only rotation**: a privileged, audited job temporarily clears `chattr +a`, rotates `audit.ndjson`, re-applies `+a`, and logs the rotation as a `audit.rotate` event (logrotate cannot rotate an append-only file unaided). Without these, the tamper-evident stores become un-restorable single points of data loss.

### 11. Network isolation summary

- nftables (node1): inbound only 443/8443 (+80 redirect); loopback-only 8792/8888/8200/5432.
- Compute nodes: 31000–31999 reachable only from node1's proxy IP; inter-node/inter-job dropped by default; Prolog installs the per-job allow rule keyed on the allocated port (§7).
- LDAP: migrate `:389` plaintext → **LDAPS/StartTLS** (self-signed CA distributed to nodes) **before** the Samba gateway reuses the bind (F11).

### 12. Storage-ownership dependency on the CIFS gateway (review gap — hard precondition)

The §6.1 `0700`-per-user workspace/log model and the wrapper's uid mapping are **meaningless unless node1's Samba/CIFS re-export maps LDAP uid/gid correctly** — that idmap *is* the "ownership gets mixed up" problem the whole rebuild targets. Therefore correct idmap (`SIRIRAJ\<user>` ⇄ LDAP uid/gid, gid 100000) is declared a **hard precondition** of this subsystem, owned by the Storage/Gateway subsystem. Gate: a **gateway-ownership smoke test** asserting "a file written by user A through the gateway is owned by A's LDAP uid and is **unreadable** by user B," run before any storage-hardening step ships.

### 13. Interfaces to other subsystems

- **Reverse-Proxy / nginx**: app vhost moves to `*.app.sisp-user.net`; swap `/_apphub_auth`→`/_apphub_authz`; `auth_request_set` for user/groups; `__Host-` SSO cookie; route-map writes coordinated with reconciler (§4.7).
- **Identity/LDAP**: `svc-apphub` read-only bind; LDAPS; `memberOf` group source.
- **Storage/Gateway**: idmap precondition + ownership smoke test (§12); per-user log/workspace perms.
- **Scheduler/SLURM**: `AllowedSubmitUsers`, `large` QOS caps, Prolog uid+SIF checks, cgroup constraints.
- **Build (node2)**: signing, digest pinning, SBOM, read-only image store.
- **apphub app**: `/internal/route-acl` unix socket + cache invalidation; CSRF; instance-bound app token; append-only audit.

### 14. Rollout sequence (all human-confirmed; each step ships a smoke test + rollback)

1. **Day 0 (no service change):** rotate F1 secrets with third-party-owner coordination (§2.1), stand up Vault out-of-boot-path, scrub git history, gitleaks hook.
2. **Storage + executable-runtime relocation** (§6.1, F5+F5b): job spool & runtime to `/opt`/local, per-user log perms, read-only image store. Verify `apphub` cannot write anything it executes.
3. **Image signing + `apptainer verify`** in runner/Prolog (§8); confirm apptainer mode (§7).
4. **Wrapper hardening** (constants, fail-closed, sudoers `env_reset`) (§6) + extend smoke tests.
5. **auth-check rewrite**: concurrency model, `/authz/app`, cache, circuit-breaker, unix-socket ACL, login lockout; **load test > 100 sessions** (gate); remove all three auth-disabled spots; instance-bound token + reconciler fail-closed (§4) behind a feature flag; `authz-smoke` (user B forbidden + unauth kernel/RStudio rejected, both templates).
6. **User-content domain** procurement + cookie re-scoping (F2) — coordinate with proxy/networking.
7. **CSRF + origin checks, append-only audit shipping, alerting, backup/recovery runbooks** (§5.3, §10).


**Dependencies:** Reverse-Proxy/nginx subsystem: app vhost domain move to *.app.sisp-user.net, /_apphub_auth -> /_apphub_authz, auth_request_set for user/groups, __Host- SSO cookie, route-map reload coordination with the reconciler, Identity/LDAP subsystem: dedicated read-only svc-apphub bind DN, LDAPS/StartTLS migration off :389, memberOf group source for F9, Storage/CIFS-gateway subsystem: correct LDAP uid/gid idmap on the node1 Samba re-export (hard precondition) + ownership smoke test; per-user log/workspace permission model, Scheduler/SLURM subsystem: AllowedSubmitUsers/SlurmUser restriction, 'large' QOS with concrete per-user caps, PrologSlurmctld uid>=10000 + SIF-signature verification, cgroup ConstrainRAMSpace/ConstrainCores, Build subsystem (node2): SIF digest pinning, apptainer sign with Vault-backed key, SBOM/provenance, read-only non-group-writable image store, apphub application subsystem: /internal/route-acl unix socket + in-memory ACL with cache invalidation, CSRF defenses, instance-bound app-token minting, append-only audit schema/trigger, reconciler fail-closed + port-reuse guard, Networking subsystem: procurement of the sisp-user.net user-content domain and its TLS certificates; nftables policy on node1 and compute nodes, Secrets/Platform: Vault deployment with auto-unseal (second node or TPM) scoped out of the boot path; systemd LoadCredential sealed-file delivery

**Open questions:** 
- What exactly is in the nginxauth SSO cookie? (F2b) Is it an opaque session handle or an LDAP-credential-derived token? This determines whether F2 is session replay (Critical) or credential theft (Critical+rotate-derivation-key) and gates the scoped-JWT replacement design.
- What is the team/group model for 'team' app visibility — LDAP groups, an apphub-managed roster, or PI-defined lab groups? Needed before 'team' visibility can be enforced at the edge without over-sharing.
- Is the *.app.sisp-user.net (or equivalent) separate registrable domain procurable, and on what timeline? The full F2 fix and host-scoped app tokens depend on it; otherwise we ship the weaker interim mitigation.
- What Apptainer mode runs on node2-4 — unprivileged userns or setuid? This changes the container isolation and per-job network threat model (section 7).
- Confirm the concrete SLURM QOS fairness caps (proposed MaxJobs=4, cpu=16/mem=64G per user, 24h wall) are acceptable for real wet-lab workloads, or whether per-PI/per-lab quotas are preferred.
- Who holds the auto-unseal recovery quorum and the offline SIF signing-key escrow now that non-technical PIs are removed — is 'nodeadmin + 1 technical admin' sufficient for the lab's availability expectations?
- Auto-unseal mechanism choice: Vault transit on a second node vs TPM/KMS — which is operationally supportable in this 4-node lab?


---

<a id="observability-ops"></a>

## Observability, Deployment & Operations

### Purpose

Keep the SISP AppHub control plane on node1 observable, deployable, and recoverable without ever making an autonomous change to a node. This subsystem owns: the node1 deploy/upgrade/rollback pipeline; the metrics/logs/alerting stack; the live cluster-utilization feed behind the dashboard gauges; stuck/zombie-job and platform alerting routed to operators; state-DB backup/restore; and the capacity policy that fixes the "slow/hung" complaint by keeping node1 a pure control plane and pushing per-user apps onto SLURM node[2-4]. Read-only telemetry is automated; every node-mutating remediation is emitted as a copy-pasteable, owner-verified command that a human runs.

### 0. Boundary rule (unchanged, hardened)

Two action classes, enforced by design:

- **Automated (read-only):** `sinfo`/`squeue`/`scontrol show` (text format, see §2.1), `pg_dump`, Prometheus scrapes, journald reads, `nginx -t`, reconcile polling, health probes. Every one of these that touches the CIFS mount runs inside a kill-able child process with a hard `timeout` (§3.2) — never via in-process `fs` on the mount.
- **Confirmation-required (node-mutating):** `scancel`, `systemctl restart/reload`, route-map writes that drop a live app, `pg_restore`, `.sif` rebuilds, CIFS remounts, and **toggling `maintenance.flag`**. The system detects the condition and prints the exact remediation command into the alert and the admin "Proposed actions" tray. A human runs it, or clicks an admin button that invokes the server-side NOPASSWD path behind a confirm dialog (§5.3).

The sudoers surface is **not** widened: apphub may only call `apphub-sbatch-as-user.sh submit|cancel *` and `apphub-nginx-reload`. Metrics/backup timers run as dedicated unprivileged users or root timers that only read/`pg_dump` (and are themselves `timeout`-wrapped, §6).

### 1. node1 deployment topology

All control-plane services on node1 (192.168.0.25), each bound to `127.0.0.1` (except node_exporter, §4.4) behind the existing nginx terminating `*.sisp.com` TLS.

| Service | systemd unit | Bind | Public vhost |
|---|---|---|---|
| AppHub API (Node, 8792) | `apphub.service` | 127.0.0.1:8792 | apphub.sisp.com (`/api`, `/`) |
| Auth provider (8888 `/check`,`/auth`) | `apphub-auth.service` | 127.0.0.1:8888 | via auth_request |
| MapDrive portal + Samba re-export | `mapdrive.service` + `smbd`/`nmbd` | 127.0.0.1:8793 / 445 | mapdrive.sisp.com |
| PostgreSQL (state DB) | `postgresql.service` | unix socket | — |
| Prometheus | `prometheus.service` | 127.0.0.1:9090 | grafana-proxied only |
| Alertmanager | `alertmanager.service` | 127.0.0.1:9093 | — |
| Grafana | `grafana-server.service` | 127.0.0.1:3000 | grafana.sisp.com (admin-only) |
| Loki | `loki.service` | 127.0.0.1:3100 | — |
| Promtail | `promtail.service` | — | ships to Loki |
| node_exporter | `node_exporter.service` (node1-4) | **192.168.0.2x:9100** | — |
| SLURM exporter | `slurm-exporter.service` | 127.0.0.1:9341 | — |

On node[2-4]: only `node_exporter` (bound to the cluster IP) plus the existing slurmd/apptainer. No portal code runs there. Image build/prewarm stay as SLURM/`srun` jobs.

#### 1.1 Filesystem layout — hot-path state lives on LOCAL disk (resolves MISSING: JOB_ROOT/LOG_ROOT drift)

The scaffold's `apphub.service` set `JOB_ROOT`/`LOG_ROOT` under `/var/lib`, but the installed `apphub.env` overrode them to the CIFS mount, and EnvironmentFile wins — so status.json/logs silently lived on the fragile mount, the exact thing that wedges the reconcile loop (§3.2). **Decision, deliberate:** hot-path state that the reconcile loop reads every cycle lives on node1 **local disk**; only artifacts that compute nodes must read live on the share.

- `/opt/sisp-apphub/` — released code (immutable per release; installer `mv`s old to `/opt/sisp-apphub.backup.<ts>`).
- `/etc/sisp-apphub/apphub.env` — env (0640 root:apphub).
- `/var/lib/sisp-apphub/{jobs,logs,cluster,backups}` — **local** runtime state. `status.json`/`runner-status.json` (hot path) live here.
- `/mnt/sisplockers/apphub/{runtime,images,workspaces}` — CIFS-shared: job scripts, manifests, `.sif` images, user workspaces — written once at launch, read by compute nodes; **not** polled every reconcile cycle.
- `/var/lib/prometheus` and `/var/lib/loki` — see §4.5 (sized volume).
- `/etc/nginx/apphub/routes.map` — dynamic vhost map (single source of truth).

The installer asserts `JOB_ROOT`/`LOG_ROOT` resolve under `/var/lib` and fails the smoke gate otherwise.

#### 1.2 Hardening additions to `apphub.service`

```ini
Environment=APPHUB_SLURM_MODE=slurm
Environment=UV_THREADPOOL_SIZE=16        # bound, raised from default 4 (see §3.2)
Environment=APPHUB_FS_TIMEOUT_MS=2000
TimeoutStartSec=30
WatchdogSec=60                           # sd_notify gated on reconcile completion, §3.2
Restart=on-failure
RestartSec=3
StartLimitIntervalSec=300
StartLimitBurst=5
MemoryMax=1536M
CPUQuota=200%
ReadWritePaths=/var/lib/sisp-apphub /etc/nginx/apphub
```

The `MemoryMax`/`CPUQuota` cap means a runaway portal cannot starve node1.

#### 1.3 Installer bug fixed on first clean build

`install-node1.sh` wrote `APPHUB_SLURM_MODE=mock` into the live env while the unit set `slurm`; EnvironmentFile won, so prod silently ran mock. The clean installer writes `slurm` and the smoke gate (§7) asserts `/api/health.slurmMode == "slurm"` before declaring success.

### 2. Live cluster-utilization feed — two distinct facts per node

#### 2.1 Source of truth and the SLURM-version decision (resolves MISSING: text vs json)

The scaffold parses **text** (`squeue -h -o "%T|%N"`, `scontrol show job` regex in `lib/slurm.js`). The original sampler assumed `--json` (Slurm ≥ 21.08, requires `data_parser`). Shipping both doublesthe breakage surface. **Decision:** standardize on **one text path** using stable `--Format`/`-O` and `-o` columns that have existed since well before 21.08, and drop the `--json` dependency entirely. The smoke gate runs `sinfo --version`, records it in `/opt/sisp-apphub/RELEASE`, and asserts the parser's expected columns exist. If the cluster is later confirmed ≥ 23.02 with `data_parser/v0.0.40`, a single config flag `APPHUB_SLURM_FORMAT=json|text` may switch parsers — but only one is active per deploy, chosen by the verified version.

Critically (resolves HIGH issue #3): **`scontrol`/`squeue` report SLURM *allocation*, not OS load.** node1 is control-plane-only and excluded from scheduling, and may run no slurmd at all — so its allocation reads ~idle even while nginx+TLS+OpenLDAP+Postgres+portal+the five persistent third-party apps saturate its 28 cores. Therefore:

- **OS load / CPU / RAM per host** (all four nodes, including node1) is sourced from **node_exporter via Prometheus**, which we already deploy. This is what users see as the "how busy is this box" gauge.
- **SLURM allocated CPUs / queue depth / partition idle** is sourced from `squeue`/`scontrol` text. This is the scheduling view.

The dashboard shows both, labelled distinctly, so node1's gauge reflects *real* load and never the comforting lie of `cpusAlloc:2`.

#### 2.2 Sampler (in-process, single batched call, re-entrancy guarded)

`sampleCluster()` runs on the reconcile machinery on its own interval `APPHUB_CLUSTER_SAMPLE_MS=15000`:

1. **One** `squeue` for all apphub jobs (job-name prefix `apphub-`) plus **one** `sinfo`/`scontrol show node` — not per-app (resolves issue #5's O(N) spawn storm). Each is a `timeout 2`-wrapped child process.
2. For per-host load, read the latest values from the local Prometheus HTTP API (`127.0.0.1:9090/api/v1/query`) — node_exporter `node_load1`, `node_memory_*`. If Prometheus is down, the SLURM-allocation half still renders and the load half greys out.
3. Tag node1 `role:"control"`, node[2-4] `role:"compute"`.
4. Cache in memory and atomically write `/var/lib/sisp-apphub/cluster/state.json` (temp + `rename`).
5. On error, keep last-good with `stale:true` + `ageSec` (derived from synchronized clocks, §4.6).

Served at `GET /api/cluster` (authenticated; node-level numbers visible to all, per-user queue breakdown admin-only). Frontend polls 15s, renders gauges, greys out on `stale`; empty state renders a skeleton, never a spinner.

#### 2.3 Data shape

```json
{
  "sampledAt": "2026-06-27T04:00:00Z", "stale": false, "ageSec": 4,
  "totals": {"cpusTotal":112,"cpusAlloc":68,"memTotalMb":515072,"memAllocMb":311296},
  "nodes": [
    {"name":"node1","role":"control","slurmd":false,
     "load1":21.7,"cpusTotal":28,"memUsedMb":94000,"memTotalMb":128768,"up":true},
    {"name":"node2","role":"compute","slurmd":true,"state":"mixed",
     "cpusTotal":28,"cpusAlloc":24,"load1":22.1,
     "memTotalMb":128768,"memAllocMb":98304,"memUsedMb":101200,"up":true}
  ],
  "queue": {"pending":3,"running":11,"longestPendingSec":420,"byUser":{"dianap":2}},
  "partitions":[{"name":"large","nodes":["node2","node3","node4"],"idleCpus":12}]
}
```

node1 carries `load1`/`memUsed` (from node_exporter) and `slurmd:false`; compute nodes carry both allocation and load.

#### 2.4 Two independent readers

Grafana/alerting read Prometheus directly, never the portal feed. If the in-UI gauge and Grafana disagree, that divergence is itself a signal.

### 3. Health, probes & the CIFS-wedge fix

#### 3.1 Layered health endpoints

- `GET /api/health` (shallow, **no fs**): `{ok, slurmMode, store, runtime}` — nginx/systemd liveness.
- `GET /api/health/deep` (admin/localhost only): per-dependency status. **Every mount/SLURM probe runs as a `timeout`-bounded child process, never in-process `fs` (see 3.2):**
  - `db`: `SELECT 1` round-trip ms.
  - `slurm`: `timeout 2 sinfo -h -o "%a"` reachable.
  - `cifs`: `timeout 2 stat /mnt/sisplockers/apphub/runtime/templates.json` in a child process — a stall returns red, it does **not** block the event loop or leak a threadpool worker.
  - `nginxRouteMap`: routes.map writable + `nginx -t` clean.
  - `auth`: `127.0.0.1:8888/check` returns 401 (not 502) for anonymous.
  - `sampler`: `ageSec` of cluster state.
  - 200 only if all green; 503 + JSON detail otherwise.

#### 3.2 The CIFS-wedge fix (resolves HIGH issue #1 — the core reliability claim)

The original watchdog design was false against its target failure mode. Confirmed in code: `reconcileApps()` awaits `slurm.readJobStatus()` per app, which `fs.readFile()`s `runner-status.json`/`status.json`. Node `fs` runs on the libuv threadpool. A hard CIFS stall (NAS reboot/network blip — the single most likely node1 failure since node1 is the CIFS gateway) blocks the syscall **in-kernel**; an `AbortSignal`/`Promise.race` returns to the caller but the worker thread stays stuck. Four stuck reads exhaust the default pool of 4; all further fs/dns/crypto queue forever. A `setInterval` `WATCHDOG=1` ping touches no fs, so it keeps firing and systemd never restarts; shallow `/api/health` keeps returning 200. The platform is wedged while every liveness signal says healthy. A naive `fs.stat` deep-probe makes it worse — one leaked thread per stuck probe.

Fix, layered:

1. **All mount and job-status reads go through a kill-able child process.** `readJobStatus()` is rewritten to read status files via `timeout ${APPHUB_FS_TIMEOUT_MS/1000} cat <path>` (or a small helper `read-with-timeout`), never `fs.readFile` on the mount. A wedged mount kills the child at the timeout; the kernel reaps it; the threadpool is never poisoned. (Local `/var/lib` reads stay in-process — they cannot wedge.)
2. **Watchdog gated on real progress.** `WATCHDOG=1` is sent **only when a reconcile cycle actually completes** within the window — `lastReconcileCompletedAt` is checked against `WatchdogSec/2`. A wedged loop stops pinging, so systemd restarts the process. This is the opposite of a free-running timer.
3. **Bounded, raised threadpool:** `UV_THREADPOOL_SIZE=16` so transient slowness has headroom, still bounded so it can't explode memory.
4. **Mount the re-export read path `soft,timeo=30,retrans=2`** where write-safety allows (coordinated with the storage subsystem) so the kernel itself returns EIO instead of hanging forever. Hot-path state on local disk (§1.1) means most cycles never touch the mount at all.

#### 3.3 Logging pipeline — bounded Loki cardinality (resolves issue #6)

Promtail scrapes journald units (`apphub`, `apphub-auth`, `mapdrive`, `nginx`, `postgresql`, `prometheus`, `alertmanager`, label `unit`), nginx access/error (label `vhost`, JSON access log with `$apphub_upstream`/auth result/request time), and per-app job logs.

**Loki index labels are low-cardinality only: `unit`, `vhost`, `template`, `node`.** `appId` and `owner` are **not** index labels (per-launch `appId` across 55 users over 14d is the canonical stream-explosion anti-pattern that would degrade the very box we keep light). They are carried in the log line / structured metadata and filtered at query time. The portal's "Logs" tab reads the same NFS bytes (last 20KB) the user sees.

The AppHub **audit log** (Postgres `apphub_audit`, last 2000 events, unbounded retention — cheap) is the authoritative human-action trail ("who launched/approved/stopped"); Loki is the firehose ("what the process printed"). Retention: Loki 14d, journald `SystemMaxUse=2G`.

### 4. Metrics & Prometheus

`/etc/prometheus/prometheus.yml` jobs: `node` (node1-4 cluster-IP `:9100`), `apphub` (`127.0.0.1:8792/metrics`), `slurm` (`127.0.0.1:9341`), and `prometheus`/`alertmanager`/`loki` self-scrapes (resolves "who watches the watchers").

#### 4.1 AppHub `/metrics` — localhost-only, auth-bypassed (resolves MISSING)

`/metrics` is served by the portal but **must not** pass through nginx `auth_request` (Prometheus has no cookie) and **must not** be public. It is exposed on a **separate localhost listener** `127.0.0.1:8792` path that nginx does **not** proxy on the public vhost; Prometheus scrapes it directly over loopback. The public `apphub.sisp.com` nginx config has no `location /metrics`. Exposition reuses values already computed by reconcile/sampler:

```
apphub_apps_total{status="running"} 11
apphub_apps_total{status="queued"} 3
apphub_apps_total{status="pending_route"} 1
apphub_apps_total{status="failed"} 2
apphub_ports_in_use 12
apphub_ports_capacity 1000
apphub_port_collisions_total 0          # §8 atomic allocation
apphub_route_count 11
apphub_reconcile_duration_seconds 0.42
apphub_reconcile_inflight 0             # re-entrancy guard, §4.3
apphub_reconcile_last_success_timestamp 1.71e9
apphub_cluster_cpus_alloc 68
apphub_cluster_cpus_total 112
apphub_job_stuck_total{reason="queued_too_long"} 1
apphub_job_zombie_total 0
apphub_jobs_orphaned 0                   # reverse reconcile, §4.2
apphub_dep_up{dep="db"} 1
apphub_dep_up{dep="cifs"} 1
apphub_dep_up{dep="slurm"} 1
```

#### 4.2 Reverse reconcile — orphaned SLURM jobs (resolves HIGH issue #4)

The scaffold reconciler is one-directional: it iterates `store.listApps()` (DB rows) and reads each job's status; it never enumerates `squeue` and maps unknown jobs back to apps. After a DB restore to an older dump (or DB loss → FileStore), any app launched after the dump is gone from the DB but its container is still RUNNING on node[2-4] holding CPU/RAM; nothing reaps it and `OrphanRoute` only covers routes-without-apps. The clean rebuild adds a **reverse pass**: list `squeue --name=apphub-* -u <apphub-launch-user>`, and for every SLURM job with no matching DB app, either **re-adopt** from `manifest.json` on the share (rebuild the DB row + route) or, if the manifest is gone, flag it as **proposed-cancel**. Surfaces `apphub_jobs_orphaned` + alert `JobOrphanedNoDbRow`. The restore runbook (§6.3) runs this pass before declaring green.

#### 4.3 Reconcile concurrency control (resolves issue #5)

`setInterval` did not guard against a still-running cycle, so under CIFS slowness cycles overlapped and two reconciles could both write `routes.map` and both call `apphub-nginx-reload`, racing the single source of truth. Fixes:

- **Re-entrancy guard:** skip a tick if the previous cycle is in-flight (`apphub_reconcile_inflight`).
- **Single batched `squeue`** for all jobs (also §2.2), not per-app.
- **Serialized routes.map writes** behind an in-process async lock; **debounced nginx reload** — coalesce all route changes in a cycle into one `apphub-nginx-reload`.

#### 4.4 SLURM exporter & node_exporter — CIFS, not NFS (resolves issue #10)

`prometheus-slurm-exporter` (read-only `squeue`/`sinfo`) as `slurm-exporter.service` feeds node state, partition idle CPUs, pending-age histogram, per-user running jobs. node_exporter on each node uses `--collector.filesystem` (which exposes `node_filesystem_*{fstype="cifs"}`) — **not** `--collector.nfs`, because the re-export is CIFS/SMB and would never appear in `/proc/self/mountstats`. The stale-mount alert keys on `fstype="cifs"` plus a textfile-collector probe that runs `timeout 2 stat` on the mount and writes `apphub_cifs_mount_ok 0|1`. node_exporter binds to the **cluster IP (192.168.0.2x:9100)**, not `0.0.0.0`, and is firewalled off the public interface (asserted in the smoke gate, §7/§4.7).

#### 4.5 TSDB/Loki disk budget (resolves MISSING: DiskLow too late)

Prometheus TSDB and Loki chunks get a **dedicated volume** `/var/lib/{prometheus,loki}` (or an LVM volume separate from `/var`), so a filling TSDB cannot ENOSPC the OS root or corrupt on write. Retention sized to the volume: Prometheus `--storage.tsdb.retention.time=30d` **and** `--storage.tsdb.retention.size` set to ~70% of the volume; Loki 14d. `DiskLow` fires at **25%** free on these volumes and node1 `/var` (not 10% — far too late for a TSDB), with a `crit` at 15%.

#### 4.6 Grafana

Admin-only behind nginx at `grafana.sisp.com` (auth_request → nginxauth cookie + `APPHUB_ADMIN_GROUPS=sisp-admins` header check). Dashboards: **Cluster** (per-node OS load *and* SLURM-alloc, queue depth, idle-CPU-on-node[2-4]); **AppHub** (status over time, launch success rate, reconcile latency, port headroom); **node1 control plane** (apphub/nginx/postgres CPU+mem, watchdog restarts, CIFS latency, the five third-party app probes); **Logs** (Loki error stream). Defense-in-depth per issue #14: Grafana's own auth DB is enabled, `auth.proxy` trusts `X-WEBAUTH-USER` **only** from the nginx source with a shared `X-WEBAUTH-SECRET` header, so a co-tenant process on node1 hitting `127.0.0.1:3000` directly cannot forge an admin identity.

#### 4.7 Time sync & port-isolation assertions (resolves MISSING: NTP)

`chrony` is required on node1-4 and verified in the smoke gate (`chronyc tracking` offset < 100ms); `sampledAt`/`ageSec`, `squeue` pending-age, and cross-node Loki correlation depend on it. The smoke gate also asserts 9090/3000/9100/9093/3100 are **not** reachable from the public interface.

### 5. Alerting

Alertmanager → receivers chosen so **alert delivery does not share fate with the monitored host** (resolves issue #9):

- **Primary in-band:** Zulip `#apphub-ops` (`zulip.sisp.com`) — fine for warnings while node1 is healthy.
- **Critical out-of-band:** criticals are also sent via an **external SMTP relay** (not node1's local MTA) to `heng.kkpk@gmail.com` and, if available, a second channel not hosted on node1.
- **Deadman's switch:** an always-firing `Watchdog` alert is routed to the **external** receiver; its *absence* there signals total node1 loss (Prometheus/Alertmanager itself down, or node1 hard-down). This is the only way single-node alerting can report its own full outage. Documented as such.

Every node-mutating alert embeds the exact **owner-verified** human-run remediation command (§5.3).

| Alert | Condition | Sev | Proposed action |
|---|---|---|---|
| `JobQueuedTooLong` | PENDING > 15m while compute idleCpus ≥ app.cpus | warn | `squeue -j <id> --start`; check partition/exclude |
| `JobPendingRouteStuck` | `pending-route` > 5m | warn | run nginx-reload (§5.3); `POST /api/admin/reconcile` |
| `JobZombie` | runner exited but squeue=RUNNING | crit | owner-verified cancel via wrapper (§5.3) |
| `JobGhostAlloc` | RUNNING, no status.json 3m, no log growth | crit | `scontrol show job <id>`; propose cancel |
| `JobOrphanedNoDbRow` | squeue apphub job with no DB app (§4.2) | crit | re-adopt or owner-verified cancel |
| `OrphanRoute` | route in routes.map with no active app | warn | reconcile + nginx-reload |
| `PortPoolLow` | `apphub_ports_in_use/1000 > 0.8` | warn | raise range / clear stopped apps |
| `PortCollision` | `apphub_port_collisions_total` increased | crit | inspect overlapping launches (§8) |
| `ReconcileStalled` | `time()-reconcile_last_success > 120s` | crit | check apphub.service, CIFS mount |
| `ReconcileWedged` | `apphub_reconcile_inflight=1` for > 90s | crit | watchdog should restart; inspect CIFS |
| `CifsStale` | `apphub_cifs_mount_ok=0` OR `node_filesystem_*{fstype="cifs"}` missing | crit | remount (human, with storage subsystem) |
| `Node1Saturated` | node_exporter `node_load1{node1} > 24` for 10m | crit | find offender; ensure no per-user app on node1 |
| `QueueBacklog` | pending > running AND all compute idle=0 for 10m | warn | capacity event |
| `DiskLow` | TSDB/Loki vol or `/var` < 25% | warn/crit | prune logs/images; see §4.5 |
| `BackupStale` | newest dump age > 26h (§6) | crit | inspect backup timer / mount |
| `ImageMissing` | template enabled but `.sif` absent | warn | `build-runtime-images-node2.sh` via srun |
| `ObservabilityDown` | self-scrape of prom/alertmanager/loki/promtail down | crit | restart unit (human) |

**Stuck/zombie detection lives in the reconcile loop, with state persisted in Postgres (resolves issue #7).** The scaffold's in-memory `firstSeenInState` would reset on every restart — and we *want* the watchdog to restart often on CIFS stalls — so an in-memory clock would never cross `JobQueuedTooLong`/`JobZombie`/`ReconcileStalled` for a genuinely stuck job. The clean rebuild stores `first_seen_in_state` and `stuck_reason` in `apphub_apps`; all durations derive from DB timestamps, surviving restarts. Detection is automated; the kill is proposed, not executed.

#### 5.3 Owner-verified, paste-safe remediation (resolves issues #8 and #13)

Two corrections to the "one-paste human remediation" promise:

1. **Confused-deputy in the wrapper (issue #8).** In `runtime/wrappers/apphub-sbatch-as-user.sh`, the root branch of `cancel` runs `scancel "$target"` (the bare jobId) without checking that the job belongs to `$target_user` — so a wrong/stale/crafted jobId could cancel **any** SLURM job on the cluster. Fixed: the cancel branch resolves the job's owner (`scontrol show job <id>` → `UserId`) and refuses unless it matches the resolved uid of `target_user`, or simply runs `scancel` **as the target uid** exactly as the submit path already does (`sudo -n -u "#$target_uid"`). All `JobZombie`/`JobGhostAlloc`/orphan remediations go through this guarded wrapper, never a raw `scancel`.
2. **`sudo -n` fails for human operators (issue #13).** NOPASSWD is granted only to the `apphub` user. A human admin (e.g. `nodeadmin`) pasting `sudo -n /usr/local/sbin/apphub-nginx-reload` gets "a password is required". So operator-facing commands are generated **without `-n`** and with **absolute paths** (`/opt/sisp-apphub/runtime/wrappers/apphub-sbatch-as-user.sh`). The preferred path is the **admin-UI button** that invokes the server-side `apphub`-NOPASSWD path behind a confirm dialog, so the operator never needs sudo rights at all. The doc states explicitly: automated/button remediations run as `apphub` (NOPASSWD); manually-pasted commands run as a sudo-capable admin and will prompt for a password.

### 6. State-DB backup & restore — independent of the fragile mount

State that must survive node1 loss: Postgres `sisp_apphub` (apps, routes, templates, support, audit), `/etc/sisp-apphub/apphub.env`, `/etc/nginx/apphub/routes.map`, and the share's `runtime/templates.json` + `definitions/`. Workspaces/images are the storage subsystem's responsibility.

#### 6.1 Schedule — every step `timeout`-wrapped (resolves MISSING: backup hangs on mount)

`apphub-backup.timer` (`OnCalendar=*-*-* 02:00`, `Persistent=true`) → `apphub-backup.service`. The original tar read `templates.json` from CIFS and `pg_dump`/`find` ran unbounded — a stalled mount would hang the backup service forever. Every step is now `timeout`-wrapped, dumps land on **local disk first**, then copy to NFS:

```bash
set -euo pipefail
ts=$(date +%F_%H%M)
timeout 600 pg_dump --format=custom --no-owner sisp_apphub \
  > /var/lib/sisp-apphub/backups/sisp_apphub_$ts.dump
timeout 120 tar czf /var/lib/sisp-apphub/backups/config_$ts.tgz \
  /etc/sisp-apphub/apphub.env /etc/nginx/apphub/routes.map
# share artifacts copied with a bounded timeout; failure is non-fatal, alerts via BackupStale
timeout 60 cp /mnt/sisplockers/apphub/runtime/templates.json \
  /var/lib/sisp-apphub/backups/templates_$ts.json || echo "WARN: share snapshot skipped"
( cd /var/lib/sisp-apphub/backups && sha256sum *_$ts.* > SHA256SUMS_$ts )
# off-node copy last, bounded
timeout 300 cp /var/lib/sisp-apphub/backups/*_$ts.* \
  /mnt/sisplockers/apphub/backups/ || echo "WARN: off-node copy skipped"
```

Retention: 14 daily + 8 weekly (`find -mtime`). A weekly **restore-verify** job loads the latest dump into a throwaway `sisp_apphub_verify` DB and runs `SELECT count(*)` sanity — backups are proven, not assumed. Alerting is on **backup age** (`BackupStale` > 26h, §5), not merely on job failure, so a silently-skipped copy is caught.

#### 6.2 Postgres durability — no WAL-to-CIFS (resolves HIGH issue #2)

The original `archive_command='cp %p /mnt/sisplockers/.../wal/%f'` coupled Postgres availability to the exact flaky mount the rebuild exists to de-risk: if the CIFS target stalls or fills, `archive_command` blocks/fails, Postgres cannot recycle WAL, `pg_wal` grows until node1 ENOSPC, and the primary halts all writes — enabling PITR could itself take the control-plane DB down. **Decision:** the **restore-verified nightly custom-format dump + off-node copy is the primary and sufficient** durability mechanism for a 4-node lab. If PITR is later wanted, WAL archives to **local disk** with a bounded `archive_command` and an async out-of-band copier to NFS, plus `archive_timeout=300` and a hard `pg_wal`-size alert well above the `DiskLow` threshold. Postgres durability never depends on the fragile mount.

#### 6.3 Restore runbook (confirmation-required)

1. Enter maintenance mode (§7.3): `systemctl stop apphub.service`.
2. `pg_restore --clean --if-exists -d sisp_apphub <dump>` (human confirms).
3. **Run the reverse-reconcile pass (§4.2)** — list `squeue` apphub jobs and re-adopt/propose-cancel any with no DB row, *before* trusting the route map. Then `POST /api/admin/reconcile` so the forward loop re-derives routes from reality and rewrites `routes.map`, then nginx-reload.
4. `GET /api/health/deep` green → exit maintenance.

FileStore fallback (`apphub.json`) is the degraded mode if Postgres is down: empty `DATABASE_URL`, restart — portal stays usable read/write while the DB is recovered (then reverse-reconcile on the way back).

### 7. Upgrade / rollback

#### 7.1 Release flow (each step human-gated)

1. Build `apphub-deploy-<gitsha>.tgz` off the clean repo; record git SHA + verified `sinfo --version` (§2.1) in `/opt/sisp-apphub/RELEASE`.
2. Pre-flight on node1: `pg_dump` (§6) + snapshot `routes.map` + record current `RELEASE` sha.
3. Enter maintenance mode (§7.3).
4. Installer: untar, `npm ci --omit=dev`, run idempotent `schema.sql` (all `create ... if not exists`, additive only).
5. `systemctl restart apphub.service`.
6. **Canary gate:** run `smoke-node1.py`, `auth-smoke-node1.py`, `real-slurm-smoke-node1.py`, `check-nginx-node1.py`; assert `/api/health/deep` all-green, `slurmMode=="slurm"`, `JOB_ROOT` under `/var/lib`, chrony offset OK, the firewall port-isolation assertion, and a **websocket smoke** (§7.4). Any failure → auto-rollback.
7. Exit maintenance.

#### 7.2 Rollback (`rollback-node1.sh`)

```bash
systemctl stop apphub.service
rm -rf /opt/sisp-apphub && mv /opt/sisp-apphub.backup.<ts> /opt/sisp-apphub
# DB rollback ONLY if a destructive migration ran (policy below makes this rare)
pg_restore --clean --if-exists -d sisp_apphub <pre-upgrade.dump>
install -m0644 /opt/sisp-apphub/deploy/apphub.service /etc/systemd/system/
systemctl daemon-reload && systemctl restart apphub.service
# rerun canary smokes incl. websocket + reverse-reconcile
```

Code rollback is an instant dir swap. **Migrations are additive-only** (new columns/tables, never drop in the same release) so code rolls back without DB rollback; drops happen one release later after the new code is proven.

#### 7.3 Maintenance mode — an authorized node-mutating action (resolves MISSING)

Creating/removing `/etc/nginx/apphub/maintenance.flag` triggers nginx behavior, so by the boundary rule it is node-mutating. **Clarification:** the deploy/rollback scripts (`install-node1.sh`, `rollback-node1.sh`) are themselves **approved, human-gated operations** — an admin invokes them knowingly, which constitutes the confirmation for the maintenance-flag toggles they perform. Outside a deploy, the flag may be toggled only by a sudo-capable admin or the admin-UI button (§5.3). nginx serves a friendly themed 503 (`/maintenance.html`, "back at HH:MM") when the flag exists. Running SLURM apps keep running on compute nodes; only portal UI/launch pauses.

#### 7.4 Websocket & long-lived proxy config (resolves issue #11)

Jupyter, RStudio, Streamlit, Dash, Gradio, Galaxy all use websockets and long-lived connections; `routes.map` is only host→upstream. Without `Upgrade`/`Connection` passthrough and raised timeouts, apps "hang"/disconnect at the proxy — reproducing Problem B even after compute moves off node1. The app-proxy `location` template bakes in:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;   # map: '' default, 'upgrade' on Upgrade
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_buffering off;
```

A deploy is not green until the **websocket smoke** opens a WS through a freshly launched app and exchanges a frame.

### 8. Capacity planning — fixing slow/hung directly

Root cause of Problem B: jupyter/rstudio/galaxy ran as long-lived processes on node1, the box also doing LDAP+nginx+TLS+portal. Response:

1. **node1 = control plane only.** Default launches add `#SBATCH --exclude=node1` (extend the scaffold's allowedNodes exclude); the cgroup cap on `apphub.service` (§1.2) bounds even mis-scheduled load. The five persistent third-party apps (cmssight, dmmr, leantime, zulip, vitessce) keep running as-is but are **monitored** (node_exporter + a blackbox HTTP probe per vhost) and counted in node1's headroom budget. node1's gauge reflects their real load (§2.1).
2. **Per-user apps → SLURM on node[2-4]** (84 CPU / ~384 GB usable). Apptainer images prewarmed so cold-start isn't mistaken for "hung."
3. **Right-size defaults** in `templates.json`: light no-code apps `defaultCpus=2, defaultMemoryMb=4096, defaultTimeMinutes=240`; heavy (jupyter/rstudio) `defaultCpus=4, defaultMemoryMb=16384`. At 2-CPU defaults, node[2-4] sustain ~40 concurrent light apps before queueing — above the ~55 users (rarely all concurrent).
4. **Queue, don't thrash.** SLURM cgroup/`ConstrainRAMSpace` gives each app a hard slice; when compute is full, launches **queue** with an honest "~N ahead" message instead of a silent hang.
5. **Atomic port allocation (resolves issue #8/#12).** `allocatePort` is currently check-then-act (SELECT used ports, pick first free) with no lock, so two simultaneous launches — the exact concurrency that hung the platform — can hand out the same port and collide if SLURM co-locates them. Fixed with a **partial-unique index** `(target_host, target_port) WHERE active` plus a transactional `INSERT ... ON CONFLICT` retry (or a `pg_advisory_xact_lock` over the port range), surfacing `apphub_port_collisions_total` so ops can see any contention (`PortCollision` alert).
6. **Capacity KPIs** on the cluster dashboard + monthly review: peak concurrent running apps, queue-wait p95, idle-CPU-on-node[2-4] (under-utilization = wasted budget), port headroom. Add node5 / raise per-template caps when queue-wait p95 > 5m for two weeks.
7. **Idle reaping:** templates carry `maxTimeMinutes` → SLURM `--time` auto-terminates forgotten apps. An optional "idle 2h" reaper (no HTTP traffic per nginx access logs in Loki) **proposes** stop — never auto-stops.

### 9. Runbooks (`docs/runbooks/`, linked from Grafana alert annotations)

Portal down · App stuck queued · Zombie/ghost job (owner-verified cancel) · Orphaned SLURM job with no DB row (reverse reconcile) · Orphan vhost/404 · **CIFS stale on node1** (deep-health red, watchdog restarts, remount with storage subsystem) · Postgres down (FileStore fallback) · Restore from backup (§6.3) · Upgrade & rollback (§7) · Cert renewal/nginx reload · Node[2-4] drained/down · Port pool exhaustion / collision · Total node1 outage (deadman's-switch interpretation) · Alert silence in Alertmanager. Each: symptom → automated `timeout`-bounded diagnostics → human-confirmed fix command → verification via `/api/health/deep`.

### 10. Interfaces to other subsystems

- **Storage subsystem:** owns the CIFS re-export and its mount options. This subsystem *requires* `soft,timeo=30` on the read path (§3.2), the `fstype=cifs` mount being present for `apphub_cifs_mount_ok`, and the NFS `backups/` target. Workspace/image backup is theirs.
- **Auth/identity (OpenLDAP on node1):** Grafana/admin gating reuses the nginx `auth_request` cookie + `sisp-admins` group; the wrapper's owner verification resolves uid/gid via `getent passwd` (LDAP). A DiskLow/saturation event on node1 also degrades LDAP — flagged in `Node1Saturated`.
- **AppHub core (launch/reconcile):** this subsystem adds the metrics endpoint, deep-health, reverse-reconcile pass, persisted stuck-clock, re-entrancy guard, and atomic port allocation to the shared `server.js`/`lib`. These are co-owned and must land in the clean rebuild together.
- **Networking/TLS:** see open question on the per-app wildcard cert.

### Resolution summary

All four HIGH issues are resolved (CIFS-wedge via kill-able child reads + progress-gated watchdog; WAL-to-CIFS dropped; node1 gauge from node_exporter; reverse reconcile). All MEDIUM issues resolved (reconcile mutex/batched squeue/debounced reload; Loki low-cardinality labels; DB-persisted stuck clock; owner-verified wrapper cancel; out-of-band alerts + deadman switch; `fstype=cifs` collector; websocket proxy config + smoke). LOW issues resolved (atomic port allocation; paste-safe non-`-n` commands + admin button; Grafana own-auth + cluster-IP bind + firewall smoke). MISSING items addressed: single text SLURM parser pinned & version-verified; localhost-only auth-bypassed `/metrics`; dedicated TSDB/Loki volume + 25% DiskLow; chrony required & verified; observability self-monitoring + deadman switch; `timeout`-wrapped backups + backup-age alert; maintenance-flag lifecycle clarified; hot-path state moved to local `/var/lib`. The per-app wildcard-cert strategy is escalated as an open question (below).

**Dependencies:** storage-subsystem (CIFS re-export, soft/timeo mount options, fstype=cifs presence, NFS backups/ target, workspace+image backup ownership), auth-identity-subsystem (OpenLDAP uid/gid resolution for wrapper owner verification; nginx auth_request cookie + sisp-admins group for admin gating), apphub-core-subsystem (shared server.js/lib for /metrics, deep-health, reverse reconcile, persisted stuck-clock, re-entrancy guard, atomic port allocation), networking-tls-subsystem (wildcard cert strategy for dynamically-named *.app.sisp.com hosts; nginx routes.map and reload privilege), slurm-scheduler-subsystem (squeue/sinfo/scontrol text interfaces, partition layout, --exclude=node1 policy, cgroup/ConstrainRAMSpace enforcement)

**Open questions:** 
- Per-app TLS: are launched apps served under a wildcard cert (*.app.sisp.com or path-based under apphub.sisp.com)? If wildcard, what is the auto-renew mechanism and does adding a routes.map entry require any cert action? The deploy topology must state this before dynamic per-app hostnames go live.
- Is node1 a slurmd node at all, or strictly control-plane with no slurmd? This determines whether node1 appears in scontrol output and finalizes the gauge sourcing; current design assumes no slurmd on node1 and sources its load purely from node_exporter.
- Should we provision a node2 standby for Grafana/Alertmanager (and possibly a Postgres replica) to remove node1 as a single point of failure for observability and state, or is the restore-from-dump RTO acceptable for the lab?
- Confirm the actual Slurm version on node[1-4] (sinfo --version) so the smoke gate's column assertions and the text-vs-json parser choice are pinned to ground truth rather than assumed.
- Who are the authorized human operators for confirmation-required remediations (which LDAP accounts get sudo/NOPASSWD vs admin-UI-button access), and is heng.kkpk@gmail.com the sole critical-alert recipient or should a team/distribution list receive the external out-of-band channel?
- What external SMTP relay is available for out-of-band criticals, and is a non-node1-hosted second channel (e.g. a cloud webhook) acceptable to the lab's network/security policy?

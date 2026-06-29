# AppHub Auth Gateway (Authelia + nginx)

Implements the LDAP authentication front for AppHub (ADR-001 / Q15). Authelia authenticates
users against the existing OpenLDAP; nginx `auth_request` enforces it and forwards the verified
identity to the AppHub backend as the `X-Remote-*` headers it already trusts.

## How it fits the backend contract
The AppHub backend (`apphub/backend/src/lib/auth.js`) is **header-trust, fail-closed**: it
accepts identity ONLY from `X-Remote-User` / `X-Remote-Groups`, and ONLY when the request also
carries `X-Auth-Proxy == APPHUB_PROXY_SECRET`. This gateway provides exactly that:

```
browser ──https──▶ nginx (apphub.sisp.com)
                     │  auth_request ──▶ Authelia ──▶ OpenLDAP (verify user+password, get groups)
                     │  on success: set X-Remote-User/Groups from Authelia's Remote-User/Groups,
                     │              inject X-Auth-Proxy=<secret>, OVERWRITE any client X-Remote-*
                     ▼
                   AppHub backend (unix socket)  →  roleForGroups(groups): sisp-admins=admin,
                                                     apphub-power=power, else researcher
```
- Web login = single identity/password (the SMB drive auth stays separate — Samba/NTLM, ADR-001).
- Per-instance app vhosts (`*.app.sisp.com`) are authenticated the same way; the **SSO cookie is
  stripped** before proxying to user/app upstreams (ADR-005 cookie isolation).

## Files
- `configuration.yml` — Authelia: LDAP backend, sessions, access control (sisp group).
- `nginx-apphub.conf` — the edge: auth_request, header injection, SPA + `/api` proxy to the
  backend socket, and `*.app.sisp.com` per-instance routing via the reconciler's `routes.map`.
- `docker-compose.yml` — runs Authelia on node1 (loopback 9091).
- `.env.example` — secrets template.

## Deploy (maintenance window)
1. **LDAP prerequisites** (one-time): create `cn=apphub-ro` (read-only bind) and the role groups
   `ou=Groups` → `cn=sisp`, `cn=apphub-power`, `cn=sisp-admins` (ADR-001 LDIF). Without the role
   groups everyone resolves to `researcher` (safe default).
2. `cp .env.example .env`, fill secrets (`openssl rand -hex 32`); set the LDAP bind password.
3. `docker compose up -d` (Authelia → 127.0.0.1:9091).
4. Install `nginx-apphub.conf` under `/etc/nginx/conf.d/`; replace `__APPHUB_PROXY_SECRET__`
   with the backend's `APPHUB_PROXY_SECRET`; `mkdir -p /etc/nginx/apphub` and point the AppHub
   reconciler's `APPHUB_ROUTES_MAP` at `/etc/nginx/apphub/routes.map`; `nginx -t && reload`.
5. Smoke: hit `https://apphub.sisp.com` unauthenticated → redirected to `auth.sisp.com`; after
   login, `/api/session` returns your user with the right role.

## Known follow-ups
- **StartTLS to LDAP** once the internal CA is in place (currently plaintext on the LAN — switch
  `ldap://`→`ldaps://`, `start_tls: true`).
- **Per-instance authorization** on `*.app.sisp.com`: add an `auth_request` to an AppHub
  `/api/authz/<host>` endpoint so only the owner/shared/admin can open a given instance (ADR-003);
  today the vhost enforces authn + group membership only.
- **Depends on identity reconciliation** (`docs/IDENTITY_AUDIT.md`): users with shadow/local
  accounts must be cleaned up so LDAP groups resolve correctly.

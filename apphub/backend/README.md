# SISP AppHub — Backend (control plane)

Plain-Node API (no framework) per **ADR-005**. Runs in two modes:

- **dev** — `APPHUB_DEV_AUTH=1` synthesizes a user, `APPHUB_SLURM_MODE=mock` fakes the
  scheduler, and state lives in a JSON file. No cluster, no Postgres, no auth gateway.
- **prod** — identity comes from nginx/sisp-sso headers (trusted only with the shared
  proxy secret), jobs are submitted to SLURM via the fail-closed `sbatch-as-user`
  wrapper, and state lives in Postgres.

## Run (dev)

```bash
cd apphub/backend
npm install            # only needs pg for prod; dev runs without a DB
npm run dev            # http://127.0.0.1:8792  (mock SLURM, dev auth)
npm run smoke          # end-to-end checks against the running server
```

Point the frontend at it: in `apphub/frontend/.env.local` set `VITE_USE_MOCK=0` and
`VITE_API_PROXY=http://127.0.0.1:8792`, then `npm run dev` in the frontend.

## API

`GET /healthz` · `GET|DELETE /api/session` · `GET /api/templates` ·
`GET|POST /api/apps` · `GET /api/apps/:id` · `POST /api/apps/:id/stop|extend` ·
`GET /api/apps/:id/logs` · `GET /api/cluster/nodes` · `GET /api/jobs`

## Design properties (from the architecture)

- **Header-trust auth, fail-closed** — inbound `X-Remote-*` is honored only with the
  proxy secret (constant-time compared); with no secret the backend trusts nobody, and
  `bootGuards()` *refuses to start* without a secret in prod or with dev-auth enabled
  alongside any prod signal. TCP binds loopback by default. Malformed group names are
  dropped (`src/lib/auth.js`, `src/config.js`, ADR-001 / RISKS #4).
- **Single-writer reconciler** — the only mutator of lifecycle state + the route table,
  so no multi-writer race on `routes.map` (`src/lib/reconciler.js`, ADR-005).
- **Cached reads, no reconcile-on-read** — `GET /api/apps` serves stored state; the
  reconcile loop is backend-paced, so clients can't recreate the concurrency hang
  (RISKS #8).
- **Atomic port allocation** — `FOR UPDATE SKIP LOCKED` in Postgres
  (`src/lib/postgres-store.js`); first-free in the dev store.
- **squeue-derived routing** — upstreams come from a hard-coded `node→IP` allowlist,
  never from job-written fields (`src/lib/slurm.js` `nodeUpstream`, ADR-003).
- **Server-authoritative limits** — resources/time clamped and public visibility
  refused server-side, regardless of client (`src/lib/validate.js`).
- **Debounced nginx reload** — a burst of launches yields one reload, gated on
  `nginx -t` in the reload wrapper (`src/lib/routes-table.js`).
- **Fail-closed privilege boundary** — `scripts/apphub-sbatch-as-user.sh` refuses
  uid<10000, gid≠100000, reserved users, and bad arg shapes; submits via `runuser`
  with `--export=NONE` and `--exclude=node1` (ADR-002).

## Production env

See `.env.example`. Set `APPHUB_DEV_AUTH=0`, `APPHUB_SLURM_MODE=slurm`, `DATABASE_URL`,
`APPHUB_PROXY_SECRET`, `APPHUB_SBATCH_WRAPPER`, `APPHUB_NGINX_RELOAD`, and a unix-socket
`APPHUB_LISTEN`.

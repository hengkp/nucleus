# SISP AppHub — Frontend (clean rebuild)

Vite + React + TypeScript + Tailwind SPA, built to the approved design language
(`apphub/docs/design/DESIGN_DIRECTION.md`) and the verified architecture
(`apphub/docs/architecture/ARCHITECTURE.md`, ADR-006).

## Run it

```bash
cd apphub/frontend
npm install
cp .env.example .env.local   # VITE_USE_MOCK=1 by default — no backend needed
npm run dev                  # http://localhost:5173
```

It boots straight into the app with **mock data** (the in-browser fake backend in
`src/lib/mockApi.ts`), so you can click through every screen — dashboard, catalog,
launch wizard, instance detail, job queue, workspace, admin, settings — with no
cluster. Visit `/login` to see the sign-in screen.

```bash
npm run build       # typecheck + production build
npm run typecheck   # types only
```

## Design contract (where things live)

| Concern | File |
|---|---|
| Color/spacing/type tokens (light + dark) | `src/index.css` + `tailwind.config.js` |
| Icon seam (Remix → inline SVG later, ADR-006) | `src/components/Icon.tsx` |
| API surface (mirrors the Node control plane) | `src/lib/api.ts` |
| Mock backend | `src/lib/mockApi.ts` |
| Polling cadence safety valve (Problem B) | `src/lib/live.ts` |
| Theme (no-FOUC boot) | `public/theme-boot.js` + `src/lib/theme.tsx` |

## Connecting to the real backend

Set `VITE_USE_MOCK=0`. The SPA then calls same-origin `/api/*`, which nginx routes
to the plain-Node control plane (ADR-005). Auth is handled at the nginx gateway; a
`401` triggers a full-page redirect to `VITE_GATEWAY_LOGIN_URL`.

**Do not** flip `VITE_APPS_READ_IS_CHEAP=1` until the backend ships the cached,
non-reconciling `GET /api/apps` + single-flight reconcile — otherwise fast polling by
many users can recreate the original concurrency hang (see ADR-006 / RISKS #8).

# Nucleus

**Self-service HPC platform for the SISP cluster — host no-code apps and reach your lab data, all on SLURM.**

Nucleus turns a 4-node SLURM cluster + an Infortrend NAS into a self-service platform for a research lab. It has two products that share one identity (LDAP) and one storage fabric (the NAS):

- **AppHub** — launch interactive apps and pipelines (JupyterLab, RStudio, Streamlit/Gradio/FastAPI, static sites, batch jobs, Nextflow/nf-core pipelines, and your own Singularity containers) from a web catalog. Each app runs **as you** inside a Singularity container on a compute node, gets its own URL, and is gated by SSO at the edge.
- **MapDrive** — map the lab's shared NAS folders as a drive on Windows/macOS using your normal LDAP login, through a CIFS gateway (correct file ownership) or straight to the NAS.

## Repository layout

```
apphub/     The no-code app + pipeline platform
  backend/    Plain-Node ESM control plane (SLURM submission, reconciler, files API, store)
  frontend/   Vite + React + TS + Tailwind SPA
  scripts/    Privilege-boundary helpers (sudo): sbatch-as-user, runner, file-helper
  images/     Singularity image build recipes + managed Nextflow config
  examples/   Sample pipeline configs / inputs

mapdrive/   The CIFS/NFS drive gateway — web + desktop apps + server-side provisioning
  web/        Tailwind/Remix portal served at mapdrive.sisp.com (share picker + guides)
  windows/    PowerShell tray app (retarget, session cleanup) + assets
  installer/  Per-user Inno Setup installer builder
  macos/      Swift menu-bar app (source + build.sh); legacy/ holds the older .app/.command
  gateway/    Samba + Authelia + SSSD provisioning for the node1 gateway
  server/     Legacy support API (community posts) — retained for reference

docs/       Design notes, deployment runbooks, security, pain points & solutions
```

## How it works

- **Cluster** — node1 is the control plane + MapDrive gateway (never schedules user jobs); node2–4 run the workloads. All nodes mount the same NAS shares under `/mnt` over NFS.
- **Identity** — one LDAP directory via SSSD/NSS. AppHub submits jobs **as the requesting user** through a tightly-scoped sudo wrapper; MapDrive authenticates the same LDAP users over CIFS.
- **AppHub apps** — a per-app SLURM job runs the chosen Singularity image (`--containall`) on an allocated port; nginx routes `*.app.sisp.com` to it behind Authelia. Apps can opt into an external `*.sisp.freeddns.org:8443` URL with no login (for portfolios/demos).
- **Pipelines** — Nextflow runs inside a SLURM allocation; the form is built from each pipeline's `nextflow_schema.json`, and inputs can point straight at shared NAS data (no copying).
- **MapDrive** — the **gateway** mode (Samba on node1, `\\192.168.0.25\<share>`) re-exports the NFS mounts with correct ownership; **direct** mode connects straight to the NAS (`\\192.168.0.103\<share>`).

## Live services

| Service | URL |
| --- | --- |
| AppHub portal | `https://apphub.sisp.com` |
| App instances | `https://<name>.app.sisp.com` |
| MapDrive portal | `https://mapdrive.sisp.com` |
| Community (Zulip) | `https://zulip.sisp.freeddns.org:8443/` |

## Develop

AppHub frontend (mock API, no backend needed):

```bash
cd apphub/frontend
npm install
npm run dev          # VITE_USE_MOCK defaults on
npm run build        # type-check + production build
```

AppHub backend (plain Node ESM):

```bash
cd apphub/backend
node src/server.js   # configured via .env (SLURM mode, sudo helper paths, store)
```

## Docs

See [`docs/`](docs/) for the deployment runbook, security model, architecture, user guide, and the running list of pain points & solutions. Start with [`docs/README.md`](docs/README.md).

## Status

Running in production on the SISP cluster. Deploys are applied to node1 (`/opt/sisp-apphub`) and the NAS-mounted runner/images; see [`docs/DEPLOY_RUNBOOK.md`](docs/DEPLOY_RUNBOOK.md).

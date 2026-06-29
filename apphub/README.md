# SISP AppHub

SISP AppHub is the no-code portal for launching lab applications through Slurm while keeping node1 as the public control plane.

## Components

- `web/` - static portal for `https://apphub.sisp.com`.
- `server/` - Node API for LDAP-header sessions, app registry, support posts, approvals, audit, Slurm launch, and route metadata.
- `runtime/templates.json` - admin-owned no-code templates for JupyterLab, RStudio, Streamlit, Dash, Shiny, Flask/FastAPI, Gradio, static HTML, and Galaxy tool development.
- `runtime/wrappers/` - controlled Slurm and Apptainer wrappers.
- `deploy/` - nginx, systemd, sudoers, and environment examples.
- `docs/` - production deployment and runtime notes.

Local development defaults to file storage and mock Slurm:

```powershell
cd C:\Users\user\sisp-mapdrive\apphub\server
node server.js
```

Then open `http://127.0.0.1:8792`. Use the development login shown by the UI.

Production should set `DATABASE_URL`, `APPHUB_SLURM_MODE=slurm`, `APPHUB_DEV_AUTH=0`, and LDAP-protected trusted headers from nginx.

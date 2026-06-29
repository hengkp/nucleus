# Test Plan

## Login

- LDAP-authenticated user reaches AppHub through nginx and sees their username.
- Admin user or admin group sees the Admin tab.
- Direct unauthenticated production requests receive `401`.

## Slurm Launch

- User launches JupyterLab and RStudio with default limits.
- Job owner in `squeue` is the LDAP/Linux username, not `apphub`.
- CPU/RAM/time limits match the submitted form.
- Job prefers node2-node4.
- Logs appear in the AppHub log viewer.

## Routing

- `<slug>-<user>.app.sisp.com` opens the running app after reconciliation.
- Stopping the app removes the route from `/etc/nginx/apphub/routes.map`.
- Port allocation prevents two active apps from sharing a port.

## Persistence

- Normal apps stop when Slurm time expires.
- User can request persistent hosting.
- Admin can approve/reject a pending persistent app and assign a public route.

## Storage

- App reads and writes the selected workspace.
- Files created by an app are owned by the LDAP/Linux user.
- MapDrive page clearly links users to the drive mapper and includes the NAS UID/GID caveat.

## Support

- Users can post, reply, react, mark solved, and mark admin-needed.
- Admin can filter unresolved or admin-needed threads through the Admin overview counts.

## Failure Handling

- Missing Apptainer or missing `.sif` image produces a readable app failure.
- Busy cluster leaves the app queued.
- Stopped or failed jobs remove active routes.

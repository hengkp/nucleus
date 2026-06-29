# Nucleus — Documentation

Design notes, runbooks, and the running record of pain points & solutions for the Nucleus platform
(AppHub + MapDrive). See the [repo README](../README.md) for the overview.

## Architecture & plans
- [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md) — system architecture (cluster, control plane, storage, identity).
- [architecture/ADRS.md](architecture/ADRS.md) — architecture decision records.
- [architecture/BUILD_PLAN.md](architecture/BUILD_PLAN.md) — build/rollout plan.
- [architecture/RISKS.md](architecture/RISKS.md) — risk register.
- [MAPDRIVE_DESIGN.md](MAPDRIVE_DESIGN.md) — MapDrive design (gateway vs direct, share model).
- [CIFS_GATEWAY_REFACTOR.md](CIFS_GATEWAY_REFACTOR.md) — the CIFS gateway refactor.

## Pain points & solutions
- [PRODUCTS_AND_PAINPOINTS.md](PRODUCTS_AND_PAINPOINTS.md) — products, the problems they solve, and open pain points.
- [PREFLIGHT_FINDINGS.md](PREFLIGHT_FINDINGS.md) — pre-launch findings.
- [IDENTITY_AUDIT.md](IDENTITY_AUDIT.md) — LDAP/SSSD identity audit (uid/gid coherence across CIFS + SLURM).

## Deploy & operations
- [DEPLOY_RUNBOOK.md](DEPLOY_RUNBOOK.md) — how to deploy each component (start here).
- [DEPLOYMENT.md](DEPLOYMENT.md) — deployment layout/reference.
- [DEPLOY_LOG.md](DEPLOY_LOG.md) — chronological deploy log.
- [SECURITY.md](SECURITY.md) — security model (privilege boundary, SSO, isolation).

## Users & design
- [USER_GUIDE.md](USER_GUIDE.md) — end-user guide.
- [MOODBOARD.md](MOODBOARD.md) — visual/design direction.
- [GITHUB.md](GITHUB.md) — repository / GitHub notes.

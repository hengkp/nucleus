# SISP Products & Member Pain Points

**Purpose of this document.** Describe the two products we are building/improving — **MapDrive** and **AppHub** — and exactly which pain points of the SISP members each one solves. It is the plain-language companion to the architecture docs (`docs/architecture/`), aimed at anyone who needs to understand *what* we are fixing and *why*, not the low-level *how*.

---

## 1. Who the members are, and the world they work in

SISP is a small bioinformatics/wet-lab unit. The people we serve are **~47 non-technical wet-lab researchers** (LDAP accounts, uid ≥ 10000, primary group `sisp` / gid 100000). They are biologists and clinicians first — not Linux, SLURM, or networking users.

The shared infrastructure they depend on:

| Resource | Reality |
|---|---|
| Compute | **4-node cluster** (node1–4), **112 cores / ~503 GiB RAM each** → ~448 cores / ~2 TB total, running **SLURM 21.08** |
| Identity | **OpenLDAP** on node1 (`dc=siriraj,dc=local`); one account/password per person |
| Storage | **Infortrend NAS** (`192.168.0.103`) over NFS; per-user "lockers" + shared datasets at `/mnt/sisplockers` |
| Control plane | node1 hosts LDAP + nginx + the portals + Postgres; node2–4 are the workers |

**The core principle of both products:** the researcher should get **one identity, one password, reliable file storage, and on-demand analysis apps** — without ever needing to understand the machinery underneath.

---

## 2. The two pain points that drive everything

Everything below traces back to two concrete, observed problems.

### Problem A — "My files keep getting mixed up" (storage & ownership)
Today, Windows/macOS clients **map the NAS directly**. That has two consequences members feel:
- **Scrambled file ownership.** Because of a half-finished uid migration and direct NAS mounts, locker folders are owned by a mix of legacy local uids (`1000`, `1005`, …) and correct LDAP uids (`10000+`). The live audit found that **51 of 53 locker dirs are world-writable (`777`)** and only one user's locker is correctly private. People literally **cannot open their own files**, and any user can read/write anyone else's locker — a real confidentiality breach. Admins constantly hand-fix this with `chown`/ACLs.
- **Stale SMB sessions & one-credential-per-server.** Windows allows only one SMB credential per server name per sign-in, so switching accounts means manually disconnecting drives and forgetting credentials. Sessions go stale and wedge.

### Problem B — "The analysis tools hang for everyone" (shared compute)
JupyterHub, RStudio, and Galaxy historically all run **on node1**, the same machine that runs identity and the web front door. Under concurrent load they **fall over and take everything with them**. When several people open notebooks at once, the shared server becomes unusable for the whole unit.

> **MapDrive attacks Problem A. AppHub attacks Problem B.** A shared identity + security backbone ties them together.

---

## 3. Product 1 — **MapDrive** (file access made boring and correct)

### 3.1 What it is today
A **Windows tray helper + macOS helper + web download portal** (`https://mapdrive.sisp.com`) that helps a researcher mount their SISP NAS share with their LDAP credentials. The browser portal can't mount SMB itself, so it builds a `sispdrive://open?...` link that hands prefilled settings to the installed desktop helper; credentials and SMB sessions stay on the workstation. A small support board (posts, replies, reactions, "solved") lets members help each other with connection problems.

### 3.2 The member pain points it must solve
- "I can't open my own files / someone else changed my files."
- "Mapping the drive is fiddly — wrong login format, stale credentials, drive won't reconnect."
- "I have to ask an admin every time something breaks."

### 3.3 What we want to improve
The fix is **architectural, not cosmetic**: *stop pointing clients at the NAS.*

1. **Route all file traffic through a single CIFS gateway** (on node2, **not** node1) that **stamps every file with the correct LDAP user/group by construction.** Ownership becomes "always right" instead of "fixed up after the fact."
2. **Per-user isolation by default** — each locker is owner-only (mode `2700/0600`, `valid users=%U`); group write is confined to an explicit `_shared/` tree. This ends the `777`/all-readable regression.
3. **Reconcile the broken identity migration first** (the true root cause): remove duplicate local accounts that shadow LDAP users, make LDAP authoritative, and recursively re-own each stranded locker to its real LDAP uid — reversibly, in a maintenance window with comms.
4. **Clean client behavior** — retargeted `SISPDriveMapper` helpers, SMB signing, and a **logoff cleanup task** so stale sessions stop wedging.
5. **Self-service SMB enrollment** — a "set my drive password" page (plus admin fallback) so members don't need a ticket to get connected.
6. **Polished, low-friction clients** — keep the one-click Windows tray flow and ship a **properly signed** macOS `.app`/`.pkg` (today's bundle is unsigned).

**Outcome for the member:** the drive just mounts, the files are theirs and only theirs, and it keeps working across logins — no admin required.

---

## 4. Product 2 — **AppHub** (on-demand analysis apps that never hang the server)

### 4.1 What it is today
A **no-code web portal** (`https://apphub.sisp.com`) for launching lab applications. A researcher picks a template, and AppHub runs it for them on the cluster. It ships admin-owned templates for **JupyterLab, RStudio, Streamlit, Dash, Shiny, Flask/FastAPI, Gradio, static HTML, and Galaxy tool development**, plus a support board, an approvals/audit trail, and route metadata. (An older scaffold is live today; we are doing a clean rebuild informed by it.)

### 4.2 The member pain points it must solve
- "Jupyter/RStudio is down again because too many people are using it."
- "I have to SSH and write SLURM scripts to run my analysis" — a non-starter for non-technical users.
- "My long single-cell job competes with someone's quick notebook and everyone loses."
- "Is my data safe from the person running a notebook next to me?"

### 4.3 What we want to improve
1. **Each app becomes an isolated SLURM job on node2–4, running as the real researcher's uid.** node1 is **protected as control-plane-only and never runs user jobs** — so one heavy session can't take down identity or the web front door. This is the direct fix for Problem B.
2. **No-code launch.** The researcher clicks a template and gets a working Jupyter/RStudio/Streamlit/etc.; AppHub writes and submits the SLURM job for them. No shell, no scripts.
3. **Honest, fair scheduling.** Memory (not CPU) is the real ceiling (~6–10 heavy single-cell sessions at once), so:
   - a **guaranteed "small" lane** (a standing reservation) means a light 4 GB notebook is never stuck behind heavy jobs;
   - sensible defaults (4 CPU / 32 GB single-cell with opt-up; whole-node pin for >64 GB);
   - a **calm, honest queue UI** that shows "queued / starting / your estimated start" instead of a spinning hang.
4. **Strong tenant isolation.** Every app binds to loopback only, is reached through a **per-job tunnel**, and carries a **native auth token** — so a co-located job can't reach a neighbor's notebook, and a researcher's blast radius can never exceed what that user could already do on their own locker (never root, never another user's files).
5. **Always-on where it makes sense.** Galaxy is modeled as a persistent service (its sub-jobs spread across node2–4) rather than an idle-culled job that dies under you.
6. **A portal that feels trustworthy.** Clean Vite/React rebuild on the approved SISP design language ("Linear bones, Stripe warmth," SISP teal `#11695f`), poll-first and contract-bound so the *frontend itself can never re-create the concurrency hang.*

**Outcome for the member:** click an app, get a reliable private session in seconds-to-a-short-queue, work without fear of crashing the shared server or leaking data.

---

## 5. The shared backbone (why both products are one project)

Both products only work if identity and security are solved once, centrally:

- **One identity, one password — two credential channels by design.** A single LDAP account works for both the web portal and the file gateway. The web login (HTTP cookie via a fail-closed in-house `sisp-sso` gateway) and the SMB login (NT-hash / port 445) are **kept as separate credential planes on purpose** — conflating them was the central flaw of the old design (SMB can't read an HTTP cookie).
- **Security-first, fail-closed.** The auth gateway fronts all web traffic and fails *closed*; nginx overwrites identity headers on every request; the SLURM wrapper refuses anything that isn't a real researcher uid. Apps run as the real user, isolated from each other.
- **Honest about the constraints.** node1 stays a single point of failure (acceptable for a 4-node lab, mitigated by verified nightly restores rather than full HA); memory caps concurrency, so some queuing is intrinsic; and every node-touching change is a **human-confirmed, reversible** maintenance action — nothing in this plan assumes autonomous production changes.

---

## 6. Pain point → solution map

| # | Member pain point | Product | What fixes it |
|---|---|---|---|
| 1 | "I can't open my own files" / scrambled ownership | **MapDrive** | CIFS gateway stamps correct LDAP uid/gid by construction; identity migration reconciled first |
| 2 | "Anyone can read/write my locker" (`777`, all-readable) | **MapDrive** | Per-user owner-only shares (`2700/0600`); group write only in explicit `_shared/` |
| 3 | "Drive won't reconnect / stale sessions / wrong login" | **MapDrive** | Retargeted clients, SMB signing, logoff cleanup, self-service enrollment |
| 4 | "I need an admin every time" | **MapDrive + AppHub** | Self-service flows + community support boards |
| 5 | "The analysis server hangs for everyone" | **AppHub** | Apps run as isolated SLURM jobs on node2–4; node1 never scheduled |
| 6 | "I have to SSH and write SLURM scripts" | **AppHub** | No-code templates (Jupyter, RStudio, Streamlit, Dash, Shiny, FastAPI, Gradio, Galaxy, …) |
| 7 | "My quick notebook is stuck behind heavy jobs" | **AppHub** | Guaranteed "small" lane + honest defaults + transparent queue |
| 8 | "Is my data safe from the job next to me?" | **AppHub** | Loopback-only bind, per-job tunnel + token, run-as-real-uid isolation |
| 9 | "One outage takes down everything" | **Backbone** | node1 protected as control-plane-only; cgroup caps; restore-verified backups |
| 10 | "Too many passwords / logins" | **Backbone** | One LDAP identity + password across web and file access |

---

## 7. What "done" looks like for a member

A SISP researcher should be able to, with one account and no admin ticket:

1. **Map their drive** — it mounts, the files are theirs and private, and it survives logout/login.
2. **Open an analysis app** — pick Jupyter/RStudio/etc. in the browser, get a private session quickly (or a clear queue position), and never crash the shared server.
3. **Trust the system** — their data isn't readable by colleagues, their session isn't reachable by a neighboring job, and the lights stay on for everyone else while they work.

> Sources: `README.md`, `apphub/README.md`, `docs/architecture/BUILD_PLAN.md`, `docs/architecture/ADRS.md`, `docs/architecture/RISKS.md`, `docs/PREFLIGHT_FINDINGS.md`, `docs/USER_GUIDE.md`, `apphub/runtime/templates.json`.

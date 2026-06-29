# SISP AppHub — Design Direction (Phase 1)

> First deliverable of the AppHub rebuild. No code or cluster access required to act on this.
> Scope: moodboard + reference-style decision, design system (color / type / spacing / motion),
> Remix Icon + Google Fonts mapping, component inventory, key-screen intent, and a
> GPT-Image 2.0 prompt pack. Everything here is a *contract* the new frontend will be built against.

Status: **Draft for approval** · Date: 2026-06-26 · Owner: design+frontend rebuild

---

## 1. Who we are designing for

| Audience | Share | What they need | Design consequence |
|---|---|---|---|
| **Wet-lab researchers** (primary) | ~80% | Launch JupyterLab/RStudio/an app without knowing SLURM, ports, or containers. Get in, do analysis, leave. | Guided, low-jargon, big targets, sane defaults, "it just works" launch flow. Never show a port number unless asked. |
| **Power users / bioinformaticians** | ~15% | Pick CPUs/RAM/time, choose task templates (Seurat, scRNA-seq), host their own app. | Progressive disclosure — advanced controls exist but stay folded away. Keyboard + command palette. |
| **Admins (nodeadmin)** | ~5% | See all jobs across node[1-4], approve app hosting, kill runaway jobs, manage templates, audit. | A distinct admin surface with density, tables, and bulk actions. |

**Design principle that follows from this split:** *Calm by default, powerful on demand.* The default surface must be readable by a biologist who has never opened a terminal; every advanced lever is one disclosure away, never in the primary path.

---

## 2. Reference-style analysis & decision

I evaluated the references you named against the job AppHub actually does — a **no-code control plane for compute** (think "Vercel/Render dashboard, but for an HPC lab").

| Reference | Strength for us | Weakness for us |
|---|---|---|
| **Linear** | The gold standard for app *shells*: sidebar + content, command palette, keyboard-first, calm dark UI, beautiful status/queue lists. Our job queue & resource monitor *are* Linear screens. | Pure Linear is aimed at expert tech users; too austere/cold for a first-time wet-lab user. |
| **Stripe** | Best-in-class at making something complex feel trustworthy and *guided*; excellent onboarding, generous explanation, tasteful gradients. | Marketing-heavy patterns; we are an app, not a landing page. |
| **Apple / HIG** | Friendliness, clarity, large hit areas, restraint. | Can feel content-light for dense dashboards/tables. |
| **Vercel / Geist** | Superb dark mode, monospace-for-data discipline, deployment-card mental model that maps 1:1 to "app instances." | Very developer-coded aesthetic. |
| **OpenAI / Claude** | Warm neutrals, soft surfaces, approachable for non-experts. | Less suited to dense operational tables. |
| **Google Material** | Familiar, accessible components out of the box. | Generic; would make AppHub look like a default admin template (the trap the current UI fell into). |

### Decision: **"Linear bones, Stripe warmth," carrying SISP teal.**

- **Structure & interaction model → Linear.** Persistent left sidebar, top context bar, `⌘K`/`Ctrl-K` command palette, dense-but-calm lists for jobs and instances, first-class dark mode, keyboard support for power users.
- **Tone & onboarding → Stripe/Apple.** Generous empty states, plain-language helper text, a guided launch flow, soft depth instead of harsh borders. This is what makes it usable for the 80%.
- **Brand identity → SISP heritage.** Keep **teal (`#11695f` family)** as the signature accent so AppHub and the existing MapDrive portal read as one product family — but modernize everything around it (real type system, refined neutrals, dark mode, motion). MapDrive's current Arial/light-only utility look is explicitly *not* the target.

The mental model we design around: **an app is a "deployment."** A user launches a template → it becomes a running instance (a card) with status, resources, time-remaining, and an Open button. This is the Vercel/Linear deployment metaphor, which non-technical users grasp instantly ("my thing is running / starting / stopped").

---

## 3. Design system

### 3.1 Color tokens

Semantic tokens (not raw hex in components). Heritage teal is the brand accent; neutrals are a slightly warm slate so it reads calm, not clinical.

**Light**
```
--bg            #f7f9f9   /* app canvas */
--surface       #ffffff   /* cards, panels */
--surface-2     #eef3f2   /* insets, hover */
--border        #dce4e2   /* hairlines */
--ink           #131a19   /* primary text */
--ink-muted     #5d6b68   /* secondary text */
--brand         #11695f   /* SISP teal — primary actions, active nav */
--brand-strong  #0c4f47   /* hover/pressed */
--brand-tint    #e2f1ee   /* selected rows, badges */
--accent-blue   #1b7fbd   /* network/links/focus, MapDrive kinship */
```

**Dark** (Linear/Geist-grade — the default for power users & admins)
```
--bg            #0d1413
--surface       #131d1b
--surface-2     #1a2624
--border        #25332f
--ink           #e7efed
--ink-muted     #8fa09c
--brand         #2bb3a3   /* lifted teal for contrast on dark */
--brand-strong  #46c7b7
--brand-tint    #11332e
--accent-blue   #4fb0e6
```

**Status (shared, tuned per theme)** — used for job/instance state, the heart of the UI:
```
running/ok      green   #1f9d57 (light) / #34d27f (dark)
starting/queued amber   #c98a16 / #e0a93a
stopped/idle    slate   --ink-muted
failed/error    red     #c0392b / #f06a5d
warning         amber   (credential/ownership conflicts — MapDrive parity)
```

Rule: **green status dot = connected/running** (carried over from MapDrive so the family shares a status language); **amber only for warnings/conflicts**; red only for failure.

### 3.2 Typography — Google Fonts

| Role | Font | Usage |
|---|---|---|
| UI / headings / body | **Inter** | Everything. Variable, superb at small sizes, neutral-scientific. |
| Numeric / code / logs / resource readouts | **JetBrains Mono** | Job IDs, ports, CPU/RAM figures, terminal/log panels, command palette. |
| (Optional display) | **Inter Tight** | Hero/marketing headline weight only. |

Type scale (rem, 16px base): `12 / 13 / 14 / 16 / 18 / 22 / 28 / 36`. Body 14–16; table/meta 12–13 in JetBrains Mono for figures. Weights: 400 body, 500 UI labels, 600 headings. Line-height 1.5 body / 1.2 headings. Load via `@fontsource` (self-hosted on node1 — no external CDN dependency for an internal lab tool).

### 3.3 Spacing, radius, elevation, motion

- **Spacing scale (px):** 2, 4, 8, 12, 16, 24, 32, 48, 64. 8px base grid.
- **Radius:** `--r-sm 6` (controls), `--r-md 10` (cards), `--r-lg 16` (modals/hero), `--r-full` pills/avatars. (Softer than MapDrive's 8px squares — friendlier.)
- **Elevation:** prefer 1px hairline border + soft shadow over heavy borders. `--shadow-1: 0 1px 2px rgba(0,0,0,.06)`, `--shadow-2: 0 8px 24px rgba(16,32,29,.10)`, dark mode uses border-glow not shadow.
- **Motion:** 120ms ease for hover/press, 200ms ease-out for panels/modals, 400ms for status transitions (queued→running pulses). Respect `prefers-reduced-motion`. Skeleton loaders, never spinners-on-blank, for launch/queue waits.

### 3.4 Remix Icon (`ri-*`) mapping

Use Remix Icon throughout (line style default, fill for active nav). Canonical mapping so icons are consistent across screens:

| Concept | Icon |
|---|---|
| Dashboard / home | `ri-dashboard-3-line` |
| App catalog / launch | `ri-apps-2-line` |
| My instances / deployments | `ri-rocket-2-line` |
| Job queue | `ri-stack-line` |
| Resources / nodes | `ri-server-line`, `ri-cpu-line`, `ri-ram-2-line` |
| Files / workspace (MapDrive bridge) | `ri-folder-3-line`, `ri-hard-drive-2-line` |
| JupyterLab | `ri-terminal-box-line` | RStudio | `ri-bar-chart-box-line` |
| Galaxy | `ri-flask-line` | Container/host-your-app | `ri-box-3-line` |
| Start / stop / restart | `ri-play-circle-line` / `ri-stop-circle-line` / `ri-restart-line` |
| Time limit | `ri-timer-line` | Settings | `ri-settings-3-line` |
| Admin / approvals | `ri-shield-check-line` | Audit log | `ri-file-list-3-line` |
| User / account | `ri-user-3-line` | Logout | `ri-logout-box-r-line` |
| Status ok/warn/fail | `ri-checkbox-circle-fill` / `ri-error-warning-fill` / `ri-close-circle-fill` |
| Command palette | `ri-command-line` | Search | `ri-search-line` | Theme | `ri-contrast-2-line` |

### 3.5 Accessibility (non-negotiable for the audience)

- WCAG 2.1 AA contrast (tokens above are checked for it); never color-alone status — always icon + label + color.
- All interactive elements keyboard reachable; visible 3px focus ring (`--accent-blue` at 25%).
- Hit targets ≥ 40px. Form fields always labeled, errors in text not just red.
- Dark/light toggle persisted per user; honor `prefers-color-scheme` and `prefers-reduced-motion`.

---

## 4. Component inventory (build order for the rebuild)

**Primitives:** Button (primary/secondary/ghost/danger), Input, Select, Toggle, Slider (CPU/RAM/time), Badge/Pill, Tag, Avatar, Tooltip, Skeleton, Toast, Modal, Drawer, Tabs, Dropdown/Menu, ProgressBar/Gauge.

**Composite (AppHub-specific):**
- **Template card** — icon, name, category, "what's preinstalled," Launch button. The catalog tile.
- **Instance card** — status dot, app name, node, CPU/RAM, time-remaining ring, Open / Stop. The core object.
- **Resource gauge** — per-node CPU/RAM utilization (node1–4), cluster total (112 CPU / 512 GB).
- **Job queue row** — JetBrains-Mono job id, owner, state chip, elapsed/limit, actions.
- **Launch wizard** — 1: pick template → 2: (optional) resources & time → 3: workspace folder → Launch. Defaults pre-filled so step 1 → Launch is valid for novices.
- **Command palette** (`⌘/Ctrl-K`) — launch app, jump to instance, switch theme, admin actions.
- **Empty states** — friendly illustration + one clear CTA (never a blank panel).

---

## 5. Key screens (intent, not pixels)

1. **Login** — split layout: left = brand panel (logo, teal gradient, one-line value prop + subtle hero), right = LDAP username/password. Plain-language, no jargon.
2. **Dashboard** — "Your running apps" (instance cards) on top; cluster health strip (node1–4 gauges); quick-launch row of favorite templates; recent activity.
3. **App catalog** — template cards grouped by category (Notebook / App / Tooling / Host-your-app), with the task-specific variants surfaced (RStudio·Seurat, Jupyter·scRNA-seq).
4. **Launch wizard** — guided, progressive disclosure as above.
5. **Instance detail** — status, live resource use, time-remaining + "extend," Open, Stop, logs panel (JetBrains Mono), the connection/workspace path.
6. **Job queue** — Linear-style list across all nodes; filter by state/node/owner.
7. **Workspace / Files** — the MapDrive bridge: shows the user's `sisplockers/<username>` mount, links to the MapDrive helper.
8. **Admin** — all jobs, approvals (host-your-app requests), template manager, audit log, node management. Denser, dark by default.
9. **Settings** — theme, default resources, notifications, account.

---

## 6. GPT-Image 2.0 prompt pack

House style for all assets: *modern scientific-tech, calm, precise; SISP teal `#11695f` + deep slate; soft depth; geometric not skeuomorphic; flat vector with subtle gradient; consistent 2px-ish line weight to echo Remix Icon; transparent background unless stated.* Generate at 2× for retina; export PNG (+ trace logo/icons to SVG).

**1 — Primary logomark**
> "A minimalist geometric logo mark for 'SISP AppHub', a scientific HPC application hub. An abstract hexagonal node/cluster motif suggesting connected compute nodes forming a subtle 'A' or hub shape. Flat vector, single-weight lines with one soft teal-to-deep-slate gradient (teal #11695f). Clean, balanced, scalable to a 16px favicon. Transparent background, no text, generous padding."

**2 — Wordmark lockup**
> "Horizontal logo lockup: the hexagonal hub mark at left, 'AppHub' wordmark right in a geometric sans (Inter-like), 600 weight, deep slate #131a19. 'SISP' as a smaller teal tag above or beside. Crisp vector, transparent background, balanced spacing for a top-left app header."

**3 — App template icons (one per template, consistent set)**
> "A set of 9 matching app-tile icons in one consistent flat-vector style, rounded-square tiles with a soft teal #11695f → slate gradient and a white line glyph centered: (1) notebook/code brackets [JupyterLab], (2) R bar-chart [RStudio], (3) flask/molecule [Galaxy], (4) Streamlit ribbon, (5) Dash dashboard grid, (6) Shiny spark, (7) API plug/brackets [FastAPI], (8) Gradio slider, (9) cube/box [host-your-app]. Single 2px line weight, identical padding and corner radius, transparent background, retina."

**4 — Login hero / brand panel background**
> "Abstract background for a login side-panel: dark teal-to-slate gradient (#0c4f47 → #131a19) with a faint geometric mesh of connected nodes and thin lines suggesting an HPC cluster, very subtle, low-contrast, no text. Soft glow accents in teal. Calm, premium, scientific. 1200×1600 portrait."

**5 — Dashboard ambient background (light + dark)**
> "Extremely subtle seamless background texture for an app canvas: faint dotted/grid pattern with occasional thin connecting lines, 3–4% opacity, warm-slate on near-white (light variant) and teal-on-near-black (dark variant). Must not distract from foreground cards. Seamless tile."

**6 — Empty-state spot illustration**
> "A small friendly flat-vector spot illustration for an empty dashboard: a stylized rocket or notebook on a launch pad made of simple geometric shapes, teal/slate palette matching #11695f, light line work, optimistic but minimal, transparent background, ~400px."

**7 — Template thumbnails (catalog header banners, optional)**
> "Wide thumbnail banner for an [JupyterLab / RStudio / Galaxy] app card: abstract representation of [Python notebooks / R analysis / genomics pipeline] in flat geometric vector, teal-slate palette, soft gradient, no realistic screenshots, 640×240, room for a label overlay."

> Note: always pair generated imagery with **Inter** (UI/text) and **JetBrains Mono** (data) and **Remix Icon** glyphs — generated icons are for brand/marketing tiles; in-product action icons stay `ri-*` for crispness and consistency.

---

## 7. What this unlocks & open questions

**Once you approve this direction, the next slices are:**
1. Architecture + phased build plan (Phase 2a).
2. Frontend shell scaffold (design tokens → CSS variables/Tailwind config, component library, login + dashboard) built to *this* spec.
3. Backend rebuild (LDAP session, SLURM launch, templates, CIFS workspace bridge) — validated against the live cluster in supervised steps.

**Open questions for you (don't block approval, but I need them soon):**
- **Logo:** generate a fresh AppHub mark (prompts above), or reuse/evolve the existing MapDrive icon for family consistency?
- **Default theme:** light-first (friendlier for the 80% wet-lab users) or dark-first (Linear-like, power users)? My rec: **light default, dark available**, since the primary audience is non-technical.
- **Framework for the rebuild:** my recommendation is **React + Vite + Tailwind** (token-driven) with **TanStack Query** for the job/instance polling — but if you want zero build tooling on node1, I can do a lighter Preact/vanilla-tokens approach. (This is really a Phase-2 question.)
- **Stack/tooling** for the new backend (keep Node, or move to a typed stack) — Phase 2.
```

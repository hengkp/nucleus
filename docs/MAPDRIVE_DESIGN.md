# SISP MapDrive — Design Direction (web + exe)

Brings MapDrive up to the **same professional design language as AppHub** so the two read as
one product family. Reference: `apphub/docs/design/DESIGN_DIRECTION.md` (the shared system).

Status: Draft for approval · 2026-06-27 · Scope: `mapdrive.sisp.com` web portal **and** the
Windows tray exe (+ macOS helper).

---

## 1. Shared system (inherit from AppHub)
- **Direction:** "Linear bones, Stripe warmth," SISP teal heritage.
- **Color tokens** (identical to AppHub §3.1): brand `#11695f`, brand-strong `#0c4f47`,
  brand-tint `#e2f1ee`, accent-blue `#1b7fbd`, ink `#131a19`, ink-muted `#5d6b68`,
  surface `#fff`, bg `#f7f9f9`, border `#dce4e2`; full dark palette mirrored. Status: green
  = connected, amber = credential/conflict warning, red = error.
- **Type:** Inter (UI), JetBrains Mono (paths, drive letters, UNC, commands). Web self-hosts
  via @fontsource. The exe uses **Segoe UI Variable** (native closest match; bundling Inter in
  WinForms is avoidable) with a monospace (Cascadia Mono) for UNC paths.
- **Icons:** Remix Icon (`ri-*`) on web; the exe reuses the generated PNG glyphs.
- **Radius/spacing/motion:** AppHub scale (6/10/16 radius, 8px grid, 120/200ms easing).

**MapDrive's identity within the family:** AppHub = compute; MapDrive = storage/connection. Its
signature motif is a **drive/plug linked into the SISP hexagon‑cluster** — same mark family,
storage‑flavored.

---

## 2. Web portal — `mapdrive.sisp.com`
A calm, guided one‑pager (the portal can't mount SMB itself — it builds a `sispdrive://` link
and offers downloads). Redesign to match AppHub's polish.

**Screens / sections (single scrolling app, AppHub components):**
1. **Top bar** — MapDrive wordmark (left), theme toggle, "Open AppHub" link (family cross-nav), status pill `Gateway nas.sisp.com` (green dot).
2. **Hero** — split like AppHub login: left = headline *"Map your lab drive in one click."* + 1‑line value (LDAP login, ownership always correct) over a soft teal hex‑mesh; right = the **Connect card**.
3. **Connect card** (the core) — drive letter select, share picker (searchable, from `share-presets.json`), username, a live `net use`/UNC preview in JetBrains Mono, and a primary **"Open in MapDrive app"** button (fires `sispdrive://`) + a secondary "Copy command."
4. **Get the app** — two download cards (Windows `.exe`, macOS `.command`) with OS glyphs, version, size, and a "what it does" line.
5. **How it works** — 3 steps with the generated spot illustrations (install → choose share → connect), plain language for non‑technical users.
6. **Troubleshooting / community** — the existing support posts, restyled as AppHub cards (status chips: open / solved).
7. **Footer** — SISP, links to AppHub, admin contact.

**Components:** reuse AppHub primitives (Card, Button, Badge, Field, Input, Select, StatusDot,
EmptyState, Modal, toast). Same focus ring, AA contrast, dark mode, skeletletons.

---

## 3. The exe (Windows tray app) — within WinForms reality
WinForms can't do full web‑grade UI, but it can look modern and on‑brand with deliberate choices.

- **App + tray icon:** new generated `app-icon.ico` (drive‑in‑hexagon mark, teal gradient), multi‑res (16/32/48/256).
- **Window chrome:** white surface (`#ffffff`) / dark mode optional later; **8px padding grid**, `FlatStyle.Flat` controls, 1px `#dce4e2` borders, 6px‑radius via rounded panels (custom paint) or clean squared cards. Title row with the logo + "SISP MapDrive".
- **Type:** Segoe UI Variable 9–10pt for UI; **Cascadia Mono** for the UNC/drive readout.
- **Accent:** teal `#11695f` primary button (white text), secondary = bordered; danger = red `#c0392b`.
- **Connect panel:** Drive (combo), Share (combo, presets), Login (username; format hint "plain lab username"), Password; a **status pill** (green "Connected" / slate "Disconnected" / amber "Credential conflict") mirroring AppHub StatusDot; primary **Connect**, secondary **Disconnect**, **Open in Explorer**.
- **Tray:** green dot when a drive is mapped; balloon tips for connect/conflict; right‑click menu (Connect…, Disconnect, Open, Quit).
- **Copy:** plain, friendly, matches the web ("Sign in with your plain lab username — your files are stamped with your identity automatically").
- These are localized style changes to `windows-app/SISPDriveMapper.ps1` (colors, fonts, FlatStyle, spacing, the new icon) — no behavior change.

---

## 4. GPT‑Image asset pack (for Codex to generate)
House style (same as AppHub): *modern scientific‑tech, calm, flat geometric vector, SISP teal
`#11695f`→deep slate gradient, ~2px line weight, soft depth, transparent bg unless stated; 2× retina; PNG.*

1. **Logomark** → `logo.png` (1024², transparent): "an abstract mark for SISP MapDrive: a network drive / plug motif fused into a hexagonal cluster node (same hex family as the AppHub logo), single‑weight lines, teal #11695f→slate gradient, minimal, scalable to 16px."
2. **App icon** → `app-icon.png` (1024², transparent) + trace to `.ico`: "rounded‑square app tile, teal→slate gradient, a white line glyph of a hard‑drive linked to a hexagon node, centered, crisp at 32px."
3. **Wordmark** → `wordmark.png` (1600×400, transparent): "the mark + 'MapDrive' in Inter 600 deep‑slate, 'SISP' teal tag."
4. **Web hero bg** → `hero.png` (1600×1000, filled): "dark teal→slate gradient with a faint geometric mesh of connected nodes and drive/plug nodes, low‑contrast, no text."
5. **Ambient bg light/dark** → `bg-light.png`/`bg-dark.png` (1536×1024, seamless, very faint).
6. **How‑it‑works spots (3)** → `step-install.png`, `step-choose.png`, `step-connect.png` (800², transparent): flat teal/slate spot illustrations — (a) installing an app, (b) choosing a folder/share, (c) a drive connecting to a cluster (green check).
7. **OS badges** → `os-windows.png`, `os-macos.png` (256², transparent): clean teal‑tinted OS glyphs for the download cards.
8. **Success/empty state** → `connected.png` (640², transparent): a mapped drive with a green check, friendly.

Output dirs: `sisp-mapdrive/web/assets/` (web) and `sisp-mapdrive/windows-app/assets/` (exe icon).
Each prompt: pair with Inter + JetBrains/Cascadia Mono + `ri-*` in the actual UI.

---

## 5. Build order after assets land
1. Web portal restyle to AppHub components (`web/index.html`, `web/styles.css`, `web/app.js`) — reuse the shared tokens; wire the new hero/illustrations/logo.
2. Exe restyle (`windows-app/SISPDriveMapper.ps1`) — colors/fonts/FlatStyle/spacing + new `app-icon.ico`.
3. macOS `.command` — cosmetic header/branding only (it's a terminal helper).

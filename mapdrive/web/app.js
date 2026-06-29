// SISP MapDrive portal — single-page controller. Two connection modes: the SISP gateway
// (node1, ownership-correct) or direct to the Infortrend NAS. Builds a sispdrive:// launch
// link + a net-use fallback from the chosen mode/share/drive/login, and renders the share
// browser + community help. The browser can't mount SMB itself — it hands off to the helper.

const state = { config: null, mode: 'gateway', threads: [] }
const driveLetters = ['Z:', 'Y:', 'X:', 'W:', 'V:', 'U:', 'T:', 'S:', 'R:', 'Q:', 'P:', 'O:', 'N:', 'M:', 'L:', 'K:', 'J:', 'I:', 'H:', 'G:', 'F:', 'E:', 'D:']
const reactions = [
  { key: 'same', icon: 'ri-user-shared-line', label: 'Same issue' },
  { key: 'helpful', icon: 'ri-thumb-up-line', label: 'Helpful' },
  { key: 'thanks', icon: 'ri-heart-3-line', label: 'Thanks' },
]
const modeIcon = (k) => (k === 'gateway' ? 'ri-shield-check-line' : 'ri-server-line')

const $ = (s) => document.querySelector(s)
const $$ = (s) => Array.from(document.querySelectorAll(s))
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]))

const currentMode = () => state.config.modes[state.mode] || Object.values(state.config.modes)[0]
const modeShares = () => currentMode().shares || []
const allShares = () => Object.entries(state.config.modes).flatMap(([k, m]) => (m.shares || []).map((s) => ({ ...s, mode: k, modeLabel: m.label })))

function toast(msg) {
  const t = $('#toast'); if (!t) return
  t.textContent = msg; t.classList.add('show')
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2200)
}
function setTheme(theme) { document.documentElement.dataset.theme = theme; try { localStorage.setItem('mapdrive-theme', theme) } catch (e) {} }

function selectedShare() {
  const unc = $('#shareSelect')?.value || ''
  const list = modeShares()
  return list.find((s) => s.unc === unc) || list[0]
}
function serverOf(unc) { return (String(unc || '').match(/^\\\\([^\\]+)\\/) || [])[1] || currentMode().server || 'gateway' }

function loginCode(fmt) { if (!fmt) return 'plain'; if (fmt.includes('@')) return 'upn'; if (fmt.includes('\\')) return 'domain'; return 'plain' }
function userString(fmt, u) {
  const name = u || 'username'
  if (fmt?.includes('@')) return `${name}@siriraj.local`
  if (fmt?.includes('\\')) return `SIRIRAJ\\${name}`
  return name
}

function launchUrl() {
  const share = selectedShare()
  const fmt = $('#loginSelect')?.value || ''
  const params = new URLSearchParams({
    share: share?.unc || '',
    drive: $('#driveSelect')?.value || 'Z:',
    login: loginCode(fmt),
    username: ($('#usernameInput')?.value || '').trim(),
    domain: fmt?.includes('\\') ? 'SIRIRAJ' : '',
  })
  return `sispdrive://open?${params.toString()}`
}
function manualCommand() {
  const share = selectedShare()
  const drive = $('#driveSelect')?.value || 'Z:'
  const fmt = $('#loginSelect')?.value || ''
  const user = userString(fmt, ($('#usernameInput')?.value || '').trim())
  const unc = share?.unc || ''
  const server = serverOf(unc)
  return `net use \\\\${server} /delete /y 2>nul & net use ${drive} ${unc} /user:${user} * /persistent:no`
}
function updatePreview() {
  const share = selectedShare()
  const fmt = $('#loginSelect')?.value || ''
  const u = ($('#usernameInput')?.value || '').trim()
  $('#previewDrive').textContent = $('#driveSelect')?.value || 'Z:'
  $('#previewUnc').textContent = share?.unc || '—'
  $('#previewUser').textContent = u ? userString(fmt, u) : userString(fmt, '')
  $('#manualCommand').textContent = manualCommand()
}

function fillSelects() {
  const ss = $('#shareSelect'); ss.innerHTML = ''
  for (const s of modeShares()) ss.add(new Option(s.name, s.unc))
  const ds = $('#driveSelect'); ds.innerHTML = ''
  for (const d of driveLetters) ds.add(new Option(d, d))
  ds.value = state.config?.defaultDrive || 'Z:'
  const ls = $('#loginSelect'); ls.innerHTML = ''
  for (const f of (state.config.loginFormats || ['username only'])) ls.add(new Option(f, f))
  ls.value = currentMode().defaultLoginFormat || 'username only'
}

function renderModeToggle() {
  const wrap = $('#modeToggle'); if (!wrap) return
  wrap.innerHTML = Object.entries(state.config.modes).map(([k, m]) => `
    <button data-mode="${k}" role="tab" aria-selected="${k === state.mode}" class="${k === state.mode ? 'active' : ''}">
      <span class="m-label"><i class="${modeIcon(k)}"></i> ${esc(m.label)}</span>
      <span class="m-sub">${esc(m.sublabel || '')}</span>
    </button>`).join('')
  $('#modeHint').textContent = currentMode().hint || ''
}
function setMode(key) {
  if (!state.config.modes[key]) return
  state.mode = key
  renderModeToggle(); fillSelects(); updatePreview()
  $('#gatewayHost').textContent = currentMode().server
}

function renderShares() {
  const term = ($('#shareSearch')?.value || '').trim().toLowerCase()
  const rows = $('#shareRows')
  const items = allShares().filter((s) => `${s.name} ${s.unc} ${s.nasPath || ''} ${s.modeLabel}`.toLowerCase().includes(term))
  if (!items.length) { rows.innerHTML = `<div class="empty"><i class="ri-search-eye-line"></i><p>No matching shares.</p></div>`; return }
  rows.innerHTML = items.map((s) => `
    <div class="share-row">
      <div><div class="nm">${esc(s.name)}</div><div class="sub">${esc(s.nasPath || '')}</div></div>
      <div class="unc">${esc(s.unc)}</div>
      <div style="display:flex;align-items:center;gap:0.6rem;justify-content:flex-end">
        <span class="pill ${s.mode === 'gateway' ? 'ok' : 'mut'}"><i class="${modeIcon(s.mode)}"></i>${esc(s.modeLabel)}</span>
        <button class="use" data-mode="${s.mode}" data-unc="${esc(s.unc)}" type="button">Use</button>
      </div>
    </div>`).join('')
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, ...opts })
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`)
  return res.json()
}
function statusPill(s) {
  return s === 'solved'
    ? `<span class="pill ok"><i class="ri-checkbox-circle-line"></i>Solved</span>`
    : `<span class="pill mut" style="color:var(--amber)"><i class="ri-error-warning-line"></i>Open</span>`
}
function renderSupport() {
  const list = $('#supportList')
  const open = state.threads.filter((t) => t.status !== 'solved').length
  $('#supportOpenCount').textContent = String(open)
  if (!state.threads.length) { list.innerHTML = `<div class="empty"><i class="ri-chat-new-line"></i><p>No questions yet — be the first.</p></div>`; return }
  list.innerHTML = state.threads.map((t) => `
    <article class="thread" data-id="${esc(t.id)}">
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center">
        ${statusPill(t.status)}
        <span class="pill mut"><i class="ri-folder-line"></i> ${esc(t.share || 'General')}</span>
        <button class="react status-toggle" data-id="${esc(t.id)}" style="margin-left:auto"><i class="${t.status === 'solved' ? 'ri-restart-line' : 'ri-checkbox-circle-line'}"></i>${t.status === 'solved' ? 'Reopen' : 'Mark solved'}</button>
      </div>
      <h4>${esc(t.title)}</h4>
      <div class="meta">By ${esc(t.author)} · ${new Date(t.createdAt).toLocaleString()}</div>
      <div class="body">${esc(t.body)}</div>
      <div class="reactions">${reactions.map((r) => `<button class="react reaction" data-id="${esc(t.id)}" data-r="${r.key}"><i class="${r.icon}"></i>${r.label} <strong>${t.reactions?.[r.key] || 0}</strong></button>`).join('')}</div>
      ${(t.replies || []).map((rp) => `<div class="reply"><div class="meta"><strong>${esc(rp.author)}</strong> · ${new Date(rp.createdAt).toLocaleString()}</div><div class="body" style="margin:0.3rem 0 0">${esc(rp.body)}</div></div>`).join('')}
      <form class="reply-form" data-id="${esc(t.id)}">
        <input class="ctl" name="author" placeholder="Your name" required />
        <input class="ctl" name="body" placeholder="Reply with a fix or update" required maxlength="1000" />
        <button class="btn btn-ghost" type="submit"><i class="ri-reply-line"></i></button>
      </form>
    </article>`).join('')
}
async function loadSupport() {
  try { state.threads = (await api('/api/support')).threads || []; renderSupport() }
  catch (e) { $('#supportList').innerHTML = `<div class="errbox"><i class="ri-error-warning-line"></i> Could not load: ${esc(e.message)}</div>` }
}

function showView(name) {
  $$('.view').forEach((s) => s.classList.toggle('hidden', !s.classList.contains(`view-${name}`)))
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === name))
  window.scrollTo({ top: 0, behavior: 'smooth' })
}
function wireScroll() {
  const hdr = $('#hdr')
  const onScroll = () => hdr.classList.toggle('scrolled', window.scrollY > 8)
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll()
  showView('connect')
}

async function init() {
  state.config = await fetch('/config/share-presets.json').then((r) => r.json())
  state.mode = state.config.defaultMode || Object.keys(state.config.modes)[0]
  $('#shareCount').textContent = String(allShares().length)
  $('#gatewayHost').textContent = currentMode().server
  // support "Related share" dropdown = every share across both modes
  const sup = $('#supportShare'); if (sup) { sup.innerHTML = ''; for (const s of allShares()) sup.add(new Option(s.name, s.name)) }
  renderModeToggle(); fillSelects(); renderShares(); updatePreview(); wireScroll()
  await loadSupport()
}

// ---- events ----
document.addEventListener('click', async (e) => {
  const navLink = e.target.closest('[data-view]')
  if (navLink) { e.preventDefault(); showView(navLink.dataset.view); return }
  const modeBtn = e.target.closest('#modeToggle button')
  if (modeBtn) { setMode(modeBtn.dataset.mode); return }
  if (e.target.closest('#themeToggle')) setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
  if (e.target.closest('#openBtn')) { window.location.href = launchUrl() }
  if (e.target.closest('#copyBtn')) { try { await navigator.clipboard.writeText(manualCommand()); toast('Command copied') } catch { toast('Copy failed') } }
  if (e.target.closest('#refreshSupport')) await loadSupport()

  const use = e.target.closest('.use')
  if (use) { setMode(use.dataset.mode); $('#shareSelect').value = use.dataset.unc; updatePreview(); showView('connect'); toast('Loaded into the connect panel') }

  const react = e.target.closest('.reaction')
  if (react) { await api(`/api/support/${react.dataset.id}/reactions`, { method: 'POST', body: JSON.stringify({ reaction: react.dataset.r }) }); await loadSupport() }
  const st = e.target.closest('.status-toggle')
  if (st) { const t = state.threads.find((x) => x.id === st.dataset.id); await api(`/api/support/${st.dataset.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: t?.status === 'solved' ? 'open' : 'solved' }) }); await loadSupport() }
})

document.addEventListener('input', (e) => {
  if (['shareSelect', 'driveSelect', 'loginSelect', 'usernameInput'].includes(e.target.id)) updatePreview()
  if (e.target.id === 'shareSearch') renderShares()
})

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'supportForm') {
    e.preventDefault()
    await api('/api/support', { method: 'POST', body: JSON.stringify({ author: $('#supportAuthor').value, title: $('#supportTitle').value, share: $('#supportShare').value, status: $('#supportStatus').value, body: $('#supportBody').value }) })
    e.target.reset(); toast('Question posted'); await loadSupport()
    return
  }
  const rf = e.target.closest('.reply-form')
  if (rf) {
    e.preventDefault()
    const fd = new FormData(rf)
    await api(`/api/support/${rf.dataset.id}/replies`, { method: 'POST', body: JSON.stringify({ author: fd.get('author'), body: fd.get('body') }) })
    toast('Reply posted'); await loadSupport()
  }
})

init().catch((err) => { document.body.innerHTML = `<main style="padding:2rem;color:#c0392b">Could not start MapDrive: ${esc(err.message)}</main>` })

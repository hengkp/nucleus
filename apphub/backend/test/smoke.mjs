// End-to-end smoke test against a running control plane (mock mode).
// Usage: start the server (npm run dev) then `npm run smoke`, or set APPHUB_URL.
const BASE = process.env.APPHUB_URL || 'http://127.0.0.1:8792'

let pass = 0
let fail = 0
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.error(`  ✗ ${label}`) }
}
const get = (p) => fetch(BASE + p).then((r) => r.json())
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log(`smoke: ${BASE}`)

// health + session
const health = await get('/healthz')
ok(health.ok === true, `healthz ok (slurm=${health.slurm}, store=${health.store})`)

const session = await get('/api/session')
ok(session.authenticated === true && !!session.user?.username, `session authenticated as ${session.user?.username}`)
ok(Array.isArray(session.user?.groups), 'session has groups')

// templates
const templates = await get('/api/templates')
ok(Array.isArray(templates) && templates.length >= 8, `templates listed (${templates.length})`)
ok(templates.every((t) => t.icon && t.defaults && t.limits), 'templates have icon/defaults/limits')
ok(templates.every((t) => t.image === undefined), 'templates strip server-only image field')

// cluster
const cluster = await get('/api/cluster/nodes')
ok(cluster.nodes?.length === 4, 'cluster has 4 nodes')
ok(cluster.nodes.find((n) => n.name === 'node1')?.controlPlane === true, 'node1 is control plane')

// launch lifecycle
const launchRes = await fetch(BASE + '/api/apps', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ templateId: 'jupyterlab', name: 'Smoke Test 01', cpus: 4, memoryMb: 16384, timeMinutes: 240, visibility: 'private' }),
})
const inst = await launchRes.json()
ok(launchRes.status === 201, `launch returns 201 (${launchRes.status})`)
ok(inst.id && inst.state === 'queued', `instance created queued (${inst.id})`)
ok(inst.name === 'smoke-test-01', `name slugified -> ${inst.name}`)
ok(inst.cpus === 4 && inst.memoryMb === 16384, 'requested resources honored within limits')

// over-limit clamp
const clampRes = await fetch(BASE + '/api/apps', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ templateId: 'streamlit', name: 'clamp', cpus: 999, memoryMb: 99999999, timeMinutes: 99999, entrypoint: 'app.py', visibility: 'public' }),
}).then((r) => r.json())
ok(clampRes.cpus <= 32, `cpus clamped to template max (${clampRes.cpus})`)
ok(clampRes.timeLimitMinutes <= 720, `time clamped to template max (${clampRes.timeLimitMinutes})`)
ok(clampRes.visibility === 'private', 'public visibility coerced to private')

// over-length name rejected (no silent truncation)
const longName = 'x'.repeat(60)
const rejected = await fetch(BASE + '/api/apps', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ templateId: 'jupyterlab', name: longName, cpus: 2, memoryMb: 8192, timeMinutes: 240, visibility: 'private' }),
})
ok(rejected.status === 400, `over-length name rejected with 400 (${rejected.status})`)

// disabled template rejected
const disabled = await fetch(BASE + '/api/apps', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ templateId: 'host-app', cpus: 2, memoryMb: 4096, timeMinutes: 240, visibility: 'private' }),
})
ok(disabled.status === 403, `disabled template rejected with 403 (${disabled.status})`)

// reconcile to running, then check url + route
console.log('  … waiting for reconcile to running')
let ran = null
for (let i = 0; i < 12; i++) {
  await sleep(1000)
  ran = await get(`/api/apps/${inst.id}`)
  if (ran.state === 'running') break
}
ok(ran?.state === 'running', `instance reaches running (${ran?.state})`)
ok(typeof ran?.url === 'string' && ran.url.endsWith('.app.sisp.com/'), `routed url assigned (${ran?.url})`)
ok(ran?.node && ran.node !== 'node1', `scheduled off the control plane (${ran?.node})`)

// jobs view
const jobs = await get('/api/jobs')
ok(Array.isArray(jobs) && jobs.length >= 1, `jobs listed (${jobs.length})`)

// logs
const logs = await fetch(BASE + `/api/apps/${inst.id}/logs`).then((r) => r.text())
ok(logs.includes(inst.name), 'logs reference the instance')

// stop
const stopRes = await fetch(BASE + `/api/apps/${inst.id}/stop`, { method: 'POST' })
ok(stopRes.status === 204, `stop returns 204 (${stopRes.status})`)
const stopped = await get(`/api/apps/${inst.id}`)
ok(stopped.state === 'stopped' && stopped.url === null, 'instance stopped, route cleared')

console.log(`\nsmoke: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

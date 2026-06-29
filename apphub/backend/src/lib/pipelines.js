import { readFileSync } from 'node:fs'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { HttpError } from './http.js'
import { newId } from './id.js'

// Nextflow pipeline launcher: a curated built-in catalog PLUS user-added pipelines (Tower-style:
// a Git repo + revision), a server-side schema proxy (so the browser needs no internet), and a
// builder that turns a pipeline + params (+ optional uploaded config) into the host-mode
// `nextflow run ...` command the runner executes inside a SLURM job.

const here = dirname(fileURLToPath(import.meta.url))
const FILE = resolve(here, '../../data/pipelines.json')
const CUSTOM_FILE = process.env.APPHUB_CUSTOM_PIPELINES_FILE || './.data/custom-pipelines.json'

const LOCKERS_ROOT = process.env.APPHUB_LOCKERS_ROOT || '/mnt/sisplockers'
// A dedicated, in-place conda env (NOT the relocated shared pool, whose baked /opt/shared-conda
// path doesn't exist on bare compute nodes). Self-consistent, so the driver runs on any host.
const NF_ENV = process.env.APPHUB_NF_ENV || '/mnt/sisplockers/.apphub-nf/nf-env'
const NF_BIN = process.env.APPHUB_NF_BIN || `${NF_ENV}/bin/nextflow`
const NF_CONFIG = process.env.APPHUB_NF_CONFIG || '/mnt/sisplockers/.apphub-nf/apphub-nextflow.config'
const NF_CACHE = process.env.APPHUB_NF_CACHE || '/mnt/sisplockers/.apphub-nf/singularity-cache'
const DEFAULT_DEFAULTS = { cpus: 8, memoryMb: 32768, timeMinutes: 1440 }

let builtin = null
export function loadPipelines() {
  if (!builtin) builtin = JSON.parse(readFileSync(FILE, 'utf8')).pipelines
  return builtin
}

// ---- custom (user-added) pipelines store ----------------------------------
let cache = null
let q = Promise.resolve()
async function loadCustom() {
  if (cache) return cache
  try { cache = JSON.parse(await readFile(CUSTOM_FILE, 'utf8')) } catch { cache = { pipelines: [] } }
  if (!Array.isArray(cache.pipelines)) cache.pipelines = []
  return cache
}
async function saveCustom() {
  await mkdir(dirname(CUSTOM_FILE), { recursive: true })
  q = q.then(async () => {
    const tmp = `${CUSTOM_FILE}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8')
    await rename(tmp, CUSTOM_FILE)
  })
  return q
}

// owner/name  OR  https://github.com/owner/name(.git)[/tree/branch]  ->  raw schema URL (best effort)
function deriveSchemaUrl(repo, rev) {
  const s = String(repo).replace(/\/(tree|blob)\/[^/]+\/?$/, '') // tolerate a pasted /tree/<branch> URL
  const m = s.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/) || s.match(/^([\w.-]+)\/([\w.-]+)$/)
  if (!m) return null
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${rev}/nextflow_schema.json`
}
const isSchemaUrl = (u) => /^https:\/\/[\w./@:-]+\.json$/.test(String(u || '').trim())

// Check whether a pipeline publishes a nextflow_schema.json we can build a form from — used by the
// "Add a pipeline" form so users see, before saving, whether they'll get a parameter form. We
// auto-FIND the standard schema from the repo (or an explicit schema URL); we can't synthesize a
// form from arbitrary pipeline code, so a repo without that file launches with a custom config.
export async function probeSchema({ repo, revision, schemaUrl }) {
  const rev = String(revision || '').trim() || 'main'
  let url = String(schemaUrl || '').trim()
  if (url) { if (!isSchemaUrl(url)) throw new HttpError(400, 'Schema URL must be an https .json link') }
  else url = deriveSchemaUrl(repo, rev)
  if (!url) return { found: false, reason: 'norepo', url: null, sections: 0 }
  let res
  try { res = await fetch(url, { signal: AbortSignal.timeout(12000) }) }
  catch (e) { return { found: false, reason: 'unreachable', url, sections: 0, message: e.message } }
  if (res.status === 404) return { found: false, reason: 'missing', url, sections: 0 }
  if (!res.ok) return { found: false, reason: 'http', url, sections: 0, status: res.status }
  let json
  try { json = await res.json() } catch { return { found: false, reason: 'parse', url, sections: 0 } }
  const defs = json.$defs || json.definitions || {}
  const sections = Object.values(defs).filter((g) => g && g.properties && Object.keys(g.properties).length).length
  return { found: true, url, sections, title: typeof json.title === 'string' ? json.title : null }
}

export function publicPipeline(p) {
  const { schemaUrl, ...rest } = p // eslint-disable-line no-unused-vars
  return rest
}

// Catalog for a user: built-ins + shared customs + the user's own customs.
export async function pipelinesFor(user) {
  const customs = (await loadCustom()).pipelines.filter((c) => c.scope === 'shared' || c.owner === user)
  return [...loadPipelines(), ...customs]
}
export async function resolvePipeline(id, user) {
  const b = loadPipelines().find((p) => p.id === id)
  if (b) return b
  const c = (await loadCustom()).pipelines.find((p) => p.id === id && (p.scope === 'shared' || p.owner === user))
  return c || null
}

export async function addCustomPipeline(def, user) {
  const name = String(def?.name ?? '').trim().slice(0, 80)
  if (!name) throw new HttpError(400, 'A pipeline name is required')
  const repo = String(def?.repo ?? '').trim()
  // github shorthand or an https git URL
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) && !/^https:\/\/[\w./@:-]+$/.test(repo)) {
    throw new HttpError(400, 'Repo must be like "nf-core/rnaseq" or an https git URL')
  }
  const revision = (String(def?.revision ?? '').trim() || 'main').slice(0, 60)
  if (!/^[\w.\-/]+$/.test(revision)) throw new HttpError(400, 'Invalid revision')
  const scope = def?.scope === 'shared' && user.role === 'admin' ? 'shared' : 'personal'
  const icon = typeof def?.icon === 'string' && /^[a-z0-9-]{1,40}$/.test(def.icon) ? def.icon : 'git-branch-line'
  // Explicit schema URL wins; otherwise auto-derive from the repo (github raw nextflow_schema.json).
  const schemaUrl = isSchemaUrl(def?.schemaUrl) ? String(def.schemaUrl).trim() : deriveSchemaUrl(repo, revision)
  const data = await loadCustom()
  if (data.pipelines.length >= 500) throw new HttpError(429, 'Pipeline limit reached')
  const rec = {
    id: newId('pipe'),
    name,
    repo,
    revision,
    icon,
    category: 'Custom',
    description: String(def?.description ?? '').trim().slice(0, 240) || `${repo} @ ${revision}`,
    schemaUrl,
    docs: /^https:/.test(repo) ? repo : `https://github.com/${repo}`,
    defaults: { ...DEFAULT_DEFAULTS },
    owner: user.username,
    scope,
    custom: true,
    createdAt: Date.now(),
  }
  data.pipelines.push(rec)
  await saveCustom()
  return rec
}

export async function removeCustomPipeline(id, user) {
  const data = await loadCustom()
  const p = data.pipelines.find((x) => x.id === id)
  if (!p) throw new HttpError(404, 'Pipeline not found')
  if (user.role !== 'admin' && p.owner !== user.username) throw new HttpError(403, 'Not your pipeline')
  data.pipelines = data.pipelines.filter((x) => x.id !== id)
  await saveCustom()
  return { ok: true }
}

// ---- schema proxy ---------------------------------------------------------
const schemaCache = new Map()
export async function fetchSchema(pipeline) {
  if (!pipeline) throw new HttpError(404, 'Unknown pipeline')
  // A bundled, curated schema (for pipelines that don't ship a nextflow_schema.json, e.g. mcmicro).
  if (pipeline.localSchema && /^[a-z0-9._-]+\.json$/i.test(pipeline.localSchema)) {
    try { return JSON.parse(readFileSync(resolve(here, '../../data/schemas', pipeline.localSchema), 'utf8')) }
    catch { return { _noSchema: true } }
  }
  if (!pipeline.schemaUrl) return { _noSchema: true } // custom repo without a schema -> form shows "no params"
  const key = `${pipeline.id}@${pipeline.revision}`
  if (schemaCache.has(key)) return schemaCache.get(key)
  let res
  try { res = await fetch(pipeline.schemaUrl, { signal: AbortSignal.timeout(15000) }) }
  catch (e) { throw new HttpError(502, `Could not reach the pipeline schema (${e.message})`) }
  if (res.status === 404) { const empty = { _noSchema: true }; schemaCache.set(key, empty); return empty }
  if (!res.ok) throw new HttpError(502, `Pipeline schema fetch failed: HTTP ${res.status}`)
  const json = await res.json()
  schemaCache.set(key, json)
  return json
}

// ---- launch command builder ----------------------------------------------
export function pipelineSlug(raw, fallback) {
  const s = String(raw || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return s || fallback
}
function safeRel(p) {
  const rel = String(p || '').trim().replace(/^\/+|\/+$/g, '')
  if (!rel) return ''
  if (rel.includes('..') || rel.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(rel)) throw new HttpError(400, 'Invalid output folder')
  return rel
}

// pipeline = a resolved built-in/custom object. Singularity comes from the managed config
// (singularity.enabled), so no `-profile singularity` is forced — that lets ANY pipeline run,
// not just nf-core ones. Users may add profiles (e.g. "test") and upload an extra config.
export function buildNextflowRun({ user, pipeline, params, runName, outdir, revision, runId, profiles, configText }) {
  if (!pipeline) throw new HttpError(400, 'Unknown pipeline')
  const rev = revision && /^[\w.\-/]{1,60}$/.test(revision) ? revision : pipeline.revision
  const locker = `${LOCKERS_ROOT}/${user}`
  const slug = pipelineSlug(runName, `${pipeline.id}-run`)
  const runDir = `${locker}/nextflow-runs/${slug}-${String(runId).replace(/[^a-z0-9]/gi, '').slice(-8)}`
  const out = outdir ? `${locker}/${safeRel(outdir)}` : `${runDir}/results`
  const b64 = Buffer.from(JSON.stringify(params && typeof params === 'object' ? params : {})).toString('base64')

  const prof = (profiles && /^[\w,.-]{1,80}$/.test(profiles)) ? ` -profile ${profiles}` : ''
  // The shared env was relocated to /opt/shared-conda (the in-container path); on the host we
  // must point Java + curl/git SSL at the real env path so Nextflow can bootstrap and fetch.
  const lines = [
    'set -e',
    `export PATH='${NF_ENV}/bin':"$PATH" JAVA_HOME='${NF_ENV}' TERM=dumb`,
    `export CURL_CA_BUNDLE='${NF_ENV}/ssl/cacert.pem' SSL_CERT_FILE='${NF_ENV}/ssl/cacert.pem' GIT_SSL_CAINFO='${NF_ENV}/ssl/cacert.pem' REQUESTS_CA_BUNDLE='${NF_ENV}/ssl/cacert.pem'`,
    `export NXF_HOME='${locker}/.nextflow' NXF_SINGULARITY_CACHEDIR='${NF_CACHE}' NXF_ANSI_LOG=false`,
    `mkdir -p "$NXF_SINGULARITY_CACHEDIR" '${runDir}' '${out}'`,
    `cd '${runDir}'`,
    `printf %s '${b64}' | base64 -d > params.json`,
  ]
  let cfgFlag = ''
  if (configText && String(configText).trim()) {
    const cb64 = Buffer.from(String(configText)).toString('base64')
    lines.push(`printf %s '${cb64}' | base64 -d > user.config`)
    cfgFlag = ` -c '${runDir}/user.config'`
  }
  lines.push(`exec '${NF_BIN}' run ${pipeline.repo} -r ${rev}${prof} -params-file params.json -c '${NF_CONFIG}'${cfgFlag} --outdir '${out}' -with-report '${runDir}/report.html' -with-trace '${runDir}/trace.txt' -with-timeline '${runDir}/timeline.html'`)
  const command = lines.join('; ')
  return { command, runDir, outdir: out, pipeline, revision: rev, slug }
}

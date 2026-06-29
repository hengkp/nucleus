import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const FILE = resolve(here, '../../data/templates.json')

let cache = null

export function loadTemplates() {
  if (cache) return cache
  const parsed = JSON.parse(readFileSync(FILE, 'utf8'))
  cache = parsed.templates
  return cache
}

export function getTemplate(id) {
  return loadTemplates().find((t) => t.id === id) || null
}

// Public shape sent to the SPA — strips server-only fields (image).
export function publicTemplate(t) {
  const { image, ...rest } = t // eslint-disable-line no-unused-vars
  return rest
}

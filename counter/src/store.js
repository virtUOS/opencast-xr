// @ts-check
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { emptyState } from './aggregate.js'

/**
 * Disk persistence for the aggregate state — a single JSON file, written
 * atomically (write to a sibling temp file, then rename over the real path,
 * which POSIX guarantees is atomic on the same filesystem). A reader (or a
 * crash) never observes a half-written file.
 *
 * This is the ONLY place in the service that touches the state file. It only
 * ever sees the shape `aggregate.js` produces — dates, country codes, and
 * counters. No IP address, salt, or per-visitor identifier is ever a
 * parameter here.
 */

/**
 * @param {string} filePath
 * @returns {Promise<import('./aggregate.js').CounterState>}
 */
export async function loadState(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') {
      return parsed
    }
    console.warn(`[counter] state file ${filePath} did not contain the expected shape — starting fresh`)
    return emptyState()
  } catch (/** @type {any} */ err) {
    if (err && err.code === 'ENOENT') return emptyState()
    console.warn(`[counter] could not read state file ${filePath} (${err?.message ?? err}) — starting fresh`)
    return emptyState()
  }
}

/**
 * @param {string} filePath
 * @param {import('./aggregate.js').CounterState} state
 */
export async function saveStateAtomic(filePath, state) {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`)
  await fs.writeFile(tmpPath, JSON.stringify(state), 'utf8')
  await fs.rename(tmpPath, filePath)
}

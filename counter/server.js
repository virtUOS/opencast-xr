// @ts-check
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createDailyDedup } from './src/dedup.js'
import { recordHit } from './src/aggregate.js'
import { loadState, saveStateAtomic } from './src/store.js'
import { createFixtureCountryLookup, createMmdbCountryLookup } from './src/geo.js'
import { renderStatsHtml, renderStatsJson } from './src/render.js'
import { MAX_HIT_BODY_BYTES, parseHitPayload } from './src/validate.js'

/**
 * The counter service: a tiny, dependency-light HTTP server (plain
 * `node:http`, no framework — see the design note "no express needed") that
 * Caddy reverse-proxies at `/api/hit` and `/stats` (see
 * `docs/INSTALL-rocky-linux-10.md`'s counter section for the exact Caddyfile
 * stanza, including the `basic_auth` that MUST gate `/stats`).
 *
 * ## What is, and is never, kept
 *
 * - `POST /api/hit` accepts exactly `{"kind": "page" | "vr" | "ar"}`
 *   (`src/validate.js`, strict — anything else is rejected).
 * - The requester's IP is used ONLY in memory, for exactly two things:
 *   (1) a GeoIP country lookup (`src/geo.js`) and (2) an HMAC-based same-day
 *   dedup check (`src/dedup.js`, salt random per day, never persisted). The
 *   IP itself is never written to disk, logged, or kept past the end of the
 *   request handler.
 * - What DOES get persisted (`src/store.js`, atomic writes) is only the
 *   aggregate: per UTC day, per country, `{pageHits, uniqueVisitors,
 *   vrSessions, arSessions}` (`src/aggregate.js`). No per-visitor record of
 *   any kind, no video/episode identifiers (the player never sends any).
 *
 * ## Binding and trust
 *
 * Always binds `127.0.0.1` — this is a private backend Caddy reaches over
 * loopback, never a public listener, so that is not configurable. The port
 * is (`COUNTER_PORT`, default 8787).
 *
 * The client IP is taken from the raw TCP connection
 * (`req.socket.remoteAddress`) UNLESS `COUNTER_TRUST_PROXY=1`, in which case
 * the leftmost entry of `X-Forwarded-For` is trusted instead — this must
 * only be set when a reverse proxy that the operator controls (Caddy, per
 * the install guide) is the sole path to this service and sets that header
 * itself; otherwise any client could forge its own "IP" (and thus its
 * reported country) by simply sending the header.
 */

const HOST = '127.0.0.1'
const DEFAULT_PORT = 8787

function readEnvPort() {
  const raw = process.env.COUNTER_PORT
  if (!raw) return DEFAULT_PORT
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT
}

/** Strips a `::ffff:`-mapped IPv4 prefix so IPv4 clients get a plain,
 * consistent address regardless of whether Node reports them via an IPv6
 * socket — purely cosmetic for the hash/lookup below, no behavior depends
 * on the exact string surviving unmodified.
 * @param {string} ip */
function normalizeIp(ip) {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} trustProxy
 */
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const header = req.headers['x-forwarded-for']
    const value = Array.isArray(header) ? header[0] : header
    const first = value?.split(',')[0]?.trim()
    if (first) return normalizeIp(first)
  }
  return normalizeIp(req.socket.remoteAddress ?? 'unknown')
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<string | null>} null means "too large, connection already handled by caller"
 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let received = 0
    /** @type {Buffer[]} */
    const chunks = []
    let tooLarge = false
    req.on('data', (chunk) => {
      if (tooLarge) return
      received += chunk.length
      if (received > maxBytes) {
        tooLarge = true
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

/**
 * Builds the request handler and the pieces a live `.listen()` needs,
 * without actually listening — this is what `counter/test/http.test.js`
 * exercises directly (creating a real server on an ephemeral port), and
 * what the bottom of this file calls when run as `node server.js`.
 *
 * @param {{
 *   initialState: import('./src/aggregate.js').CounterState,
 *   countryLookup: import('./src/geo.js').CountryLookup,
 *   dedup: ReturnType<typeof createDailyDedup>,
 *   stateFilePath: string,
 *   trustProxy: boolean,
 *   now?: () => Date,
 * }} options
 */
export function createApp({ initialState, countryLookup, dedup, stateFilePath, trustProxy, now = () => new Date() }) {
  let state = initialState
  let writeQueue = Promise.resolve()

  function scheduleSave() {
    // Re-reads `state` (via the closure, at the time this link of the chain
    // actually runs) rather than capturing today's value — so a burst of
    // hits collapses into however many writes the disk keeps up with, and
    // the file always ends up holding the latest in-memory state rather
    // than risking an older write finishing after a newer one.
    writeQueue = writeQueue
      .then(() => saveStateAtomic(stateFilePath, state))
      .catch((/** @type {any} */ err) => {
        console.error(`[counter] failed to persist state: ${err?.message ?? err}`)
      })
    return writeQueue
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async function handleHit(req, res) {
    const body = await readBody(req, MAX_HIT_BODY_BYTES)
    if (body === null) {
      res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' }).end('payload too large')
      return
    }
    const parsed = parseHitPayload(body)
    if (!parsed.ok) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(parsed.error)
      return
    }

    const ip = clientIp(req, trustProxy)
    const { dateKey, isFirstToday } = dedup.recordAndCheck(ip, now())
    const country = await countryLookup(ip).catch(() => null)

    state = recordHit(state, { dateKey, country, kind: parsed.kind, isFirstVisitorToday: isFirstToday })
    scheduleSave() // fire-and-forget: the client doesn't wait on the disk write

    res.writeHead(204).end()
  }

  /** @param {import('node:http').ServerResponse} res */
  function handleStats(res) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(renderStatsHtml(state, { now }))
  }

  /** @param {import('node:http').ServerResponse} res */
  function handleStatsJson(res) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(renderStatsJson(state, { now })))
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  function requestListener(req, res) {
    const url = req.url ?? '/'
    const path = url.split('?')[0]
    Promise.resolve()
      .then(() => {
        if (req.method === 'POST' && path === '/api/hit') return handleHit(req, res)
        if (req.method === 'GET' && path === '/stats') return handleStats(res)
        if (req.method === 'GET' && path === '/stats.json') return handleStatsJson(res)
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
      })
      .catch((/** @type {any} */ err) => {
        console.error(`[counter] request handler error: ${err?.message ?? err}`)
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('internal error')
      })
  }

  return {
    requestListener,
    /** Waits for any in-flight/queued disk writes — for tests only. */
    flush: () => writeQueue,
    /** Current in-memory state — for tests only. */
    getState: () => state,
  }
}

async function main() {
  const port = readEnvPort()
  const stateFilePath = process.env.COUNTER_STATE_FILE ?? new URL('./data/state.json', import.meta.url).pathname
  const mmdbPath = process.env.COUNTER_MMDB_PATH ?? new URL('./data/dbip-country-lite.mmdb', import.meta.url).pathname
  const trustProxy = process.env.COUNTER_TRUST_PROXY === '1'

  const initialState = await loadState(stateFilePath)
  const countryLookup = process.env.COUNTER_FAKE_GEO
    ? createFixtureCountryLookup(JSON.parse(process.env.COUNTER_FAKE_GEO)) // dev/manual-test escape hatch only, see README
    : createMmdbCountryLookup(mmdbPath)
  const dedup = createDailyDedup()

  const { requestListener } = createApp({ initialState, countryLookup, dedup, stateFilePath, trustProxy })

  const server = createServer(requestListener)
  server.listen(port, HOST, () => {
    console.log(`[counter] listening on http://${HOST}:${port} (state: ${stateFilePath})`)
  })

  for (const signal of /** @type {const} */ (['SIGTERM', 'SIGINT'])) {
    process.on(signal, () => {
      server.close(() => process.exit(0))
    })
  }
}

// Only auto-start when run directly (`node server.js` / the systemd unit),
// not when imported by tests.
const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err) => {
    console.error('[counter] fatal startup error:', err)
    process.exit(1)
  })
}

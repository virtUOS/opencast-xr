// @ts-check
import { createHmac, randomBytes as nodeRandomBytes } from 'node:crypto'

/**
 * Same-day "was this visitor already counted today" tracking, WITHOUT ever
 * keeping the IP address itself in memory or on disk.
 *
 * Design (see counter/README.md for the full writeup):
 *   - A random 32-byte salt is minted the first time a given UTC date is
 *     seen, held in memory only, and used to compute
 *     `HMAC-SHA256(salt, ip)` for every hit that day. Only that hash — never
 *     the IP — is kept, in a `Set` scoped to the day.
 *   - The salt is never persisted and never logged. A process restart mid-day
 *     loses that day's dedup set and mints a fresh salt, so a visitor who
 *     hits again after a restart is counted as "unique" a second time that
 *     day. This is an accepted trade-off (see the design doc): the
 *     alternative is persisting either the salt or the IP hashes to survive
 *     a restart, and both add a durable, deanonymizable-adjacent artifact to
 *     disk for a counter whose entire point is to avoid exactly that.
 *   - Only ONE day's salt/set is ever held at a time — as soon as a hit for a
 *     new UTC date key arrives, the previous day's salt and set are dropped.
 *     The previous day's counts already live in the persisted aggregate by
 *     then; nothing is lost except the (now pointless) dedup state itself.
 *
 * `now` and `randomBytes` are injectable so tests can control the clock and
 * make salts deterministic without touching real time or `crypto`.
 */

/**
 * @param {{ now?: () => Date, randomBytes?: (size: number) => Buffer }} [deps]
 */
export function createDailyDedup({ now = () => new Date(), randomBytes = nodeRandomBytes } = {}) {
  /** @type {string | null} */
  let currentDateKey = null
  /** @type {Buffer | null} */
  let currentSalt = null
  /** @type {Set<string>} */
  let currentSeen = new Set()

  /** @param {Date} date */
  function dateKeyFor(date) {
    return date.toISOString().slice(0, 10) // UTC yyyy-mm-dd — see module doc on why UTC
  }

  /** @param {string} dateKey */
  function rotateIfNeeded(dateKey) {
    if (currentDateKey === dateKey) return
    currentDateKey = dateKey
    currentSalt = randomBytes(32)
    currentSeen = new Set()
  }

  /**
   * Records a hit from `ip` at `date` (defaults to now) and reports whether
   * this is the first hit seen from that IP on that UTC day. Never throws on
   * a malformed `ip` — an empty/unknown address is just hashed as-is, which
   * still gives a stable (if degenerate) dedup key for that request.
   *
   * @param {string} ip
   * @param {Date} [date]
   * @returns {{ dateKey: string, isFirstToday: boolean }}
   */
  function recordAndCheck(ip, date = now()) {
    const dateKey = dateKeyFor(date)
    rotateIfNeeded(dateKey)
    const hash = createHmac('sha256', /** @type {Buffer} */ (currentSalt)).update(String(ip)).digest('hex')
    if (currentSeen.has(hash)) {
      return { dateKey, isFirstToday: false }
    }
    currentSeen.add(hash)
    return { dateKey, isFirstToday: true }
  }

  return { recordAndCheck, dateKeyFor }
}

// @ts-check

/**
 * Pure aggregation over the counter's persisted state — no I/O, no clock, no
 * randomness. Everything that touches disk (`store.js`), the network
 * (`server.js`), GeoIP (`geo.js`) or the daily dedup salt (`dedup.js`) calls
 * into these functions with plain values, which is what makes this module
 * fully covered by ordinary unit tests.
 *
 * ## Shape of the persisted state
 *
 * ```
 * {
 *   days: {
 *     "2026-08-28": {
 *       countries: {
 *         "DE": { pageHits: 12, uniqueVisitors: 5, vrSessions: 2, arSessions: 0 },
 *         "ZZ": { pageHits: 1,  uniqueVisitors: 1, vrSessions: 0, arSessions: 0 },
 *       },
 *     },
 *   },
 * }
 * ```
 *
 * Dates are UTC `yyyy-mm-dd` (see `dedup.js`'s `dateKeyFor`) — a single
 * consistent day boundary for every visitor regardless of their own time
 * zone, rather than the server's local time zone or (worse) each visitor's.
 * `"ZZ"` is the "country unknown" bucket (no GeoIP match, lookup failed, or
 * GeoIP not configured at all) — not a real ISO 3166-1 code, chosen the same
 * way `dbip`/MaxMind readers already report an absent match.
 */

/** @typedef {'page' | 'vr' | 'ar'} HitKind */

/** @typedef {{ pageHits: number, uniqueVisitors: number, vrSessions: number, arSessions: number }} CountryCounts */

/** @typedef {{ countries: Record<string, CountryCounts> }} DayRecord */

/** @typedef {{ days: Record<string, DayRecord> }} CounterState */

export const UNKNOWN_COUNTRY = 'ZZ'

/** @returns {CounterState} */
export function emptyState() {
  return { days: {} }
}

/** @returns {CountryCounts} */
function zeroCounts() {
  return { pageHits: 0, uniqueVisitors: 0, vrSessions: 0, arSessions: 0 }
}

/**
 * Folds one hit into `state`, returning a NEW state (the input is never
 * mutated) — safe to call with the module-level `state` variable in
 * `server.js` re-assigned from the result, and safe to unit-test by
 * comparing successive return values.
 *
 * @param {CounterState} state
 * @param {{ dateKey: string, country: string | null | undefined, kind: HitKind, isFirstVisitorToday: boolean }} hit
 * @returns {CounterState}
 */
export function recordHit(state, { dateKey, country, kind, isFirstVisitorToday }) {
  const countryKey = country || UNKNOWN_COUNTRY
  const prevDay = state.days[dateKey]
  const prevCounts = prevDay?.countries[countryKey] ?? zeroCounts()

  /** @type {CountryCounts} */
  const nextCounts = {
    pageHits: prevCounts.pageHits + (kind === 'page' ? 1 : 0),
    uniqueVisitors: prevCounts.uniqueVisitors + (isFirstVisitorToday ? 1 : 0),
    vrSessions: prevCounts.vrSessions + (kind === 'vr' ? 1 : 0),
    arSessions: prevCounts.arSessions + (kind === 'ar' ? 1 : 0),
  }

  return {
    days: {
      ...state.days,
      [dateKey]: {
        countries: {
          ...prevDay?.countries,
          [countryKey]: nextCounts,
        },
      },
    },
  }
}

/** @param {CountryCounts} a @param {CountryCounts} b @returns {CountryCounts} */
function addCounts(a, b) {
  return {
    pageHits: a.pageHits + b.pageHits,
    uniqueVisitors: a.uniqueVisitors + b.uniqueVisitors,
    vrSessions: a.vrSessions + b.vrSessions,
    arSessions: a.arSessions + b.arSessions,
  }
}

/** @param {DayRecord | undefined} day @returns {CountryCounts} */
function totalsForDay(day) {
  if (!day) return zeroCounts()
  return Object.values(day.countries).reduce(addCounts, zeroCounts())
}

/**
 * Grand totals across every recorded day — the "Gesamt" numbers at the top
 * of the stats page.
 *
 * @param {CounterState} state
 * @returns {CountryCounts}
 */
export function grandTotals(state) {
  return Object.values(state.days).reduce((sum, day) => addCounts(sum, totalsForDay(day)), zeroCounts())
}

/**
 * Per-day totals (summed across countries) for the last `days` UTC dates
 * ending at `endDateKey` inclusive, oldest first, zero-filled for any date
 * with no recorded hits. `endDateKey` is a parameter (not `new Date()`
 * internally) so this stays a pure function of its arguments.
 *
 * @param {CounterState} state
 * @param {string} endDateKey UTC `yyyy-mm-dd`
 * @param {number} days
 * @returns {Array<{ dateKey: string } & CountryCounts>}
 */
export function lastNDays(state, endDateKey, days) {
  const end = new Date(`${endDateKey}T00:00:00.000Z`)
  /** @type {Array<{ dateKey: string } & CountryCounts>} */
  const result = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86_400_000)
    const dateKey = d.toISOString().slice(0, 10)
    result.push({ dateKey, ...totalsForDay(state.days[dateKey]) })
  }
  return result
}

/**
 * Per-country totals (summed across all recorded days), sorted by
 * descending page hits — the ranking the stats page's country table uses.
 *
 * @param {CounterState} state
 * @returns {Array<{ country: string } & CountryCounts>}
 */
export function countryTotals(state) {
  /** @type {Record<string, CountryCounts>} */
  const byCountry = {}
  for (const day of Object.values(state.days)) {
    for (const [country, counts] of Object.entries(day.countries)) {
      byCountry[country] = addCounts(byCountry[country] ?? zeroCounts(), counts)
    }
  }
  return Object.entries(byCountry)
    .map(([country, counts]) => ({ country, ...counts }))
    .sort((a, b) => b.pageHits - a.pageHits)
}

// @ts-check
import { countryTotals, grandTotals, lastNDays } from './aggregate.js'

/**
 * Renders `/stats` as a small, self-contained German HTML page — no external
 * assets, no JS, inline CSS only, so it works from behind Caddy's
 * `basic_auth` with nothing more than a browser (see the install guide's
 * counter section for why `/stats` MUST sit behind that auth: these are the
 * only aggregate numbers this service produces, but they're still nobody's
 * business but the operator's).
 *
 * "VR vs. AR vs. Browser" is derived, not stored: a browser-only page view
 * is `pageHits - vrSessions - arSessions` for that row, clamped at 0. This
 * holds because the player beacon (`src/telemetry.ts`) sends at most one
 * `vr` and one `ar` hit per page load — see that module's doc comment — so
 * double-counting only happens in the (rare, documented) case where a
 * single page load enters BOTH an AR and a VR session (a mid-session
 * background switch), in which case the clamp keeps the derived
 * "Nur Browser" count from going negative rather than reporting it.
 *
 * @param {import('./aggregate.js').CounterState} state
 * @param {{ now?: () => Date }} [deps]
 */
export function renderStatsHtml(state, { now = () => new Date() } = {}) {
  const todayKey = now().toISOString().slice(0, 10)
  const totals = grandTotals(state)
  const days = lastNDays(state, todayKey, 30)
  const countries = countryTotals(state)
  const maxDayHits = Math.max(1, ...days.map((d) => d.pageHits))
  const browserOnly = Math.max(0, totals.pageHits - totals.vrSessions - totals.arSessions)

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>Besucherstatistik – Opencast-XR-Player</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font: 14px/1.5 system-ui, sans-serif; background: #16161a; color: #e8e8ee; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 32px 0 8px; color: #b8b8c4; }
  .totals { display: flex; gap: 16px; flex-wrap: wrap; margin: 16px 0; }
  .stat { background: #22222a; border: 1px solid #38383f; border-radius: 6px; padding: 12px 16px; min-width: 120px; }
  .stat .n { font-size: 22px; font-weight: 600; display: block; }
  .stat .l { font-size: 12px; color: #a8a8b4; }
  table { border-collapse: collapse; width: 100%; max-width: 720px; }
  th, td { text-align: left; padding: 4px 8px; font-size: 13px; border-bottom: 1px solid #2c2c33; }
  th { color: #a8a8b4; font-weight: 500; }
  .bar-cell { width: 40%; }
  .bar-track { background: #26262e; border-radius: 3px; height: 10px; overflow: hidden; }
  .bar-fill { background: #6a8fd8; height: 100%; }
  footer { margin-top: 32px; font-size: 12px; color: #8a8a96; }
  footer a { color: #a8bce8; }
</style>
</head>
<body>
<h1>Besucherstatistik – Opencast-XR-Player</h1>
<p style="color:#a8a8b4">Anonyme Zugriffszahlen. Es werden keine IP-Adressen oder Video-Aufrufe gespeichert.</p>

<div class="totals">
  <div class="stat"><span class="n">${totals.pageHits}</span><span class="l">Seitenaufrufe gesamt</span></div>
  <div class="stat"><span class="n">${totals.uniqueVisitors}</span><span class="l">Eindeutige Besucher (pro Tag)</span></div>
  <div class="stat"><span class="n">${totals.vrSessions}</span><span class="l">VR-Sitzungen</span></div>
  <div class="stat"><span class="n">${totals.arSessions}</span><span class="l">AR-Sitzungen</span></div>
  <div class="stat"><span class="n">${browserOnly}</span><span class="l">Nur Browser (ohne VR/AR)</span></div>
</div>

<h2>Letzte 30 Tage</h2>
<table>
  <thead><tr><th>Datum</th><th>Aufrufe</th><th class="bar-cell"></th><th>Besucher</th><th>VR</th><th>AR</th></tr></thead>
  <tbody>
    ${days
      .map(
        (d) => `<tr>
      <td>${escapeHtml(d.dateKey)}</td>
      <td>${d.pageHits}</td>
      <td class="bar-cell"><div class="bar-track"><div class="bar-fill" style="width:${Math.round((d.pageHits / maxDayHits) * 100)}%"></div></div></td>
      <td>${d.uniqueVisitors}</td>
      <td>${d.vrSessions}</td>
      <td>${d.arSessions}</td>
    </tr>`,
      )
      .join('\n    ')}
  </tbody>
</table>

<h2>Nach Herkunftsland</h2>
<table>
  <thead><tr><th>Land</th><th>Aufrufe</th><th>Besucher</th><th>VR</th><th>AR</th></tr></thead>
  <tbody>
    ${
      countries.length === 0
        ? '<tr><td colspan="5">Noch keine Daten.</td></tr>'
        : countries
            .map(
              (c) => `<tr>
      <td>${escapeHtml(countryLabel(c.country))}</td>
      <td>${c.pageHits}</td>
      <td>${c.uniqueVisitors}</td>
      <td>${c.vrSessions}</td>
      <td>${c.arSessions}</td>
    </tr>`,
            )
            .join('\n    ')
    }
  </tbody>
</table>

<footer>
  Herkunftsland ermittelt mit <a href="https://db-ip.com" rel="noopener noreferrer">IP-to-Country-Lite-Daten von DB-IP</a>,
  lizenziert unter <a href="https://creativecommons.org/licenses/by/4.0/" rel="noopener noreferrer">CC BY 4.0</a>.
  IP-Adressen werden dabei nur im Arbeitsspeicher ausgewertet und nicht gespeichert.
</footer>
</body>
</html>
`
}

/**
 * `/stats.json` — the same aggregate the state file holds, plus a
 * generation timestamp. This IS "raw aggregates": no derived/rounded
 * numbers, so a caller can recompute whatever view it wants.
 *
 * @param {import('./aggregate.js').CounterState} state
 * @param {{ now?: () => Date }} [deps]
 */
export function renderStatsJson(state, { now = () => new Date() } = {}) {
  return { generatedAt: now().toISOString(), ...state }
}

/** @param {string} s */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

/** A small, curated ISO-3166 alpha-2 -> German name lookup for readability
 * in the country table. Deliberately not exhaustive — an unlisted or
 * unknown code just falls back to the raw code (or "Unbekannt" for the
 * dedicated "ZZ" bucket), which is still meaningful to the operator. */
const COUNTRY_NAMES = /** @type {Record<string, string>} */ ({
  ZZ: 'Unbekannt',
  DE: 'Deutschland',
  AT: 'Österreich',
  CH: 'Schweiz',
  NL: 'Niederlande',
  BE: 'Belgien',
  FR: 'Frankreich',
  GB: 'Vereinigtes Königreich',
  IE: 'Irland',
  ES: 'Spanien',
  PT: 'Portugal',
  IT: 'Italien',
  PL: 'Polen',
  CZ: 'Tschechien',
  DK: 'Dänemark',
  SE: 'Schweden',
  NO: 'Norwegen',
  FI: 'Finnland',
  US: 'USA',
  CA: 'Kanada',
  AU: 'Australien',
  NZ: 'Neuseeland',
  JP: 'Japan',
  CN: 'China',
  IN: 'Indien',
  BR: 'Brasilien',
})

/** @param {string} code */
function countryLabel(code) {
  const name = COUNTRY_NAMES[code]
  return name ? `${name} (${code})` : code
}

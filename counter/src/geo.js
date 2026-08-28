// @ts-check

/**
 * Country lookup, abstracted behind a single function type so the rest of
 * the service (and its tests) never have to know whether it's backed by a
 * real db-ip `.mmdb` file, a fixture, or a constant.
 *
 * @typedef {(ip: string) => Promise<string | null>} CountryLookup
 */

/**
 * The real implementation: opens a db-ip.com "Country Lite" `.mmdb` file
 * (see counter/README.md for the download URL and the CC-BY 4.0 attribution
 * this data requires — already on the `/stats` page) via the `maxmind` npm
 * package and looks up the ISO 3166-1 alpha-2 country code for an IP.
 *
 * Never throws: a missing/corrupt mmdb file, or an IP the database has no
 * entry for, both resolve to `null` (which `aggregate.js`'s `recordHit`
 * turns into the `"ZZ"` bucket) rather than rejecting the request. This is a
 * visitor counter, not a security control — a lookup failure should degrade
 * to "country unknown", never to a 500.
 *
 * The mmdb file is opened lazily, once, on first use, and the open reader is
 * reused for every subsequent lookup.
 *
 * @param {string} mmdbPath
 * @returns {import('./geo.js').CountryLookup}
 */
export function createMmdbCountryLookup(mmdbPath) {
  /** @type {Promise<any | null> | null} */
  let readerPromise = null

  function getReader() {
    if (!readerPromise) {
      readerPromise = import('maxmind')
        .then(({ open }) => open(mmdbPath))
        .catch((/** @type {any} */ err) => {
          console.warn(
            `[counter] could not open GeoIP database at ${mmdbPath} (${err?.message ?? err}) — ` +
              'every hit will be recorded under the "ZZ" (unknown) country until this is fixed',
          )
          return null
        })
    }
    return readerPromise
  }

  return async function lookupCountry(ip) {
    const reader = await getReader()
    if (!reader) return null
    try {
      const result = reader.get(ip)
      return result?.country?.iso_code ?? null
    } catch {
      // Malformed/unparseable IP, or a reader edge case — unknown, not fatal.
      return null
    }
  }
}

/**
 * A test double: resolves whatever `map` says (defaulting to `null`, i.e.
 * "unknown"), with no file I/O and no dependency on the real `maxmind`
 * package or a real `.mmdb` file — which is deliberately not checked into
 * this repository (see the design note: "Do NOT test actual GeoIP with the
 * real mmdb").
 *
 * @param {Record<string, string>} map
 * @returns {import('./geo.js').CountryLookup}
 */
export function createFixtureCountryLookup(map) {
  return async function lookupCountry(ip) {
    return map[ip] ?? null
  }
}

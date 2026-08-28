// @ts-check

/**
 * Strict validation for the `POST /api/hit` body. Nothing about this counter
 * is worth accepting garbage for: an invalid or oversized body is rejected
 * outright rather than coerced, so the persisted aggregates can never contain
 * a hit that didn't actually look like `{"kind": "page" | "vr" | "ar"}`.
 *
 * Kept as a pure function (string in, result out) so the request handler in
 * `server.js` stays a thin wrapper: read the body up to the size cap, hand
 * the raw string here, act on the result.
 */

/** @typedef {'page' | 'vr' | 'ar'} HitKind */

/** Hard cap on the request body, in bytes, enforced by the caller before it
 * ever reaches `JSON.parse` — the payload is a single short field, so
 * anything past a few dozen bytes is already suspicious. */
export const MAX_HIT_BODY_BYTES = 256

const VALID_KINDS = /** @type {const} */ (['page', 'vr', 'ar'])

/** @param {unknown} value @returns {value is HitKind} */
function isHitKind(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (VALID_KINDS).includes(value)
}

/**
 * @param {string} rawBody
 * @returns {{ ok: true, kind: HitKind } | { ok: false, error: string }}
 */
export function parseHitPayload(rawBody) {
  if (typeof rawBody !== 'string' || rawBody.length === 0) {
    return { ok: false, error: 'empty body' }
  }
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_HIT_BODY_BYTES) {
    return { ok: false, error: 'body too large' }
  }

  /** @type {unknown} */
  let json
  try {
    json = JSON.parse(rawBody)
  } catch {
    return { ok: false, error: 'invalid JSON' }
  }

  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, error: 'body must be a JSON object' }
  }

  const keys = Object.keys(json)
  if (keys.length !== 1 || keys[0] !== 'kind') {
    return { ok: false, error: 'body must contain exactly one field, "kind"' }
  }

  const kind = /** @type {{ kind: unknown }} */ (json).kind
  if (!isHitKind(kind)) {
    return { ok: false, error: 'kind must be "page", "vr", or "ar"' }
  }

  return { ok: true, kind }
}

import type { OcTrack } from './types'

export interface StreamSource {
  flavorType: string
  url: string
  width?: number
  height?: number
}

const DEFAULT_MAX_HEIGHT = 1080

// Operators assign arbitrary flavor names (audience/*, and whatever else),
// but the player's window layout wants presenter and presentation windows
// first and in a stable position; everything else is just alphabetical so
// the order is at least deterministic and reproducible across sessions.
const PREFERRED_FLAVOR_ORDER = ['presenter', 'presentation']

function orderFlavorTypes(flavorTypes: string[]): string[] {
  const rest = flavorTypes.filter((f) => !PREFERRED_FLAVOR_ORDER.includes(f)).sort()
  const preferred = PREFERRED_FLAVOR_ORDER.filter((f) => flavorTypes.includes(f))
  return [...preferred, ...rest]
}

/**
 * Picks one track from a single flavor's candidates: the highest resolution
 * that's still <= maxHeight, or (if every candidate exceeds the cap) the
 * smallest one above it.
 *
 * Tracks with no known resolution (no video.resolution in the Opencast
 * response, so width/height are undefined) are treated as the LOWEST
 * quality available for their flavor - they're only ever picked when no
 * track in that flavor reports a resolution at all. There's no reliable
 * signal to rank unknown-resolution tracks against known ones, so rather
 * than guess, we prefer anything we can actually measure.
 */
function pickBestInFlavor(tracks: OcTrack[], maxHeight: number): OcTrack {
  const withKnownHeight = tracks.filter((t): t is OcTrack & { height: number } => t.height !== undefined)

  if (withKnownHeight.length === 0) {
    // Nothing to compare on - take the first candidate deterministically.
    return tracks[0]
  }

  const withinCap = withKnownHeight.filter((t) => t.height <= maxHeight)
  if (withinCap.length > 0) {
    // Highest resolution still at or below the cap.
    return withinCap.reduce((best, t) => (t.height > best.height ? t : best))
  }

  // Every known resolution exceeds the cap: take the smallest of those.
  return withKnownHeight.reduce((best, t) => (t.height < best.height ? t : best))
}

/**
 * Groups eligible video tracks by flavorType and picks one quality per
 * flavor. Only engage-download video/mp4 tracks are considered eligible -
 * that's the download rendition the player actually plays, as opposed to
 * streaming (HLS/DASH) renditions which this player doesn't consume.
 */
export function selectStreams(tracks: OcTrack[], opts?: { maxHeight?: number }): StreamSource[] {
  const maxHeight = opts?.maxHeight ?? DEFAULT_MAX_HEIGHT

  const eligible = tracks.filter(
    (t) => t.isVideo && t.mimetype === 'video/mp4' && t.tags.includes('engage-download'),
  )

  const byFlavor = new Map<string, OcTrack[]>()
  for (const t of eligible) {
    const group = byFlavor.get(t.flavorType)
    if (group) group.push(t)
    else byFlavor.set(t.flavorType, [t])
  }

  return orderFlavorTypes([...byFlavor.keys()]).map((flavorType) => {
    const best = pickBestInFlavor(byFlavor.get(flavorType) as OcTrack[], maxHeight)
    return { flavorType, url: best.url, width: best.width, height: best.height }
  })
}

function captionsPreferenceScore(t: OcTrack): number {
  let score = 0
  if (t.tags.includes('engage-download')) score += 2
  const subtype = t.mimetype.split('/')[1] ?? ''
  if (subtype.includes('vtt') || t.url.toLowerCase().endsWith('.vtt')) score += 1
  return score
}

/**
 * Finds the best captions/* track to use: prefers one tagged
 * engage-download, then prefers a vtt subtype or a ".vtt" URL (the format
 * this player's caption renderer consumes). Ties keep the first captions
 * track encountered, so behavior is deterministic even with no preference
 * signal at all.
 */
export function findCaptionsTrack(tracks: OcTrack[]): OcTrack | undefined {
  const captionsTracks = tracks.filter((t) => t.isCaptions)
  if (captionsTracks.length === 0) return undefined

  return captionsTracks.reduce((best, t) =>
    captionsPreferenceScore(t) > captionsPreferenceScore(best) ? t : best,
  )
}

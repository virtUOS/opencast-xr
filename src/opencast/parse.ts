import type { Episode, OcSegment, OcTrack, Series } from './types'

/**
 * Opencast's search API serializes XML "1 or many" elements inconsistently:
 * a single child comes through as a bare object, more than one as an array.
 * `media.track`, `attachments.attachment`, `creators.creator`, and
 * `segments.segment` all show this quirk. Normalize once, use everywhere.
 */
export function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

// The Opencast search API's JSON shape is loosely typed (XML-derived, no
// schema enforced across versions), so this internal parsing layer works
// against `any` and produces the strict `Episode`/`Series` types below.
/* eslint-disable @typescript-eslint/no-explicit-any */

function digResults(json: unknown): unknown {
  const j = json as any
  return j?.result ?? j?.['search-results']?.result
}

function parseTrack(t: any): OcTrack {
  const flavor = String(t?.type ?? '')
  const flavorType = flavor.split('/')[0]?.toLowerCase() ?? ''
  const mimetype = String(t?.mimetype ?? '')
  const resolution: string | undefined = t?.video?.resolution
  let width: number | undefined
  let height: number | undefined
  if (resolution) {
    const [w, h] = resolution.split('x').map(Number)
    if (Number.isFinite(w)) width = w
    if (Number.isFinite(h)) height = h
  }

  return {
    id: String(t?.id ?? ''),
    flavor,
    flavorType,
    mimetype,
    url: String(t?.url ?? ''),
    tags: asArray(t?.tags?.tag),
    width,
    height,
    isVideo: mimetype.startsWith('video/'),
    isCaptions: flavor.startsWith('captions/'),
  }
}

function parsePreviewUrl(mp: any): string | undefined {
  const attachments = asArray(mp?.attachments?.attachment)
  const searchPreview = attachments.find(
    (a: any) => typeof a?.type === 'string' && a.type.endsWith('search+preview'),
  )
  if (searchPreview) return searchPreview.url
  const playerPreview = attachments.find(
    (a: any) => typeof a?.type === 'string' && a.type.endsWith('player+preview'),
  )
  return playerPreview?.url
}

function parseSegments(entry: any): OcSegment[] {
  return asArray(entry?.segments?.segment).map((s: any) => ({
    startMs: Number(s?.time),
    durationMs: Number(s?.duration),
    text: String(s?.text ?? ''),
    previewUrl: s?.previews?.preview?.$,
  }))
}

function parseEpisode(entry: any): Episode {
  const mp = entry?.mediapackage ?? entry

  return {
    id: String(mp?.id ?? ''),
    title: String(mp?.title ?? ''),
    seriesId: mp?.series,
    seriesTitle: mp?.seriestitle,
    created: mp?.start,
    durationMs: Number(mp?.duration),
    creators: asArray(mp?.creators?.creator),
    previewUrl: parsePreviewUrl(mp),
    tracks: asArray(mp?.media?.track).map(parseTrack),
    segments: parseSegments(entry),
  }
}

export function parseEpisodeResponse(json: unknown): Episode[] {
  return asArray(digResults(json) as any).map(parseEpisode)
}

function parseSeries(entry: any): Series {
  return {
    id: String(entry?.dc?.identifier?.[0] ?? ''),
    title: String(entry?.dc?.title?.[0] ?? ''),
  }
}

export function parseSeriesResponse(json: unknown): Series[] {
  return asArray(digResults(json) as any).map(parseSeries)
}

import type { Cue, Episode, Series } from './types'
import { parseEpisodeResponse, parseSeriesResponse } from './parse'
import { findCaptionsTrack } from './selectTracks'
import { parseVtt } from './vtt'

const DEFAULT_BASE_URL = 'https://develop.opencast.org'

export interface OpencastClientOptions {
  baseUrl?: string
  /** Shapes every API/asset RequestInit before it reaches fetchFn - the JWT/LTI auth seam (spec §6). */
  authorize?: (init: RequestInit, url: string) => RequestInit
  /** Rewrites every media/image URL that leaves the data layer (track urls, previewUrl, segment previews). */
  resolveAssetUrl?: (url: string) => string
  /** Test seam; defaults to the global fetch. */
  fetchFn?: typeof fetch
}

/** Thrown when an Opencast HTTP request fails, carrying the response's status code. */
export class OpencastError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'OpencastError'
    this.status = status
  }
}

// Opencast's search API is XML-derived and loosely typed across versions;
// this internal layer works against `any` before producing the strict
// `Episode`/`Series` types re-exported from `types.ts`.
/* eslint-disable @typescript-eslint/no-explicit-any */

function identity<T>(value: T): T {
  return value
}

/**
 * `total` normally sits at the top level of the response envelope
 * (`{ result, total, offset, limit }`, per the recorded episodes-list.json
 * fixture), but older Opencast versions nest it as `search-results.total`.
 * Tolerate both.
 */
function extractTotal(json: unknown): number {
  const j = json as any
  if (typeof j?.total === 'number') return j.total
  const nested = j?.['search-results']?.total
  if (typeof nested === 'number') return nested
  return 0
}

export class OpencastClient {
  private readonly baseUrl: string
  private readonly authorizeHook: (init: RequestInit, url: string) => RequestInit
  private readonly resolveAssetUrlHook: (url: string) => string
  private readonly fetchFn: typeof fetch

  constructor(opts: OpencastClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
    this.authorizeHook = opts.authorize ?? ((init) => init)
    this.resolveAssetUrlHook = opts.resolveAssetUrl ?? identity
    this.fetchFn = opts.fetchFn ?? fetch
  }

  /** Runs one authorized fetch against an absolute URL, throwing OpencastError on a non-ok response. */
  private async fetchAuthorized(url: string): Promise<Response> {
    const init = this.authorizeHook({}, url)
    const res = await this.fetchFn(url, init)
    if (!res.ok) {
      throw new OpencastError(`Opencast request to ${url} failed with status ${res.status}`, res.status)
    }
    return res
  }

  private async requestJson(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<unknown> {
    const url = new URL(path, this.baseUrl)
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
    }
    const res = await this.fetchAuthorized(url.toString())
    return res.json()
  }

  /** Applies resolveAssetUrl to every media/image URL an Episode exposes: tracks, previewUrl, segment previews. */
  private rewriteEpisode(ep: Episode): Episode {
    return {
      ...ep,
      previewUrl: ep.previewUrl ? this.resolveAssetUrlHook(ep.previewUrl) : ep.previewUrl,
      tracks: ep.tracks.map((t) => ({ ...t, url: this.resolveAssetUrlHook(t.url) })),
      segments: ep.segments.map((s) => ({
        ...s,
        previewUrl: s.previewUrl ? this.resolveAssetUrlHook(s.previewUrl) : s.previewUrl,
      })),
    }
  }

  async listSeries(): Promise<Series[]> {
    const json = await this.requestJson('/search/series.json')
    return parseSeriesResponse(json)
  }

  async listEpisodes(p?: {
    sid?: string
    q?: string
    limit?: number
    offset?: number
  }): Promise<{ episodes: Episode[]; total: number }> {
    const json = await this.requestJson('/search/episode.json', {
      sid: p?.sid,
      q: p?.q,
      limit: p?.limit,
      offset: p?.offset,
    })
    const episodes = parseEpisodeResponse(json).map((ep) => this.rewriteEpisode(ep))
    return { episodes, total: extractTotal(json) }
  }

  async getEpisode(id: string): Promise<Episode | undefined> {
    const json = await this.requestJson('/search/episode.json', { id })
    const [episode] = parseEpisodeResponse(json)
    return episode ? this.rewriteEpisode(episode) : undefined
  }

  /** Finds the best captions track, fetches and parses its VTT; [] if the episode has no captions track. */
  async loadCaptions(ep: Episode): Promise<Cue[]> {
    const track = findCaptionsTrack(ep.tracks)
    if (!track) return []
    const res = await this.fetchAuthorized(track.url)
    const text = await res.text()
    return parseVtt(text)
  }
}

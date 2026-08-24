import { describe, expect, it } from 'vitest'
import type { Episode, OcTrack } from '../opencast/types'
import {
  CRUMB_MAX_CHARS,
  HOME_LABEL,
  adjacentEpisodes,
  breadcrumbTrail,
  needsMoreEpisodes,
  playableEpisodes,
} from './breadcrumbState'

function playableTrack(): OcTrack[] {
  return [
    {
      id: 't1',
      flavor: 'presenter/preview',
      flavorType: 'presenter',
      mimetype: 'video/mp4',
      url: 'https://example.org/v.mp4',
      tags: ['engage-download'],
      isVideo: true,
      isCaptions: false,
    },
  ]
}

/** Same shape as libraryState.test.ts's nonPlayableTrack: a real track, but not an eligible engage-download one. */
function nonPlayableTrack(): OcTrack[] {
  return [{ ...playableTrack()[0], tags: ['engage-streaming'] }]
}

function makeEpisode(overrides: Partial<Episode> & { id: string }): Episode {
  return {
    id: overrides.id,
    title: overrides.title ?? `Title ${overrides.id}`,
    seriesId: overrides.seriesId,
    seriesTitle: overrides.seriesTitle,
    created: overrides.created,
    durationMs: overrides.durationMs ?? 60_000,
    creators: overrides.creators ?? [],
    previewUrl: overrides.previewUrl,
    tracks: overrides.tracks ?? playableTrack(),
    segments: overrides.segments ?? [],
  }
}

describe('breadcrumbTrail', () => {
  it('is Home > Reihe > Aufzeichnung for an episode that belongs to a series', () => {
    const trail = breadcrumbTrail({ title: 'Vorlesung 3', seriesId: 's1', seriesTitle: 'Chaos' })
    expect(trail).toEqual([
      { kind: 'home', label: HOME_LABEL },
      { kind: 'series', label: 'Chaos', sid: 's1' },
      { kind: 'current', label: 'Vorlesung 3' },
    ])
  })

  it('omits the series step entirely for a series-less episode', () => {
    const trail = breadcrumbTrail({ title: 'Einzelaufnahme', seriesId: undefined, seriesTitle: undefined })
    expect(trail.map((c) => c.kind)).toEqual(['home', 'current'])
    // Nothing left over that a click could target - not a disabled crumb.
    expect(trail.some((c) => c.kind === 'series')).toBe(false)
  })

  it('falls back to the series ID when the episode carries a seriesId but no title', () => {
    const trail = breadcrumbTrail({ title: 'V1', seriesId: 's-42', seriesTitle: undefined })
    expect(trail[1]).toEqual({ kind: 'series', label: 's-42', sid: 's-42' })
  })

  it('always starts at Home and ends at the current recording', () => {
    for (const seriesId of [undefined, 's1']) {
      const trail = breadcrumbTrail({ title: 'T', seriesId, seriesTitle: 'S' })
      expect(trail[0].kind).toBe('home')
      expect(trail[trail.length - 1].kind).toBe('current')
      expect(trail.length).toBe(seriesId == null ? 2 : 3)
    }
  })

  it('truncates over-long labels with plain ASCII dots, and leaves short ones alone', () => {
    const long = 'x'.repeat(CRUMB_MAX_CHARS + 20)
    const trail = breadcrumbTrail({ title: long, seriesId: 's1', seriesTitle: long })
    for (const crumb of [trail[1], trail[2]]) {
      expect(crumb.label.length).toBe(CRUMB_MAX_CHARS)
      expect(crumb.label.endsWith('...')).toBe(true)
    }
    // No "…" (U+2026) - a missing glyph in this project's uikit font, see
    // docs/UIKIT-NOTES.md entry 3.
    expect(trail.every((c) => !c.label.includes('…'))).toBe(true)
  })

  it('leaves a label exactly at the limit untruncated', () => {
    const exact = 'y'.repeat(CRUMB_MAX_CHARS)
    const trail = breadcrumbTrail({ title: exact, seriesId: undefined, seriesTitle: undefined })
    expect(trail[1].label).toBe(exact)
  })

  it('gives only the series crumb an sid', () => {
    const trail = breadcrumbTrail({ title: 'T', seriesId: 's1', seriesTitle: 'S' })
    expect(trail.filter((c) => c.sid != null).map((c) => c.kind)).toEqual(['series'])
  })
})

describe('adjacentEpisodes', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('returns the entries either side of the current one, in list order', () => {
    expect(adjacentEpisodes(list, 'b')).toEqual({ previous: { id: 'a' }, next: { id: 'c' } })
  })

  it('has no previous at the start and no next at the end - it does not wrap', () => {
    expect(adjacentEpisodes(list, 'a')).toEqual({ previous: null, next: { id: 'b' } })
    expect(adjacentEpisodes(list, 'c')).toEqual({ previous: { id: 'b' }, next: null })
  })

  it('yields both null for a single-entry list', () => {
    expect(adjacentEpisodes([{ id: 'only' }], 'only')).toEqual({ previous: null, next: null })
  })

  it('yields both null when the current id is not in the list (list not fetched yet, or a later page)', () => {
    expect(adjacentEpisodes(list, 'zzz')).toEqual({ previous: null, next: null })
    expect(adjacentEpisodes([], 'a')).toEqual({ previous: null, next: null })
  })

  it('resolves a duplicated id against its first occurrence, deterministically', () => {
    const dupes = [{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'd' }]
    expect(adjacentEpisodes(dupes, 'a')).toEqual({ previous: null, next: { id: 'b' } })
  })

  it('returns the list entries themselves, so the caller can read any field off them', () => {
    const episodes = [makeEpisode({ id: 'e1' }), makeEpisode({ id: 'e2', title: 'Zweite' })]
    expect(adjacentEpisodes(episodes, 'e1').next?.title).toBe('Zweite')
  })
})

describe('playableEpisodes', () => {
  it('keeps episodes with an eligible video track and drops the rest', () => {
    const episodes = [
      makeEpisode({ id: 'e1' }),
      makeEpisode({ id: 'e2', tracks: nonPlayableTrack() }),
      makeEpisode({ id: 'e3' }),
      makeEpisode({ id: 'e4', tracks: [] }),
    ]
    expect(playableEpisodes(episodes).map((e) => e.id)).toEqual(['e1', 'e3'])
  })

  it('preserves the original order (previous/next depend on it)', () => {
    const episodes = [
      makeEpisode({ id: 'e1' }),
      makeEpisode({ id: 'skip', tracks: nonPlayableTrack() }),
      makeEpisode({ id: 'e2' }),
    ]
    // The unplayable middle entry is skipped over, not stepped onto: e1's next
    // is e2 directly.
    expect(adjacentEpisodes(playableEpisodes(episodes), 'e1').next?.id).toBe('e2')
  })

  it('is empty rather than throwing for an empty list', () => {
    expect(playableEpisodes([])).toEqual([])
  })
})

// Review round, I3: seriesState pages at 12 and only page 1 is fetched on
// arrival, so adjacentEpisodes was answering "no next" about a list that simply
// stops - silently, because a disabled button looks exactly like the end of a
// series.
describe('needsMoreEpisodes', () => {
  /** A fetched page of `n` playable episodes, ids e1..en. */
  const page = (n: number, from = 1) =>
    Array.from({ length: n }, (_, i) => makeEpisode({ id: `e${from + i}` }))

  it('THE PAGE BOUNDARY: episode 12 of 20 needs another page before "next" can be honest', () => {
    const fetched = page(12) // page 1 of a 20-part series
    // The pure part of the bug: adjacentEpisodes alone says "no next" here...
    expect(adjacentEpisodes(playableEpisodes(fetched), 'e12').next).toBeNull()
    // ...and this is what stops that from being rendered as end-of-series.
    expect(needsMoreEpisodes(fetched, 'e12', true, false)).toBe(true)
  })

  it('...and once that page arrives, "next" works and no further page is asked for', () => {
    const fetched = [...page(12), ...page(8, 13)] // both pages, 20 total
    expect(needsMoreEpisodes(fetched, 'e12', false, false)).toBe(false)
    expect(adjacentEpisodes(playableEpisodes(fetched), 'e12').next?.id).toBe('e13')
  })

  it('THE OPEN EPISODE IS ON PAGE 2: not in the fetched list at all, so keep paging', () => {
    const fetched = page(12)
    // Both controls are disabled in this state (adjacentEpisodes cannot place
    // an id it has never seen), which is exactly why it must not be the
    // resting state.
    expect(adjacentEpisodes(playableEpisodes(fetched), 'e15')).toEqual({ previous: null, next: null })
    expect(needsMoreEpisodes(fetched, 'e15', true, false)).toBe(true)
  })

  it('stops as soon as the open episode has a playable successor in hand', () => {
    const fetched = page(12)
    expect(needsMoreEpisodes(fetched, 'e11', true, false)).toBe(false)
    expect(needsMoreEpisodes(fetched, 'e1', true, false)).toBe(false)
  })

  it('never asks for a page the server does not have', () => {
    const fetched = page(12)
    // Last episode of a series that really does end here: no next, and nothing
    // to fetch - this is the honest end-of-series the buttons should show.
    expect(needsMoreEpisodes(fetched, 'e12', false, false)).toBe(false)
    // Not fetched AND nothing more to fetch: give up rather than loop.
    expect(needsMoreEpisodes(fetched, 'e99', false, false)).toBe(false)
  })

  it('holds off while a page is already in flight, so the convergence cannot loop', () => {
    const fetched = page(12)
    expect(needsMoreEpisodes(fetched, 'e12', true, true)).toBe(false)
    expect(needsMoreEpisodes(fetched, 'e15', true, true)).toBe(false)
  })

  it('pages past a tail of unplayable recordings to find a real successor', () => {
    const fetched = [...page(10), makeEpisode({ id: 'skip', tracks: nonPlayableTrack() })]
    // e10 has no PLAYABLE successor even though the raw list continues.
    expect(needsMoreEpisodes(fetched, 'e10', true, false)).toBe(true)
  })

  it('does not page the whole series for a recording that has nothing playable itself', () => {
    // Reachable via the "Reihe" window, which does not gate on playability.
    // prev/next step through the playable list, so this recording has no
    // neighbourhood to complete - paging to discover that is pointless traffic.
    const fetched = [...page(5), makeEpisode({ id: 'dud', tracks: nonPlayableTrack() })]
    expect(needsMoreEpisodes(fetched, 'dud', true, false)).toBe(false)
  })

  it('asks for the first page when nothing is fetched yet but the server has some', () => {
    expect(needsMoreEpisodes([], 'e1', true, false)).toBe(true)
    expect(needsMoreEpisodes([], 'e1', false, false)).toBe(false)
  })
})

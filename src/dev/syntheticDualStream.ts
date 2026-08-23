import { OpencastClient } from '../opencast/client'
import { selectStreams } from '../opencast/selectTracks'
import type { Episode, OcSegment, OcTrack } from '../opencast/types'

/**
 * DEVELOPMENT ONLY. Turns a single-video-flavor episode into a two-stream one.
 *
 * The sync engine's whole job - drift correction, master election, handover on
 * close, rejoin on restore - is only observable with at least two streams, and
 * develop.opencast.org's recordings all have exactly one video flavor. Rather
 * than hunt for (or upload) a real dual-stream recording, this duplicates the
 * one track the player would have picked anyway under a second flavor.
 *
 * The two clones share a URL, which does NOT weaken the test: the store creates
 * one `<video>` element per flavor, so there are two independent decoders with
 * independent clocks, buffering and stalls. Only the pixels match.
 *
 * `presentation/synthetic` is the added flavor (`presenter/preview` is what the
 * develop recordings already use), so the resulting `streams` order is
 * presenter, presentation - preference 0 and 1, i.e. the real layout and the
 * real election order.
 */
export const SYNTHETIC_FLAVORS = ['presenter/preview', 'presentation/synthetic'] as const

export function syntheticDualStream(ep: Episode): Episode {
  // `selectStreams` is the same predicate the store uses, so "one stream" here
  // means exactly what the player would show. An episode that already has two
  // or more (or no) usable video flavors is returned untouched: there is
  // nothing to synthesize, and rewriting a genuinely multi-stream recording
  // would replace real content with a duplicate.
  const sources = selectStreams(ep.tracks)
  if (sources.length !== 1) return ep

  // The full track record behind the chosen rendition, so the clones keep its
  // mimetype, tags and resolution and stay eligible for selectStreams.
  const original = ep.tracks.find((t) => t.isVideo && t.url === sources[0].url)
  if (!original) return ep

  const clones: OcTrack[] = SYNTHETIC_FLAVORS.map((flavor) => ({
    ...original,
    id: `${original.id}-synthetic-${flavor.replace('/', '-')}`,
    flavor,
    flavorType: flavor.split('/')[0],
  }))

  // Every video track is replaced by the two clones (the other renditions of
  // the same flavor are alternatives to the one just cloned, and keeping them
  // would only give selectStreams a chance to pick differently per flavor);
  // captions and everything else passes through untouched.
  return { ...ep, tracks: [...ep.tracks.filter((t) => !t.isVideo), ...clones] }
}

/**
 * DEVELOPMENT ONLY. Start times (seconds) of the three chapter markers
 * `buildTestChapters` injects - Task 14's brief spells them out explicitly.
 */
export const TEST_CHAPTER_STARTS_S = [0, 60, 120] as const

/**
 * DEVELOPMENT ONLY. develop.opencast.org's recordings never carry any
 * `segments` (no OCR slide-segmentation configured on that instance), so
 * `ChaptersWindow` (Task 14) has nothing to render there without help -
 * the same problem `syntheticDualStream` solves for the sync engine's
 * multi-stream behaviour. This fabricates three chapter markers at the
 * fixed offsets above, each reusing the episode's OWN `previewUrl` as its
 * tile image (there is no per-segment preview to reuse, since there are no
 * real segments at all) and a distinguishing placeholder OCR text.
 *
 * A fixed 60s nominal duration per marker is fine here: `ChaptersWindow`'s
 * highlight logic (`chaptersState.ts`'s `activeSegmentIndex`) only ever
 * looks at `startMs`, never `durationMs` - see that function's own doc
 * comment for why.
 */
export function buildTestChapters(ep: Episode): OcSegment[] {
  return TEST_CHAPTER_STARTS_S.map((startS, i) => ({
    startMs: startS * 1000,
    durationMs: 60_000,
    text: `Kapitel ${i + 1} (Test)`,
    previewUrl: ep.previewUrl,
  }))
}

/**
 * DEVELOPMENT ONLY. An `OpencastClient` that can serve every episode through
 * `syntheticDualStream` and/or `buildTestChapters`, each switchable at
 * runtime and independently of the other.
 *
 * Mutable fields rather than constructor flags, on purpose: the player store
 * is created once per `<App>` mount and holds the client for its whole life
 * (see store.ts), so a flag that could only be set at construction time would
 * mean rebuilding the store - and tearing down playback - every time a dev
 * checkbox is ticked. Both flags are read per `getEpisode` call, so each
 * takes effect on the NEXT episode opened, not retroactively on the one
 * showing - same as `syntheticSecondStream` already worked before this.
 */
export class SyntheticDualStreamClient extends OpencastClient {
  syntheticSecondStream = false
  testChapters = false

  override async getEpisode(id: string): Promise<Episode | undefined> {
    const episode = await super.getEpisode(id)
    if (!episode) return episode
    const withStream = this.syntheticSecondStream ? syntheticDualStream(episode) : episode
    return this.testChapters ? { ...withStream, segments: buildTestChapters(withStream) } : withStream
  }
}

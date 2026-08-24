import type { Episode } from '../opencast/types'
import { selectStreams } from '../opencast/selectTracks'
import { truncateOcrText } from './chaptersState'

/**
 * The pure logic behind the dock's second row (the user-feedback round): the
 * `Home > Reihe > aktuelle Aufzeichnung` breadcrumb, and which episodes of the
 * series sit either side of the open one for the previous/next controls.
 *
 * Same split as every other `*State.ts` in this folder - `DockTransport.tsx`
 * is thin glue over this, because `@react-three/uikit` components cannot
 * render meaningfully in jsdom and so anything worth asserting on has to live
 * outside the component.
 */

/** How long a breadcrumb label may render before being truncated - the dock's second row is one line and shares it with the previous/next controls. */
export const CRUMB_MAX_CHARS = 30

/**
 * One breadcrumb step. `kind` is what the click means, and the component maps
 * it to an action:
 * - `home` -> browse mode at library level 1 (this is what REPLACED the old
 *   „Bibliothek" button);
 * - `series` -> browse mode showing that series' own episode list (level 2),
 *   via the player store's one-shot browse target; `sid` is the series to
 *   scope to and is always set for this kind;
 * - `current` -> nothing. It is where the user already is, so it renders as
 *   plain (non-interactive) text rather than as a dead link.
 */
export interface Crumb {
  kind: 'home' | 'series' | 'current'
  label: string
  /** Set exactly for `kind: 'series'` - the series id to browse into. */
  sid?: string
}

export const HOME_LABEL = 'Home'

/**
 * `Home > Reihe > aktuelle Aufzeichnung`, with the series step OMITTED for a
 * series-less recording (there is no series list to navigate to, so a crumb
 * for it would be a dead end). `Home` is always first and `current` always
 * last, so the trail is 2 or 3 steps - never empty, never just `Home`.
 *
 * The series label falls back to the series ID when the episode carries a
 * `seriesId` but no `seriesTitle` (the Search API does return that
 * combination): a raw id is ugly but navigable and honest, whereas dropping
 * the crumb entirely would hide a real navigation target.
 *
 * Labels are truncated here rather than in the component so the truncation is
 * covered by these tests - reusing `chaptersState.ts`'s truncate (generic
 * despite its OCR-flavoured name) rather than a second copy of the same
 * slice-and-ellipsis arithmetic. "..." is three ASCII dots, not "…"
 * (U+2026) - see `docs/UIKIT-NOTES.md` entry 3.
 */
export function breadcrumbTrail(
  episode: Pick<Episode, 'title' | 'seriesId' | 'seriesTitle'>,
): Crumb[] {
  const trail: Crumb[] = [{ kind: 'home', label: HOME_LABEL }]
  if (episode.seriesId != null) {
    trail.push({
      kind: 'series',
      label: truncateOcrText(episode.seriesTitle ?? episode.seriesId, CRUMB_MAX_CHARS),
      sid: episode.seriesId,
    })
  }
  trail.push({ kind: 'current', label: truncateOcrText(episode.title, CRUMB_MAX_CHARS) })
  return trail
}

export interface Adjacent<T> {
  previous: T | null
  next: T | null
}

/**
 * The entries immediately before and after `currentId` in the list's OWN order
 * - which for the dock's previous/next is the series' episode order as the
 * server returned it (`seriesState.ts`), the same order `SeriesWindow` lists.
 * `null` at either end, so the caller disables that control instead of
 * wrapping around: wrapping from the last lecture of a term back to the first
 * is not what "next" means to someone working through a series.
 *
 * `currentId` not in the list yields `{previous: null, next: null}` rather than
 * guessing a position. That is a real state, not a defensive nicety: the series
 * list is fetched asynchronously and paginated, so the open episode genuinely
 * is not in it yet on the first frames after an episode change, and may sit
 * beyond the first page. Both controls being disabled for that moment is the
 * honest rendering; a fallback to "index 0" would make the first click jump
 * somewhere arbitrary.
 *
 * A duplicate id (should not happen; the API keys episodes by id) resolves
 * against its FIRST occurrence, so the result is at least deterministic.
 *
 * Generic over `{ id }` rather than fixed to `Episode` so it can be tested on
 * plain literals and reused for any id-keyed list.
 */
export function adjacentEpisodes<T extends { id: string }>(episodes: T[], currentId: string): Adjacent<T> {
  const index = episodes.findIndex((e) => e.id === currentId)
  if (index < 0) return { previous: null, next: null }
  return {
    previous: index > 0 ? episodes[index - 1] : null,
    next: index < episodes.length - 1 ? episodes[index + 1] : null,
  }
}

/**
 * The episodes of a series that actually have something to play, i.e. the ones
 * `libraryState.ts`'s `toEpisodeTile` would mark `playable`.
 *
 * The previous/next controls step through THIS list, not the raw one: a
 * recording with no eligible engage-download video track opens into a player
 * with no video windows at all, which as the destination of a deliberate
 * „Weiter" click reads as a broken control rather than as information. The
 * library's own tiles make the same distinction (a non-playable tile is shown
 * but never opened); the difference is that a tile can say „nicht abspielbar"
 * next to itself and a next-button cannot.
 */
export function playableEpisodes(episodes: Episode[]): Episode[] {
  return episodes.filter((e) => selectStreams(e.tracks).length > 0)
}

/**
 * Whether the previous/next controls still need another page of the series
 * before they can answer honestly - i.e. whether the caller should call
 * `seriesState`'s `loadMore()`.
 *
 * ## The bug this exists for (review round, I3)
 *
 * `seriesState` pages at 12, and only page 1 is fetched on arrival. Without
 * this, `adjacentEpisodes` was being asked about a list that stops at 12 and
 * answering `null` with total confidence, so:
 * - the 12th recording of a 20-part series rendered as the END of the series
 *   („Weiter" greyed out, with eight more lectures sitting on page 2), and
 * - a recording that is itself ON page 2 - reachable through the library's own
 *   „Mehr laden", or a deep link - was not in the fetched list at all, so BOTH
 *   controls were disabled forever.
 *
 * Both were silent: a disabled button looks exactly like the honest end of a
 * series. Neither the fetched list nor `hasMore` was wrong; nothing was asking
 * for the next page.
 *
 * ## Why this shape
 *
 * A predicate the caller re-evaluates, rather than "load the next page when the
 * button is pressed". Paging on press would mean a button that is enabled but
 * does nothing for a moment, and it could not fix the second case at all
 * (nothing to press - both controls are disabled). Driving it from state
 * instead converges: each page that arrives is a fresh answer, so the loop runs
 * until either the open recording has a playable successor in hand or the
 * server says there is nothing left (`hasMore` false). The controls stay a pure
 * function of the fetched list, and their brief disabled state while a page is
 * in flight is the same honest "not known yet" that
 * `adjacentEpisodes` already documents.
 *
 * `loading` is part of the predicate, not the caller's problem: it is what
 * keeps the convergence from firing a second request for the same page while
 * the first is in flight (`seriesState.loadMore` would refuse anyway, but a
 * predicate that says "yes" while a fetch is running invites a render loop).
 *
 * Returns false once the open recording is fetched and has a playable
 * successor, and false for a recording that is fetched but has nothing playable
 * itself - there is no neighbourhood to complete for it, so paging the whole
 * series to discover that would be pointless traffic.
 */
export function needsMoreEpisodes(
  fetched: Episode[],
  currentId: string,
  hasMore: boolean,
  loading: boolean,
): boolean {
  if (!hasMore || loading) return false
  // Not fetched yet at all: the neighbourhood is unknown, so keep paging - this
  // is the "open recording is on page 2" case.
  if (!fetched.some((e) => e.id === currentId)) return true
  const playable = playableEpisodes(fetched)
  // Fetched, but not playable itself: prev/next have no meaning here (the
  // controls step through the playable list), so stop.
  if (!playable.some((e) => e.id === currentId)) return false
  // Fetched and playable, but nothing playable after it - the successor may be
  // on the next page. This is the "12th of 20" case, and also covers a tail of
  // unplayable recordings at the end of the fetched list.
  return adjacentEpisodes(playable, currentId).next === null
}

/**
 * The non-video windows of player mode - Kapitel, Transkript, Reihe, Info - as
 * far as anything OUTSIDE them needs to know: their shell ids, and what a
 * button that toggles one has to do.
 *
 * ## Why they start closed
 *
 * „Am Start nur die Videofenster einblenden und das moeglichst gross." Opening
 * a recording used to put five or six panels on the shell at once, which both
 * buried the video and capped how large it could be
 * (`videoWindowState.ts`'s sizing). So player mode now opens showing the video
 * and nothing else.
 *
 * ## ...as CLOSED windows, not as unmounted ones
 *
 * The mechanism matters. A closed sphere-shell window keeps its registration
 * and therefore keeps its DOCK TILE - the affordance the user already validated
 * in step 1 ("ja geschlossene Fenster im Moment mit ins Dock nehmen"), and the
 * shell's own answer to "where did my window go". Mounting the panels only on
 * demand would have no tile, so the only way back would be a button somewhere
 * else, invented for the purpose - and a window that is not registered cannot
 * be restored, arranged, or saved in a layout either. Closing them costs one
 * registered-but-hidden window each (`<Window>` renders nothing when closed)
 * and buys the whole existing restore path for free.
 *
 * The three panels that also carry their own DATA gate (Kapitel needs segments,
 * Transkript needs cues, Reihe needs a series - see `panelWindowAvailable`) are
 * unaffected: they register nothing when they have nothing to show, so there is
 * nothing to close and no tile - which is right.
 *
 * ## ...and which of them actually GET a tile
 *
 * Only Kapitel. Reihe, Info and Transkript each have a control of their own in
 * the dock - the breadcrumb's last crumb, the „i" button and the „Transkript"
 * button - so they pass `dockTile={false}` to `<Window>` and the tiles strip
 * leaves them out („Fuer Fenster die einen Button im Dock haben keine
 * Platzhalter der Fenster im Dock anzeigen", and then „Fuer das Transcription
 * Fenster bitte auch noch einen Button ins Dock, statt des Fenster
 * Platzhalters"). Kapitel has no such button - it is also the one panel most
 * recordings do not have at all - so its tile is its only way back and stays.
 *
 * That is why `togglePanel` in `DockTransport.tsx` has to go through the
 * shell's `restore` rather than anything narrower: for those three windows it
 * is the ONLY thing that can bring them back from closed, which is exactly the
 * contract `WindowProps.dockTile` documents.
 *
 * ## Who does the closing, and who does the opening
 *
 * The SHELL owns open/closed, always (see `PlayerStore.closeStream`'s doc
 * comment for the same rule on the video side, and what happens when it is
 * broken). So the start-closed step calls `shellStore.close(id)` once per mount
 * and every toggle goes through `shellStore.restore`/`close` - never through a
 * player-store field mirroring "is the panel open", which would immediately
 * disagree with the dock tile the user just clicked.
 */

/** The shell window ids of the four panel windows. Each is the literal `id` its component passes to `<Window>`. */
export const PANEL_WINDOW_IDS = {
  chapters: 'chapters',
  transcript: 'transcript',
  series: 'series',
  /**
   * The metadata window. Its id is still „controls" - the window was renamed
   * „Info" in the previous round but its id was left alone, because the id is
   * what a saved layout refers to and renaming it would silently drop the
   * window's saved position for anyone who had one.
   */
  info: 'controls',
} as const

export type PanelWindowId = (typeof PANEL_WINDOW_IDS)[keyof typeof PANEL_WINDOW_IDS]

/** What a toggle button must do to a panel window, given the shell's current entry for it. */
export type PanelToggleAction = 'restore' | 'close'

/**
 * Whether pressing the dock's button for a panel window should bring it back or
 * put it away.
 *
 * `undefined` (the window is not registered - it is gated off by its own data,
 * or has not mounted yet) answers `'restore'`, which is a harmless no-op
 * against the shell store. The alternative - answering `'close'` - would be a
 * no-op too, but it would also mean the FIRST press of a button for a
 * momentarily-unregistered window did nothing visible and the second one
 * worked, which is exactly the kind of one-off dead click that reads as broken
 * hit-testing.
 *
 * A MINIMIZED panel is restored rather than closed, for the same reason: the
 * user pressing „Reihe" wants to see the series, and both hidden states are the
 * same request from where they are standing. `restore` clears both flags in one
 * call, so there is no two-step here.
 */
export function panelToggleAction(
  shell: { closed: boolean; minimized: boolean } | undefined,
): PanelToggleAction {
  if (shell === undefined) return 'restore'
  return shell.closed || shell.minimized ? 'restore' : 'close'
}

/** What the open recording offers, as far as the panel windows care. */
export interface PanelData {
  /** `episode.segments.length` - the OCR chapter marks. */
  segmentCount: number
  /** `cues.length` - the parsed caption cues. */
  cueCount: number
  /** `episode.seriesId != null`. */
  hasSeries: boolean
}

/**
 * Whether a panel window EXISTS for the open recording at all.
 *
 * ## Why this is one shared predicate and not a check per component
 *
 * Three of the four panels are gated on the recording's own data, and each one
 * used to spell its gate out where it happened to be needed. That is exactly how
 * the code review found a dead control: the dock's new „Transkript" button
 * rendered fully live for a recording with no captions, while `TranscriptWindow`
 * - holding the same rule in its own `return null` - had never registered the
 * window. Pressing the button then did nothing at all, silently, forever, which
 * is worse than the button not being there: before it existed, an uncaptioned
 * recording showed no affordance and told no lie.
 *
 * The gate and its consumers now read from one place, so a button cannot outlive
 * its window again. `Info` is deliberately in the table too, answering `true`
 * unconditionally: player mode always has an episode (see `store.ts`'s
 * `openEpisode`, which sets `mode` and `episode` in the same `set()`), and
 * stating that here is what keeps "which panels can be gated off" a complete,
 * reviewable list rather than three scattered conditions plus an assumption.
 *
 * Counts are compared with `> 0`, so a `NaN` or a negative from a malformed
 * payload reads as "not available" rather than as "available" - the safe
 * direction, since the window's own render would then have nothing to show.
 *
 * `data` is PARTIAL so that a caller can answer only the question it is asking:
 * the dock has the whole open recording in hand and passes all three fields,
 * while a window checking its own precondition has just its own (a component
 * inventing `hasSeries: false` to ask about cues would be noise, and the next
 * reader would have to work out that it does not matter). A field left out
 * counts as absent, i.e. "not available" - the same safe direction.
 */
export function panelWindowAvailable(id: PanelWindowId, data: Partial<PanelData>): boolean {
  switch (id) {
    case PANEL_WINDOW_IDS.chapters:
      return (data.segmentCount ?? 0) > 0
    case PANEL_WINDOW_IDS.transcript:
      return (data.cueCount ?? 0) > 0
    case PANEL_WINDOW_IDS.series:
      return data.hasSeries === true
    case PANEL_WINDOW_IDS.info:
      return true
  }
}

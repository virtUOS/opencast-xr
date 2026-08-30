/**
 * The tutorial tour's content: which dock controls each step points at, and
 * what it says about them - in the order it walks a first-time visitor
 * through the controller bindings and then the dock, left to right.
 *
 * ## Why control ids, not indices
 *
 * `DockTransport.tsx` renders each of these controls once, and a tour step
 * has to say which one(s) it is currently explaining so the dock can light
 * them up. A step referring to "the 3rd button in row 2" would silently point
 * at the wrong control the moment that row's contents change (the caption
 * size/position buttons already appear and disappear depending on whether
 * captions are on - see that file's own doc comment). A stable string id per
 * control, defined once here and consumed by both this module's step data and
 * `DockTransport.tsx`'s render, cannot drift that way - renaming a control's
 * position in the row does not change what a tour step highlights.
 *
 * Not every control the tour explains has an id here: the Kapitel window's
 * dock TILE and the shell's own `...`-menu/exit-X are not this app's
 * `IconButton`s at all (see `panelWindows.ts`'s doc comment on which panels
 * get a dock button versus a tile, and `DockTransport.tsx`'s doc comment on
 * what the shell renders outside the app's slot). Neither can be highlighted
 * from here, so the steps that mention them (`panels`, `menu`) simply carry
 * fewer - or, for `menu`, zero - ids; the bubble's own text still explains
 * them, it just cannot draw a box around them.
 */
export const TOUR_CONTROL_IDS = {
  playPause: 'transport.playPause',
  timeline: 'transport.timeline',
  breadcrumb: 'transport.breadcrumb',
  previousEpisode: 'transport.previousEpisode',
  nextEpisode: 'transport.nextEpisode',
  captionsToggle: 'transport.captionsToggle',
  captionSmaller: 'transport.captionSmaller',
  captionLarger: 'transport.captionLarger',
  captionUp: 'transport.captionUp',
  captionDown: 'transport.captionDown',
  mute: 'transport.mute',
  volumeDown: 'transport.volumeDown',
  volumeUp: 'transport.volumeUp',
  transcript: 'transport.transcript',
  info: 'transport.info',
} as const

export type TourControlId = (typeof TOUR_CONTROL_IDS)[keyof typeof TOUR_CONTROL_IDS]

/**
 * The four physical face buttons a Quest Touch controller pair actually has -
 * see `badgeHand` below for which controller each one sits on. Rendered by
 * `TourBubble.tsx` as a round badge, at the user's request: „Kann man bei dem
 * Stick und den Tasten eine etwas physischere Darstellung nutzen? Also A, B,
 * X, Y in einen Kreis setzen, dass es den Buttons ähnlicher sieht ... Vielen
 * ist leider die Quest noch sehr fremd."
 */
export type TourBadgeId = 'A' | 'B' | 'X' | 'Y'

/**
 * Which physical Quest controller a badge sits on - `A`/`B` are the RIGHT
 * controller's face buttons, `X`/`Y` the LEFT's. Pulled out as its own pure,
 * tested function (rather than inlined at each badge's render site) because
 * it's a fact about the real hardware, not a rendering choice - and because
 * `TourBubble.tsx` uses it to pick each badge's colour (the user's „Color-hint
 * per Quest reality" ask), which has to agree with the fact everywhere it's
 * drawn.
 */
export function badgeHand(id: TourBadgeId): 'links' | 'rechts' {
  return id === 'A' || id === 'B' ? 'rechts' : 'links'
}

/**
 * Which uikit-lucide glyph a controller-binding line leads with, as a
 * symbolic key rather than a component reference - this module stays
 * render-agnostic (no `@react-three/uikit`/`-lucide` import here at all;
 * `TourBubble.tsx` is the one place that maps a key to an actual icon), the
 * same "pure content, thin render" split `timelineDrag.ts`/`DockTransport.tsx`
 * already use. `'trigger'` is the controller trigger (point-and-click);
 * `'stick'` is either analog stick - the user's feedback didn't ask the two
 * to look different from one another, only for a stick to be recognisable as
 * one at all („Und vielleicht ein Icon für den Stick").
 */
export type TourIconId = 'trigger' | 'stick'

/**
 * One line of a controller-binding step's body: either plain prose (a
 * `string`, rendered exactly like any other step's line), or a structured
 * row that leads with a physical badge and/or a controller-glyph icon before
 * its own text - the „physischere Darstellung" the user asked for. Only the
 * `controller` step's `lines` actually contains the latter today; every other
 * step's lines are all plain strings, which this union still accepts (a
 * `string` is a valid `TourStepLine`) - so no other step's data had to
 * change shape at all.
 */
export interface TourBindingRow {
  /** Physical button badges leading the row, in order - e.g. `['A', 'X']` for a line that names both. Omitted (or empty) for an icon-only row. */
  badges?: readonly TourBadgeId[]
  /** The controller glyph leading the row - omitted for a badge-only row (the badge letter already says which button, with no icon needed alongside it). */
  icon?: TourIconId
  /** The row's own sentence - same plain-ASCII-plus-umlauts rule as every other line (see `TourStep.lines`'s doc comment). */
  text: string
}

export type TourStepLine = string | TourBindingRow

/** A line's own text, regardless of which of `TourStepLine`'s two shapes it is - used by the tests below, and available to any renderer that only needs the words. */
export function tourLineText(line: TourStepLine): string {
  return typeof line === 'string' ? line : line.text
}

export interface TourStep {
  /** Stable, for tests and React `key`s - not shown to the viewer. */
  id: string
  /**
   * The bubble's own body, one short sentence (or list item) per entry. Kept
   * as plain ASCII plus umlauts/`ß` throughout - see `docs/UIKIT-NOTES.md`
   * entry 3: this text is rendered by the same installed uikit font that is
   * missing several typographic-punctuation glyphs (‹, the middle dot, an
   * ellipsis, a bullet, an arrow, en dash), so it avoids all of them, exactly
   * like every other in-scene string in this app. See `TourStepLine` for the
   * two shapes an entry can take.
   */
  lines: readonly TourStepLine[]
  /** Rendered as a "- " prefixed list rather than plain paragraphs - only step 1 needs it (the controller/window bindings read as a reference list, not prose). A structured `TourBindingRow` line renders its own badge/icon as the "look here" marker instead of a leading dash - see `TourBubble.tsx`. */
  bullet?: boolean
  /** Which dock controls to highlight while this step is showing - see the doc comment above for why some steps have none. */
  highlightIds: readonly TourControlId[]
}

/**
 * The tour, in the order agreed with the user: controller bindings first
 * (the thing a VR visitor cannot see written down anywhere else), then the
 * dock left to right.
 */
export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'controller',
    bullet: true,
    lines: [
      { icon: 'trigger', text: 'Trigger: zeigen und klicken.' },
      { icon: 'stick', text: 'Linker Stick links/rechts: spulen - je staerker ausgelenkt, desto schneller.' },
      { icon: 'stick', text: 'Linker Stick hoch/runter: einen Kapitel-Sprung auslösen.' },
      // The clarifying line the user asked for („Vielen ist leider die Quest
      // noch sehr fremd") sits right before the badges start appearing, so
      // the mapping is known before it's used rather than after.
      'A und B liegen am rechten Controller, X und Y am linken.',
      { badges: ['A', 'X'], text: 'A oder X: Wiedergabe/Pause.' },
      { badges: ['B'], text: 'B gedrückt halten: Ansicht neu zentrieren - der Ring füllt sich.' },
      { icon: 'stick', text: 'Rechter Stick: Ansicht drehen.' },
      'Fenster: am Titelbalken greifen und verschieben - sie rasten aneinander ein. An der Ecke ziehen, um die Größe zu ändern.',
    ],
    highlightIds: [],
  },
  {
    id: 'transport',
    lines: [
      'Der große Knopf spielt ab oder pausiert.',
      'Auf der Zeitleiste springt ein Klick direkt an die Stelle, Ziehen spult weiter. Striche markieren Kapitel, beim Zeigen erscheint eine Vorschau.',
    ],
    highlightIds: [TOUR_CONTROL_IDS.playPause, TOUR_CONTROL_IDS.timeline],
  },
  {
    id: 'navigation',
    lines: [
      'Home bringt dich zurück zur Bibliothek. Der Reihen-Krümel öffnet die Bibliothek direkt bei dieser Reihe.',
      'Die Pfeile daneben springen zur vorherigen/nächsten Aufzeichnung der Reihe.',
      'Ein Klick auf den Namen der aktuellen Aufzeichnung öffnet das Reihen-Fenster mit allen Aufzeichnungen.',
    ],
    highlightIds: [
      TOUR_CONTROL_IDS.breadcrumb,
      TOUR_CONTROL_IDS.previousEpisode,
      TOUR_CONTROL_IDS.nextEpisode,
    ],
  },
  {
    id: 'captions',
    lines: [
      'CC schaltet Untertitel an oder aus.',
      'Größe (Minus/Plus) und Höhe (Pfeil hoch/runter) sind nur sichtbar, während Untertitel aktiv sind.',
    ],
    highlightIds: [
      TOUR_CONTROL_IDS.captionsToggle,
      TOUR_CONTROL_IDS.captionSmaller,
      TOUR_CONTROL_IDS.captionLarger,
      TOUR_CONTROL_IDS.captionUp,
      TOUR_CONTROL_IDS.captionDown,
    ],
  },
  {
    id: 'audio',
    lines: [
      'Stumm schaltet den Ton komplett aus.',
      'Lautstärke in 10 %-Schritten regeln - der Wert bleibt sichtbar, auch wenn stumm geschaltet ist.',
    ],
    highlightIds: [TOUR_CONTROL_IDS.mute, TOUR_CONTROL_IDS.volumeDown, TOUR_CONTROL_IDS.volumeUp],
  },
  {
    id: 'panels',
    lines: [
      'Die Kapitel-Kachel im Dock öffnet die Kapitelliste. Ein Klick auf ein Vorschaubild springt im Video an diese Stelle.',
      'Transkript zeigt den Mitschnitt als Text. Ein Klick auf eine Zeile springt an diese Stelle im Video.',
      'Info zeigt Titel, Beschreibung und weitere Angaben zur Aufzeichnung.',
    ],
    highlightIds: [TOUR_CONTROL_IDS.transcript, TOUR_CONTROL_IDS.info],
  },
  {
    id: 'menu',
    lines: [
      'Rechts außen: das ...-Menü (Anordnen, Zentrieren, Gewölbt/Flach, Hintergrund) und das rote X, um die Sitzung zu verlassen.',
    ],
    highlightIds: [],
  },
]

> This design spec originated in the `OpencastXR` monorepo
> (`docs/superpowers/specs/2026-08-23-opencast-player-design.md`) and is
> reproduced here unchanged as a historical record; monorepo-relative paths
> and references within it were not updated for the standalone repository.

# Design: OpencastXR Player — VR-Vorlesungsplayer auf sphere-shell

**Datum:** 2026-08-23
**Status:** Umgesetzt (v1). Alle 16 Aufgaben des Plans sind abgeschlossen; die Definition of Done (§11) und die Fehlerfälle (§9) sind im Magic Window gegen `develop.opencast.org` nachgewiesen (Belege: `.superpowers/sdd/2026-08-23-opencast-player/task-16-report.md`). Offen ist ausschließlich die Abnahme auf der Quest 3 — Checkliste: `docs/QUEST-VALIDATION-PLAYER.md`.
**Kontext:** Schritt 2 des OpencastXR-Projekts. Baut auf `sphere-shell@0.2.0` auf (Schritt 1, released: npm + GitHub + Uni-GitLab, Quest-3-validiert).

## 1. Ziel und Zweck

Eine WebXR-Anwendung zum Ansehen von Opencast-Vorlesungsaufzeichnungen auf der Quest 3 (immersiv) und im Browser (Magic Window). Zwei Modi auf derselben sphärischen Leinwand:

- **Browse:** Navigation durch die auf dem Server verfügbaren Aufzeichnungen (Serien und serienlose Einzelaufzeichnungen).
- **Player:** Synchronisierte Wiedergabe aller Video-Tracks einer Episode als einzelne Fenster, dazu Kapitel (Folien-Segmente mit OCR-Text), mitlaufendes Transkript, blickfeste Untertitel (HUD), Episodenwechsel innerhalb der Serie, Transportsteuerung.

## 2. Nicht-Ziele (v1)

- **Keine Anmeldung** — nur öffentliche Aufzeichnungen, anonym. Auth (Session-Cookie, LTI, JWT) kommt später; die Datenschicht sieht die Haken dafür aber von Anfang an vor (§6).
- **Keine Quizzes** — kein Standard-Opencast-Datenlieferant. v2-Kandidaten laut Nutzer: Opencast „Interactive Video"-Bereich, ggf. Abstimmungswerkzeug. Das Fensterverhalten (zeitgesteuertes Einblenden) ist mit sphere-shell trivial nachrüstbar.
- **Kein HLS/Adaptive Streaming** — v1 nutzt progressive `engage-download`-MP4s. HLS ist ein späterer Baustein (Track-Auswahl ist darauf vorbereitet, weil sie ohnehin pro Flavor eine Quelle wählt).
- **Keine External API** (`/api/…`) — nur Search/Engage-API, Entscheidung des Nutzers.
- **Kein interaktives head-locked UI** — Zeitstrahl bewusst NICHT blickfest (Nutzer-Entscheidung nach Empfehlung, siehe §8): Zielen auf mitbewegte UI ist ein VR-Anti-Pattern.
- **Keine Untertitel-Einblendung im Videobild** — Untertitel laufen im HUD, das Transkript im eigenen Fenster.
- **Kein Passthrough (v1)** — der Player betritt immer `immersive-vr`, also schwarzer Hintergrund, und hat anders als die Demo keinen Hintergrund-Umschalter. Die Bausteine dafür liegen bereit (`sphere-shell` 0.2.0 kann Passthrough, `useXRSession().mode` meldet den beobachteten Modus), aber WebXR erlaubt keinen Moduswechsel innerhalb einer Session: der Umschalter müsste die Session beenden und neu starten. Nachrüsten ist ein v2-Kandidat, siehe `docs/QUEST-VALIDATION-PLAYER.md` §4 („Passthrough" — ausdrücklich als Feature-Wunsch, nicht als Fehler, in die Abnahme aufgenommen).

## 3. Zielserver und geerbte Randbedingungen

- **Entwicklungs-/Testserver:** `https://develop.opencast.org` — verifiziert: CORS vollständig offen (beliebige Origins, Credentials erlaubt), Search-API anonym nutzbar, öffentliche Inhalte vorhanden (Blender-Foundation-Filme). Server-URL ist konfigurierbar.
- Aus Schritt 1 geerbt und einzuhalten:
  - Video-Elemente müssen DOM-angehängt sein (Chrome pausiert sonst unsichtbare Videos).
  - uikit 1.0.74 rendert Scroll-Spalten mit vielen umbrochenen Zeilen leer → Transkript-Fenster rendert Cues als EINZELNE kurze Text-Knoten (ein Cue = ein Block, Cues sind naturgemäß kurz); lange Cue-Texte werden defensiv hart umbrochen. Beobachtung im Abnahmetest.
  - Dock-Steckplatz (`dockControls`) ist der Ort für App-Steuerelemente.
  - `VideoSurface` steuert nie Playback — Playback gehört vollständig der App.
  - Quest-Budget: zwei parallele 1080p-Streams validiert.

## 4. Architektur

`apps/opencast-player` — neue Vite/React-App im Monorepo (Ansatz A aus dem Brainstorming), drei Schichten, die beiden unteren React-frei:

```
apps/opencast-player/src/
├── opencast/     Datenschicht: Search-API-Client, Modelle, Track-Auswahl,
│                 VTT-Parser, Auth-/Asset-URL-Haken (React-frei, fixture-getestet)
├── player/       Sync-Engine (Master/Slave, Drift, Stall, Master-Wechsel,
│                 dynamische Streams) + App-Store (zustand): mode, episode,
│                 subtitles on/off … (React-frei bzw. hook-getestet)
└── windows/      sphere-shell-Fenster: Bibliothek, Video, Kapitel, Transkript,
                  Serie, Steuerung; Dock-Steckplatz-Inhalte; HUD-Einbindung
```

Parallel dazu **sphere-shell v0.3.0**: eine neue Komponente `<HeadLocked>` (§8) — die einzige Bibliotheksänderung.

## 5. Die zwei Modi (Fenster-Sets)

**Browse:** Ein „Bibliothek"-Fenster (~50°) mittig. Ebene 1: Serien als Kachelliste (Titel, Episodenzahl, Vorschaubild) **plus Gruppe „Einzelaufzeichnungen"** für Episoden ohne Serie (die Search-API liefert sie gleichberechtigt; Gruppierung clientseitig). Ebene 2 (nach Serien-Klick): Episodenliste (Vorschaubild, Titel, Dauer, Datum), Zurück-Navigation, Nachladen per `limit/offset`-Pagination. Episoden ohne ladbare MP4-Tracks werden markiert statt ausgeblendet. Klick auf Episode → Player.

**Player:** Pro **Flavor** der Episode ein Video-Fenster (§6 Track-Auswahl). Startlayout: presenter und presentation groß und mittig, weitere Flavors (audience/*, beliebige Betreiber-Bezeichner) daneben; dazu Kapitel-Fenster (links), Transkript (rechts), Serie (außen; entfällt bei serienlosen Episoden) und ein Steuerungs-Fenster für die selteneren Regler: Lautstärke, Untertitel-Schalter, Anzeige der Episoden-Metadaten. Die häufig gebrauchte Transportsteuerung liegt im Dock-Steckplatz: Play/Pause, Zeitstrahl (§8), „Zur Bibliothek". Alle Fenster frei beweglich/minimierbar/schließbar wie gewohnt — mit den Playback-Sonderregeln aus §7.

**Nachtrag (Nutzer-Feedback-Runde, nach der ersten Browser-Erprobung — dies ist der SHIPPED-Stand):** Das Steuerungs-Fenster hat seine Regler verloren und heißt jetzt „Info" — es zeigt nur noch Metadaten (plus den Untertitel-Hinweis aus §9). Lautstärke **und** Untertitel-Schalter liegen im Dock, dazu neu: **Stummschaltung** (eigener Engine-Zustand, nicht „Lautstärke 0") und **Untertitel-Größe** (S/M/L; ein Faktor auf die Design-Pixel der Untertitel-Tafel — Schriftgröße, Innenabstand, Radius und Maximalbreite gemeinsam, also eine gleichförmige Skalierung ohne Neuumbruch; das Seek-Feedback im selben HUD bleibt bewusst fest. Standard browser-first neu justiert, weil die vorige Größe nicht ins Browserfenster passte). Der Dock-Steckplatz hat dafür **zwei Zeilen**: Zeile 1 Transport + Ton + Untertitel, Zeile 2 ein Brotkrumen-Pfad `Home > Reihe > Aufzeichnung` und Vor/Zurück zur Nachbar-Aufzeichnung der Reihe. **„Zur Bibliothek" als eigener Knopf ist entfallen** — die `Home`-Krume tut dasselbe; die `Reihe`-Krume öffnet die Bibliothek direkt auf Ebene 2 dieser Reihe (neuer Store-Einmal-Zustand `browseTarget`). Vor/Zurück respektiert §7: der Episodenwechsel startet nie von selbst.

Der Moduswechsel ist reines Mounten/Unmounten von Fenster-Sets; Layouts deklarativ über sphere-shells `initialLayout`/`arrange`.

## 6. Datenschicht (`opencast/`)

- `listSeries()` → `/search/series.json`; `listEpisodes({ sid?, limit, offset })` und `getEpisode(id)` → `/search/episode.json`. Übersetzung in schlanke Modelle: `Episode { id, title, seriesId?, seriesTitle?, duration, created, tracks[], previewUrl, segments[], captions[] }`.
- **Track-Auswahl** (reine Funktion): gruppiert nach Flavor-Typ **generisch** — was immer der Betreiber vergibt (presenter/*, presentation/*, audience/*, …) wird je ein Kandidat; nur `engage-download`-getaggte MP4s; pro Flavor die höchste Auflösung ≤1080p (Quest-Budget). Fixtures: echte develop-Antworten PLUS konstruierte Mehr-Flavor-/Mehr-Qualitäts-Fälle (develop-Demodaten haben das laut Nutzer nicht).
- **Segmente:** direkt aus der Search-Antwort (Zeit, Dauer, OCR-Text, Vorschaubild-URL) → Kapitel-Fenster.
- **Untertitel:** WebVTT aus den Publikationen (Captions-Flavor); eigener kleiner Parser → `Cue[] { start, end, text }`. Eine Quelle, zwei Abnehmer: HUD und Transkript. Untertitel gelten episodenweit (nicht pro Video) — Vorgabe des Nutzers.
- **Auth-Vorsorge (JWT/Tobira-Hinweis des Nutzers):** `<video>`/Bild-Elemente können keine Header setzen — geschützte Assets laufen über URL-Parameter oder Cookies. Deshalb zwei Haken ab v1, beide zunächst Identität: `authorize(request)` für API-Aufrufe, `resolveAssetUrl(url)` für alle Medien-/Bild-URLs. Spätere JWT-/LTI-Integration füllt nur diese Stelle.

## 7. Sync-Engine (`player/`)

Master-Slave mit dynamischer Stream-Menge; reine TS-Zustandsmaschine gegen eine schmale Video-Schnittstelle (currentTime, playbackRate, paused, readyState, play/pause/seek) — vollständig mit Fakes testbar.

- **Master:** bevorzugt presenter/*, sonst presentation/*, sonst erster verbleibender. Der Master trägt den Ton (alle anderen gemutet).
- **Drift pro Tick:** < 0,05 s ignorieren; 0,05–0,5 s → playbackRate des Nachzüglers 0,95–1,05 bis aufgeholt; > 0,5 s → seek.
- **Stall:** irgendein Stream `waiting` → alle pausieren, bis `canplay`.
- **Fenster schließen = Stream abmelden** (Nutzer-Anforderung, auch aus Performance-Gründen): Video-Element wird wirklich entladen (src entfernt, Element verworfen) — keine Bandbreite, keine Decoder-Last. **Schließt der Nutzer den Master, wählt die Engine nahtlos einen neuen** (Vorzugsreihenfolge wie oben), der Ton wandert mit.
- **Wiederherstellen** (Dock-Kachel): Element neu erzeugen, auf Master-Zeit seeken, wieder anmelden.
- **Letzter Stream ist unschließbar** (`closable` dynamisch) — ohne Stream kein Player.
- **Bedienung** (Play/Pause/Seek aus Dock, Zeitstrahl, Kapiteln, Transkript) geht ausschließlich an die Engine; Wiedergabe startet nur auf Nutzer-Geste, nie automatisch beim Episodenwechsel.

## 8. HUD: `<HeadLocked>` (sphere-shell v0.3.0) und der Zeitstrahl

- **`<HeadLocked>`**: hält uikit-Inhalt blickfest per **lazy follow** — gedämpftes Nachziehen (Zeitkonstante ~0,3 s) statt hartem Ankleben (Komfort, kein Zittern); Default ~15° unter Blickmitte, feste Distanz; Pitch-Mitführung begrenzt (±40°), damit es beim Bodenblick lesbar stehen bleibt. Identisches Verhalten im Magic Window (effektiv bildschirmfest unten). Render-Order: eigenes Band über Fenstern/Dock, unter dem XR-Zeiger. Follow-Mathematik als reine, getestete `core/`-Funktion; Komponente nur Verdrahtung.
- **Nutzung im Player:** (a) Untertitel-Cues, wenn eingeschaltet (Schalter in Steuerung/Dock); (b) **nicht-interaktives** Seek-Feedback: Während am Zeitstrahl gezogen wird, zeigt das HUD Zeitposition und Kapiteltitel an der Zielstelle.
- **Zeitstrahl: im Dock, NICHT blickfest** (Entscheidung des Nutzers nach Empfehlung): interaktive head-locked UI ist ein Ziel-Anti-Pattern — beim Zielen bewegt sich das Ziel mit dem Kopf. Das Dock ist ankerfest, gut zielbar und per Rezentrieren sofort wieder vor dem Nutzer.

## 9. Fehlerfälle

- Server nicht erreichbar / CORS verweigert → Bibliothek zeigt die konkrete Ursache lesbar an (Diagnose-Philosophie aus der Demo) + Wiederholen.
- Episode ohne ladbare Tracks → in der Liste markiert; kein leerer Player.
- Keine Captions → Transkript-Fenster erscheint nicht. Keine Segmente → kein Kapitel-Fenster. **Abweichung (bewusst, umgesetzt):** der Untertitel-Schalter im Steuerungs-Fenster wird nicht ausgeblendet, sondern deaktiviert dargestellt (ausgegraut, kein Hover-Effekt, Klick ohne Wirkung) und mit dem Hinweis „Keine Untertitel für diese Aufzeichnung verfügbar." beschriftet. Grund: ein ganz fehlender Schalter ist von einem übersehenen nicht zu unterscheiden — der Hinweis beantwortet „warum sehe ich keine Untertitel?" an genau der Stelle, an der die Frage entsteht. Das Transkript-Fenster verschwindet dagegen wirklich, weil es ohne Cues nur ein leerer Rahmen wäre.
- Stream-Fehler während der Wiedergabe → Engine pausiert alle; betroffenes Fenster zeigt Fehlerkachel mit Neuladen. Der gescheiterte Stream wird dabei **aus der Sync-Engine abgemeldet** (Fenster und Element bleiben, `open` bleibt `true`): ein totes Element kommt nie über `readyState` 0 hinaus und würde als „puffert noch" die gesamte Wiedergabe blockieren. Die übrigen Streams laufen nach einer Nutzer-Geste weiter, „Neu laden" meldet den Stream wieder an. Bei Einzel-Flavor-Aufzeichnungen (der Normalfall) nennt die Kachel zusätzlich den Ausweg „Home" (bis zur Nutzer-Feedback-Runde: „Bibliothek" — der Knopf existiert nicht mehr, siehe Nachtrag zu §5), weil das ✕ des letzten Streams per Veto wirkungslos ist.
- Autoplay-Politik: erste Wiedergabe immer per Nutzer-Geste.

## 10. Teststrategie

1. **Datenschicht:** Fixtures aus aufgezeichneten develop-Antworten + konstruierte Mehr-Flavor-/Qualitäts-/JWT-Hook-Fälle; VTT-Parser mit echten und defekten Dateien.
2. **Sync-Engine:** Fake-Videos/-Uhren; Drift-Bänder, Stall, Master-Wechsel bei Schließen, Wiederanmelden mit Seek, Verteilung der Bedienbefehle, Unschließbarkeits-Regel.
3. **Store/Modi:** Hook-Tests (Browse↔Player, Episodenwechsel, Untertitel-Schalter).
4. **`<HeadLocked>`:** Follow-Mathematik als Unit-Tests (Dämpfung, Pitch-Grenzen); Rendering per etablierter Desktop-Pixel-Verifikation.
5. **Abnahme:** Quest-3-Checkliste (Erweiterung von docs/QUEST-VALIDATION.md), inkl. Master-schließen-Szenario, Wiederherstellen, HUD-Lesbarkeit bei Kopfbewegung, Seek-Feedback.

## 11. Definition of Done (v1)

Auf Quest 3 **und** im Magic Window:

- develop.opencast.org anonym durchstöbern: Serien **und** Einzelaufzeichnungen, Pagination, Vorschaubilder
- Episode öffnen: alle vorhandenen Flavors als Fenster, synchron (Drift nach Korrektur < 100 ms)
- Kapitel-Sprünge (Segment-Klick), mitlaufendes + klickbares Transkript
- HUD-Untertitel zuschaltbar, lesbar bei beliebiger Kopfbewegung
- Episodenwechsel innerhalb der Serie aus dem Serien-Fenster
- Video-Fenster schließen → kein Laden im Hintergrund; Master schließen → nahtloser Master-/Ton-Wechsel; Wiederherstellen → synchroner Wiedereinstieg
- Zeitstrahl-Seek aus dem Dock mit HUD-Feedback
- Stabile 72 Hz mit zwei 1080p-Streams

## 12. Entscheidungs-Log (Brainstorming 2026-08-23)

| Frage | Entscheidung |
|---|---|
| Server / API / Auth | develop.opencast.org; nur Search/Engage-API; v1 anonym/öffentlich, Auth später (JWT-Haken ab v1) |
| Browse-Form | Ein Bibliotheks-Fenster (A); räumliche Galerie später möglich; Episoden ohne Serie als eigene Gruppe |
| Fenster-Set v1 | Videos, Steuerung, Kapitel (Segmente+OCR), Transkript, Serie; Quizzes → v2 (Interactive Video / Abstimmung als Kandidaten) |
| Untertitel | episodenweit; blickfest im HUD (lazy follow); Transkript-Fenster zusätzlich |
| Flavors | generisch, beliebige Bezeichner, mehrere Qualitäten; pro Flavor ein Fenster |
| Fenster schließen | entlädt Stream komplett; Master-Wechsel automatisch; letzter Stream unschließbar |
| Zeitstrahl | im Dock (ankerfest), nicht blickfest; HUD zeigt nicht-interaktives Seek-Feedback |
| Architektur | Ansatz A: apps/opencast-player, Schichten opencast/ + player/ (React-frei) + windows/; sphere-shell v0.3.0 nur `<HeadLocked>` |

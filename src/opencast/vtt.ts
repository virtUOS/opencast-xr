import type { Cue } from './types'

// Matches both "HH:MM:SS.mmm" and "MM:SS.mmm" cue timing lines, e.g.
// "00:00:09.780 --> 00:00:24.780" or "00:09.780 --> 00:24.780". Anything
// trailing the second timestamp (cue settings like "line:0 align:start") is
// ignored.
const TIMING_LINE = /^(\d{2,}:)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2,}:)?(\d{2}):(\d{2})\.(\d{3})/

function parseTimestamp(hours: string | undefined, minutes: string, seconds: string, millis: string): number {
  const h = hours ? Number.parseInt(hours.replace(':', ''), 10) : 0
  const m = Number.parseInt(minutes, 10)
  const s = Number.parseInt(seconds, 10)
  const ms = Number.parseInt(millis, 10)
  return h * 3_600_000 + m * 60_000 + s * 1000 + ms
}

// Strips inline VTT tags like <v Speaker>, </v>, <c>, </c>, <b>, etc.
function stripInlineTags(line: string): string {
  return line.replace(/<\/?[^>]+>/g, '')
}

/**
 * Parses a WebVTT captions file into a flat list of cues. Tolerant of
 * header junk before the "WEBVTT" line's content, NOTE/STYLE/REGION blocks
 * (skipped whole), optional cue identifier lines, both "HH:MM:SS.mmm" and
 * "MM:SS.mmm" timestamp forms, multi-line cue text (joined with "\n"), and
 * inline tags like <v Speaker> (stripped). Never throws: unparseable input
 * (missing the WEBVTT signature, or containing no valid cues) yields [].
 */
export function parseVtt(text: string): Cue[] {
  try {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    if (!/^﻿?WEBVTT/.test(normalized)) {
      return []
    }

    const lines = normalized.split('\n')
    const cues: Cue[] = []

    let i = 0
    // Skip the header line and any header junk up to the first blank line.
    while (i < lines.length && lines[i].trim() !== '') {
      i++
    }

    while (i < lines.length) {
      // Skip blank lines between blocks.
      while (i < lines.length && lines[i].trim() === '') {
        i++
      }
      if (i >= lines.length) break

      const line = lines[i]

      // Skip NOTE and STYLE/REGION blocks entirely (until the next blank line).
      if (/^(NOTE|STYLE|REGION)(\s|$)/.test(line)) {
        while (i < lines.length && lines[i].trim() !== '') {
          i++
        }
        continue
      }

      // This line is either a cue identifier or the timing line itself.
      let timingLine = line
      if (!TIMING_LINE.test(timingLine)) {
        // Treat as an identifier; the next line should be the timing line.
        i++
        if (i >= lines.length) break
        timingLine = lines[i]
      }

      const match = TIMING_LINE.exec(timingLine)
      if (!match) {
        // Not a valid cue block; skip to the next blank line and continue.
        while (i < lines.length && lines[i].trim() !== '') {
          i++
        }
        continue
      }

      const startMs = parseTimestamp(match[1], match[2], match[3], match[4])
      const endMs = parseTimestamp(match[5], match[6], match[7], match[8])
      i++

      const textLines: string[] = []
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(stripInlineTags(lines[i]).trim())
        i++
      }

      const cueText = textLines.filter((l) => l.length > 0).join('\n')
      if (cueText.length > 0 && Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
        cues.push({ startMs, endMs, text: cueText })
      }
    }

    return cues
  } catch {
    return []
  }
}

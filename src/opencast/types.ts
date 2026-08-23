export interface OcTrack {
  id: string
  flavor: string // e.g. "presenter/preview", "captions/source+en"
  flavorType: string // part before "/" lowercased, e.g. "presenter"
  mimetype: string
  url: string
  tags: string[] // e.g. ["engage-download", ...]
  width?: number
  height?: number // from video.resolution "1920x804"
  isVideo: boolean // mimetype starts with "video/"
  isCaptions: boolean // flavor starts with "captions/"
}

export interface OcSegment {
  startMs: number
  durationMs: number
  text: string
  previewUrl?: string
}

export interface Episode {
  id: string
  title: string
  seriesId?: string
  seriesTitle?: string
  created?: string
  durationMs: number
  creators: string[]
  previewUrl?: string // attachment flavor "*/search+preview" preferred, else "*/player+preview"
  tracks: OcTrack[]
  segments: OcSegment[]
}

export interface Series {
  id: string
  title: string
}

export interface Cue {
  startMs: number
  endMs: number
  text: string
}

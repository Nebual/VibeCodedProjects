export interface SystemDeps {
  ffmpeg: boolean
  espeak_ng: boolean
}

export interface Health {
  status: 'ok' | 'degraded'
  version: string
  role: string
  tts_backend: string
  deps: SystemDeps
}

export interface ChapterInfo {
  index: number
  title: string
  section: string | null
  include: boolean
  skip_reason: string | null
  word_count: number
  sources: string[]
  est_seconds: number
}

export interface BookSummary {
  id: string
  title: string
  authors: string[]
  has_cover: boolean
  created_at: string
  chapter_count: number
  included_words: number
  est_seconds: number
}

export interface BookDetail extends BookSummary {
  language: string | null
  identifier: string | null
  publisher: string | null
  source_filename: string
  toc_synthesised: boolean
  chapters: ChapterInfo[]
  total_words: number
}

export interface ChapterText {
  index: number
  title: string
  paragraphs: string[]
}

export type JobStatus =
  | 'queued' | 'running' | 'cancelling' | 'cancelled' | 'done' | 'failed'

export interface JobChapterInfo {
  chapter_index: number
  title: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  chunks_total: number
  chunks_done: number
  audio_seconds: number
  gain_db: number | null
  error: string | null
  has_audio: boolean
}

export interface JobInfo {
  id: string
  book_id: string
  status: JobStatus
  voice: string
  speed: number
  backend: string
  model_version: string
  chapters_total: number
  chapters_done: number
  chunks_total: number
  chunks_done: number
  cache_hits: number
  audio_seconds: number
  current_title: string | null
  stage: string | null
  output_format: 'mp3' | 'm4b' | 'both'
  artifact_path: string | null
  artifact_bytes: number | null
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  chapters: JobChapterInfo[]
  progress: number
  is_terminal: boolean
}

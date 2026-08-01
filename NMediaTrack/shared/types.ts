// Types shared between the Nuxt app (client) and the Nitro server.

export const MEDIA_TYPES = ['game', 'show', 'movie', 'book', 'other'] as const
export type MediaType = (typeof MEDIA_TYPES)[number]

export const MEDIA_STATUSES = [
  'backlog', // want to play/watch/read
  'active', // currently consuming
  'paused', // set aside, may return
  'completed', // finished
  'dropped', // abandoned
] as const
export type MediaStatus = (typeof MEDIA_STATUSES)[number]

export interface Review {
  stars: number // 1..5
  message: string
  updatedAt: string // ISO timestamp
}

export interface MediaItem {
  id: string
  title: string
  type: MediaType
  /** Name of the person who owns/created this entry. */
  owner: string
  status: MediaStatus
  /** Other people consuming this together with the owner (tag names). */
  companions: string[]
  /** For shows: last episode watched, e.g. "S2E5" or "Episode 12". */
  lastEpisode?: string
  /** When the owner last engaged with this media (played/watched/read). */
  lastActivityAt?: string
  createdAt: string
  updatedAt: string
  notes?: string
  review?: Review
}

/** Payload accepted when creating a new media item. */
export interface MediaCreateInput {
  title: string
  type: MediaType
  owner: string
  status?: MediaStatus
  companions?: string[]
  lastEpisode?: string
  lastActivityAt?: string
  notes?: string
  review?: Review | null
}

/** Payload accepted when updating an existing media item. */
export interface MediaUpdateInput extends Partial<Omit<MediaCreateInput, 'owner'>> {
  /** Required to authorise the edit — only the owner may modify an item. */
  actor: string
}

export const TYPE_META: Record<MediaType, { label: string; icon: string; noun: string }> = {
  game: { label: 'Game', icon: '🎮', noun: 'played' },
  show: { label: 'Show', icon: '📺', noun: 'watched' },
  movie: { label: 'Movie', icon: '🎬', noun: 'watched' },
  book: { label: 'Book', icon: '📚', noun: 'read' },
  other: { label: 'Other', icon: '✨', noun: 'enjoyed' },
}

export const STATUS_META: Record<MediaStatus, { label: string; badge: string }> = {
  backlog: { label: 'Backlog', badge: 'badge-ghost' },
  active: { label: 'Active', badge: 'badge-success' },
  paused: { label: 'Paused', badge: 'badge-warning' },
  completed: { label: 'Completed', badge: 'badge-info' },
  dropped: { label: 'Dropped', badge: 'badge-error' },
}

import { sqliteTable, text, integer, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core'
import type { EditList, EditSettings, NoiseRegion } from '../../shared/types'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  googleSub: text('google_sub').notNull().unique(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
  role: text('role', { enum: ['admin', 'user'] }).notNull().default('user'),
  status: text('status', { enum: ['pending', 'approved', 'rejected'] }).notNull().default('pending'),
  approvedAt: integer('approved_at', { mode: 'timestamp_ms' }),
  approvedBy: text('approved_by'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  actorUserId: text('actor_user_id').notNull(),
  action: text('action').notNull(),
  targetUserId: text('target_user_id'),
  detail: text('detail'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

export const songs = sqliteTable('songs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  title: text('title').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),
  musicKey: text('music_key'),
  timeSignature: text('time_signature'),
  rating: integer('rating'),
  externalUrl: text('external_url'),
  masterPath: text('master_path'),
  peaksPath: text('peaks_path'),
  durationS: real('duration_s'),
  sampleRate: integer('sample_rate'),
  channels: integer('channels'),
  noiseRegion: text('noise_region', { mode: 'json' }).$type<NoiseRegion | null>(),
  editList: text('edit_list', { mode: 'json' }).$type<EditList>().notNull(),
  /** The editor controls' state (crop selection + enabled takes) as of last Save — lets re-opening the editor restore "what you had before Save" against the full original, not just what got rendered into editList. */
  editSettings: text('edit_settings', { mode: 'json' }).$type<EditSettings | null>(),
  shareToken: text('share_token').unique(),
  /** SHA-256 of the source file for bulk-imported songs, so re-running the importer is a no-op. */
  importHash: text('import_hash'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, t => [
  index('songs_user_id_idx').on(t.userId),
  uniqueIndex('songs_user_import_hash_idx').on(t.userId, t.importHash),
])

export const takes = sqliteTable('takes', {
  id: text('id').primaryKey(),
  songId: text('song_id').notNull().references(() => songs.id),
  sourcePath: text('source_path').notNull(),
  timelineStart: real('timeline_start').notNull().default(0),
  durationS: real('duration_s'),
  ordinal: integer('ordinal').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, t => [
  index('takes_song_id_idx').on(t.songId),
])

export const renders = sqliteTable('renders', {
  id: text('id').primaryKey(),
  songId: text('song_id').notNull().references(() => songs.id),
  specHash: text('spec_hash').notNull(),
  format: text('format', { enum: ['mp3', 'ogg'] }).notNull(),
  path: text('path').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, t => [
  uniqueIndex('renders_song_spec_format_idx').on(t.songId, t.specHash, t.format),
])

export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }).notNull(),
}, t => [
  uniqueIndex('tags_user_name_idx').on(t.userId, t.name),
])

export const songTags = sqliteTable('song_tags', {
  songId: text('song_id').notNull().references(() => songs.id),
  tagId: text('tag_id').notNull().references(() => tags.id),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, t => [
  uniqueIndex('song_tags_pk').on(t.songId, t.tagId),
])

export const albums = sqliteTable('albums', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  title: text('title').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),
  shareToken: text('share_token').unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, t => [
  index('albums_user_id_idx').on(t.userId),
])

export const albumSongs = sqliteTable('album_songs', {
  albumId: text('album_id').notNull().references(() => albums.id),
  songId: text('song_id').notNull().references(() => songs.id),
  position: integer('position').notNull(),
}, t => [
  uniqueIndex('album_songs_pk').on(t.albumId, t.songId),
])

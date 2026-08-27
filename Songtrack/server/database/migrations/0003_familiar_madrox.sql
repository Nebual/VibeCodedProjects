CREATE TABLE `transcriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`song_id` text NOT NULL,
	`spec_hash` text NOT NULL,
	`model` text NOT NULL,
	`instruments` text NOT NULL,
	`midi_path` text NOT NULL,
	`events_path` text NOT NULL,
	`preview_path` text,
	`beat_grid` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transcriptions_song_spec_idx` ON `transcriptions` (`song_id`,`spec_hash`);
ALTER TABLE `songs` ADD `import_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `songs_user_import_hash_idx` ON `songs` (`user_id`,`import_hash`);
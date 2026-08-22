ALTER TABLE `memories` ADD `valid_from` integer;--> statement-breakpoint
ALTER TABLE `memories` ADD `valid_until` integer;--> statement-breakpoint
UPDATE `memories` SET `valid_from` = `created_at` WHERE `valid_from` IS NULL;

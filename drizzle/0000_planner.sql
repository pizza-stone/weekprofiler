CREATE TABLE `planner_states` (
	`user_id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`revision` integer NOT NULL,
	`mutation_id` text NOT NULL
);

// Docker has already waited for PostgreSQL and Lavalink health. Prepare the
// selected instance schema, then start the normal production application.
await import("./migrate-active-database.js");
await import("../bootstrap/start.js");

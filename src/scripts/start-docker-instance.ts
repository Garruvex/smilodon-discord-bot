// Docker has already waited for PostgreSQL and Lavalink health. Prepare the
// selected instance schema, synchronize its Discord commands, then start the
// normal production application.
await import("./migrate-active-database.js");
await import("./deploy-commands.js");
await import("../bootstrap/start.js");

import "dotenv/config";

import { z } from "zod";
import { resolveDefaultInstanceEnvironment } from "../config/instance-environment.js";

const token = resolveDefaultInstanceEnvironment(process.env).DISCORD_TOKEN;
if (!token) {
  process.stderr.write("DISCORD_TOKEN is missing from .env.\n");
  process.exit(1);
}

if (token.length === 32 && !token.includes(".")) {
  process.stderr.write(
    "DISCORD_TOKEN looks like a Discord Client Secret, not a Bot Token. " +
      "Copy/reset the token from Developer Portal > Bot > Token.\n",
  );
  process.exit(1);
}

if (token.startsWith("Bot ")) {
  process.stderr.write(
    'DISCORD_TOKEN must contain only the token; remove the leading "Bot " prefix.\n',
  );
  process.exit(1);
}

const response = await fetch("https://discord.com/api/v10/users/@me", {
  headers: { Authorization: `Bot ${token}` },
});

if (!response.ok) {
  process.stderr.write(`Discord rejected DISCORD_TOKEN with HTTP ${response.status}.\n`);
  process.exit(1);
}

const identity = z.object({ id: z.string(), username: z.string() }).parse(
  await response.json(),
);
process.stdout.write(
  `Discord token accepted for ${identity.username} (${identity.id}).\n`,
);

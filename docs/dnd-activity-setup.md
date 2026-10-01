# D&D Activity

The Activity opens to a server-scoped lobby at `assets/activity/`. It authenticates players with Discord, lists campaigns visible to them in the launch server, and uses the existing campaign services for lobby choices and game actions.

## Enable it for one bot instance

For a native bot process, set these in the environment used to start it:

```env
ACTIVITY_ENABLED=true
ACTIVITY_HOST=127.0.0.1
ACTIVITY_PORT=3000
DISCORD_CLIENT_SECRET=<Discord application client secret>
```

Set `DISCORD_CLIENT_SECRET` from the Discord Developer Portal's application OAuth2 settings. Keep it private and configure it only on the bot instance that hosts the Activity. Do not put it in frontend configuration or commit its value.

For a named bot instance, put the settings in `config/instances/<instance-name>.env`. Enable the server on only one instance so there is a single Activity origin and no port conflict.

Start that bot as usual. The Activity should answer at `http://127.0.0.1:3000/`, and its health endpoint is `http://127.0.0.1:3000/healthz`. Point the existing Cloudflare published-application route at the same HTTP service. The public Activity address should be the hostname configured in Discord's Activities URL mapping.

For Docker Compose, set `ACTIVITY_HOST=0.0.0.0` and `ACTIVITY_PORT=3000` in the selected instance environment file so the Activity server listens on the container network. The `stack:up`, `stack:down`, `stack:logs`, `stack:ps`, and `stack:config` npm scripts include the tracked `compose.tunnel.yaml` overlay, so the tunnel service shares the network with the machine-specific `compose.yaml` even though that file is ignored by Git. Set the Cloudflare published-application origin to the selected bot service, such as `http://bot-yohta:3000` or `http://bot-pinecone:3000`. Inside a container, `localhost` refers to that container itself, so `http://localhost:3000` is not the bot service. No public host port needs to be published.

Set `CLOUDFLARE_TUNNEL_TOKEN` in the server's root `.env` file. Keep the existing remotely managed Tunnel and its public hostname route; only change its origin to the bot service URL above. Run `npm run stack:up` to start or update the bots and Compose-managed tunnel together. Check the full stack with `npm run stack:ps`. After confirming the Compose-managed connector is connected, stop and remove the old standalone `jovial_leavitt` container so there is only one connector using the token. `npm run stack:down` includes the tunnel too.

If the tunnel process runs directly on the host instead, publish the selected bot's container port on a loopback-only host port and route it to `http://127.0.0.1:3000`.

## Current scope

- The lobby lists open games and games the player can access. Players can join an open lobby, choose an available starter hero, and start it when they are the organizer.
- The game screen reads live campaign state: scene, party status and health, enemy health, and legal actions for the player's turn. It refreshes from the bot's campaign API every five seconds; this polling does not call Discord's API.
- Activity actions use the same campaign controller and rules engine as the Discord controls. Their direct card refresh is suppressed, so each action does not also edit the Discord campaign card. The campaign's existing narration and background delivery still use Discord.
- The lobby supports starter heroes, organizer start, join requests, invitations, and joining an approved active game with the player's latest saved character snapshot.
- Exploration supports submitting an action, passing, rolling a pending check, casting available cantrips or rituals, healing and reviving party members, summoning companions, drinking carried potions, and proposing an available move.
- Combat presents the engine's legal attacks, spells, features, potions, shield toggles, engagement, movement and teleport options, safe withdrawal, Dodge, Dash, Wild Shape, turn ending, reaction spells, Divine Smite, and opportunity attacks.
- Character details include the requesting player's spells, resources, equipment and gold. They can equip or remove carried armor and shields, move items between their inventory and the party stash, and inspect stash contents. Other party members' private inventory and spell details are not sent to the Activity.
- OAuth identity and launch-server membership are verified through Discord on the bot server. The Activity receives an opaque, in-memory session token; a bot restart expires those sessions, so players should reopen the Activity after a restart.

The game list is scoped to the server in which the Activity was launched. Private campaigns are only shown to their members, organizer, or a player with an active invitation. The Activity and Discord campaign controls act on the same saved campaign, so updates appear in both views; routine snapshot polling itself is backend-only.

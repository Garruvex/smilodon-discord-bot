# D&D Activity preview server

The repository now contains a first UI preview at `assets/activity/`. It is served by the bot process when Activity hosting is enabled, and it initializes Discord's Embedded App SDK so the page can complete the Activity launch handshake. The preview uses example characters and sample encounter state; it does not authenticate a player or read/write campaign data yet.

## Enable it for one bot instance

For a native bot process, set these in the environment used to start it:

```env
ACTIVITY_ENABLED=true
ACTIVITY_HOST=127.0.0.1
ACTIVITY_PORT=3000
```

For a named bot instance, put the settings in `config/instances/<instance-name>.env`. Enable the server on only one instance so there is a single Activity origin and no port conflict.

Start that bot as usual. The preview should answer at `http://127.0.0.1:3000/`, and its health endpoint is `http://127.0.0.1:3000/healthz`. Point the existing Cloudflare published-application route at the same HTTP service. The public Activity address should be the hostname configured in Discord's Activities URL mapping.

For Docker Compose, the bot binds the Activity to its container network on port `3000`. Use the `cloudflared` service from `compose.example.yaml` (or add that service to your local `compose.yaml`) so it shares the Compose network. Set the Cloudflare published-application origin to the selected service name, such as `http://bot-yohta:3000` or `http://bot-pinecone:3000`. Inside a container, `localhost` refers to that container itself, so `http://localhost:3000` is not the bot service. No public host port needs to be published.

Set `CLOUDFLARE_TUNNEL_TOKEN` in the server's root `.env` file. Keep the existing remotely managed Tunnel and its public hostname route; only change its origin to the bot service URL above. To let Compose manage the connector on future restarts and deployments, start the `cloudflared` service with the other Compose services. After confirming the Compose-managed connector is connected, stop and remove the old standalone `jovial_leavitt` container so there is only one connector using the token.

If the tunnel process runs directly on the host instead, publish the selected bot's container port on a loopback-only host port and route it to `http://127.0.0.1:3000`.

## What is not wired yet

- Discord OAuth code exchange and authenticated player identity
- Campaign and player authorization
- Live campaign snapshot, private character details, and revision updates
- Action submissions through the existing campaign controller
- The quiet Discord-panel mode while Activity clients are connected

The preview buttons explain these missing connections instead of claiming to perform game actions. The Activity API work should implement these paths against the same campaign services used by Discord controls.

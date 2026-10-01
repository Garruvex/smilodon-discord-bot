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

If the bot runs in Docker, set `ACTIVITY_HOST=0.0.0.0` inside its container and publish container port `3000` to a loopback-only host port. Keep the published host side bound to `127.0.0.1`; Cloudflare Tunnel should be the public ingress.

## What is not wired yet

- Discord OAuth code exchange and authenticated player identity
- Campaign and player authorization
- Live campaign snapshot, private character details, and revision updates
- Action submissions through the existing campaign controller
- The quiet Discord-panel mode while Activity clients are connected

The preview buttons explain these missing connections instead of claiming to perform game actions. The Activity API work should implement these paths against the same campaign services used by Discord controls.

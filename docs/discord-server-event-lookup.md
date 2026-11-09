# Answering server and scheduled-event questions

Chat can use the read-only `lookup_discord_server` tool to answer questions such as “這個伺服器有多少人？” and “最近有什麼活動？”. The tool is registered with the existing chat tools, so the global tools switch and per-tool disabled list apply. It requires no new configuration or scheduled-event gateway intent: each lookup requests the current Discord data through REST.

The `server` scope supplies the server name, description, member count (including bots), creation date, preferred locale and the bot's configured server timezone. It does not inspect message history, member lists, invites, moderation records or private configuration.

The `events` scope supplies active and scheduled events, ordered by their supplied start time: name, description, start/end dates, status, location or channel ID, event link, and recurrence metadata. An optional name/description keyword filters the list. Results are capped at ten and report truncation. Dates are snapshots of Discord's current event data; the model must not invent future occurrences from a recurrence rule. Server-provided text is untrusted content, not instructions.

Channel-based events require bot and caller visibility. Cross-channel results additionally require visibility for everyone and no role/member overwrite denying channel visibility, because replies are visible to the whole destination channel. Restricted events are conservatively omitted, including for bot owners; adult-channel events are excluded from safe-channel lookups. External events with no associated channel can be returned as guild events. An empty visible list does not establish that the server has no events. Permission/API failures return an unavailable result rather than an empty list.

This adds an information source for ordinary replies. It does not automatically announce events or bypass participation settings: optional participation still uses message accumulation and the decision gate; direct questions and explicit bot replies bypass accumulation. Accepted optional continuation/spontaneous replies receive only this server lookup tool, without access to action tools. The guild tools switch and disabled-tool list still apply. When tools are disabled, the bot cannot claim to have checked live events.

Local checks cover metadata, current event fetches, statuses/order/links, bounded keyword results, private-channel isolation, access changes, cancellation and unavailable lookups. Live Discord and real-model answer quality still require a deployed check.

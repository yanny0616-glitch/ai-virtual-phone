# Float tool event gateway

The host has one event intake, inbox, role binding, receive/auto choice and dispatch pipeline. It does not assume that every MCP emits events. An external adapter or webhook-capable service must actively deliver events. Garden is a built-in transport adapter; new producers use the standard webhook without modifying Float's core.

## User configuration

Chat toolbox → any existing MCP server → Event wake (optional). Enter the existing private gateway connection code, choose adapter, target role and receive/auto, save, then explicitly start. Each source has independent configuration and credentials; clearing or stopping one does not change another. Webhook sources expose delivery configuration only after the owner explicitly requests it. Keep the source token outside model prompts. Changing the bound MCP URL suspends handling of old queued events until the owner resolves the binding.

VPS receives while the phone is closed; the visible Float app later imports messages. There is no offline agent runner. The receiver persists a stable-ID ordinary user message, then acknowledges it; only the acknowledgement winner triggers the existing role pipeline. A crash between ack and generation can leave a message without an automatic response; remote tool actions are not automatically replayed. The most recent 10,000 producer event IDs retained globally are a bounded deduplication window (oldest receipts are evicted); IDs must remain stable for retries. Garden's ID-less hints coalesce only while pending. On-disk storage failures roll back in-memory mutation. At most 32 sources and 200 total pending events are accepted. Stopping a source also pauses delivery of its queued events; starting it resumes intake and delivery.

## Producer protocol

POST `https://YOUR_FLOAT/api/tool-events/ingest`

Header: `Authorization: Bearer <this-source-token>` (not the owner connection code, not the Garden machine token).

```json
{"version":1,"sourceId":"mcp_your_server_id","eventId":"upstream-event-123","reason":"notification","message":"There is a new notification; use the configured MCP to inspect it."}
```

The producer cannot choose a role, execution mode, tool list or system prompt. Those fields are ignored. It cannot manage configuration or publish to another source. `eventId` is required, maximum 200 characters; message maximum 4096, reason maximum 128. Use the same eventId on retries; an already accepted ID returns `duplicate:true`, including after inbox acknowledgement. HTTP 401 means wrong source key, 409 means stopped, 429 means inbox full. The sample `send-event.mjs` CLI reads one event from stdin and protected environment variables `FLOAT_EVENT_URL`, `FLOAT_EVENT_SOURCE_ID`, `FLOAT_EVENT_TOKEN`; it does not retry automatically or print payloads/credentials. Providers with other protocols can translate into this format in their own adapter.

## Architecture and deployment

- `service.mjs`: multiple source configurations, source-scoped producer auth, durable queue and management; loopback 127.0.0.1:18062.
- `adapters/garden.mjs`: independently installed MIT upstream `WenXiaoWendy/galatea-garden-wake-bridge` 0.2.1. Only this adapter imports its SSE library. No reconnects or automatic startup. The general webhook path works without the Garden library installed.
- `/api/tool-events`: site login (when enabled), same-origin POST and private owner connection code; forwards only management to loopback using the backend key.
- `/api/tool-events/ingest`: public transport endpoint with per-source Bearer auth, no cookie. It cannot access backend management credentials. Middleware exempts only this intake route from browser login.
- All existing physical secret paths and local browser keys are retained for upgrade compatibility: `/etc/float-garden-wake/client-token`, `backend-token`, 0700 directory/0600 files. State stays `/var/lib/float-garden-wake/state.json`. The v1 Garden config and events migrate to v2 sources, retaining original target/token and old `garden_wake_*` message IDs. Legacy `/api/garden-wake` remains an alias; its no-source management requests select only the Garden source.
- Runtime source copy: `/root/vibe-coding/float/tool-events-vps`, including `adapters/`. Copy the service unit to `/etc/systemd/system/float-garden-wake.service`, daemon-reload, restart. The historical unit name remains for operational compatibility. `Restart=no`. Restarting the local manager never reopens Garden or starts a producer; the owner explicitly starts each source.
- Upstream path is `/root/vibe-coding/float/galatea-garden-wake-bridge`, optionally overridden by `GARDEN_BRIDGE_ROOT`. Its lightweight tsc compilation is separate from Next.js. Never run a Next.js production build locally.

Checks: `node tools/tool-events/check.mjs`, `node scripts/check-tool-events.mjs`. These use temporary local state, fake transports and fake model calls; no real Garden business operations are executed.

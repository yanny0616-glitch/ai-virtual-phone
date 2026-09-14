# Float Garden wake adapter

Uses the independently installed MIT-licensed upstream `WenXiaoWendy/galatea-garden-wake-bridge` 0.2.1. The upstream library owns SSE parsing and the single-connection, fail-stop policy. The adapter is Float code; no upstream source is copied here.

Deployment on this VPS:

- Upstream checkout: `/root/vibe-coding/float/galatea-garden-wake-bridge` (dependencies installed with `npm ci --ignore-scripts`; lightweight TypeScript compilation via `npx tsc -p tsconfig.json`, never a local Next.js build).
- Copy `service.mjs` to `/root/vibe-coding/float/garden-wake-adapter/service.mjs`. `GARDEN_BRIDGE_ROOT` optionally overrides the upstream root.
- Generate a random private backend credential at `/etc/float-garden-wake/backend-token`, directory 0700, file 0600. Never log it. Create a separate private client-token for the owner; enter it once in the UI (stored only in this browser localStorage). The API never bootstraps or returns this credential.
- State directory `/var/lib/float-garden-wake` is 0700; atomic JSON state files are 0600 and include the user's machine token.
- Copy the supplied unit to `/etc/systemd/system/float-garden-wake.service`, daemon-reload and enable/start. It listens only on 127.0.0.1:18062, uses `Restart=no`, and NEVER starts a Garden connection on process startup. Only the explicit UI Start action opens one stream.
- Next.js `/api/garden-wake` requires the site login when account mode is enabled, same-origin browser POST and the constant-time-checked `x-float-garden-key` matching a separate 0600 `/etc/float-garden-wake/client-token`, and forwards to the credential-protected loopback service. This is a single-owner VPS integration, not a multi-tenant service.

UI: chat toolbox → Garden MCP → Garden event wake. User chooses a character and auto/receive mode. Save stops the previous connection; Start begins one new connection. Stop, status refresh, and clear are explicit actions. Clear removes configuration and pending events. No timers, health checks or process restarts reopen Garden SSE.

The VPS persists at most 200 pending wake hints, coalesces identical outstanding hints and fails delivery when full. It preserves server message text. Events retain their original role/server/mode target across config edits. The foreground client polls the LOCAL inbox every 20 seconds (never Garden), durably imports each message as a normal user turn using a stable ID, then acknowledges it. Atomic acknowledgement selects one execution winner across clients. It respects missing roles/disabled MCP and defers while background generation is busy. Receive mode only imports; auto mode requests the existing chat pipeline. Once acknowledged, failed model/tool execution is not replayed automatically; the inbound message remains in chat.

Limit: there is no headless Float agent on the VPS. Closing/locking the phone queues events for the next visible Float session; it does not run offline MCP. A crash after ack and before generation can leave an inbound message without an automatic reply; this deliberately avoids replaying potentially state-changing tools. Fresh browser installs must save/start in the panel to opt into consuming this VPS inbox. Do not label this as offline agent execution.

Checks: `node tools/garden-wake/check.mjs` and `node scripts/check-garden-wake.mjs`. Both use local mocks/temporary state and never connect to Garden or send posts.

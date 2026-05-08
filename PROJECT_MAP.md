# Project Map

Quick notes for me. Goal: make a real Chat SDK adapter for Linq. The Nitro app is mostly here to make setup/testing less annoying.

## Setup stuff I added

- `apps/api/index.html` — setup page/buttons for Telegram + Linq webhooks.
- `apps/api/server/api/index.ts` — route index / quick sanity check.
- `apps/api/server/lib/setup-auth.ts` — optional `BOT_SETUP_ACCESS_TOKEN` guard.
- `apps/api/server/lib/database.ts` — Postgres pool, webhook secrets, raw Linq events, Chat SDK state client.

### Telegram setup path

- `apps/api/server/lib/telegram-api.ts` — `getMe`, `getWebhookInfo`, `setWebhook` helpers.
- `apps/api/server/api/telegram/setup/status.get.ts` — setup/status check.
- `apps/api/server/api/telegram/setup/webhook.post.ts` — registers Telegram webhook + stores secret.
- `apps/api/server/api/webhooks/telegram.post.ts` — verifies Telegram secret, then hands to Chat SDK.

### Linq setup path

- `apps/api/server/lib/linq-api.ts` — Linq API helper + webhook subscription creation.
- `apps/api/server/api/linq/setup/webhook.post.ts` — creates Linq `message.received` subscription + stores signing secret.
- `apps/api/server/api/webhooks/linq.post.ts` — verifies Linq signature + stores raw payloads.

## Files that matter most

### Adapter package

Everything in `packages/adapter-linq` matters.

- `packages/adapter-linq/src/index.ts` — where the real adapter needs to go. Currently just a stub.
- `packages/adapter-linq/package.json` — package/export shape.
- `packages/adapter-linq/tsconfig.json` — adapter build config.

### App integration

- `apps/api/server/lib/bot.ts` — Chat SDK instance + handlers. Linq adapter gets mounted here.
- `apps/api/server/api/webhooks/linq.post.ts` — current Linq webhook intake; likely moves into adapter later.
- `apps/api/server/lib/linq-api.ts` — current Linq API helper; send-message code may start here or move into package.
- `apps/api/server/lib/database.ts` — secrets/state/raw webhook storage.
- `apps/api/index.html` — setup UI.

### Workspace basics

- `package.json`
- `pnpm-workspace.yaml`
- `turbo.json`
- `tsconfig.base.json`
- `apps/api/package.json`
- `apps/api/nitro.config.ts`

## Where we are

Done:

- Monorepo + Nitro app.
- Telegram works through Chat SDK code path.
- Setup UI exists.
- Postgres state/settings exist.
- Linq webhook subscription setup exists.
- Linq signature verification + raw event storage exists.

Not done:

- Real `createLinqAdapter(...)`.
- Mapping Linq `message.received` into Chat SDK messages.
- Sending Linq replies from `thread.post(...)`.
- Mounting Linq in `bot.ts`.

## Next step

Build the smallest Linq adapter: receive text messages, map `chat.id` to thread, and send plain-text replies back to the same chat.

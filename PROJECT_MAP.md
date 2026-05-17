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

- `apps/api/server/lib/linq-api.ts` — Linq SDK client + webhook subscription creation.
- `apps/api/server/api/linq/setup/webhook.post.ts` — creates Linq `message.received` subscription + stores signing secret.
- `apps/api/server/api/webhooks/linq.post.ts` — thin handoff to `bot.webhooks.linq`.

## Files that matter most

### Adapter package

Everything in `packages/adapter-linq` matters.

- `packages/adapter-linq/src/index.ts` — public exports only.
- `packages/adapter-linq/src/adapter.ts` — Chat SDK adapter: maps inbound text, sends text replies.
- `packages/adapter-linq/src/format-converter.ts` — tiny Chat SDK format converter.
- `packages/adapter-linq/src/verification.ts` — Linq webhook timestamp/signature verification.
- `packages/adapter-linq/package.json` — package/export shape.
- `packages/adapter-linq/tsconfig.json` — adapter build config.

### App integration

- `apps/api/server/lib/bot.ts` — Chat SDK instance + handlers. Linq adapter gets mounted here.
- `apps/api/server/api/webhooks/linq.post.ts` — Linq webhook route + raw event storage.
- `apps/api/server/lib/linq-api.ts` — Linq setup/subscription helper.
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
- Linq adapter exists.
- Linq API calls use `@linqapp/sdk`.
- Linq signature verification lives in the adapter package.
- Linq inbound text maps into Chat SDK messages.
- Linq `thread.post(...)` can send plain text to existing chats.
- Raw Linq webhook event storage lives in the app route, not the adapter.
- Linq typing-start calls the SDK.
- Linq is mounted in `bot.ts`.

Not done:

- Attachments/reactions/typing-stop/editing.
- Message history fetch from Linq API.
- Real payload fixtures/tests.

## Next step

Test with a real signed Linq webhook, then add fixtures/tests around that payload.

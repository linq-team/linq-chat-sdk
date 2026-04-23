# Linq x Chat SDK Plan

## Short Answer

Yes, a light Turborepo setup is a good idea here.

Not because we need a giant monorepo.

Because you want two things at the same time:

- one app you can deploy quickly
- packages you can publish later

That is a good Turbo shape.

The key is to keep it small.


## The Vibe

Optimize for iteration.

Not completeness.

Not perfect abstractions.

Not every Linq feature on day one.

The first real win is:

1. a Chat SDK bot running behind Nitro
2. Telegram working end-to-end
3. a place to add the Linq adapter in small steps


## Why This Shape Works

Chat SDK is a good fit because the core model is already adapter-based.

Adapters handle:

- webhook verification
- payload parsing
- outgoing API calls

Your bot logic can stay separate from the Linq transport details.

Nitro is also a good fit.

Chat SDK webhook handlers are just `Request -> Response` functions, so they can sit behind a simple Nitro server without needing Next.js.


## Recommended Repo Shape

```text
apps/
  api/

packages/
  adapter-linq/
```


## What Each Piece Does

### `apps/api`

The deployable Nitro app.

This is the thing you run locally and deploy early.

Responsibilities:

- expose `/api/webhooks/:platform`
- load env vars
- create the Chat SDK instance in server code
- register handlers and official adapters in server code
- mount Chat SDK webhook handlers
- give you one real URL for Telegram and later Linq


### `packages/adapter-linq`

The future publishable Linq adapter.

Keep this as its own package from the start, even if it begins as a stub.

That keeps the path to publishing clean later.

Important: Chat SDK reserves the `@chat-adapter/*` scope for official packages, so this should eventually publish under your own scope or as something like `chat-adapter-linq`.


## Keep The Monorepo Light

Use Turbo, but do not build a whole internal platform.

For now, skip:

- shared config packages
- internal UI packages
- fancy codegen
- multi-app setups
- production infra packages

One app.

One package.

That is enough.


## Phase 1: Prove The Loop With Telegram

This is the right first slice.

Before touching Linq, get the full loop working with an official adapter.

Why:

- it proves the Nitro wiring
- it proves deployment
- it proves the Chat SDK event model
- it gives you a stable place to iterate from


### Phase 1 Goal

Send a Telegram message.

Have the Nitro app receive the webhook.

Let Chat SDK process it.

Return a reply from your handler.


### What To Build

- `apps/api` with a Nitro route for webhooks
- Chat instance and handlers inside `apps/api`
- official Telegram adapter
- memory state for now
- one dead-simple handler like echo or a fixed reply


### Why Memory State First

Use in-memory state first.

Redis can wait.

The goal right now is to get the server and handler loop working, not to harden distributed state.


## Phase 2: Add The Linq Adapter In The Smallest Useful Way

Start with the minimum adapter that can receive a Linq message and reply in the same chat.

That means:

- verify webhook signatures
- parse inbound Linq messages
- normalize them into Chat SDK messages
- send plain-text replies back through Linq


## Linq Facts That Matter For The Plan

### Auth

Use Bearer auth.

Base URL:

`https://api.linqapp.com/api/partner`

Header:

`Authorization: Bearer <token>`


### Webhooks

Linq sends signed webhooks.

Relevant headers:

- `X-Webhook-Event`
- `X-Webhook-Subscription-ID`
- `X-Webhook-Timestamp`
- `X-Webhook-Signature`

Signature verification is HMAC-SHA256 over:

```text
{timestamp}.{raw_body}
```

Important detail: use the raw request body bytes, not parsed-and-re-serialized JSON.

Also reject stale timestamps.

Linq recommends rejecting requests older than 5 minutes.


### Retry Behavior

Failed deliveries are retried up to 10 times over roughly 25 minutes.

So the adapter should:

- return `2xx` quickly
- hand work off to Chat SDK immediately
- avoid doing slow work before acknowledging the webhook


### Event Surface

The useful initial Linq events are:

- `message.received`
- `reaction.added`
- `reaction.removed`
- `chat.typing_indicator.started`
- `chat.typing_indicator.stopped`

But the smallest first pass only really needs `message.received`.


## Smallest Useful Linq Adapter

The first version of `packages/adapter-linq` should support:

- inbound text messages
- outbound text replies in an existing chat
- webhook verification

It does not need to support everything else yet.


## The Mapping To Start With

### Thread Identity

Use Linq `chat.id` as the core thread identifier.

That is the obvious anchor for Chat SDK thread IDs.


### Inbound Messages

Map Linq `message.received` events into Chat SDK messages.

Start with text parts only.

Ignore rich media and links on the first pass if needed.


### Outbound Replies

Use Linq message send APIs for replying inside an existing chat.

This keeps the adapter narrow at first.

Do not start by solving "open a brand new chat from arbitrary input" unless you need it immediately.


### Formatting

Linq text is sent as-is.

So for v1, keep formatting simple.

Plain text first.

Fancy markdown conversion later.


## What To Defer On Purpose

Do not try to nail all of Linq in the first adapter pass.

Push these to later:

- attachments
- voice memos
- reactions
- message editing
- read receipts
- typing indicators
- group chat management
- contact sharing
- rich link handling
- full message history sync
- cards and modal-like UI ideas

Those are nice once send/receive is stable.


## Suggested Build Order

### Milestone 0

Repo scaffold only.

- pnpm workspace
- turbo
- TypeScript
- Nitro app
- Linq adapter package stub


### Milestone 1

Telegram end-to-end.

- official Telegram adapter wired in
- webhook route working
- deployable Nitro server live
- one simple message handler working


### Milestone 2

Linq webhook receive path.

- verify Linq signature
- parse `message.received`
- map into Chat SDK
- log raw payloads while shape is still settling


### Milestone 3

Linq reply path.

- reply to messages in existing chats
- text only
- enough metadata to correlate message IDs


### Milestone 4

Tighten the adapter.

- thread fetching
- message fetching
- reactions
- typing
- attachments
- better tests


## Local Iteration Loop

The loop should feel like this:

1. run Nitro locally
2. expose it with a tunnel if needed
3. point Telegram or Linq webhooks at that URL
4. edit code in `apps/api` or `packages/adapter-linq`
5. hit the bot again immediately

That is the main reason to keep the first app so small.


## Good Defaults For Now

- package manager: `pnpm`
- workspace runner: `turbo`
- runtime app: Nitro
- state: in-memory first
- first platform: Telegram
- Linq webhook version: pin one current version and build fixtures around it
- first Linq capability: receive + reply in existing chats


## What Success Looks Like Soon

You are in a good spot when:

- `apps/api` can be deployed by itself
- Telegram messages hit Chat SDK through Nitro
- Linq webhooks can hit the same server
- the Linq adapter can receive a message and send a plain reply
- bot logic mostly lives in app server modules, not inline in route handlers


## My Recommendation

Build this in two moves:

1. set up the light Turbo + Nitro + Telegram loop
2. add Linq as a deliberately narrow adapter after the loop feels good

That gets you something real quickly without locking you into a messy single-app prototype.


## Sources

- Chat SDK docs: `https://chat-sdk.dev/`
- Chat SDK adapter guide: `https://chat-sdk.dev/docs/contributing/building`
- Linq Partner API docs: `https://apidocs.linqapp.com/`
- Linq webhooks: `https://apidocs.linqapp.com/documentation/webhooks`
- Linq chats: `https://apidocs.linqapp.com/documentation/chats`
- Linq messages: `https://apidocs.linqapp.com/documentation/messages`

# Linq Chat SDK adapter scope

This is the implementation checklist for turning `packages/adapter-linq` from the current narrow receive/reply prototype into a clean Chat SDK adapter.

Sources checked:

- Chat SDK `Adapter` type from installed `chat@4.26.0`.
- Chat SDK adapter authoring docs in `node_modules/chat/docs/contributing/building.mdx`.
- Linq SDK `@linqapp/sdk@0.22.1` resources for webhooks, chats, messages, typing, attachments, and subscriptions.
- Local Linq integration files under `packages/adapter-linq` and `apps/api/server`.

## Shape we should keep

- The adapter package owns Linq webhook verification, payload parsing, thread/message normalization, and Linq API calls.
- The Nitro app owns setup UI/routes, Postgres settings, Chat SDK state, and raw webhook event storage.
- Linq webhook URLs should stay pinned to `?version=2026-02-03` so message payloads use the current `MessageEventV2` shape.
- The first public behavior should remain boring and reliable: signed inbound Linq messages become Chat SDK messages, and `thread.post()` sends replies to the same Linq chat.

## Current baseline

Implemented now:

- `handleWebhook()` verifies Linq signatures, parses with `apiClient.webhooks.events()`, and processes inbound `message.received` events.
- `parseMessage()` handles current `message.received` webhooks and `chats.messages.send()` responses, text-only.
- `postMessage()` sends text replies to an existing Linq chat.
- `fetchThread()` returns decoded thread metadata without calling Linq.
- `startTyping()` calls `chats.typing.start()`.
- `addReaction()`, `removeReaction()`, `deleteMessage()`, and `editMessage()` intentionally throw `NotImplementedError` today.
- App setup can create a minimal `message.received` webhook subscription and store the one-time `signing_secret` in Postgres.

Problems to fix before expanding features:

- `getBot()` caches the Linq adapter with whatever signing secret existed at construction time. If the Linq webhook secret is created/rotated after the bot is already cached, webhook verification can stay broken until process restart.
- Linq webhook setup always tries to create a subscription even when a stored subscription ID already exists. Linq requires `target_url` uniqueness, so setup should be idempotent.
- `fetchMessages()` is an empty success result, which hides that history is not implemented.
- Message parsing ignores media parts, link previews, reactions on parts, edited metadata, delivery/read timestamps, and retrieved-message response shapes.
- The adapter constructs its Linq SDK client with only `apiToken`; it does not accept/pass a `baseURL`, so app setup and adapter sends can point at different Linq environments.
- There are no payload fixtures/tests for the signed webhook path.

## Thread identity decision

Use the Linq chat as the Chat SDK thread.

Current encoding is acceptable for now:

```text
linq:<encoded chat_id>[:group|dm]
```

Notes:

- `chat.id` is the durable anchor for inbound webhooks, sends, history, typing, and read state.
- `is_group` is useful metadata for `isDM()` and typing limitations.
- Do not encode every `reply_to.message_id` as a separate Chat SDK thread yet. Linq supports message replies, but Chat SDK bot handlers will be much simpler if a Linq chat maps to one conversation first.
- If we later need true per-message iMessage reply threads, add an optional thread-root segment deliberately and migrate stored state carefully.

## Adapter method checklist

| Chat SDK method | Linq support | Current state | Scope |
| --- | --- | --- | --- |
| `initialize(chat)` | SDK lifecycle only | Stores `chat` | Keep. Also use `chat.getLogger("linq")` if we add logging. |
| `encodeThreadId()` / `decodeThreadId()` | Use `chat.id` | Implemented | Keep chat-level IDs; validate malformed IDs; avoid changing encoding unless we are ready to migrate state. |
| `channelIdFromThreadId()` | Linq has no separate channel | Implemented as chat ID | Keep returning the chat-level ID. |
| `isDM()` | `chat.is_group` / webhook `chat.is_group` | Implemented from encoded metadata | Keep. `fetchThread()` can confirm from `chats.retrieve()`. |
| `handleWebhook()` | Signed Linq webhooks + `webhooks.events()` parser | Handles inbound `message.received` only | Keep raw-byte verification, return 2xx fast, process inbound messages with `chat.processMessage()`. Add reaction event handling later via `chat.processReaction()`. Ignore outbound/status events unless we need observability. |
| `parseMessage()` | Webhook message events, sent-message responses, retrieved messages | Partial text-only | Centralize parsing for `MessageEventV2`, `chats.messages.send()` response, and `messages.retrieve()` / `chats.messages.list()` messages. Preserve raw payload. |
| `renderFormatted()` | Linq text parts are sent as plain text unless using iMessage text decorations | Plain-text fallback | Keep plain text in P0. Later map basic AST marks to `text_decorations` for iMessage only if worth it. |
| `postMessage()` | `chats.messages.send(chatId, { message })` | Sends one text part | Keep text replies. Add files/attachments and optional idempotency later. Do not turn normal URLs into rich `link` parts automatically because Linq has first-message/link restrictions. |
| `postChannelMessage()` | Same as chat send | Alias to `postMessage()` | Keep alias because channel/thread distinction does not exist for Linq chats. |
| `fetchThread()` | `chats.retrieve(chatId)` | Decoded metadata only | Implement real retrieval: display name, handles, service, health, `is_group`, archived state. |
| `fetchMessages()` | `chats.messages.list(chatId, { cursor, limit })` | Empty stub | Implement paginated chat history and always return messages oldest-first within the page. `direction: "backward"` is implementable; `forward` may be best-effort unless Linq exposes ordering on chat-message list. |
| `fetchMessage?()` | `messages.retrieve(messageId)` | Missing | Implement optional method and normalize through the same parser. |
| `editMessage()` | `messages.update(messageId, { text, part_index })` | Not implemented | Implement text-only edits for part `0` first. Document Linq limits: max 5 edits and only within 15 minutes. |
| `deleteMessage()` | `messages.delete(messageId)` exists but only deletes from Linq API, not recipient chat | Not implemented | Do **not** implement as Chat SDK delete unless product accepts that semantic mismatch. Chat SDK callers expect visible deletion/unsend. |
| `addReaction()` / `removeReaction()` | `messages.addReaction(messageId, { operation, type, custom_emoji })` | Not implemented | Implement. Map common Chat SDK emoji to Linq tapbacks: heart→`love`, thumbs up→`like`, thumbs down→`dislike`, laugh→`laugh`, exclamation→`emphasize`, question→`question`; otherwise use `custom`. |
| `startTyping()` | `chats.typing.start(chatId)` / `stop(chatId)` | Starts only | Keep start. Linq rejects group typing with 403; decide whether to ignore group failures or surface them. Chat SDK has no separate stop method. |
| `openDM?()` | `chats.create()` requires `from`, recipients, and an initial message | Missing | Do not implement yet. Chat SDK `openDM()` returns a thread before posting, but Linq creates a chat with the first message, so this needs a deliberate product/API design. |
| `stream?()` | No native Linq streaming | Missing | Do not implement native streaming. Once `editMessage()` works, Chat SDK fallback streaming can be considered, but Linq edit limits make it risky for long streams. |
| `postObject?()` / `editObject?()` | No direct Linq equivalent | Missing | Do not implement. Plans/cards should fall back to text only. |
| `openModal?()` / actions / slash commands / app home | No Linq equivalent | Missing | Not applicable. |
| `scheduleMessage?()` | No scheduling endpoint found | Missing | Not applicable. |
| `postEphemeral?()` | No ephemeral message support | Missing | Not applicable. |
| `fetchChannelInfo?()` / `listThreads?()` / `fetchChannelMessages?()` | No separate channel/thread layer | Missing | Skip unless Chat SDK usage requires it later. |

## Linq message parsing scope

Normalize all Linq message-like payloads with one helper.

Input shapes to support:

- `MessageEventV2` from `message.received` / `message.sent` / `message.delivered` / `message.read` / `message.failed` webhooks.
- `MessageSendResponse` from `chats.messages.send()`.
- `Message` from `messages.retrieve()` and `chats.messages.list()`.

Fields to map:

- `Message.id` ← Linq message ID.
- `Message.threadId` ← encoded Linq `chat_id` / `data.chat.id`.
- `Message.text` ← joined text/link parts. Media-only messages should not become empty/meaningless if attachment metadata exists.
- `Message.formatted` ← `converter.toAst(text)`.
- `Message.author` ← `sender_handle` / `from_handle`; `isMe` from `direction === "outbound"`, `is_from_me`, or handle `is_me`.
- `Message.metadata.dateSent` ← best available `sent_at`, then `created_at`, then webhook `created_at`.
- `Message.metadata.edited` / `editedAt` ← message edited webhook/retrieved metadata where available.
- `Message.attachments` ← Linq media parts: type from MIME, `url`, `filename`, `mime_type`, `size_bytes`, dimensions if present later.
- `Message.links` ← Linq link parts and URLs if link metadata is available.
- Preserve the full Linq payload in `raw`.

## Webhook event scope

P0 subscription should stay minimal:

```json
{
  "subscribed_events": ["message.received"]
}
```

P1/P2 events that are implementable if we need them:

- `reaction.added` / `reaction.removed` → `chat.processReaction()`.
- `message.edited` → no obvious Chat SDK handler; useful for raw storage or future sync, not bot routing.
- `message.sent`, `message.delivered`, `message.read`, `message.failed` → useful for observability/status, not initial bot routing.
- `chat.typing_indicator.started` / `.stopped` → Linq exposes events, but Chat SDK does not currently have a typing-event handler to route.
- `participant.*`, `chat.group_*`, `phone_number.*`, call events → out of adapter scope unless product needs them.

Webhook rules to preserve:

- Verify `X-Webhook-Signature` with HMAC-SHA256 over `{timestamp}.{raw_body}`.
- Use raw request bytes, not parsed JSON.
- Reject stale timestamps older than 5 minutes.
- Return 2xx quickly and run bot handling/storage through `waitUntil` when available.
- Store `signing_secret` immediately because Linq only returns it on creation.

## App integration scope

`apps/api/server/lib/bot.ts`

- Avoid fixed secret capture. Either pass a `getSigningSecret` provider into the adapter or reset/rebuild the cached bot after Linq setup changes the secret. Provider is cleaner because the adapter stays current without app restart.
- Pass Linq `baseURL` into the adapter so setup and send paths use the same environment.
- Keep bot business logic out of webhook routes.

`apps/api/server/lib/linq-api.ts`

- Keep `https://api.linqapp.com/api/partner` as the default base URL.
- Add subscription helpers beyond create: retrieve/list/update/delete as needed for idempotent setup.
- Keep webhook target URLs pinned with `version=2026-02-03`.

`apps/api/server/api/linq/setup/webhook.post.ts`

- Make setup idempotent:
  - if stored subscription exists and matches target/events, return it;
  - if stored subscription exists but target/events changed, update it when possible;
  - if the secret is missing or unrecoverable, recreate deliberately and store the new one;
  - surface target URL uniqueness conflicts clearly.
- After creating/rotating a secret, ensure the live bot will use it.

`apps/api/server/api/webhooks/linq.post.ts`

- Keep this route thin: clone request for storage, hand the original to `bot.webhooks.linq`, store only after successful verification/ack path.
- If we subscribe to more events later, raw storage should keep all verified events even when the adapter ignores them for Chat SDK routing.

`apps/api/server/lib/database.ts`

- Current settings table is enough for secret/subscription ID.
- Current raw event table is enough for fixture/debugging; keep `event_id` unique for dedupe.

## Implementation priority

### P0 — make the current receive/reply path reliable

- Fix cached signing-secret/baseURL behavior.
- Make Linq webhook setup idempotent.
- Add signed webhook fixture coverage for `message.received` v2026-02-03.
- Add focused coverage for `verifyLinqWebhookRequest()` timestamp/signature failures.
- Tighten message parsing for text/link/media parts from the current webhook shape.
- Run adapter and app typechecks.

### P1 — fill Chat SDK methods backed cleanly by Linq

- Implement `fetchThread()` via `chats.retrieve()`.
- Implement `fetchMessage()` via `messages.retrieve()`.
- Implement `fetchMessages()` via `chats.messages.list()` with cursor/limit and chronological output.
- Implement text-only `editMessage()` via `messages.update()`.
- Implement outbound `addReaction()` / `removeReaction()` via `messages.addReaction()`.
- Handle inbound `reaction.added` / `reaction.removed` if we subscribe to those events.

### P2 — richer messaging

- Outbound attachments from Chat SDK `files`/`attachments` using Linq media parts and optional `attachments.create()` pre-upload.
- Inbound attachment normalization for all media parts.
- Optional iMessage text decorations for bold/italic/underline/strikethrough.
- Optional voice memo support as a Linq-specific helper, not necessarily a generic Chat SDK method.
- Decide whether a Linq-specific `createChat()` helper is better than forcing Chat SDK `openDM()` semantics.

## Explicit non-goals for now

- Do not implement `deleteMessage()` as if it unsends messages; Linq's delete endpoint only deletes from the Linq API.
- Do not implement Chat SDK modals/actions/slash commands/app home for Linq.
- Do not implement native streaming.
- Do not broaden webhook subscriptions beyond `message.received` until routing/storage/tests are ready.
- Do not add a big abstraction layer around the adapter; most behavior can live in small parsing/rendering helpers inside `packages/adapter-linq`.

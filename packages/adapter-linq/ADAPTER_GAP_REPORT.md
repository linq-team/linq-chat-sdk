# Linq Chat SDK adapter gap report

This report compares the local Linq adapter against:

- Sendblue, via Librarian research
- Installed `@chat-adapter/whatsapp`
- Installed `@chat-adapter/telegram`
- The Chat SDK adapter contract

The goal is to show what is missing before this adapter feels like a mature production Chat SDK adapter.

---

## TL;DR

The Linq adapter is a solid **text-first MVP**.

It currently handles:

- signed webhooks
- inbound `message.received`
- basic message parsing
- text send/edit
- outbound reactions
- typing
- fetch message/history/thread
- buffered streaming

But compared with Sendblue plus mature Chat SDK adapters like WhatsApp and Telegram, it is missing the production-grade pieces:

```text
Biggest gaps:

1. Thread identity is too weak for groups
2. Webhook handling only covers inbound messages
3. No real media/file sending lifecycle
4. No inbound reaction/edit/read/delivery event support
5. No openDM / chat creation flow
6. Formatting is mostly plain text
7. Tests are concentrated in one file and miss many edge cases
```

---

## Current adapter shape

The adapter is split into reasonable files:

- `src/adapter.ts` — adapter orchestration
- `src/message-parser.ts` — message parsing and attachments
- `src/verification.ts` — webhook signature verification
- `src/reactions.ts` — reaction mapping
- `src/format-converter.ts` — Chat SDK formatting conversion
- `test/adapter.test.ts` — current test coverage

That structure is good.

The missing work is mostly capability coverage, not file organization.

---

## Quick comparison matrix

| Area | Linq adapter | Sendblue | WhatsApp | Telegram |
|---|---:|---:|---:|---:|
| Signed webhook verification | ✅ strong HMAC | ⚠️ simpler secret-header style | ✅ HMAC | ✅ secret token |
| Replay timestamp check | ✅ | ❌ / weak | platform-specific | platform-specific |
| Inbound messages | ✅ | ✅ | ✅ | ✅ |
| Inbound reactions | ❌ | ❌ / limited | ✅ | ✅ |
| Message edits from webhook | ❌ | ❌ | platform-limited | ✅ |
| Delivery/read/failure events | ❌ | partial/status callback-ish | ✅ delivery/status-ish | partial |
| Outbound text | ✅ | ✅ | ✅ | ✅ |
| Outbound edit | ✅ | ❌ / unsupported | ❌ platform limitation | ✅ |
| Delete message | ❌ throws | ❌ soft/no-op-ish | ❌ limitation | ✅ |
| Open DM | ❌ | ❌ | ✅ constructs thread | ✅ |
| File/media send | ❌ | ✅ `sendMediaMessage` helper | ✅ media support | ✅ document/media support |
| Inbound attachments | ✅ basic | ✅ media URL | ✅ | ✅ |
| Attachment rehydration | ❌ | ❌ / limited | ✅ | ✅ |
| Thread/channel helpers | minimal | moderate | DM-focused | broad |
| Streaming | ⚠️ buffers final text | ✅ paragraph chunks | ⚠️ buffered | ✅ post/edit fallback |
| Card/actions | ❌ fallback-ish text only | ❌ | ✅ buttons/list-ish | ✅ inline keyboard buttons |
| Config/env fallback | ❌ | likely ✅/partial | ✅ | ✅ |
| Tests | ⚠️ one main file | ⚠️ basic | broader | broader |

---

## What is already good

### 1. Webhook verification is stronger than Sendblue

The local verification code does the important security work:

- uses HMAC-SHA256
- signs `{timestamp}.{raw_body}`
- reads raw bytes
- rejects stale timestamps
- compares signatures in constant-ish time
- accepts `sha256=` prefix

This is stronger than the Sendblue-style “compare header secret” approach found during Librarian research.

### 2. The core adapter contract exists

Implemented methods include:

- `fetchMessages`
- `fetchMessage`
- `postMessage`
- `editMessage`
- `deleteMessage`, currently unsupported
- `addReaction`
- `removeReaction`
- `fetchThread`
- `startTyping`
- `stream`
- `handleWebhook`
- `parseMessage`
- `renderFormatted`
- `channelIdFromThreadId`
- `isDM`

### 3. Message parsing is isolated

`message-parser.ts` now owns:

- raw Linq payload normalization
- text/link/media parts
- attachment generation
- link extraction
- date parsing
- author mapping

That split is the right direction.

---

# Major gaps

## P0 — Thread identity is too weak

Current decoded ID shape:

```ts
type LinqThreadId = {
  chatId: string;
  isGroup?: boolean;
};
```

Current encoded forms:

```text
linq:{chatId}
linq:{chatId}:group
linq:{chatId}:dm
```

The problem is that `isGroup` is optional.

The same Linq chat can become multiple Chat SDK thread IDs depending on which path produced it:

```text
Webhook path:
  event.data.chat.is_group = true
  -> linq:chat-123:group

Fetch/send path:
  API response may only have chat_id
  -> linq:chat-123
```

Those are different SDK threads.

### Why this matters

This can split:

- subscriptions
- transcript/history
- thread state
- locks/dedupe behavior
- group vs DM behavior

### Mature adapter pattern

Telegram keeps explicit thread identity:

```text
telegram:{chatId}:{messageThreadId?}
```

WhatsApp keeps explicit identity:

```text
whatsapp:{phoneNumberId}:{userWaId}
```

Sendblue uses encoded segments for sender/contact/group.

### Recommendation

For MVP simplicity, use only:

```text
linq:{chatId}
```

Do not encode `isGroup` into the thread ID unless every code path can guarantee it.

Then make `isDM()` conservative instead of defaulting unknown chats to DM.

---

## P0 — Webhook handling is too narrow

Current behavior dispatches only:

```text
message.received
+
direction === "inbound"
```

Everything else returns `200 OK` and disappears.

### Missing webhook events

Likely missing from the adapter surface:

```text
message.sent
message.edited
message.delivered
message.read
message.failed

reaction.added
reaction.removed

participant.added
participant.removed

chat.created
chat.group_name.updated
chat.group_icon.updated
chat.typing_indicator.started
chat.typing_indicator.stopped

phone_number.status_updated
```

### Why this matters

Without those events, the SDK cannot power:

- reaction handlers
- edit-aware bots
- delivery/read/failure tracking
- group participant updates
- typing observability
- outbound message state updates

### Recommendation

Next webhook milestone:

```text
1. message.received -> processMessage        ✅ already
2. reaction.added/removed -> processReaction
3. message.edited -> processMessage or update-aware path
4. message.failed/read/delivered -> log or metadata event
5. unknown event -> log debug, still 200
```

---

## P0 — No inbound reaction handling

Outbound reactions exist:

- `addReaction`
- `removeReaction`
- `toLinqReaction`

But there is no webhook path for:

```text
reaction.added
reaction.removed
```

So Chat SDK `onReaction(...)` handlers will not fire.

### Compared to Sendblue

This is not worse than Sendblue. Librarian found Sendblue also lacks real inbound reaction dispatch.

### Compared to WhatsApp / Telegram

This is behind both. WhatsApp and Telegram expose reaction processing patterns.

### Recommendation

Add inbound reaction webhook dispatch before adding fancy message features.

It is high-value and relatively contained.

---

## P1 — Media/file sending is missing

Inbound media parsing exists.

Outbound `postMessage()` only sends:

```ts
parts: [{ type: "text", value: text }]
```

### Missing outbound support

Chat SDK postable messages can include:

```ts
attachments?: Attachment[];
files?: FileUpload[];
```

The adapter currently ignores those.

So these do not really work:

```ts
await thread.post({
  markdown: "here is a file",
  files: [...],
});
```

or:

```ts
await thread.post({
  raw: "image",
  attachments: [...],
});
```

### Compared to references

- Sendblue has a `sendMediaMessage` helper.
- WhatsApp has media support.
- Telegram has document/media support.

### Recommendation

Add a media pipeline:

```text
Chat SDK FileUpload / Attachment
        ↓
upload/create Linq attachment
        ↓
send message with media part
        ↓
return RawMessage
```

Test at least:

- image
- video
- audio
- generic file
- text + file
- multiple files, if Linq supports it
- file too large
- upload failure
- send failure after upload

---

## P1 — Attachment rehydration is missing

Current inbound attachment `fetchData()` uses the part URL directly.

That works only while the Linq media URL is still valid.

If the URL is presigned/expiring, persisted messages can lose usable downloads.

### Mature adapter pattern

WhatsApp and Telegram expose patterns like:

```text
attachment.fetchMetadata = { mediaId/fileId }
rehydrateAttachment(attachment)
downloadMedia(mediaId/fileId)
```

### Missing in Linq

Likely needed:

```ts
rehydrateAttachment(attachment: Attachment): Attachment
```

and stable `fetchMetadata`, for example:

```ts
{
  linqAttachmentId: "...",
  messageId: "...",
  partIndex: "..."
}
```

### Recommendation

Do not rely only on `url`.

Store stable fetch metadata so downloads can be refreshed later.

---

## P1 — Delete is missing

`deleteMessage()` currently throws `NotImplementedError`.

If Linq supports deletion/unsend, implement it.

If Linq does not support it, keep throwing, but document and test that this is intentional.

---

## P1 — No openDM / chat creation flow

The adapter assumes callers already know a Linq `chatId`.

That means proactive messages are awkward.

Mature adapters often support:

```ts
openDM(userId): Promise<string>
```

### Missing in Linq

No helper for:

```text
phone/email handle -> Linq chat -> thread ID
```

### Recommendation

Add one of these flows:

```text
openDM(handle)
  -> find existing chat
  -> create chat if needed
  -> return linq:{chatId}
```

or, if Linq chat creation must wait until first send:

```text
linq:pending:{handle}
```

Then `postMessage()` resolves pending thread -> real chat.

---

## P1 — Formatting is mostly plain text

`LinqFormatConverter.fromAst()` currently uses `toPlainText()`.

So outbound markdown/AST becomes plain text.

### What this means

This:

```md
**bold** and [link](https://example.com)
```

will not preserve rich formatting as platform formatting.

### Missing richer mapping

Potential Linq features not used yet:

- `text_decorations`
- link parts
- message effects
- richer multi-part messages

### Compared to references

- Telegram has serious markdown/entity conversion.
- WhatsApp maps some card/actions to interactive messages.
- Sendblue intentionally strips markdown, but has more dedicated tests proving that behavior.

### Recommendation

Short-term:

```text
Add tests proving current plain-text behavior is intentional.
```

Medium-term:

```text
Map markdown AST -> Linq text_decorations if Linq supports it.
```

---

## P1 — Cards/actions/modals/slash commands are not supported

This may be fine.

But compared to WhatsApp / Telegram, the adapter does not support:

- `processAction`
- `openModal`
- `processModalSubmit`
- `processSlashCommand`
- card-to-platform interactive UI
- button callbacks

### Recommendation

Do not prioritize this unless Linq has an actual interactive message primitive.

For iMessage/SMS-style bots, text fallback is probably fine.

---

## P1 — Stream support is minimal

Current `stream()` buffers all chunks and sends one final message.

### Compared to references

- Sendblue reportedly sends paragraph chunks.
- Telegram can do post/edit fallback streaming.
- WhatsApp buffers because editing is limited.

### Recommendation

Keep buffered streaming for now if simplicity matters.

But document it as:

```text
Streaming is buffered; users see only the final message.
```

If Linq edit is reliable, a later implementation could do:

```text
post placeholder
edit every N ms
final edit
```

---

## P2 — Config ergonomics are minimal

Current config:

```ts
export interface LinqAdapterConfig {
  apiKey: string;
  baseURL?: string;
  signingSecret: string;
}
```

### Missing compared with mature adapters

- env var fallback
- optional logger injection
- configurable `userName`
- `botUserId` / self identity
- default API URL docs
- initialize-time credential validation
- webhook version config/check
- clearer errors for missing config

### Recommendation

Add ergonomic factory defaults:

```ts
createLinqAdapter({
  apiKey: process.env.LINQ_API_KEY,
  signingSecret: process.env.LINQ_SIGNING_SECRET,
  baseURL: process.env.LINQ_API_URL,
  userName: process.env.LINQ_BOT_USERNAME ?? "linq",
  logger,
});
```

And validate missing required values early.

---

## P2 — `persistMessageHistory` should become `persistThreadHistory`

The adapter currently sets:

```ts
readonly persistMessageHistory = true;
```

In Chat SDK types, `persistMessageHistory` is deprecated in favor of `persistThreadHistory`.

### Recommendation

Use:

```ts
readonly persistThreadHistory = true;
```

Optionally keep both temporarily if compatibility matters.

---

## P2 — Channel-level behavior is thin

Current behavior:

```ts
channelIdFromThreadId(threadId: string): string {
  return threadId;
}
```

No implementation for:

- `fetchChannelInfo`
- `fetchChannelMessages`
- `postChannelMessage`
- `listThreads`

This may be fine for SMS/iMessage-style adapters, but it should be intentional.

### Recommendation

Either document:

```text
Linq channel === Linq chat/thread
```

or add minimal `fetchChannelInfo` that delegates to `fetchThread`.

---

## P2 — Error handling is basic

The adapter currently special-cases:

- 404 in `fetchMessage`
- 403 in `startTyping`

But most SDK errors pass through raw.

### Missing

- rate-limit handling
- retry-after parsing
- consistent auth errors
- network error wrapping
- better validation errors
- typed adapter-specific errors

### Recommendation

Not urgent, but useful before publishing.

---

# Testing gaps

Current test coverage lives in one file:

```text
test/adapter.test.ts
```

It is good MVP coverage, but not enough for a mature adapter.

---

## Good tests already present

Existing tests cover:

- missing webhook signature
- invalid webhook signature
- valid message webhook
- dispatch to `processMessage`
- parse text
- parse links
- parse media
- preserve raw `reply_to`
- retrieved edited message metadata
- post text
- reject empty post
- typing
- group typing skip
- 403 typing skip
- stream buffering
- channel ID
- DM detection

---

## Missing tests: must-have

### 1. Thread ID roundtrip tests

Need dedicated tests for:

```text
encodeThreadId({ chatId })
decodeThreadId("linq:chat")

encodeThreadId({ chatId, isGroup: true })
decodeThreadId("linq:chat:group")

encodeThreadId({ chatId, isGroup: false })
decodeThreadId("linq:chat:dm")

invalid adapter prefix
missing chat ID
unknown kind
chat IDs containing ":"
```

If Linq IDs can contain special chars, use base64url encoding.

### 2. Webhook verification edge tests

Add standalone tests for:

```text
stale timestamp
future timestamp beyond tolerance
non-numeric timestamp
odd-length hex signature
invalid hex characters
sha256= prefix
missing signingSecret -> 503
raw body exactness
body whitespace changes break signature
```

Suggested file:

```text
test/verification.test.ts
```

### 3. Invalid JSON webhook test

Test:

```text
signed invalid JSON -> 400
```

### 4. Ignored webhook event tests

Test that these return 200 but do not dispatch message processing:

```text
outbound message.received
message.sent
message.read
message.delivered
reaction.added
unknown event
```

This documents current behavior.

### 5. Reaction mapping tests

`reactions.ts` should have its own tests.

Cases:

```text
thumbs_up -> like
+1 -> like
👍 -> like

thumbs_down -> dislike
heart/love/❤️ -> love
laugh/😂 -> laugh
! / emphasize -> emphasize
? / question -> question

unknown emoji -> custom
{{emoji:name}} cleanup
:emoji: cleanup
```

Suggested file:

```text
test/reactions.test.ts
```

### 6. Format converter tests

`format-converter.ts` currently has no dedicated tests.

Add tests proving intentional behavior:

```text
plain text roundtrip
markdown bold -> expected plain text
link markdown -> expected plain text
list -> expected plain text
code -> expected plain text
card fallback behavior through renderPostable
```

This matters because Sendblue had detailed format-converter tests.

### 7. Fetch method tests

Missing tests for:

```text
fetchMessages passes cursor/limit
fetchMessages sorts chronological
fetchMessages returns nextCursor
fetchMessage returns parsed message
fetchMessage returns null on 404
fetchMessage rethrows non-404
fetchThread maps id/channelName/isDM/metadata
```

### 8. Edit/delete tests

Add:

```text
editMessage sends text + part_index 0
editMessage rejects empty text
deleteMessage throws NotImplementedError
```

If delete is implemented later, update the last one.

### 9. Attachment tests

Current media parsing test is useful but shallow.

Add:

```text
image MIME -> image
video MIME -> video
audio MIME -> audio
unknown MIME -> file
width/height
width_px/height_px
fetchData success
fetchData non-200 throws
missing id uses url in error message
```

Later, add rehydration tests.

### 10. Integration-style Chat SDK tests

Chat SDK adapter docs recommend full-pipeline tests:

```text
Chat -> webhook -> adapter -> handler
```

Missing flows:

```text
onDirectMessage fires for DM
onSubscribedMessage after subscribe
self-message filtering behavior
waitUntil behavior
dedupe behavior if relevant
reaction handler once implemented
```

---

# Sendblue-specific comparison

From Librarian research, Sendblue has or exposes:

- `stream()` that sends paragraph chunks
- `sendMediaMessage()`
- service filtering / iMessage vs SMS-ish behavior
- `evaluateService()`
- `listLines()`
- `getSdk()` escape hatch
- status callback URL support

## Which Sendblue ideas matter for Linq?

Likely useful:

```text
sendMediaMessage / media support
streaming strategy
getSdk/api escape hatch
service/account helpers, if Linq has equivalent APIs
```

Probably Sendblue-specific:

```text
evaluateService()
allowedServices
listLines()
statusCallbackUrl
```

Do not copy those blindly unless Linq has equivalent phone-line/service APIs.

---

# WhatsApp / Telegram patterns worth copying

## WhatsApp patterns

Relevant mature-adapter patterns:

- `lockScope = "channel"`
- `persistThreadHistory = true`
- env fallback factory
- `botUserId`
- `openDM`
- `markAsRead`
- `downloadMedia`
- `rehydrateAttachment`
- media-specific attachment handling
- interactive reply handling
- reaction webhook handling
- text chunking for platform limits

Most relevant for Linq:

```text
openDM
markAsRead if Linq supports it
download/rehydrate attachments
reaction webhook handling
env fallback config
persistThreadHistory
```

## Telegram patterns

Relevant mature-adapter patterns:

- webhook + polling modes
- `getUser`
- `postChannelMessage`
- `fetchChannelInfo`
- `fetchChannelMessages`
- `openDM`
- topic/thread ID support
- edit/delete support
- reaction updates
- attachment rehydration
- MarkdownV2 formatting
- cached messages when platform history is limited

Most relevant for Linq:

```text
stable thread ID shape
edit/delete tests
inbound edited message handling
reaction updates
format converter tests
attachment rehydration
```

Polling probably does not matter for Linq webhooks.

---

# Prioritized backlog

## P0 — Correctness first

```text
[ ] Decide stable Linq thread ID format
[ ] Fix group/DM identity drift
[ ] Add thread ID roundtrip tests

[ ] Add reaction.added / reaction.removed webhook handling
[ ] Add processReaction integration

[ ] Add tests for webhook ignored/unsupported event types
```

## P1 — Production usefulness

```text
[ ] Implement openDM / chat lookup-or-create
[ ] Implement outbound file/media sending
[ ] Add attachment fetchMetadata
[ ] Add rehydrateAttachment
[ ] Implement deleteMessage if Linq supports it

[ ] Add message.edited webhook support
[ ] Add delivery/read/failed event handling or logging
[ ] Add markRead if Linq supports it
```

## P2 — Polish / publish quality

```text
[ ] Add env var fallback in createLinqAdapter
[ ] Add logger config
[ ] Add configurable userName
[ ] Switch persistMessageHistory -> persistThreadHistory
[ ] Add initialize-time validation
[ ] Add format-converter tests
[ ] Add verification unit tests
[ ] Add README feature matrix
```

---

# Honest current feature matrix

| Feature | Status |
|---|---|
| Inbound text messages | ✅ |
| Outbound text messages | ✅ |
| Fetch messages | ✅ |
| Fetch single message | ✅ |
| Fetch thread | ✅ |
| Edit message | ✅ text / part 0 only |
| Delete message | ❌ |
| Add reaction | ✅ |
| Remove reaction | ✅ |
| Inbound reaction events | ❌ |
| Typing indicator | ✅ start only |
| Open DM | ❌ |
| Send files/media | ❌ |
| Receive files/media | ✅ basic |
| Rehydrate attachments | ❌ |
| Streaming | ⚠️ buffered final send |
| Cards/actions | ❌ fallback text only |
| Modals | ❌ |
| Slash commands | ❌ |
| Webhook verification | ✅ |
| Webhook replay protection | ✅ |
| Group chats | ⚠️ partial / identity risk |

---

# Final take

The adapter is not bad.

It is currently:

```text
text-first
existing-chat-first
message.received-first
media-light
group-cautious
```

The strongest next move is not random feature work.

The strongest sequence is:

```text
1. Fix stable thread IDs
2. Add inbound reaction webhook support
3. Add dedicated tests for verification / reactions / format / IDs
4. Add media send + attachment rehydration
5. Add openDM
```

That gets the adapter from “works for demos/basic bots” to “feels like a real Chat SDK adapter.”

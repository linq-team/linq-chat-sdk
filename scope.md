# Linq adapter scope

This file tracks what is still left in the Linq Chat SDK adapter.

Keep this readable and practical: each item should say what is missing, why it matters, and any Linq-specific caveats.

## Current adapter status

The adapter can already handle the core receive/reply path:

- Verify signed Linq webhooks.
- Convert inbound `message.received` events into Chat SDK messages.
- Send text replies to an existing Linq chat.
- Fetch thread metadata with `chats.retrieve()`.
- Fetch recent chat history with `chats.messages.list()`.
- Fetch a single message with `messages.retrieve()`.
- Edit text messages with `messages.update()`.
- Render formatted Chat SDK content as markdown text.
- Add and remove reactions with `messages.addReaction()`.
- Cache direct-message vs group-chat metadata in new thread IDs.
- Detect direct-message vs group-chat threads from encoded metadata.
- Skip typing indicators for known group chats and ignore Linq's expected group-chat typing rejection.
- Show typing indicators for direct-message chats.

## Work still left

### 1. Delete messages

Status: **intentionally not implemented**

Linq's delete endpoint only deletes the message from the Linq API.

It does **not** unsend or remove the message from the recipient's chat.

Because Chat SDK callers usually expect `deleteMessage()` to remove the visible chat message, implementing this directly would be misleading.

Only implement this if product explicitly accepts the narrower Linq semantics.

### 2. Richer inbound message parsing

Status: **basic but useful**

Current parsing handles:

- text parts
- link parts as text
- media parts as Chat SDK attachments
- sender identity
- basic sent timestamp

Still missing:

- edited metadata
- delivered/read status
- link previews as `links`
- reactions on inbound message parts
- image/video dimensions when available
- richer media metadata

### 3. Outbound attachments and media

Status: **not implemented**

Current `postMessage()` sends text only.

Future support should map Chat SDK attachments/files to Linq media parts.

Likely areas to check:

- Linq attachment upload/create endpoints
- Linq media part requirements
- file size and MIME type limits

### 4. Inbound reaction webhooks

Status: **not implemented**

Outbound add/remove reactions work.

Inbound reaction events are not routed into Chat SDK yet.

Future support should subscribe to:

- `reaction.added`
- `reaction.removed`

Then map those webhooks into `chat.processReaction()`.

### 5. Opening new direct messages / creating chats

Status: **not implemented**

Linq creates chats with an initial message.

Chat SDK `openDM()` expects to return a thread before posting.

Those semantics do not line up cleanly.

This needs a deliberate product/API decision before implementation.

### 6. Channel and thread listing APIs

Status: **not implemented**

Linq does not have the same channel/thread split that platforms like Slack have.

Skip channel-level APIs unless the app needs them later.

### 7. Native streaming

Status: **intentionally not implemented**

Linq does not have native streaming message support.

The adapter currently buffers stream text and posts once.

Once `editMessage()` exists, Chat SDK fallback streaming may technically work, but Linq edit limits make long streaming risky.

Use fallback streaming carefully.

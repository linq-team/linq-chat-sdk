# @linqapp/chat-sdk-adapter

## 0.6.0

### Minor Changes

- caa7980: Keep the line breaks between blocks and list items in outbound text.
  
  `renderDecoratedPostable` ran every block and list item together, so a heading,
  a paragraph and a bullet list arrived as
  `Pregame pick97 Wythe Avefirst detailsecond detail`. Its renderer mirrored the
  `mdast-util-to-string` join that `toPlainText` used through chat 4.33.0; chat
  4.34.0 replaced that with a structure-aware renderer, and the adapter kept the
  old one. Posting and editing the same markdown had drifted apart as a result,
  since `editMessage` goes through `toPlainText`.
  
  The renderer now emits the same separators — a blank line between blocks, a
  newline between list items, blockquote lines and table rows, a tab between
  cells — and shifts every decoration range past them, so styles stay on their
  characters. Requires `chat` 4.34.0 or later; the peer range moves from
  `^4.28.1` to `^4.34.0`.

## 0.5.1

### Patch Changes

- b36b95c: Move to @linqapp/sdk 0.47.0.
  
  The adapter was held at 0.40.0 because 0.41.0 through 0.46.0 shipped an empty
  Webhooks class, dropping the `UnwrapWebhookEvent` types it depends on. 0.47.0
  restores them. Adds coverage entries for the two new events, both ignored:
  `chat.background_update_failed` and `contact_card.received`.

## 0.5.0

### Minor Changes

- 0cec668: Send text decorations and idempotency keys.
  
  Markdown formatting now reaches iMessage as real styling instead of being
  flattened: `**bold**`, `_italic_`, and `~~strikethrough~~` become
  `text_decorations` ranges on the outbound text part. `postMessage` takes an
  optional third argument for the Linq-native options the Chat SDK has no
  equivalent for — `textDecorations` (the only route to animations and underline)
  and `idempotencyKey`.

## 0.4.0

### Minor Changes

- f98ee5b: Report delivery status for outbound messages. `adapter.onDeliveryStatus()`
  surfaces `message.sent`, `message.delivered`, `message.read`, and
  `message.failed`, so a caller can tell a delivered message from one the carrier
  rejected instead of treating every send as a success. Chat SDK has no
  delivery-status dispatch, so this lives on the adapter — reach it with
  `chat.getAdapter("linq")`.

### Patch Changes

- a746e67: Record a disposition for every Linq webhook event type, so an
  `@linqapp/sdk` upgrade that adds events fails typecheck instead of passing
  unnoticed.

## 0.3.0

### Minor Changes

- ee6bae3: Implement `markRead()`. Chat SDK's read receipts now reach Linq, so a bot that
  processes a message can clear the unread badge on the recipient's device.
  Linq marks a whole chat read rather than up to a specific message, so the
  `messageId` argument is accepted for interface compatibility and ignored.

## 0.2.1

### Patch Changes

- 36ed580: Ship `CHANGELOG.md` inside the published package, so the release notes are
  visible on npm rather than only in the repository.

## 0.2.0

Released before this package adopted changesets, so this entry is written by
hand from the merged pull requests.

### Minor Changes

- `openDM()` is implemented. It returns a pending thread ID,
  `linq:pending:{handle}`, and the chat is created on that thread's first
  message — Linq has no empty-chat primitive. The ID is deterministic, so a
  handle you have never messaged can be addressed without a round trip, and a
  repeated first post reuses the existing chat rather than starting a parallel
  one. Previously the adapter could only reply to chats that already existed,
  which made proactive sends impossible.

### Patch Changes

- Webhook verification moved to [Standard Webhooks](https://www.standardwebhooks.com).
  The adapter previously read only Linq's legacy `X-Webhook-*` headers and
  hand-rolled an HMAC over `{timestamp}.{raw_body}`. Linq marks those headers
  deprecated and signs with `webhook-id` / `webhook-timestamp` /
  `webhook-signature`, so the old path worked only while both header sets were
  sent. Verification now delegates to `standardwebhooks`, the reference
  implementation.
- Tracks `@linqapp/sdk` `^0.40.0`, up from `^0.22.1`.
- Operations that need an existing chat — fetching messages, editing, typing,
  reactions — now fail on a pending thread with the remedy instead of a
  confusing API error.

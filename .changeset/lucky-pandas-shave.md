---
"@linqapp/chat-sdk-adapter": minor
---

Send text decorations and idempotency keys.

Markdown formatting now reaches iMessage as real styling instead of being
flattened: `**bold**`, `_italic_`, and `~~strikethrough~~` become
`text_decorations` ranges on the outbound text part. `postMessage` takes an
optional third argument for the Linq-native options the Chat SDK has no
equivalent for — `textDecorations` (the only route to animations and underline)
and `idempotencyKey`.

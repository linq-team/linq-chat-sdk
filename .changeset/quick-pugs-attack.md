---
"@linqapp/chat-sdk-adapter": minor
---

Keep the line breaks between blocks and list items in outbound text.

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

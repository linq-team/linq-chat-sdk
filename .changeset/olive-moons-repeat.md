---
"@linqapp/chat-sdk-adapter": patch
---

Move to @linqapp/sdk 0.47.0.

The adapter was held at 0.40.0 because 0.41.0 through 0.46.0 shipped an empty
Webhooks class, dropping the `UnwrapWebhookEvent` types it depends on. 0.47.0
restores them. Adds coverage entries for the two new events, both ignored:
`chat.background_update_failed` and `contact_card.received`.

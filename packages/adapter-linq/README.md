# @linqapp/chat-sdk-adapter

[Linq](https://linqapp.com) adapter for [Chat SDK](https://www.npmjs.com/package/chat) (`chat`). Build agentic chatbots that talk over iMessage and SMS through Linq, using the same handler code you'd write for Slack, Telegram, or WhatsApp.

## Install

```bash
npm install @linqapp/chat-sdk-adapter chat
```

## Quick start

```ts
import { createLinqAdapter } from "@linqapp/chat-sdk-adapter";
import { Chat } from "chat";

const chat = new Chat({
  userName: "mybot",
  adapters: {
    linq: createLinqAdapter({
      apiKey: process.env.LINQ_API_KEY!,
      signingSecret: process.env.LINQ_WEBHOOK_SECRET!,
    }),
  },
});

chat.onDirectMessage(async (thread, message) => {
  await thread.subscribe();
  await thread.post(`you said: ${message.text}`);
});

chat.onReaction(["thumbs_up"], async (event) => {
  await event.thread.post("appreciate the tapback 🫡");
});
```

Then route Linq webhooks to the adapter from any framework with fetch-style handlers:

```ts
// e.g. a Nitro/Next.js/Hono POST route
export default async (request: Request) => {
  return chat.webhooks.linq(request);
};
```

Point a [Linq webhook subscription](https://docs.linqapp.com) at that route and subscribe to at least:

- `message.received`
- `reaction.added`
- `reaction.removed`

Other event types are acknowledged with a `200` and ignored.

## Configuration

| Option          | Required | Description                                                                                                              |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `apiKey`        | yes      | Linq API key used for all outbound API calls.                                                                            |
| `signingSecret` | yes      | Webhook signing secret. Requests are verified with HMAC-SHA256 over `{timestamp}.{raw_body}`, with replay-window checks. |
| `baseURL`       | no       | Override the Linq API base URL (e.g. sandbox).                                                                           |

## Supported features

| Feature                                            | Status                                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Inbound text messages                              | ✅                                                                                                                                 |
| Outbound text messages                             | ✅                                                                                                                                 |
| Group chats                                        | ✅ reply to existing groups received via webhook                                                                                   |
| Inbound media (images, audio, files)               | ✅ parsed as attachments with downloadable data                                                                                    |
| Outbound media / file sending                      | ✅ `attachments` and `files` on a message become media parts                                                                       |
| Inbound reactions (tapbacks + custom emoji)        | ✅ dispatch to `onReaction()`                                                                                                      |
| Outbound reactions (add/remove)                    | ✅                                                                                                                                 |
| Edit message                                       | ✅ text, first part only                                                                                                           |
| Fetch message / history / thread                   | ✅                                                                                                                                 |
| Typing indicators                                  | ✅ DMs only (Linq rejects typing in groups)                                                                                        |
| Webhook signature verification + replay protection | ✅                                                                                                                                 |
| Streaming                                          | ⚠️ buffered — recipients see one final message                                                                                     |
| Sticker reactions                                  | ❌ skipped (no Chat SDK equivalent)                                                                                                |
| Delete message                                     | ❌ Linq cannot unsend on the recipient's device                                                                                    |
| `openDM()` / creating chats                        | ❌ Linq creates chats with an initial message, which doesn't match Chat SDK semantics — the adapter only replies to existing chats |
| Cards                                              | ✅ four composable layers: plain-text fallback, reply-mapped buttons (`onAction` works in-chat), interactive web cards via rich link previews, and native iMessage app-card bubbles |
| Modals, slash commands                             | ❌ no Linq equivalent                                                                                                              |

## Thread IDs

Thread IDs are stable and always take the form `linq:{chatId}`, regardless of whether the thread was first seen via webhook or API. Group vs DM identity is tracked internally from webhook payloads and `chats.retrieve()` calls; legacy `linq:{chatId}:group` / `linq:{chatId}:dm` IDs from older versions still decode.

## Attachments

Attach media by putting `attachments` or `files` on a message:

```ts
await thread.post({
  markdown: "here's the report 📎",
  attachments: [
    { type: "file", url: "https://example.com/report.pdf", mimeType: "application/pdf" },
  ],
});

// or send raw bytes
await thread.post({
  markdown: "fresh render",
  files: [{ filename: "render.png", mimeType: "image/png", data: pngBuffer }],
});
```

How each attachment is delivered:

- **Public HTTPS URL, ≤ 10MB** — sent by reference; Linq downloads it on send. No upload round-trip, so forwarding inbound Linq media (already on `cdn.linqapp.com`) is free.
- **Raw bytes, non-HTTPS URLs, or files > 10MB** — uploaded via `POST /v3/attachments` (up to 100MB) and sent by `attachment_id`.

A message can be media-only (no text). Inbound attachments expose `fetchData()` to download, and survive queue serialization via `rehydrateAttachment` (Linq CDN URLs don't expire). Audio is sent as a downloadable file attachment — the dedicated iMessage voice-memo bubble endpoint isn't wired up yet.

## Cards

iMessage has no native buttons for arbitrary recipients, so the adapter layers up to four strategies. They compose — enable what you need:

### 1. Plain-text fallback (always on)

Title, subtitle, text, fields, links, dividers, and tables render as clean plain text (markdown is stripped — iMessage would show literal `**`); `<Image>` elements and the card's `imageUrl` become real image media parts. An explicit `fallbackText` on `{ card, fallbackText }` replaces the generated text.

### 2. Reply-mapped buttons (`cardReplyActions`, on by default)

Buttons render as numbered reply options — `Reply 1 to Approve or 2 to Reject` — and the next inbound reply in that chat matching a number, label, or action ID dispatches the button's `onAction` handler (with real sender attribution) instead of being processed as a message. This is the only in-chat button mechanism that exists on iMessage/SMS. The latest card with buttons per chat is live for 24h and is consumed by one match; non-matching replies pass through untouched.

### 3. Interactive web cards (`cardLinks`)

```ts
createLinqAdapter({
  apiKey,
  signingSecret,
  cardLinks: { baseUrl: "https://your-bot.example.com/cards" },
});
```

Cards are hosted at signed, short-lived URLs (served by `handleWebhook` — point `baseUrl` at your existing public endpoint) and sent as rich link previews. Tapping opens the full card as a clean mobile page whose buttons and selects POST back and dispatch `onAction`. DM taps are attributed to the chat's counterpart; group taps are anonymous. Cards live in adapter memory: a restart invalidates in-flight card pages (replies via layer 2 keep working).

### 4. Native app-card bubbles (`cardAppIdentity`, requires `cardLinks`)

```ts
createLinqAdapter({
  apiKey,
  signingSecret,
  cardLinks: { baseUrl: "https://your-bot.example.com/cards" },
  cardAppIdentity: { bundleId: "com.acme.bot.MessagesExtension", name: "Acme", teamId: "ACMETEAM12" },
});
```

Cards go out as Linq `imessage_app` parts — real iMessage card bubbles with an image (title/subtitle overlaid), caption/subcaption, and trailing labels mapped from the card's title, subtitle, fields, and first image. The subcaption carries the reply hint, the tap URL opens the layer-3 web card, and the fallback text covers notifications. Caveats: iMessage-only (Linq rejects app cards over SMS), and `image_url` only renders in chats Linq considers trusted (healthy chat with inbound activity) — unhealthy chats get the text layout silently.

```tsx
await thread.post(
  <Card title="Order #1234" subtitle="Ready for review" imageUrl="https://cdn.example.com/receipt.png">
    <CardText>Your order has been received!</CardText>
    <Fields>
      <Field label="Total" value="$42" />
    </Fields>
    <Actions>
      <Button id="approve" style="primary">Approve</Button>
      <Button id="reject" style="danger">Reject</Button>
    </Actions>
  </Card>,
);
// text mode  → one bubble: "Order #1234 … Reply 1 to Approve or 2 to Reject"
// link mode  → rich preview bubble → tap → interactive web card
// app mode   → native card bubble; replying "1" fires onAction("approve")
```

## Reactions

Standard iMessage tapbacks map to normalized Chat SDK emoji in both directions:

| Linq tapback | Chat SDK emoji |
| ------------ | -------------- |
| `like`       | `thumbs_up`    |
| `dislike`    | `thumbs_down`  |
| `love`       | `heart`        |
| `laugh`      | `laugh`        |
| `emphasize`  | `exclamation`  |
| `question`   | `question`     |

Custom emoji reactions pass through the default emoji resolver (e.g. `👍` → `thumbs_up`), falling back to the raw emoji for anything unmapped.

## Development

```bash
pnpm install
pnpm test        # vitest
pnpm typecheck
pnpm build
```

A full example app (Nitro server wiring Linq, Telegram, and WhatsApp adapters into one bot) lives in [`apps/api`](../../apps/api) in this repo.

## Live smoke test

`smoke-live.mjs` drives this adapter against the **real Linq API** so you can validate a sandbox in one command. Run `pnpm build` first (it imports `./dist`).

Get a sandbox number with the [Linq CLI](https://www.npmjs.com/package/@linqapp/cli): `linq signup --phone <your cell>`, then grab the token from `~/.linq/config.json`.

```bash
# outbound: bootstrap a chat and send text + two images (one by URL, one pre-uploaded)
LINQ_API_KEY=<token> LINQ_FROM=<sandbox number> LINQ_TEST_TO=<your cell> \
  node smoke-live.mjs send

# cards: send Chat SDK cards end-to-end — a full text card, a card with an image,
# and the image+buttons-only card that used to silently vanish
LINQ_API_KEY=<token> LINQ_FROM=<sandbox number> LINQ_TEST_TO=<your cell> \
  node smoke-live.mjs cards

# inbound: receive real webhooks (text + reactions), optionally echo-reply
LINQ_API_KEY=<token> LINQ_SIGNING_SECRET=<webhook secret> LINQ_ECHO=1 \
  node smoke-live.mjs serve
# then tunnel it (cloudflared/ngrok) and register the URL as a Linq webhook subscription
```

| Env                          | Mode  | Purpose                                                                           |
| ---------------------------- | ----- | --------------------------------------------------------------------------------- |
| `LINQ_API_KEY`               | both  | Linq API token                                                                    |
| `LINQ_FROM` / `LINQ_TEST_TO` | send  | sender (sandbox) number / your phone — or set `LINQ_TEST_CHAT_ID` to reuse a chat |
| `LINQ_SIGNING_SECRET`        | serve | webhook signing secret (from the subscription)                                    |
| `LINQ_BASE_URL`              | both  | override API base URL (optional)                                                  |
| `LINQ_ECHO=1`                | serve | reply to inbound messages so you get a round-trip on the device                   |

## License

[Apache-2.0](../../LICENSE)

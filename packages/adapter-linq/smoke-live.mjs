// Live smoke test against the REAL Linq API, through the real adapter.
// Whatever lands on your phone is exactly what ships.
//
//   send       — bootstrap a chat (or reuse one) and send text + two images
//   cards      — send Chat SDK cards (incl. the image+buttons card that used to vanish)
//   cards-link — send an INTERACTIVE card as a rich link preview; tapping its
//                buttons dispatches onAction and replies in the thread.
//                needs a public tunnel: LINQ_CARD_BASE_URL=https://<tunnel>/cards
//   cards-reply— send a card with numbered reply options; replying "1"/"Approve"
//                dispatches onAction. registers a TEMPORARY webhook subscription
//                (scoped to LINQ_FROM, deleted on ctrl-c).
//                needs: LINQ_PUBLIC_URL=https://<tunnel>  LINQ_FROM=+1...
//   serve      — receive real webhooks (text/reactions) and optionally echo-reply
//
// Run from packages/adapter-linq so deps + ./dist resolve.
//
//   pnpm build   # make sure dist is current
//
//   LINQ_API_KEY=...  LINQ_FROM=+1...  LINQ_TEST_TO=+1<your phone> \
//   [LINQ_BASE_URL=https://sandbox...] node smoke-live.mjs send
//
//   LINQ_API_KEY=...  LINQ_SIGNING_SECRET=...  LINQ_ECHO=1 \
//   [PORT=8787] node smoke-live.mjs serve     # then tunnel + register webhook

import { createServer } from "node:http";
import { Buffer } from "node:buffer";

import { LinqAPIV3 } from "@linqapp/sdk";
import {
  Actions,
  Button,
  Card,
  CardLink,
  CardText,
  Divider,
  Field,
  Fields,
  Image,
  LinkButton,
} from "chat";
import { createLinqAdapter } from "./dist/index.js";

const API_KEY = need("LINQ_API_KEY");
const BASE_URL = process.env.LINQ_BASE_URL || undefined;
// Real 1x1 PNG so Linq's content validation passes on the pre-upload path.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
// Full-size: iMessage only renders the large card-style link preview when the
// og:image is big; a 120px thumb gets the compact row treatment.
const IMAGE_URL =
  process.env.LINQ_TEST_IMAGE_URL ||
  "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/1200px-Cat03.jpg";

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env: ${name}`);
    process.exit(2);
  }
  return v;
}

function adapter(signingSecret = "unused-for-outbound") {
  return createLinqAdapter({ apiKey: API_KEY, baseURL: BASE_URL, signingSecret });
}

async function step(label, fn) {
  process.stdout.write(`  … ${label}`);
  try {
    const out = await fn();
    console.log(`\r  ✓ ${label}${out ? ` — ${out}` : ""}`);
    return true;
  } catch (err) {
    const status = err?.status ? ` [${err.status}]` : "";
    const body = err?.error ? ` ${JSON.stringify(err.error)}` : ` ${err?.message ?? err}`;
    console.log(`\r  ✗ ${label}${status}${body}`);
    return false;
  }
}

async function bootstrapChat(firstMessage) {
  let chatId = process.env.LINQ_TEST_CHAT_ID;

  if (!chatId) {
    const from = need("LINQ_FROM");
    const to = need("LINQ_TEST_TO");
    const sdk = new LinqAPIV3({ apiKey: API_KEY, baseURL: BASE_URL });
    console.log(`bootstrapping a chat ${from} → ${to} …`);
    const created = await sdk.chats.create({
      from,
      to: [to],
      message: { parts: [{ type: "text", value: firstMessage }] },
    });
    chatId = created.chat.id;
    console.log(`chat id: ${chatId}\n`);
  } else {
    console.log(`reusing chat ${chatId}\n`);
  }

  return chatId;
}

async function send() {
  const a = adapter();
  const chatId = await bootstrapChat("linq adapter smoke test 👋 (1/4)");
  const threadId = `linq:${chatId}`;
  console.log("sending through the adapter — watch your phone:");

  let ok = true;
  ok &= await step("2/4 outbound text", async () => {
    const r = await a.postMessage(threadId, "outbound text via the adapter ✅ (2/4)");
    return `msg ${r.id}`;
  });
  ok &= await step("3/4 image by public URL", async () => {
    const r = await a.postMessage(threadId, {
      markdown: "image by url (3/4)",
      attachments: [{ type: "image", url: IMAGE_URL, mimeType: "image/jpeg" }],
    });
    return `msg ${r.id}`;
  });
  ok &= await step("4/4 image by bytes (real /attachments pre-upload + PUT)", async () => {
    const r = await a.postMessage(threadId, {
      markdown: "image by bytes (4/4)",
      files: [{ filename: "smoke.png", mimeType: "image/png", data: PNG_1x1 }],
    });
    return `msg ${r.id}`;
  });

  console.log(
    ok
      ? "\nall sends accepted by Linq. confirm all 4 messages + both images arrived on the device."
      : "\nsomething was rejected — the error above is the real Linq response. that's the bug to fix before Wed.",
  );
  process.exit(ok ? 0 : 1);
}

// The card payloads below are exactly what chat-core hands the adapter after
// thread.post(<Card …/>) — JSX is flattened to these CardElement objects by
// toCardElement() before postMessage() runs.
async function cards() {
  const a = adapter();
  const chatId = await bootstrapChat("linq adapter card smoke test 🃏 (1/4)");
  const threadId = `linq:${chatId}`;
  console.log("sending cards through the adapter — watch your phone:");

  let ok = true;
  ok &= await step("2/4 full text card (title/fields/link/divider/buttons)", async () => {
    const r = await a.postMessage(
      threadId,
      Card({
        title: "Order #1234 (2/4)",
        subtitle: "Placed today",
        children: [
          CardText("Your order has been **received**! _No literal asterisks should show._"),
          Fields([Field({ label: "Name", value: "Eve" }), Field({ label: "Total", value: "$42" })]),
          CardLink({ url: "https://chat-sdk.dev/docs/cards", label: "View order" }),
          Divider(),
          Actions([
            Button({ id: "approve", label: "Approve", style: "primary" }),
            Button({ id: "reject", label: "Reject", style: "danger" }),
            LinkButton({ url: "https://linqapp.com", label: "Get help" }),
          ]),
        ],
      }),
    );
    return `msg ${r.id}`;
  });
  ok &= await step("3/4 card with an image element", async () => {
    const r = await a.postMessage(
      threadId,
      Card({
        title: "Card with image (3/4)",
        children: [
          CardText("This card should arrive as text + a real image attachment."),
          Image({ url: IMAGE_URL, alt: "cat" }),
        ],
      }),
    );
    return `msg ${r.id}`;
  });
  ok &= await step("4/4 regression: image + buttons only (used to vanish)", async () => {
    const r = await a.postMessage(
      threadId,
      Card({
        children: [
          Image({ url: IMAGE_URL, alt: "cat" }),
          Actions([Button({ id: "yes", label: "Yes" }), Button({ id: "no", label: "No" })]),
        ],
      }),
    );
    return `msg ${r.id}`;
  });

  console.log(
    ok
      ? "\nall card sends accepted by Linq. on the device, check: (2/4) one clean text bubble with no ** or dropped links, (3/4) text + image, (4/4) 'Options: Yes, No' + image."
      : "\na card send was rejected — the error above is the real Linq response.",
  );
  process.exit(ok ? 0 : 1);
}

// Full interactive-card loop, live: card goes out as a rich link preview, the
// local server (behind a tunnel) serves the card page, and button taps
// dispatch processAction — which replies back into the iMessage thread.
async function cardsLink() {
  const cardBaseUrl = need("LINQ_CARD_BASE_URL");
  const port = Number(process.env.PORT || 8787);
  const a = createLinqAdapter({
    apiKey: API_KEY,
    baseURL: BASE_URL,
    signingSecret: "unused-for-cards-link",
    cardLinks: { baseUrl: cardBaseUrl },
  });

  // Minimal ChatInstance stand-in: processAction is exactly what chat-core
  // exposes; here it replies in-thread so the tap is visible on the device.
  a.chat = {
    getLogger: () => console,
    processAction: async (event) => {
      console.log(
        `\n🔘 action dispatched  actionId=${event.actionId}  value=${JSON.stringify(event.value)}  by=${event.user?.userName}  thread=${event.threadId}`,
      );
      await a
        .postMessage(
          event.threadId,
          `✅ onAction fired: "${event.actionId}"${event.value ? ` (${event.value})` : ""} — tapped by ${event.user?.userName}`,
        )
        .then((r) => console.log(`   ↪︎ replied in thread, msg ${r.id}`))
        .catch((e) => console.log(`   ↪︎ reply failed: ${e?.message ?? e}`));
    },
  };

  createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
    }
    const request = new Request(`http://localhost:${port}${req.url}`, {
      method: req.method,
      headers,
      body: raw.length > 0 ? raw : undefined,
    });
    const response = await a.handleWebhook(request);
    console.log(`   ${req.method} ${req.url} → ${response.status}`);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  }).listen(port, async () => {
    console.log(`card server on http://localhost:${port} (public: ${cardBaseUrl})`);

    const chatId = await bootstrapChat("interactive card test — next message is a tappable card");
    const threadId = `linq:${chatId}`;

    const ok = await step("interactive card as rich link preview", async () => {
      const r = await a.postMessage(
        threadId,
        Card({
          title: "Order #1234",
          subtitle: "Tap to review",
          imageUrl: IMAGE_URL,
          children: [
            CardText("Your order is ready for review. **Approve** or **reject** below."),
            Fields([
              Field({ label: "Name", value: "Eve" }),
              Field({ label: "Total", value: "$42" }),
            ]),
            Divider(),
            Actions([
              Button({ id: "approve", label: "Approve", style: "primary", value: "order-1234" }),
              Button({ id: "reject", label: "Reject", style: "danger", value: "order-1234" }),
              LinkButton({ url: "https://linqapp.com", label: "Get help" }),
            ]),
          ],
        }),
      );
      return `msg ${r.id}`;
    });

    if (!ok) {
      process.exit(1);
    }

    console.log(
      "\ncard sent as a link preview. tap it on the device, hit Approve/Reject, and watch for the in-thread reply. ctrl-c when done.",
    );
  });
}

// The full composed experience: ONE native app-card bubble (image + overlaid
// title, captions, price columns) whose subcaption says how to reply, whose
// tap URL opens the interactive web card, and whose replies dispatch onAction.
async function cardsApp() {
  const publicUrl = need("LINQ_PUBLIC_URL").replace(/\/+$/, "");
  const fromNumber = need("LINQ_FROM");
  const port = Number(process.env.PORT || 8787);
  const sdk = new LinqAPIV3({ apiKey: API_KEY, baseURL: BASE_URL });

  console.log("registering temporary webhook subscription …");
  const subscription = await sdk.webhookSubscriptions.create({
    subscribed_events: ["message.received"],
    target_url: `${publicUrl}/webhook`,
    phone_numbers: [fromNumber],
  });
  console.log(`subscription ${subscription.id} → ${subscription.target_url}`);

  const cleanup = async () => {
    console.log(`\ndeleting webhook subscription ${subscription.id} …`);
    await sdk.webhookSubscriptions.delete(subscription.id).catch((e) => {
      console.log(`  cleanup failed (${e?.status}): delete it manually with the API`);
    });
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const a = createLinqAdapter({
    apiKey: API_KEY,
    baseURL: BASE_URL,
    signingSecret: subscription.signing_secret,
    cardLinks: { baseUrl: `${publicUrl}/cards` },
    cardAppIdentity: {
      bundleId: "com.milolabs.milo.MessagesExtension",
      name: "Milo",
      teamId: "MILOLABS42",
    },
  });

  a.chat = {
    getLogger: () => console,
    processAction: async (event) => {
      console.log(
        `\n🔘 onAction dispatched  actionId=${event.actionId}  value=${JSON.stringify(event.value)}  by=${event.user?.userName}`,
      );
      await a
        .postMessage(
          event.threadId,
          `✅ onAction fired: "${event.actionId}"${event.value ? ` (${event.value})` : ""}`,
        )
        .then((r) => console.log(`   ↪︎ replied in thread, msg ${r.id}`))
        .catch((e) => console.log(`   ↪︎ reply failed: ${e?.message ?? e}`));
    },
    processMessage: async (_adapter, threadId, factory) => {
      const msg = await factory();
      console.log(
        `\n📩 plain message (no action match)  thread=${threadId}  text=${JSON.stringify(msg.text)}`,
      );
    },
  };

  createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
    }
    const request = new Request(`http://localhost:${port}${req.url}`, {
      method: req.method,
      headers,
      body: raw.length > 0 ? raw : undefined,
    });
    const response = await a.handleWebhook(request);
    console.log(`   ${req.method} ${req.url} → ${response.status}`);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  }).listen(port, async () => {
    console.log(`server on http://localhost:${port} (public: ${publicUrl})`);

    const chatId = await bootstrapChat("full card experience test — next up: the real deal");
    const threadId = `linq:${chatId}`;

    const ok = await step("native app card + tap page + reply actions", async () => {
      const r = await a.postMessage(
        threadId,
        Card({
          title: "Order #1234",
          subtitle: "Ready for review",
          imageUrl: process.env.LINQ_CARD_IMAGE_URL || IMAGE_URL,
          children: [
            CardText("Eve's order is ready. Approve to start fulfillment."),
            Fields([
              Field({ label: "Total", value: "$42" }),
              Field({ label: "Items", value: "2 items" }),
            ]),
            Actions([
              Button({ id: "approve", label: "Approve", style: "primary", value: "order-1234" }),
              Button({ id: "reject", label: "Reject", style: "danger", value: "order-1234" }),
            ]),
          ],
        }),
      );
      return `msg ${r.id}`;
    });

    if (!ok) {
      await cleanup();
    }

    console.log(
      '\none bubble, three layers: native card look, tap → web card, reply "1"/"2" → onAction. ctrl-c to clean up.',
    );
  });
}

// Reply-mapped card actions, live: the card offers "Reply 1 to Approve or 2 to
// Reject"; a temporary webhook subscription delivers your reply, the adapter
// matches it, and onAction fires — no web page, works over SMS too.
async function cardsReply() {
  const publicUrl = need("LINQ_PUBLIC_URL").replace(/\/+$/, "");
  const fromNumber = need("LINQ_FROM");
  const port = Number(process.env.PORT || 8787);
  const sdk = new LinqAPIV3({ apiKey: API_KEY, baseURL: BASE_URL });

  console.log("registering temporary webhook subscription …");
  const subscription = await sdk.webhookSubscriptions.create({
    subscribed_events: ["message.received"],
    target_url: `${publicUrl}/webhook`,
    phone_numbers: [fromNumber],
  });
  console.log(`subscription ${subscription.id} → ${subscription.target_url}`);

  const cleanup = async () => {
    console.log(`\ndeleting webhook subscription ${subscription.id} …`);
    await sdk.webhookSubscriptions.delete(subscription.id).catch((e) => {
      console.log(`  cleanup failed (${e?.status}): delete it manually with the API`);
    });
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const a = createLinqAdapter({
    apiKey: API_KEY,
    baseURL: BASE_URL,
    signingSecret: subscription.signing_secret,
  });

  a.chat = {
    getLogger: () => console,
    processAction: async (event) => {
      console.log(
        `\n🔘 onAction dispatched  actionId=${event.actionId}  value=${JSON.stringify(event.value)}  by=${event.user?.userName}`,
      );
      await a
        .postMessage(
          event.threadId,
          `✅ onAction fired via reply: "${event.actionId}"${event.value ? ` (${event.value})` : ""}`,
        )
        .then((r) => console.log(`   ↪︎ replied in thread, msg ${r.id}`))
        .catch((e) => console.log(`   ↪︎ reply failed: ${e?.message ?? e}`));
    },
    processMessage: async (_adapter, threadId, factory) => {
      const msg = await factory();
      console.log(
        `\n📩 plain message (no action match)  thread=${threadId}  text=${JSON.stringify(msg.text)}`,
      );
    },
  };

  createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
    }
    const request = new Request(`http://localhost:${port}${req.url}`, {
      method: req.method,
      headers,
      body: raw.length > 0 ? raw : undefined,
    });
    const response = await a.handleWebhook(request);
    if (response.status !== 200) {
      console.log(`⚠️  ${req.method} ${req.url} → ${response.status}`);
    }
    res.writeHead(response.status);
    res.end(await response.text().catch(() => ""));
  }).listen(port, async () => {
    console.log(`webhook receiver on http://localhost:${port} (public: ${publicUrl}/webhook)`);

    const chatId = await bootstrapChat("reply-action card test — answer the next card by replying");
    const threadId = `linq:${chatId}`;

    const ok = await step("card with numbered reply options", async () => {
      const r = await a.postMessage(
        threadId,
        Card({
          title: "Order #1234",
          children: [
            CardText("Ready for review."),
            Actions([
              Button({ id: "approve", label: "Approve", style: "primary", value: "order-1234" }),
              Button({ id: "reject", label: "Reject", style: "danger", value: "order-1234" }),
            ]),
          ],
        }),
      );
      return `msg ${r.id}`;
    });

    if (!ok) {
      await cleanup();
    }

    console.log(
      '\nnow reply on your phone: "1", "2", "approve", or "reject" → watch for the onAction reply. any other text logs as a plain message. ctrl-c to clean up.',
    );
  });
}

async function serve() {
  const signingSecret = need("LINQ_SIGNING_SECRET");
  const a = adapter(signingSecret);
  const echo = process.env.LINQ_ECHO === "1";
  const port = Number(process.env.PORT || 8787);

  // Minimal stand-in for ChatInstance: log what the adapter dispatches, and
  // (optionally) reply so you get a real round-trip on the device.
  a.chat = {
    processMessage: async (_adapter, threadId, factory) => {
      const msg = await factory();
      console.log(
        `\n📩 inbound message  thread=${threadId}  from=${msg.author?.userName}  text=${JSON.stringify(msg.text)}  attachments=${msg.attachments?.length ?? 0}`,
      );
      if (echo && msg.text) {
        await a
          .postMessage(threadId, `echo: ${msg.text}`)
          .then((r) => console.log(`   ↪︎ replied msg ${r.id}`))
          .catch((e) => console.log(`   ↪︎ reply failed: ${e?.message ?? e}`));
      }
    },
    processReaction: (payload) => {
      console.log(
        `\n👍 inbound reaction  ${payload.added ? "added" : "removed"}  ${payload.emoji?.name}  on msg=${payload.messageId}`,
      );
    },
  };

  createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
    }
    const request = new Request(`http://localhost:${port}${req.url}`, {
      method: "POST",
      headers,
      body: raw,
    });
    const response = await a.handleWebhook(request);
    if (response.status !== 200) {
      console.log(`⚠️  webhook rejected: ${response.status} ${await response.text()}`);
    }
    res.writeHead(response.status);
    res.end(await response.text().catch(() => ""));
  }).listen(port, () => {
    console.log(`webhook receiver on http://localhost:${port}`);
    console.log("now expose it and register the webhook:");
    console.log(`  1. tunnel:   cloudflared tunnel --url http://localhost:${port}`);
    console.log("                (or: ngrok http " + port + ")");
    console.log("  2. register the https tunnel URL as a Linq webhook subscription");
    console.log("     events: message.received, reaction.added, reaction.removed");
    console.log(
      "  3. text the sandbox number from your phone — watch this log" + (echo ? " (echo on)" : ""),
    );
  });
}

const mode = process.argv[2];
if (mode === "send") await send();
else if (mode === "cards") await cards();
else if (mode === "cards-link") await cardsLink();
else if (mode === "cards-reply") await cardsReply();
else if (mode === "cards-app") await cardsApp();
else if (mode === "serve") await serve();
else {
  console.error("usage: node smoke-live.mjs <send|cards|cards-link|cards-reply|serve>");
  process.exit(2);
}

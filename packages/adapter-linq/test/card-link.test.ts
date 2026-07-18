import { Actions, Button, Card, CardText, Fields, Field, LinkButton } from "chat";
import type { Author, ChatInstance, Logger } from "chat";
import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter } from "../src/adapter";
import { LinqCardLinkServer, collectCardActions } from "../src/card-link";

const BASE_URL = "https://bot.example.com/linq/cards";

function createServer(overrides?: { ttlMs?: number; processAction?: ReturnType<typeof vi.fn> }) {
  const processAction = overrides?.processAction ?? vi.fn(async () => undefined);
  const actor: Author = {
    userId: "handle-1",
    userName: "+15551234567",
    fullName: "+15551234567",
    isBot: false,
    isMe: false,
  };
  const resolveActor = vi.fn(async () => actor);
  const server = new LinqCardLinkServer(
    { baseUrl: BASE_URL, ttlMs: overrides?.ttlMs },
    "test-secret",
    {
      getChat: () => ({ processAction }) as unknown as ChatInstance,
      getAdapter: () => ({ name: "linq" }),
      resolveActor,
      getLogger: () => ({ warn: vi.fn(), debug: vi.fn() }) as unknown as Logger,
    },
  );

  return { server, processAction, resolveActor, actor };
}

function sampleCard() {
  return Card({
    title: "Order #1234",
    subtitle: "Placed today",
    imageUrl: "https://example.com/header.png",
    children: [
      CardText("Your order has been **received**!"),
      Fields([Field({ label: "Name", value: "Eve" })]),
      Actions([
        Button({ id: "approve", label: "Approve", style: "primary", value: "order-1234" }),
        Button({ id: "reject", label: "Reject", style: "danger" }),
        LinkButton({ url: "https://example.com/help", label: "Get help" }),
      ]),
    ],
  });
}

describe("LinqCardLinkServer", () => {
  it("creates signed URLs under the configured base", () => {
    const { server } = createServer();
    const { url } = server.createCard(sampleCard(), { chatId: "chat-1", threadId: "linq:chat-1" });

    expect(url).toMatch(
      /^https:\/\/bot\.example\.com\/linq\/cards\/[0-9a-f-]{36}\.\d+\.[0-9a-f]{64}$/,
    );
  });

  it("serves the card page with OG tags and interactive controls", async () => {
    const { server } = createServer();
    const { url } = server.createCard(sampleCard(), { chatId: "chat-1", threadId: "linq:chat-1" });

    const response = await server.handleRequest(new Request(url));

    expect(response?.status).toBe(200);

    const html = await response?.text();

    expect(html).toContain('<meta property="og:title" content="Order #1234">');
    expect(html).toContain('<meta property="og:image" content="https://example.com/header.png">');
    expect(html).toContain('data-action-id="approve"');
    expect(html).toContain('data-action-id="reject"');
    expect(html).toContain('href="https://example.com/help"');
    // Markdown is stripped, not rendered literally.
    expect(html).toContain("Your order has been received!");
    expect(html).not.toContain("**received**");
  });

  it("ignores requests outside the card path", async () => {
    const { server } = createServer();

    server.createCard(sampleCard(), { chatId: "chat-1", threadId: "linq:chat-1" });

    expect(await server.handleRequest(new Request("https://bot.example.com/webhook"))).toBeNull();
    expect(
      await server.handleRequest(new Request("https://bot.example.com/linq/cards/a/b")),
    ).toBeNull();
  });

  it("rejects tampered tokens", async () => {
    const { server } = createServer();
    const { url } = server.createCard(sampleCard(), { chatId: "chat-1", threadId: "linq:chat-1" });
    const tampered = url.replace(/\.(\d+)\./, (_, exp) => `.${Number(exp) + 1}.`);

    const response = await server.handleRequest(new Request(tampered));

    expect(response?.status).toBe(404);
  });

  it("serves an expired page once the TTL passes", async () => {
    const { server } = createServer({ ttlMs: -1000 });
    const { url } = server.createCard(sampleCard(), { chatId: "chat-1", threadId: "linq:chat-1" });

    const response = await server.handleRequest(new Request(url));

    expect(response?.status).toBe(410);
    expect(await response?.text()).toContain("expired");
  });

  it("dispatches button actions with the button's own value and the resolved actor", async () => {
    const { server, processAction, actor } = createServer();
    const { cardId, url } = server.createCard(sampleCard(), {
      chatId: "chat-1",
      threadId: "linq:chat-1",
    });

    server.attachMessageId(cardId, "msg-9");

    const response = await server.handleRequest(
      new Request(url, {
        method: "POST",
        // A malicious client value must not override the button's declared value.
        body: JSON.stringify({ actionId: "approve", value: "spoofed" }),
      }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true });
    expect(processAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "approve",
        value: "order-1234",
        messageId: "msg-9",
        threadId: "linq:chat-1",
        user: actor,
      }),
      undefined,
    );
  });

  it("rejects actions the card does not declare", async () => {
    const { server, processAction } = createServer();
    const { url } = server.createCard(sampleCard(), { chatId: "chat-1", threadId: "linq:chat-1" });

    const response = await server.handleRequest(
      new Request(url, { method: "POST", body: JSON.stringify({ actionId: "self-destruct" }) }),
    );

    expect(response?.status).toBe(400);
    expect(processAction).not.toHaveBeenCalled();
  });

  it("dispatches select actions only for declared options", async () => {
    const { server, processAction } = createServer();
    const card = Card({
      children: [
        {
          type: "actions",
          children: [
            {
              type: "select",
              id: "priority",
              label: "Priority",
              options: [
                { label: "High", value: "high" },
                { label: "Low", value: "low" },
              ],
            },
          ],
        },
      ],
    });
    const { url } = server.createCard(card, { chatId: "chat-1", threadId: "linq:chat-1" });

    const bad = await server.handleRequest(
      new Request(url, {
        method: "POST",
        body: JSON.stringify({ actionId: "priority", value: "nope" }),
      }),
    );

    expect(bad?.status).toBe(400);

    const good = await server.handleRequest(
      new Request(url, {
        method: "POST",
        body: JSON.stringify({ actionId: "priority", value: "high" }),
      }),
    );

    expect(good?.status).toBe(200);
    expect(processAction).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "priority", value: "high" }),
      undefined,
    );
  });

  it("resolves the actor once and caches it on the card", async () => {
    const { server, resolveActor } = createServer();
    const { url } = server.createCard(sampleCard(), { chatId: "chat-1", threadId: "linq:chat-1" });
    const post = () =>
      server.handleRequest(
        new Request(url, { method: "POST", body: JSON.stringify({ actionId: "approve" }) }),
      );

    await post();
    await post();

    expect(resolveActor).toHaveBeenCalledTimes(1);
  });
});

describe("collectCardActions", () => {
  it("collects buttons and selects, including inside sections", () => {
    const card = Card({
      children: [
        Actions([Button({ id: "top", label: "Top" })]),
        {
          type: "section",
          children: [
            {
              type: "actions",
              children: [
                {
                  type: "select",
                  id: "nested",
                  label: "Nested",
                  options: [{ label: "A", value: "a" }],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(collectCardActions(card).map((action) => action.id)).toEqual(["top", "nested"]);
  });
});

describe("LinqAdapter with card links", () => {
  function createLinkTestAdapter() {
    const adapter = createLinqAdapter({
      apiKey: "test-key",
      signingSecret: "test-secret",
      cardLinks: { baseUrl: BASE_URL },
    });
    const send = vi.fn(async (chatId: string, _body: unknown) => ({
      chat_id: chatId,
      message: {
        id: "outbound-message-id",
        created_at: "2026-07-18T00:00:00.000Z",
        delivery_status: "queued",
        is_read: false,
        parts: [],
        sent_at: null,
      },
    }));
    const retrieve = vi.fn(async (chatId: string) => ({
      id: chatId,
      is_group: false,
      handles: [
        { id: "me", handle: "+15550000000", is_me: true, service: "imessage" },
        { id: "them", handle: "+15551234567", is_me: false, service: "imessage" },
      ],
    }));

    (
      adapter as unknown as {
        apiClient: { chats: { messages: { send: typeof send }; retrieve: typeof retrieve } };
      }
    ).apiClient = { chats: { messages: { send }, retrieve } };

    const processAction = vi.fn(async () => undefined);
    const chat = {
      processAction,
      getLogger: () => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
    } as unknown as ChatInstance;

    return { adapter, send, processAction, chat };
  }

  it("sends a card as a single link part", async () => {
    const { adapter, send } = createLinkTestAdapter();

    await adapter.postMessage("linq:chat-123", sampleCard());

    expect(send).toHaveBeenCalledTimes(1);

    const body = send.mock.calls[0]?.[1] as { message: { parts: unknown[] } };

    expect(body.message.parts).toHaveLength(1);
    expect(body.message.parts[0]).toEqual({
      type: "link",
      value: expect.stringMatching(/^https:\/\/bot\.example\.com\/linq\/cards\//),
    });
  });

  it("serves the card page and dispatches actions through handleWebhook", async () => {
    const { adapter, send, processAction, chat } = createLinkTestAdapter();

    await adapter.initialize(chat);
    await adapter.postMessage("linq:chat-123", sampleCard());

    const sendBody = send.mock.calls[0]![1] as { message: { parts: { value: string }[] } };
    const url = sendBody.message.parts[0]!.value;

    const page = await adapter.handleWebhook(new Request(url));

    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Order #1234");

    const action = await adapter.handleWebhook(
      new Request(url, { method: "POST", body: JSON.stringify({ actionId: "approve" }) }),
    );

    expect(action.status).toBe(200);
    expect(processAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "approve",
        value: "order-1234",
        messageId: "outbound-message-id",
        threadId: "linq:chat-123",
        adapter,
        user: expect.objectContaining({ userName: "+15551234567", isMe: false }),
      }),
      undefined,
    );
  });

  it("attributes group-chat taps to an anonymous actor", async () => {
    const { adapter, send, processAction, chat } = createLinkTestAdapter();

    (
      adapter as unknown as { apiClient: { chats: { retrieve: unknown } } }
    ).apiClient.chats.retrieve = vi.fn(async (chatId: string) => ({
      id: chatId,
      is_group: true,
      handles: [],
    }));

    await adapter.initialize(chat);
    await adapter.postMessage("linq:chat-123", sampleCard());

    const url = (send.mock.calls[0]![1] as { message: { parts: { value: string }[] } }).message
      .parts[0]!.value;

    await adapter.handleWebhook(
      new Request(url, { method: "POST", body: JSON.stringify({ actionId: "approve" }) }),
    );

    expect(processAction).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ userId: "linq-card-link" }) }),
      undefined,
    );
  });
});

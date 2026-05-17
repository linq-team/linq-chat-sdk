import { createHmac } from "node:crypto";
import type { ChatInstance } from "chat";
import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter } from "../src/adapter";

const SIGNING_SECRET = "test_linq_webhook_secret";
const API_KEY = "test_linq_api_key";

describe("LinqAdapter.handleWebhook", () => {
  it("returns 401 when signature headers are missing", async () => {
    const adapter = createTestAdapter();
    const request = new Request("https://example.com/webhooks/linq", {
      method: "POST",
      body: "{}",
    });

    const response = await adapter.handleWebhook(request);

    expect(response.status).toBe(401);
  });

  it("returns 401 when the signature is invalid", async () => {
    const adapter = createTestAdapter();
    const request = createSignedRequest({ ok: true }, { signature: "00" });

    const response = await adapter.handleWebhook(request);

    expect(response.status).toBe(401);
  });

  it("returns 200 for a valid signed message.received webhook", async () => {
    const adapter = createTestAdapter();
    const request = createSignedRequest(createMessageReceivedPayload());

    const response = await adapter.handleWebhook(request);

    expect(response.status).toBe(200);
  });

  it("dispatches inbound message.received webhooks to Chat SDK", async () => {
    const adapter = createTestAdapter();
    const processMessage = vi.fn((..._args: Parameters<ChatInstance["processMessage"]>) => {});
    (adapter as unknown as { chat: Pick<ChatInstance, "processMessage"> }).chat = {
      processMessage,
    };
    vi.spyOn(adapter, "encodeThreadId").mockReturnValue("linq:chat-123");

    const request = createSignedRequest(createMessageReceivedPayload());
    const response = await adapter.handleWebhook(request);

    expect(response.status).toBe(200);
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledWith(
      adapter,
      "linq:chat-123",
      expect.any(Function),
      undefined,
    );
  });
});

describe("LinqAdapter.parseMessage", () => {
  it("normalizes text message.received data", () => {
    const adapter = createTestAdapter();
    vi.spyOn(adapter, "encodeThreadId").mockReturnValue("linq:chat-123");

    const message = adapter.parseMessage(createMessageReceivedPayload().data);

    expect(message.id).toBe("e230c922-3e96-4376-9332-67b644d11237");
    expect(message.threadId).toBe("linq:chat-123");
    expect(message.text).toBe("hi");
    expect(message.author).toMatchObject({
      userId: "1fcfb06a-99d6-4df5-9e26-d8a5b1be24ed",
      userName: "+15550002000",
      fullName: "+15550002000",
      isBot: false,
      isMe: false,
    });
    expect(message.metadata.dateSent.toISOString()).toBe("2026-05-08T16:21:12.499Z");
    expect(message.metadata.edited).toBe(false);
    expect(message.attachments).toEqual([]);
  });

  it("normalizes media parts as attachments", () => {
    const adapter = createTestAdapter();
    vi.spyOn(adapter, "encodeThreadId").mockReturnValue("linq:chat-123");
    const payload = createMessageReceivedPayload();
    payload.data.parts = [
      {
        id: "006a4826-7700-45e3-8796-39a7e26137e6",
        url: "https://cdn.linqapp.com/attachments/test/IMG_3389.png",
        type: "media",
        filename: "IMG_3389.png",
        mime_type: "image/png",
        size_bytes: 58500,
      },
    ];

    const message = adapter.parseMessage(payload.data);

    expect(message.text).toBe("");
    expect(message.attachments).toEqual([
      {
        type: "image",
        url: "https://cdn.linqapp.com/attachments/test/IMG_3389.png",
        name: "IMG_3389.png",
        mimeType: "image/png",
        size: 58500,
      },
    ]);
  });
});

describe("LinqAdapter.postMessage", () => {
  it("sends a text message to an existing Linq chat", async () => {
    const adapter = createTestAdapter();
    const send = vi.fn().mockResolvedValue({
      chat_id: "3caaf1a0-ef9f-46e0-8c22-31e82c8514dc",
      message: {
        id: "outbound-message-id",
        created_at: "2026-05-08T16:22:00.000Z",
        delivery_status: "queued",
        is_read: false,
        parts: [{ type: "text", value: "hello" }],
        sent_at: null,
      },
    });
    (
      adapter as unknown as { apiClient: { chats: { messages: { send: typeof send } } } }
    ).apiClient = {
      chats: { messages: { send } },
    };
    vi.spyOn(adapter, "decodeThreadId").mockReturnValue({
      chatId: "3caaf1a0-ef9f-46e0-8c22-31e82c8514dc",
    });
    vi.spyOn(adapter, "encodeThreadId").mockReturnValue("linq-chat-123");

    const result = await adapter.postMessage("linq-chat-123", " hello ");

    expect(send).toHaveBeenCalledWith("3caaf1a0-ef9f-46e0-8c22-31e82c8514dc", {
      message: {
        parts: [{ type: "text", value: "hello" }],
      },
    });
    expect(result).toEqual({
      id: "outbound-message-id",
      threadId: "linq-chat-123",
      raw: {
        chat_id: "3caaf1a0-ef9f-46e0-8c22-31e82c8514dc",
        message: {
          id: "outbound-message-id",
          created_at: "2026-05-08T16:22:00.000Z",
          delivery_status: "queued",
          is_read: false,
          parts: [{ type: "text", value: "hello" }],
          sent_at: null,
        },
      },
    });
  });

  it("rejects empty messages", async () => {
    const adapter = createTestAdapter();
    vi.spyOn(adapter, "decodeThreadId").mockReturnValue({ chatId: "chat-id" });

    await expect(adapter.postMessage("linq-chat-id", "   ")).rejects.toThrow(
      "Linq message text cannot be empty.",
    );
  });
});

describe("LinqAdapter.channelIdFromThreadId", () => {
  it("uses the Linq thread ID as the channel ID", () => {
    const adapter = createTestAdapter();

    expect(adapter.channelIdFromThreadId("linq-chat-123")).toBe("linq-chat-123");
  });
});

describe("LinqAdapter.isDM", () => {
  it("treats Linq chat threads as DMs", () => {
    const adapter = createTestAdapter();

    expect(adapter.isDM("linq-chat-123")).toBe(true);
  });
});

function createTestAdapter() {
  return createLinqAdapter({ apiKey: API_KEY, signingSecret: SIGNING_SECRET });
}

function createSignedRequest(
  payload: unknown,
  overrides: { signature?: string; timestamp?: string } = {},
): Request {
  const body = JSON.stringify(payload);
  const timestamp = overrides.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const signature =
    overrides.signature ??
    createHmac("sha256", SIGNING_SECRET).update(`${timestamp}.${body}`).digest("hex");

  return new Request("https://example.com/webhooks/linq", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-signature": signature,
      "x-webhook-timestamp": timestamp,
    },
    body,
  });
}

function createMessageReceivedPayload() {
  return {
    api_version: "v3",
    webhook_version: "2026-02-03",
    event_type: "message.received",
    event_id: "ff654877-df18-4384-b3aa-928212533477",
    created_at: "2026-05-08T16:21:12.793119775Z",
    trace_id: "5619088b713532654fd0e6023b8c98e1",
    partner_id: "7ac8224b-c41a-54fb-96ed-e28a94f97ff6",
    data: {
      id: "e230c922-3e96-4376-9332-67b644d11237",
      chat: {
        id: "3caaf1a0-ef9f-46e0-8c22-31e82c8514dc",
        is_group: false,
        owner_handle: {
          id: "80e94fbc-df40-4421-807c-71f9ee6b6390",
          is_me: true,
          handle: "+15550001000",
          status: "active",
          left_at: null,
          service: "iMessage",
          joined_at: "2026-04-17T17:26:38.725846Z",
        },
        health_status: {
          status: "healthy",
          doc_url: "https://docs.linqapp.com/guides/chats/chat-health#healthy",
          updated_at: "2026-04-25T03:51:55.282Z",
        },
      },
      parts: [
        {
          type: "text",
          value: "hi",
          text_decorations: null,
        },
      ],
      effect: null,
      read_at: null,
      sent_at: "2026-05-08T16:21:12.499Z",
      service: "iMessage",
      reply_to: null,
      direction: "inbound",
      delivered_at: null,
      sender_handle: {
        id: "1fcfb06a-99d6-4df5-9e26-d8a5b1be24ed",
        is_me: false,
        handle: "+15550002000",
        status: "active",
        left_at: null,
        service: "iMessage",
        joined_at: "2026-04-17T17:26:38.725846Z",
      },
      idempotency_key: null,
      preferred_service: null,
    },
  };
}

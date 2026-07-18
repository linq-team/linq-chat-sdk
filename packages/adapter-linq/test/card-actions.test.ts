import { createHmac } from "node:crypto";

import { Actions, Button, Card, CardText } from "chat";
import type { ChatInstance } from "chat";
import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter } from "../src/adapter";
import { CardActionRegistry, collectReplyActions } from "../src/card-actions";
import { renderLinqCardText } from "../src/cards";

const SIGNING_SECRET = "test-secret";

function approvalCard() {
  return Card({
    title: "Order #1234",
    children: [
      CardText("Ready for review."),
      Actions([
        Button({ id: "approve", label: "Approve", style: "primary", value: "order-1234" }),
        Button({ id: "reject", label: "Reject", style: "danger" }),
      ]),
    ],
  });
}

describe("renderLinqCardText with numbered buttons", () => {
  it("renders buttons as reply instructions", () => {
    expect(renderLinqCardText(approvalCard(), { numberedButtons: true })).toBe(
      ["Order #1234", "Ready for review.", "Reply 1 to Approve or 2 to Reject"].join("\n"),
    );
  });

  it("numbers buttons across multiple actions blocks", () => {
    const card = Card({
      children: [
        Actions([Button({ id: "a", label: "One" })]),
        Actions([Button({ id: "b", label: "Two" })]),
      ],
    });

    const text = renderLinqCardText(card, { numberedButtons: true });

    expect(text).toContain("Reply 1 to One");
    expect(text).toContain("Reply 2 to Two");
  });
});

describe("CardActionRegistry", () => {
  function registered() {
    const registry = new CardActionRegistry();

    registry.register("chat-1", {
      threadId: "linq:chat-1",
      messageId: "msg-card",
      actions: collectReplyActions(approvalCard()),
    });

    return registry;
  }

  it("matches by ordinal, label, and action ID, ignoring case and punctuation", () => {
    for (const reply of ["1", "Approve", "approve", " APPROVE. ", "1!"]) {
      const match = registered().match("chat-1", reply);

      expect(match, `reply ${JSON.stringify(reply)}`).toMatchObject({
        actionId: "approve",
        value: "order-1234",
        threadId: "linq:chat-1",
        messageId: "msg-card",
      });
    }

    expect(registered().match("chat-1", "2")).toMatchObject({ actionId: "reject" });
  });

  it("consumes the card on match", () => {
    const registry = registered();

    expect(registry.match("chat-1", "1")).not.toBeNull();
    expect(registry.match("chat-1", "2")).toBeNull();
  });

  it("passes through non-matching replies without consuming", () => {
    const registry = registered();

    expect(registry.match("chat-1", "what does this mean?")).toBeNull();
    expect(registry.match("chat-1", "approve")).not.toBeNull();
  });

  it("keeps only the latest card per chat", () => {
    const registry = registered();

    registry.register("chat-1", {
      threadId: "linq:chat-1",
      messageId: "msg-card-2",
      actions: [{ actionId: "confirm", label: "Confirm", ordinal: 1 }],
    });

    expect(registry.match("chat-1", "approve")).toBeNull();
    expect(registry.match("chat-1", "confirm")).toMatchObject({ messageId: "msg-card-2" });
  });

  it("expires entries after the TTL", () => {
    const registry = new CardActionRegistry(-1000);

    registry.register("chat-1", {
      threadId: "linq:chat-1",
      actions: collectReplyActions(approvalCard()),
    });

    expect(registry.match("chat-1", "1")).toBeNull();
  });
});

describe("LinqAdapter reply-mapped card actions", () => {
  function createReplyTestAdapter() {
    const adapter = createLinqAdapter({ apiKey: "test-key", signingSecret: SIGNING_SECRET });
    const send = vi.fn(async (chatId: string, _body: unknown) => ({
      chat_id: chatId,
      message: {
        id: "card-message-id",
        created_at: "2026-07-18T00:00:00.000Z",
        delivery_status: "queued",
        is_read: false,
        parts: [],
        sent_at: null,
        from_handle: null,
      },
    }));

    (adapter as unknown as { apiClient: { chats: { messages: { send: typeof send } } } }).apiClient =
      { chats: { messages: { send } } };

    const processAction = vi.fn(async () => undefined);
    const processMessage = vi.fn(async () => undefined);
    const chat = {
      processAction,
      processMessage,
      getLogger: () => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
    } as unknown as ChatInstance;

    return { adapter, send, processAction, processMessage, chat };
  }

  function signedInboundText(text: string, chatId = "chat-123"): Request {
    const body = JSON.stringify({
      event_type: "message.received",
      data: {
        id: `inbound-${text}`,
        chat: { id: chatId, is_group: false },
        direction: "inbound",
        parts: [{ type: "text", value: text, reactions: null }],
        sender_handle: {
          id: "them",
          handle: "+15551234567",
          service: "imessage",
          joined_at: "2026-07-18T00:00:00.000Z",
          is_me: false,
        },
        service: "imessage",
        sent_at: "2026-07-18T00:00:00.000Z",
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", SIGNING_SECRET)
      .update(`${timestamp}.${body}`)
      .digest("hex");

    return new Request("https://bot.example.com/webhook", {
      method: "POST",
      headers: {
        "x-webhook-timestamp": timestamp,
        "x-webhook-signature": signature,
      },
      body,
    });
  }

  it("sends numbered reply hints and dispatches onAction for a matching reply", async () => {
    const { adapter, send, processAction, processMessage, chat } = createReplyTestAdapter();

    await adapter.initialize(chat);
    await adapter.postMessage("linq:chat-123", approvalCard());

    expect(send).toHaveBeenCalledWith("chat-123", {
      message: {
        parts: [
          {
            type: "text",
            value: "Order #1234\nReady for review.\nReply 1 to Approve or 2 to Reject",
          },
        ],
      },
    });

    const response = await adapter.handleWebhook(signedInboundText("1"));

    expect(response.status).toBe(200);
    expect(processMessage).not.toHaveBeenCalled();
    expect(processAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "approve",
        value: "order-1234",
        messageId: "card-message-id",
        threadId: "linq:chat-123",
        adapter,
        user: expect.objectContaining({ userName: "+15551234567", isMe: false }),
      }),
      undefined,
    );
  });

  it("passes non-matching replies through as messages and consumes the card once", async () => {
    const { adapter, processAction, processMessage, chat } = createReplyTestAdapter();

    await adapter.initialize(chat);
    await adapter.postMessage("linq:chat-123", approvalCard());

    await adapter.handleWebhook(signedInboundText("hey what is this"));

    expect(processAction).not.toHaveBeenCalled();
    expect(processMessage).toHaveBeenCalledTimes(1);

    await adapter.handleWebhook(signedInboundText("approve"));

    expect(processAction).toHaveBeenCalledTimes(1);

    // The card is consumed: a second "approve" is just a message again.
    await adapter.handleWebhook(signedInboundText("approve"));

    expect(processAction).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(2);
  });

  it("keeps buttons as plain options when reply actions are disabled", async () => {
    const adapter = createLinqAdapter({
      apiKey: "test-key",
      signingSecret: SIGNING_SECRET,
      cardReplyActions: false,
    });
    const send = vi.fn(async (chatId: string, _body: unknown) => ({
      chat_id: chatId,
      message: {
        id: "card-message-id",
        created_at: "2026-07-18T00:00:00.000Z",
        delivery_status: "queued",
        is_read: false,
        parts: [],
        sent_at: null,
      },
    }));

    (adapter as unknown as { apiClient: { chats: { messages: { send: typeof send } } } }).apiClient =
      { chats: { messages: { send } } };

    await adapter.postMessage("linq:chat-123", approvalCard());

    const body = send.mock.calls[0]![1] as { message: { parts: { value?: string }[] } };

    expect(body.message.parts[0]?.value).toContain("Options: Approve, Reject");
  });
});

import { Actions, Button, Card, CardText, Fields, Field, Image } from "chat";
import type { ChatInstance } from "chat";
import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter } from "../src/adapter";
import { buildAppCardLayout } from "../src/app-card";

function orderCard() {
  return Card({
    title: "Order #1234",
    subtitle: "Ready for review",
    imageUrl: "https://cdn.example.com/photo.png",
    children: [
      CardText("Eve's order is ready."),
      Fields([Field({ label: "Total", value: "$42" }), Field({ label: "Items", value: "2 items" })]),
      Actions([
        Button({ id: "approve", label: "Approve", style: "primary", value: "order-1234" }),
        Button({ id: "reject", label: "Reject", style: "danger" }),
      ]),
    ],
  });
}

describe("buildAppCardLayout", () => {
  it("maps title, image, fields, and the reply hint onto the layout", () => {
    expect(buildAppCardLayout(orderCard(), { replyHint: "Reply 1 to Approve or 2 to Reject" })).toEqual({
      image_url: "https://cdn.example.com/photo.png",
      image_title: "Order #1234",
      image_subtitle: "Ready for review",
      caption: "Order #1234",
      subcaption: "Reply 1 to Approve or 2 to Reject",
      trailing_caption: "$42",
      trailing_subcaption: "2 items",
    });
  });

  it("falls back to subtitle then first text for the subcaption", () => {
    const card = Card({ title: "Title", subtitle: "Subtitle", children: [CardText("Body")] });

    expect(buildAppCardLayout(card)).toMatchObject({ caption: "Title", subcaption: "Subtitle" });

    const noSubtitle = Card({ title: "Title", children: [CardText("Body")] });

    expect(buildAppCardLayout(noSubtitle)).toMatchObject({ caption: "Title", subcaption: "Body" });
  });

  it("uses the first text as caption when the card has no title", () => {
    const card = Card({ children: [CardText("Just **text**")] });

    expect(buildAppCardLayout(card)).toEqual({ caption: "Just text" });
  });

  it("picks up an image element when there is no header image", () => {
    const card = Card({
      title: "T",
      children: [Image({ url: "https://cdn.example.com/inline.png" })],
    });

    expect(buildAppCardLayout(card)).toMatchObject({
      image_url: "https://cdn.example.com/inline.png",
    });
  });
});

describe("LinqAdapter app-card mode", () => {
  it("requires cardLinks alongside cardAppIdentity", () => {
    expect(() =>
      createLinqAdapter({
        apiKey: "k",
        signingSecret: "s",
        cardAppIdentity: { bundleId: "com.acme.app", name: "Acme", teamId: "ACMETEAM12" },
      }),
    ).toThrow(/cardLinks/);
  });

  it("sends a card as a native app-card part with tap URL, fallback, and reply registration", async () => {
    const adapter = createLinqAdapter({
      apiKey: "k",
      signingSecret: "s",
      cardLinks: { baseUrl: "https://bot.example.com/cards" },
      cardAppIdentity: {
        bundleId: "com.acme.app",
        name: "Acme",
        teamId: "ACMETEAM12",
        appStoreId: 42,
      },
    });
    const send = vi.fn(async (chatId: string, _body: unknown) => ({
      chat_id: chatId,
      message: {
        id: "app-card-msg",
        created_at: "2026-07-18T00:00:00.000Z",
        delivery_status: "queued",
        is_read: false,
        parts: [],
        sent_at: null,
      },
    }));

    (adapter as unknown as { apiClient: { chats: { messages: { send: typeof send } } } }).apiClient =
      { chats: { messages: { send } } };

    const processAction = vi.fn(async () => undefined);

    await adapter.initialize({
      processAction,
      getLogger: () => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
    } as unknown as ChatInstance);

    await adapter.postMessage("linq:chat-123", orderCard());

    expect(send).toHaveBeenCalledTimes(1);

    const body = send.mock.calls[0]![1] as {
      message: {
        parts: {
          type: string;
          app: Record<string, unknown>;
          layout: Record<string, unknown>;
          url?: string;
          fallback_text?: string;
        }[];
      };
    };
    const part = body.message.parts[0]!;

    expect(body.message.parts).toHaveLength(1);
    expect(part.type).toBe("imessage_app");
    expect(part.app).toEqual({
      bundle_id: "com.acme.app",
      name: "Acme",
      team_id: "ACMETEAM12",
      app_store_id: 42,
    });
    expect(part.layout).toMatchObject({
      caption: "Order #1234",
      subcaption: "Reply 1 to Approve or 2 to Reject",
      trailing_caption: "$42",
    });
    expect(part.url).toMatch(/^https:\/\/bot\.example\.com\/cards\//);
    expect(part.fallback_text).toContain("Reply 1 to Approve or 2 to Reject");
  });
});

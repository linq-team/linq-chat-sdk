import { markdownToPlainText } from "chat";
import type { CardElement } from "chat";

// Native iMessage app cards: Linq's `imessage_app` part renders a real card
// bubble (image with overlaid title, caption/subcaption, trailing captions)
// for every iMessage recipient — no web page needed for the LOOK. The layout
// has no buttons, so interactivity still comes from reply-mapped actions and
// the card-link page. iMessage-only: Linq rejects app cards to SMS chats.

export interface LinqAppCardIdentity {
  /** Bundle identifier of the Messages app extension, e.g. "com.acme.bot.MessagesExtension". */
  bundleId: string;
  /** Display name shown by Messages beside the card. */
  name: string;
  /** Apple team identifier (10 uppercase alphanumerics). */
  teamId: string;
  /** App Store id; recipients without the app see a "Get the app" affordance. */
  appStoreId?: number;
}

export interface AppCardLayout {
  caption?: string;
  subcaption?: string;
  trailing_caption?: string;
  trailing_subcaption?: string;
  image_url?: string;
  image_title?: string;
  image_subtitle?: string;
}

// Best-effort projection of a Chat SDK card onto the app-card layout. The
// layout only fits a title, two caption rows, and two trailing labels — the
// full card content lives in the fallback text and the tap-through page.
export function buildAppCardLayout(
  card: CardElement,
  options?: { replyHint?: string | null },
): AppCardLayout {
  const layout: AppCardLayout = {};
  const image = firstHttpsImage(card);
  const text = firstText(card);
  const fields = firstFields(card);

  if (image) {
    layout.image_url = image;

    if (card.title) {
      layout.image_title = card.title;
    }

    if (card.subtitle) {
      layout.image_subtitle = card.subtitle;
    }
  }

  if (card.title) {
    layout.caption = card.title;
  } else if (text) {
    layout.caption = text;
  }

  // The reply hint is the card's one shot at telling the recipient how to
  // act, so it wins the subcaption; the subtitle then rides on the image.
  const subcaption = options?.replyHint || card.subtitle || (card.title ? text : null);

  if (subcaption && subcaption !== layout.caption) {
    layout.subcaption = subcaption;
  }

  if (fields[0]) {
    layout.trailing_caption = fields[0].value;
  }

  if (fields[1]) {
    layout.trailing_subcaption = fields[1].value;
  }

  return layout;
}

function firstHttpsImage(card: CardElement): string | null {
  if (card.imageUrl?.startsWith("https://")) {
    return card.imageUrl;
  }

  for (const child of card.children) {
    if (child.type === "image" && child.url.startsWith("https://")) {
      return child.url;
    }
  }

  return null;
}

function firstText(card: CardElement): string | null {
  for (const child of card.children) {
    if (child.type === "text") {
      const plain = markdownToPlainText(child.content).trim();

      if (plain) {
        return plain;
      }
    }
  }

  return null;
}

function firstFields(card: CardElement): { label: string; value: string }[] {
  for (const child of card.children) {
    if (child.type === "fields") {
      return child.children.map((field) => ({ label: field.label, value: field.value }));
    }
  }

  return [];
}

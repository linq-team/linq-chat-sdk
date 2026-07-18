import type { CardElement } from "chat";

import { collectCardActions } from "./card-link.js";

// Reply-mapped card actions: iMessage/SMS recipients cannot tap buttons, so
// the card's buttons are offered as numbered reply options and the next
// matching inbound reply in that chat dispatches the button's onAction
// handler instead of being processed as a normal message.

export interface PendingCardAction {
  actionId: string;
  label: string;
  ordinal: number;
  value?: string;
}

interface PendingCard {
  threadId: string;
  messageId?: string;
  actions: PendingCardAction[];
  expiresAt: number;
}

export interface CardActionMatch {
  actionId: string;
  value?: string;
  threadId: string;
  messageId?: string;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

// The buttons a recipient can invoke by replying. Selects and link-buttons are
// excluded: selects have their own option values and link-buttons are URLs.
export function collectReplyActions(card: CardElement): PendingCardAction[] {
  return collectCardActions(card)
    .filter((action) => action.kind === "button" && !action.disabled)
    .map((action, index) => ({
      actionId: action.id,
      label: labelForAction(card, action.id) ?? action.id,
      ordinal: index + 1,
      value: action.value,
    }));
}

function labelForAction(card: CardElement, actionId: string): string | null {
  for (const child of flattenChildren(card)) {
    if (child.type === "actions") {
      for (const element of child.children) {
        if (element.type === "button" && element.id === actionId) {
          return element.label;
        }
      }
    }
  }

  return null;
}

function flattenChildren(card: CardElement) {
  const out: CardElement["children"] = [];
  const walk = (children: CardElement["children"]): void => {
    for (const child of children) {
      out.push(child);

      if (child.type === "section") {
        walk(child.children);
      }
    }
  };

  walk(card.children);

  return out;
}

// "Reply 1 to Approve or 2 to Reject" — the same wording renderLinqCardText
// uses in numbered mode, for surfaces (like app-card subcaptions) that build
// their layout outside the text renderer.
export function renderReplyHint(actions: PendingCardAction[]): string | null {
  if (actions.length === 0) {
    return null;
  }

  const options = actions.map((action) => `${action.ordinal} to ${action.label}`);
  const list =
    options.length > 1
      ? `${options.slice(0, -1).join(", ")} or ${options[options.length - 1]}`
      : options[0];

  return `Reply ${list}`;
}

export class CardActionRegistry {
  private readonly pending = new Map<string, PendingCard>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  // The latest card with buttons in a chat is the one replies act on.
  register(chatId: string, entry: Omit<PendingCard, "expiresAt">): void {
    if (entry.actions.length === 0) {
      return;
    }

    this.pending.set(chatId, { ...entry, expiresAt: Date.now() + this.ttlMs });
  }

  attachMessageId(chatId: string, messageId: string): void {
    const entry = this.pending.get(chatId);

    if (entry) {
      entry.messageId = messageId;
    }
  }

  // Matches an inbound reply against the chat's pending card. A match consumes
  // the card: one decision per card, later replies flow through as messages.
  match(chatId: string, text: string): CardActionMatch | null {
    const entry = this.pending.get(chatId);

    if (!entry) {
      return null;
    }

    if (entry.expiresAt < Date.now()) {
      this.pending.delete(chatId);

      return null;
    }

    const normalized = text.trim().toLowerCase().replace(/[.!]$/, "");

    if (!normalized) {
      return null;
    }

    const action = entry.actions.find(
      (candidate) =>
        normalized === String(candidate.ordinal) ||
        normalized === candidate.label.toLowerCase() ||
        normalized === candidate.actionId.toLowerCase(),
    );

    if (!action) {
      return null;
    }

    this.pending.delete(chatId);

    return {
      actionId: action.actionId,
      value: action.value,
      threadId: entry.threadId,
      messageId: entry.messageId,
    };
  }
}

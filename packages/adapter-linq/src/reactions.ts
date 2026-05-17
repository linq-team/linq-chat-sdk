import { LinqAPIV3 } from "@linqapp/sdk";
import { defaultEmojiResolver } from "chat";
import type { EmojiValue } from "chat";

export function toLinqReaction(emoji: EmojiValue | string): {
  type: LinqAPIV3.ReactionType;
  custom_emoji?: string;
} {
  const value = typeof emoji === "string" ? emoji : emoji.name;
  const normalized = value
    .trim()
    .replace(/^\{\{emoji:/, "")
    .replace(/\}\}$/, "")
    .replace(/^:+|:+$/g, "")
    .toLowerCase();

  if (["thumbs_up", "thumbsup", "+1", "like", "👍"].includes(normalized)) {
    return { type: "like" };
  }

  if (["thumbs_down", "thumbsdown", "-1", "dislike", "👎"].includes(normalized)) {
    return { type: "dislike" };
  }

  if (["heart", "love", "❤️", "❤"].includes(normalized)) {
    return { type: "love" };
  }

  if (["laugh", "joy", "rofl", "😂", "🤣"].includes(normalized)) {
    return { type: "laugh" };
  }

  if (["exclamation", "emphasize", "!!", "!", "‼️", "‼", "❗"].includes(normalized)) {
    return { type: "emphasize" };
  }

  if (["question", "?", "❓"].includes(normalized)) {
    return { type: "question" };
  }

  return {
    type: "custom",
    custom_emoji: defaultEmojiResolver.toDiscord(value),
  };
}

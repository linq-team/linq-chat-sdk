import { LinqAPIV3 } from "@linqapp/sdk";
import { defaultEmojiResolver, getEmoji } from "chat";
import type { EmojiValue } from "chat";

const LINQ_TAPBACK_TO_EMOJI: Partial<Record<LinqAPIV3.ReactionType, string>> = {
  like: "thumbs_up",
  dislike: "thumbs_down",
  love: "heart",
  laugh: "laugh",
  emphasize: "exclamation",
  question: "question",
};

export function fromLinqReaction(reaction: {
  reaction_type: LinqAPIV3.ReactionType;
  custom_emoji?: string | null;
}): { emoji: EmojiValue; rawEmoji: string } | null {
  if (reaction.reaction_type === "custom") {
    if (!reaction.custom_emoji) {
      return null;
    }

    return {
      emoji: defaultEmojiResolver.fromGChat(reaction.custom_emoji),
      rawEmoji: reaction.custom_emoji,
    };
  }

  const name = LINQ_TAPBACK_TO_EMOJI[reaction.reaction_type];

  // Sticker reactions have no emoji equivalent in Chat SDK.
  if (!name) {
    return null;
  }

  return { emoji: getEmoji(name), rawEmoji: reaction.reaction_type };
}

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

import { getEmoji } from "chat";
import { describe, expect, it } from "vitest";

import { fromLinqReaction, toLinqReaction } from "../src/reactions";

describe("toLinqReaction", () => {
  it("maps Chat SDK emoji to Linq tapbacks", () => {
    expect(toLinqReaction(getEmoji("thumbs_up"))).toEqual({ type: "like" });
    expect(toLinqReaction("thumbs_down")).toEqual({ type: "dislike" });
    expect(toLinqReaction("+1")).toEqual({ type: "like" });
    expect(toLinqReaction("👍")).toEqual({ type: "like" });
    expect(toLinqReaction("heart")).toEqual({ type: "love" });
    expect(toLinqReaction("❤️")).toEqual({ type: "love" });
    expect(toLinqReaction("laugh")).toEqual({ type: "laugh" });
    expect(toLinqReaction("!")).toEqual({ type: "emphasize" });
    expect(toLinqReaction("?")).toEqual({ type: "question" });
  });

  it("cleans up emoji placeholder formats", () => {
    expect(toLinqReaction("{{emoji:thumbs_up}}")).toEqual({ type: "like" });
    expect(toLinqReaction(":heart:")).toEqual({ type: "love" });
  });

  it("falls back to custom emoji for unknown reactions", () => {
    expect(toLinqReaction("fire")).toEqual({ type: "custom", custom_emoji: "🔥" });
  });
});

describe("fromLinqReaction", () => {
  it("maps Linq tapbacks to Chat SDK emoji", () => {
    expect(fromLinqReaction({ reaction_type: "like" })).toEqual({
      emoji: getEmoji("thumbs_up"),
      rawEmoji: "like",
    });
    expect(fromLinqReaction({ reaction_type: "dislike" })).toEqual({
      emoji: getEmoji("thumbs_down"),
      rawEmoji: "dislike",
    });
    expect(fromLinqReaction({ reaction_type: "love" })).toEqual({
      emoji: getEmoji("heart"),
      rawEmoji: "love",
    });
    expect(fromLinqReaction({ reaction_type: "laugh" })).toEqual({
      emoji: getEmoji("laugh"),
      rawEmoji: "laugh",
    });
    expect(fromLinqReaction({ reaction_type: "emphasize" })).toEqual({
      emoji: getEmoji("exclamation"),
      rawEmoji: "emphasize",
    });
    expect(fromLinqReaction({ reaction_type: "question" })).toEqual({
      emoji: getEmoji("question"),
      rawEmoji: "question",
    });
  });

  it("maps custom emoji reactions to normalized emoji", () => {
    const reaction = fromLinqReaction({ reaction_type: "custom", custom_emoji: "👍" });

    expect(reaction?.emoji).toBe(getEmoji("thumbs_up"));
    expect(reaction?.rawEmoji).toBe("👍");
  });

  it("keeps unknown custom emoji as raw emoji values", () => {
    const reaction = fromLinqReaction({ reaction_type: "custom", custom_emoji: "🦖" });

    expect(reaction?.rawEmoji).toBe("🦖");
    expect(reaction?.emoji.name).toBeTruthy();
  });

  it("returns null for reactions without an emoji equivalent", () => {
    expect(fromLinqReaction({ reaction_type: "custom", custom_emoji: null })).toBeNull();
    expect(fromLinqReaction({ reaction_type: "sticker" })).toBeNull();
  });
});

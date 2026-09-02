import { emphasis, paragraph, parseMarkdown, root, strong, text, toPlainText } from "chat";
import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter } from "../src/adapter";
import {
  assertDecorationsSendable,
  astToDecoratedText,
  trimDecoratedText,
} from "../src/text-decorations";

const SIGNING_SECRET = "whsec_c2hoaC10aGlzLWlzLWEtdGVzdC1zZWNyZXQtdmFsdWU=";
const API_KEY = "test_linq_api_key";
const CHAT_ID = "3caaf1a0-ef9f-46e0-8c22-31e82c8514dc";

describe("astToDecoratedText", () => {
  it("marks the bold characters, not the markdown syntax", () => {
    const { value, decorations } = astToDecoratedText(parseMarkdown("say **hi** now"));

    expect(value).toBe("say hi now");
    expect(decorations).toEqual([{ range: [4, 6], style: "bold" }]);
    expect(value.slice(4, 6)).toBe("hi");
  });

  it("maps italic and strikethrough to their Linq styles", () => {
    expect(astToDecoratedText(parseMarkdown("_a_")).decorations).toEqual([
      { range: [0, 1], style: "italic" },
    ]);
    expect(astToDecoratedText(parseMarkdown("~~a~~")).decorations).toEqual([
      { range: [0, 1], style: "strikethrough" },
    ]);
  });

  // Asterisks and underscores are usually just characters — a typo correction,
  // a footnote, an identifier. Nothing here may be eaten or styled.
  it.each([
    ["i meant to say this instead*", "i meant to say this instead*"],
    ["50% off*, terms apply", "50% off*, terms apply"],
    ["2 * 3 * 4 = 24", "2 * 3 * 4 = 24"],
    ["snake_case_name here", "snake_case_name here"],
    ["**", "**"],
    ["\\*not bold\\*", "*not bold*"],
    ["`**not bold**` code", "**not bold** code"],
    ["<b>hi</b> there", "<b>hi</b> there"],
  ])("leaves %j unstyled", (markdown, expected) => {
    const { value, decorations } = astToDecoratedText(parseMarkdown(markdown));

    expect(value).toBe(expected);
    expect(decorations).toEqual([]);
  });

  it("marks italics from either delimiter", () => {
    expect(astToDecoratedText(parseMarkdown("say *hi* now")).decorations).toEqual([
      { range: [4, 6], style: "italic" },
    ]);
    expect(astToDecoratedText(parseMarkdown("say _hi_ now")).decorations).toEqual([
      { range: [4, 6], style: "italic" },
    ]);
  });

  it("gives every run on a mixed-style line its own range", () => {
    const { value, decorations } = astToDecoratedText(parseMarkdown("_a_ and **b** and ~~c~~"));

    expect(value).toBe("a and b and c");
    expect(decorations).toEqual([
      { range: [0, 1], style: "italic" },
      { range: [6, 7], style: "bold" },
      { range: [12, 13], style: "strikethrough" },
    ]);
  });

  it("tracks offsets across several runs on one line", () => {
    const { value, decorations } = astToDecoratedText(parseMarkdown("a **b** c **d** e"));

    expect(decorations).toEqual([
      { range: [2, 3], style: "bold" },
      { range: [6, 7], style: "bold" },
    ]);
    expect(value.slice(2, 3)).toBe("b");
    expect(value.slice(6, 7)).toBe("d");
  });

  it("emits overlapping ranges for nested styles, which the API allows", () => {
    const { decorations } = astToDecoratedText(parseMarkdown("**_both_**"));

    expect(decorations).toEqual([
      { range: [0, 4], style: "italic" },
      { range: [0, 4], style: "bold" },
    ]);
  });

  // The API counts UTF-16 code units, which is what JS string indices already
  // are — so an astral emoji must shift later ranges by 2, not 1.
  it("counts an emoji as two code units", () => {
    const { value, decorations } = astToDecoratedText(parseMarkdown("👍 **hi**"));

    expect(decorations).toEqual([{ range: [3, 5], style: "bold" }]);
    expect(value.slice(3, 5)).toBe("hi");
  });

  // The emoji is inside the bold run, so it has to push the range's end, not
  // just its start.
  it("extends a range past an emoji inside it", () => {
    const { value, decorations } = astToDecoratedText(parseMarkdown("**a👍b** c"));

    expect(decorations).toEqual([{ range: [0, 4], style: "bold" }]);
    expect(value.slice(0, 4)).toBe("a👍b");
  });

  // Markdown cannot express empty emphasis, but an AST postable can, and a
  // zero-length range decorates nothing and would be rejected by the API.
  it("emits no decoration for a styled node with no text", () => {
    const ast = root([paragraph([strong([text("")]), text("hi"), emphasis([])])]);

    expect(astToDecoratedText(ast)).toEqual({ value: "hi", decorations: [] });
  });

  it("produces no decorations for unformatted text", () => {
    expect(astToDecoratedText(parseMarkdown("plain text")).decorations).toEqual([]);
  });

  // Regression: the renderer used to concatenate every block and list item,
  // producing "Pregame pick97 Wythe Avefirst detailsecond detail".
  it("separates headings, paragraphs, and list items", () => {
    const markdown = ["### Pregame pick", "97 Wythe Ave", "- first detail", "- second detail"].join(
      "\n",
    );

    expect(astToDecoratedText(parseMarkdown(markdown)).value).toBe(
      "Pregame pick\n\n97 Wythe Ave\n\nfirst detail\nsecond detail",
    );
  });

  // Separators sit between the chunks they divide, so every range after one has
  // to move by its length or the style lands on the wrong characters.
  it("shifts ranges past the separators that precede them", () => {
    const markdown = ["**a**", "", "- **b**", "- **c**"].join("\n");
    const { value, decorations } = astToDecoratedText(parseMarkdown(markdown));

    expect(value).toBe("a\n\nb\nc");
    expect(decorations).toEqual([
      { range: [0, 1], style: "bold" },
      { range: [3, 4], style: "bold" },
      { range: [5, 6], style: "bold" },
    ]);
    expect(value.slice(3, 4)).toBe("b");
    expect(value.slice(5, 6)).toBe("c");
  });

  // A hard break is its own newline, not a separator between blocks.
  it("renders a hard break as a single newline", () => {
    expect(astToDecoratedText(parseMarkdown("line one  \nline two")).value).toBe(
      "line one\nline two",
    );
  });

  // An empty child contributes no separator, so a blank block must not open a
  // gap that slides later ranges off their characters.
  it("emits no separator for a block that renders empty", () => {
    const { value, decorations } = astToDecoratedText(parseMarkdown("a\n\n---\n\n**b**"));

    expect(value).toBe("a\n\nb");
    expect(decorations).toEqual([{ range: [3, 4], style: "bold" }]);
    expect(value.slice(3, 4)).toBe("b");
  });

  it("joins table cells with tabs and rows with newlines", () => {
    const { value, decorations } = astToDecoratedText(
      parseMarkdown("| a | **b** |\n| - | - |\n| c | d |"),
    );

    expect(value).toBe("a\tb\nc\td");
    expect(decorations).toEqual([{ range: [2, 3], style: "bold" }]);
    expect(value.slice(2, 3)).toBe("b");
  });

  // The wire value must not change: only decorations are new.
  it.each([
    "say **hi** now",
    "👍 **hi**",
    "**_both_** and ~~gone~~",
    "plain text",
    "- one\n- two",
    "[link](https://linqapp.com) text",
    "\\*not bold\\*",
    "`**not bold**` code",
    "<b>hi</b> there",
    "**![pic](https://linqapp.com/b.png)**",
    "a*b*c",
    "| a | **b** |\n| - | - |\n| c | d |",
    "### Pregame pick\n97 Wythe Ave\n- first detail\n- second detail",
    "one\n\ntwo\n\nthree",
    "> quoted\n> lines",
    "line one  \nline two",
    "para\n\n---\n\nafter",
    "1. one\n2. two",
    "- outer\n  - inner\n- last",
  ])("renders the same text as toPlainText for %j", (markdown) => {
    const ast = parseMarkdown(markdown);

    expect(astToDecoratedText(ast).value).toBe(toPlainText(ast));
  });
});

describe("trimDecoratedText", () => {
  // Markdown strips paragraph whitespace, so the leading text has to come from
  // an AST postable — the path where an untrimmed value actually reaches here.
  it("shifts ranges to stay on their characters after trimming", () => {
    const trimmed = trimDecoratedText({
      value: "  hi there  ",
      decorations: [{ range: [2, 4], style: "bold" }],
    });

    expect(trimmed.value).toBe("hi there");
    expect(trimmed.decorations).toEqual([{ range: [0, 2], style: "bold" }]);
    expect(trimmed.value.slice(0, 2)).toBe("hi");
  });

  it("clamps a range that straddles both trimmed edges", () => {
    const trimmed = trimDecoratedText({
      value: "  hi  ",
      decorations: [{ range: [0, 6], style: "bold" }],
    });

    expect(trimmed).toEqual({ value: "hi", decorations: [{ range: [0, 2], style: "bold" }] });
  });

  it("drops a range that lived entirely in the leading whitespace", () => {
    const trimmed = trimDecoratedText({
      value: "  hi",
      decorations: [{ range: [0, 2], style: "bold" }],
    });

    expect(trimmed).toEqual({ value: "hi", decorations: [] });
  });

  it("drops a range that trimming removed entirely", () => {
    const trimmed = trimDecoratedText({
      value: "hi  ",
      decorations: [{ range: [2, 4], style: "bold" }],
    });

    expect(trimmed.decorations).toEqual([]);
  });
});

describe("assertDecorationsSendable", () => {
  it("accepts overlapping styles", () => {
    expect(() =>
      assertDecorationsSendable([
        { range: [0, 4], style: "bold" },
        { range: [2, 6], style: "italic" },
      ]),
    ).not.toThrow();
  });

  it("accepts an animation that touches but does not overlap a style", () => {
    expect(() =>
      assertDecorationsSendable([
        { range: [0, 4], style: "bold" },
        { range: [4, 8], animation: "shake" },
      ]),
    ).not.toThrow();
  });

  it("rejects an animation overlapping a style", () => {
    expect(() =>
      assertDecorationsSendable([
        { range: [0, 5], style: "bold" },
        { range: [3, 8], animation: "shake" },
      ]),
    ).toThrow(/animations cannot overlap/i);
  });

  it("rejects two overlapping animations", () => {
    expect(() =>
      assertDecorationsSendable([
        { range: [0, 5], animation: "shake" },
        { range: [4, 8], animation: "bloom" },
      ]),
    ).toThrow(/animations cannot overlap/i);
  });
});

describe("postMessage decorations and idempotency", () => {
  it("sends markdown formatting as text_decorations", async () => {
    const { adapter, send } = adapterWithSend();

    await adapter.postMessage(`linq:${CHAT_ID}`, { markdown: "say **hi**" });

    expect(textPart(send)).toEqual({
      type: "text",
      value: "say hi",
      text_decorations: [{ range: [4, 6], style: "bold" }],
    });
  });

  it("sends italics and strikethrough, not just bold", async () => {
    const { adapter, send } = adapterWithSend();

    await adapter.postMessage(`linq:${CHAT_ID}`, { markdown: "_a_ and ~~b~~" });

    expect(textPart(send)).toEqual({
      type: "text",
      value: "a and b",
      text_decorations: [
        { range: [0, 1], style: "italic" },
        { range: [6, 7], style: "strikethrough" },
      ],
    });
  });

  // A trailing asterisk correcting a typo is the message, not syntax: it has to
  // reach the wire as a character, with nothing styled.
  it("sends an unmatched asterisk as text, not syntax", async () => {
    const { adapter, send } = adapterWithSend();

    await adapter.postMessage(`linq:${CHAT_ID}`, { markdown: "i meant to say this instead*" });

    expect(textPart(send)).toEqual({ type: "text", value: "i meant to say this instead*" });
  });

  // Strings and `raw` are verbatim text. Parsing them would eat asterisks the
  // caller typed on purpose.
  it.each([
    ["a plain string", "say **hi**"],
    ["a raw postable", { raw: "say **hi**" }],
  ])("never parses %s as markdown", async (_label, message) => {
    const { adapter, send } = adapterWithSend();

    await adapter.postMessage(`linq:${CHAT_ID}`, message);

    expect(textPart(send)).toEqual({ type: "text", value: "say **hi**" });
  });

  it("omits the key entirely for unformatted text", async () => {
    const { adapter, send } = adapterWithSend();

    await adapter.postMessage(`linq:${CHAT_ID}`, "hello");

    expect(Object.hasOwn(textPart(send), "text_decorations")).toBe(false);
  });

  it("appends caller decorations, the only route to animations", async () => {
    const { adapter, send } = adapterWithSend();

    await adapter.postMessage(
      `linq:${CHAT_ID}`,
      { markdown: "**hi** there" },
      { textDecorations: [{ range: [3, 8], animation: "shake" }] },
    );

    expect(textPart(send).text_decorations).toEqual([
      { range: [0, 2], style: "bold" },
      { range: [3, 8], animation: "shake" },
    ]);
  });

  it("rejects a caller animation that overlaps the markdown's own styles", async () => {
    const { adapter } = adapterWithSend();

    await expect(
      adapter.postMessage(
        `linq:${CHAT_ID}`,
        { markdown: "**hi** there" },
        { textDecorations: [{ range: [1, 4], animation: "shake" }] },
      ),
    ).rejects.toThrow(/animations cannot overlap/i);
  });

  it("keeps ranges on their characters when leading whitespace is trimmed", async () => {
    const { adapter, send } = adapterWithSend();

    await adapter.postMessage(`linq:${CHAT_ID}`, {
      ast: root([paragraph([text("  "), strong([text("hi")]), text(" there")])]),
    });

    expect(textPart(send)).toEqual({
      type: "text",
      value: "hi there",
      text_decorations: [{ range: [0, 2], style: "bold" }],
    });
  });

  it("passes an idempotency key through on a chat send", async () => {
    const { adapter, send } = adapterWithSend();

    await adapter.postMessage(`linq:${CHAT_ID}`, "hello", { idempotencyKey: "job-1" });

    expect(sentMessage(send).idempotency_key).toBe("job-1");
  });

  it("omits the key when the caller supplies none", async () => {
    const { adapter, send } = adapterWithSend();

    await adapter.postMessage(`linq:${CHAT_ID}`, "hello");

    expect(Object.hasOwn(sentMessage(send), "idempotency_key")).toBe(false);
  });

  it("passes an idempotency key through when the chat is created on first post", async () => {
    const adapter = createLinqAdapter({ apiKey: API_KEY, signingSecret: SIGNING_SECRET });
    const create = vi.fn().mockResolvedValue({
      chat_id: CHAT_ID,
      created_new_chat: true,
      message: { id: "outbound-message-id" },
    });
    injectClient(adapter, { messages: { create } });

    const threadId = await adapter.openDM("+12025550147");
    await adapter.postMessage(threadId, "hello", { idempotencyKey: "job-2" });

    expect(create.mock.calls[0][0].message.idempotency_key).toBe("job-2");
  });
});

function adapterWithSend() {
  const adapter = createLinqAdapter({ apiKey: API_KEY, signingSecret: SIGNING_SECRET });
  const send = vi.fn().mockResolvedValue({
    chat_id: CHAT_ID,
    message: { id: "outbound-message-id" },
  });
  injectClient(adapter, { chats: { messages: { send } } });

  return { adapter, send };
}

function sentMessage(send: ReturnType<typeof vi.fn>) {
  return send.mock.calls[0][1].message;
}

function textPart(send: ReturnType<typeof vi.fn>) {
  return sentMessage(send).parts[0];
}

function injectClient(adapter: unknown, client: unknown): void {
  (adapter as { apiClient: unknown }).apiClient = client;
}

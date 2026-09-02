import type { LinqAPIV3 } from "@linqapp/sdk";
import type { FormattedContent } from "chat";

/** Text plus the iMessage decorations that apply to ranges within it. */
export interface DecoratedText {
  value: string;
  decorations: LinqAPIV3.TextDecoration[];
}

const STYLE_BY_NODE_TYPE: Record<string, LinqAPIV3.TextDecoration["style"]> = {
  strong: "bold",
  emphasis: "italic",
  delete: "strikethrough",
};

/** How a node's children are joined: the whitespace between them, and which of
 * them count. Mirrors `toPlainText`, whose separators are the only thing
 * keeping blocks and list items off one another's lines. */
interface JoinRule {
  separator: string;
  keeps: (text: string) => boolean;
}

const isNotEmpty = (text: string): boolean => text.length > 0;

const JOIN_BY_NODE_TYPE: Record<string, JoinRule> = {
  root: { separator: "\n\n", keeps: isNotEmpty },
  list: { separator: "\n", keeps: isNotEmpty },
  listItem: { separator: "\n", keeps: isNotEmpty },
  blockquote: { separator: "\n", keeps: isNotEmpty },
  // A header divider row renders as empty cells joined by tabs — whitespace,
  // not nothing — so it takes a stronger test than the other blocks to drop.
  table: { separator: "\n", keeps: (text) => text.trim().length > 0 },
  // An empty cell still holds its column, so it keeps its tab.
  tableRow: { separator: "\t", keeps: () => true },
};

/** Inline nodes run together: no separator, and empties add nothing. */
const INLINE_JOIN: JoinRule = { separator: "", keeps: isNotEmpty };

/**
 * Renders an mdast tree to text plus the decorations its formatting implies.
 *
 * The text is byte-identical to `toPlainText` so the wire value is unchanged;
 * only the decorations are new. Offsets are UTF-16 code units, which is what JS
 * string indices already are and what the Linq API expects.
 */
export function astToDecoratedText(ast: FormattedContent): DecoratedText {
  return renderNode(ast);
}

function renderNode(value: unknown): DecoratedText {
  if (!value || typeof value !== "object") {
    return { value: "", decorations: [] };
  }

  const node = value as Record<string, unknown>;
  const own = ownText(node);

  if (own !== null) {
    return { value: own, decorations: [] };
  }

  const type = typeof node.type === "string" ? node.type : "";

  // A hard break is a newline of its own, and a rule is nothing at all.
  if (type === "break") {
    return { value: "\n", decorations: [] };
  }

  if (type === "thematicBreak") {
    return { value: "", decorations: [] };
  }

  const rendered = joinChildren(node, JOIN_BY_NODE_TYPE[type] ?? INLINE_JOIN);
  const style = STYLE_BY_NODE_TYPE[type];

  // Children first, so a nested style's range precedes the one wrapping it.
  if (style && rendered.value.length > 0) {
    rendered.decorations.push({ range: [0, rendered.value.length], style });
  }

  return rendered;
}

/**
 * Joins a node's children, shifting each child's ranges by everything already
 * emitted — separators included, or every range after one slides off its
 * characters.
 */
function joinChildren(
  node: Record<string, unknown>,
  { separator, keeps }: JoinRule,
): DecoratedText {
  if (!Array.isArray(node.children)) {
    return { value: "", decorations: [] };
  }

  const chunks: string[] = [];
  const decorations: LinqAPIV3.TextDecoration[] = [];
  let length = 0;

  for (const child of node.children) {
    const rendered = renderNode(child);

    // A dropped child contributes no text, so no separator and no ranges.
    if (!keeps(rendered.value)) {
      continue;
    }

    if (chunks.length) {
      chunks.push(separator);
      length += separator.length;
    }

    for (const decoration of rendered.decorations) {
      const [start = 0, end = 0] = decoration.range;
      decorations.push({ ...decoration, range: [start + length, end + length] });
    }

    chunks.push(rendered.value);
    length += rendered.value.length;
  }

  return { value: chunks.join(""), decorations };
}

/** A leaf's own text: its value, or an image's alt text standing in for it. */
function ownText(node: Record<string, unknown>): string | null {
  if (typeof node.value === "string") {
    return node.value;
  }

  if (typeof node.alt === "string") {
    return node.alt;
  }

  return null;
}

/**
 * Trims surrounding whitespace, shifting decoration ranges to match.
 *
 * Trimming without this silently slides every range off its characters.
 */
export function trimDecoratedText({ value, decorations }: DecoratedText): DecoratedText {
  const leading = value.length - value.trimStart().length;
  const trimmed = value.trim();

  if (!leading && trimmed.length === value.length) {
    return { value: trimmed, decorations };
  }

  const shifted: LinqAPIV3.TextDecoration[] = [];

  for (const decoration of decorations) {
    const [start, end] = decoration.range;
    const nextStart = Math.min(Math.max((start ?? 0) - leading, 0), trimmed.length);
    const nextEnd = Math.min(Math.max((end ?? 0) - leading, 0), trimmed.length);

    if (nextEnd > nextStart) {
      shifted.push({ ...decoration, range: [nextStart, nextEnd] });
    }
  }

  return { value: trimmed, decorations: shifted };
}

/**
 * Rejects decorations the API will not accept: animation ranges may not overlap
 * any other decoration, though styles may overlap each other freely.
 */
export function assertDecorationsSendable(decorations: readonly LinqAPIV3.TextDecoration[]): void {
  for (const [index, decoration] of decorations.entries()) {
    if (!decoration.animation) {
      continue;
    }

    for (const [otherIndex, other] of decorations.entries()) {
      if (index !== otherIndex && rangesOverlap(decoration.range, other.range)) {
        throw new Error(
          `Linq text animation range [${String(decoration.range)}] overlaps another decoration ` +
            `at [${String(other.range)}] — animations cannot overlap other decorations.`,
        );
      }
    }
  }
}

function rangesOverlap(a: number[], b: number[]): boolean {
  return (a[0] ?? 0) < (b[1] ?? 0) && (b[0] ?? 0) < (a[1] ?? 0);
}

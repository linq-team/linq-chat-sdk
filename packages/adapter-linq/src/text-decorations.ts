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

/**
 * Renders an mdast tree to text plus the decorations its formatting implies.
 *
 * The text is byte-identical to `toPlainText` (mdast-util-to-string) so the
 * wire value is unchanged; only the decorations are new. Offsets are UTF-16
 * code units, which is what JS string indices already are and what the Linq
 * API expects.
 */
export function astToDecoratedText(ast: FormattedContent): DecoratedText {
  const chunks: string[] = [];
  const decorations: LinqAPIV3.TextDecoration[] = [];
  let length = 0;

  const emit = (value: unknown): void => {
    if (typeof value === "string" && value) {
      chunks.push(value);
      length += value.length;
    }
  };

  const one = (value: unknown): void => {
    if (Array.isArray(value)) {
      all(value);
      return;
    }

    if (!value || typeof value !== "object") {
      return;
    }

    const node = value as Record<string, unknown>;
    const style = typeof node.type === "string" ? STYLE_BY_NODE_TYPE[node.type] : undefined;
    const start = length;

    if ("value" in node) {
      emit(node.value);
    } else if (node.alt) {
      emit(node.alt);
    } else if ("children" in node) {
      one(node.children);
    }

    if (style && length > start) {
      decorations.push({ range: [start, length], style });
    }
  };

  const all = (values: unknown[]): void => {
    for (const value of values) {
      one(value);
    }
  };

  one(ast);

  return { value: chunks.join(""), decorations };
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

import { BaseFormatConverter, parseMarkdown, toPlainText } from "chat";
import type { AdapterPostableMessage, CardElement, FormattedContent } from "chat";

import { renderLinqCardText } from "./cards.js";
import { astToDecoratedText, type DecoratedText } from "./text-decorations.js";

export class LinqFormatConverter extends BaseFormatConverter {
  toAst(platformText: string): FormattedContent {
    return parseMarkdown(platformText);
  }

  fromAst(ast: FormattedContent): string {
    return toPlainText(ast);
  }

  /**
   * Renders a postable to text plus the decorations its markdown implies.
   *
   * Only markdown/AST postables carry formatting; everything else renders
   * exactly as `renderPostable` does, with no decorations.
   */
  renderDecoratedPostable(message: AdapterPostableMessage): DecoratedText {
    if (message && typeof message === "object") {
      if ("markdown" in message) {
        return astToDecoratedText(parseMarkdown(message.markdown));
      }

      if ("ast" in message) {
        return astToDecoratedText(message.ast);
      }
    }

    return { value: this.renderPostable(message), decorations: [] };
  }

  // Linq renders text verbatim, so the default `**bold**` markdown fallback
  // would show literal asterisks. Use the Linq-specific plain-text rendering.
  protected override cardToFallbackText(card: CardElement): string {
    return renderLinqCardText(card);
  }
}

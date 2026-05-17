import { BaseFormatConverter, parseMarkdown, toPlainText } from "chat";
import type { FormattedContent } from "chat";

export class LinqFormatConverter extends BaseFormatConverter {
  toAst(platformText: string): FormattedContent {
    return parseMarkdown(platformText);
  }

  fromAst(ast: FormattedContent): string {
    return toPlainText(ast);
  }
}

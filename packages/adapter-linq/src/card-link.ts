import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { markdownToPlainText } from "chat";
import type {
  ActionsElement,
  Author,
  CardChild,
  CardElement,
  ChatInstance,
  Logger,
  SelectOptionElement,
  WebhookOptions,
} from "chat";

// Interactive cards over iMessage: the card is hosted at a signed short-lived
// URL and sent as a Linq `link` part, which renders as a rich preview bubble.
// Tapping it opens the card as a web page whose buttons POST back here and
// dispatch Chat SDK `onAction` handlers — the only way to make card actions
// actually fire on a platform with no native buttons.

export interface LinqCardLinkConfig {
  /**
   * Public HTTPS base URL that routes to this adapter's webhook handler,
   * e.g. "https://bot.example.com/linq/cards". Card pages are served at
   * `${baseUrl}/{token}`.
   */
  baseUrl: string;
  /** Secret for signing card URLs. Defaults to the webhook signing secret. */
  secret?: string;
  /** How long card links stay live. Default: 7 days. */
  ttlMs?: number;
}

interface StoredCard {
  card: CardElement;
  chatId: string;
  threadId: string;
  messageId?: string;
  expiresAt: number;
  actor?: Author;
}

interface CardAction {
  id: string;
  kind: "button" | "select";
  value?: string;
  options?: SelectOptionElement[];
  disabled?: boolean;
}

export interface CardLinkDeps {
  getChat(): ChatInstance | null;
  getAdapter(): unknown;
  resolveActor(chatId: string): Promise<Author>;
  getLogger(): Logger;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class LinqCardLinkServer {
  private readonly baseUrl: URL;
  private readonly pathPrefix: string;
  private readonly secret: string;
  private readonly ttlMs: number;
  private readonly deps: CardLinkDeps;
  private readonly cards = new Map<string, StoredCard>();

  constructor(config: LinqCardLinkConfig, fallbackSecret: string, deps: CardLinkDeps) {
    this.baseUrl = new URL(config.baseUrl);
    this.pathPrefix = this.baseUrl.pathname.replace(/\/+$/, "");
    this.secret = config.secret || fallbackSecret;
    this.ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
    this.deps = deps;
  }

  createCard(card: CardElement, ids: { chatId: string; threadId: string }): {
    cardId: string;
    url: string;
  } {
    this.prune();

    const cardId = randomUUID();
    const expiresAt = Date.now() + this.ttlMs;

    this.cards.set(cardId, { card, ...ids, expiresAt });

    const token = `${cardId}.${expiresAt}.${this.sign(cardId, expiresAt)}`;

    return { cardId, url: `${this.baseUrl.origin}${this.pathPrefix}/${token}` };
  }

  attachMessageId(cardId: string, messageId: string): void {
    const stored = this.cards.get(cardId);

    if (stored) {
      stored.messageId = messageId;
    }
  }

  /**
   * Serve card routes. Returns null when the request is not for a card URL so
   * the caller can fall through to normal webhook handling.
   */
  async handleRequest(request: Request, options?: WebhookOptions): Promise<Response | null> {
    const token = this.tokenFromRequest(request);

    if (token === null) {
      return null;
    }

    const verified = this.verifyToken(token);

    if (!verified) {
      return htmlResponse(renderGonePage(), 404);
    }

    const stored = this.cards.get(verified.cardId);

    if (!stored || stored.expiresAt < Date.now()) {
      return htmlResponse(renderGonePage(), 410);
    }

    if (request.method === "GET" || request.method === "HEAD") {
      return htmlResponse(renderCardPage(stored.card), 200);
    }

    if (request.method === "POST") {
      return this.handleAction(request, verified.cardId, stored, options);
    }

    return new Response("Method Not Allowed", { status: 405 });
  }

  private async handleAction(
    request: Request,
    cardId: string,
    stored: StoredCard,
    options?: WebhookOptions,
  ): Promise<Response> {
    const chat = this.deps.getChat();

    if (!chat) {
      return jsonResponse({ ok: false, error: "Adapter is not initialized." }, 503);
    }

    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: "Invalid JSON body." }, 400);
    }

    const actionId =
      typeof body === "object" && body !== null && "actionId" in body
        ? String((body as Record<string, unknown>).actionId)
        : "";
    const rawValue =
      typeof body === "object" && body !== null && "value" in body
        ? (body as Record<string, unknown>).value
        : undefined;

    const action = collectCardActions(stored.card).find((entry) => entry.id === actionId);

    // Only actions the card actually declares can dispatch; the client cannot
    // invent action IDs or button payloads.
    if (!action || action.disabled) {
      return jsonResponse({ ok: false, error: "Unknown action." }, 400);
    }

    let value: string | undefined;

    if (action.kind === "button") {
      value = action.value;
    } else {
      value = typeof rawValue === "string" ? rawValue : undefined;

      if (!action.options?.some((option) => option.value === value)) {
        return jsonResponse({ ok: false, error: "Unknown option." }, 400);
      }
    }

    if (!stored.actor) {
      stored.actor = await this.deps.resolveActor(stored.chatId);
    }

    await chat.processAction(
      {
        actionId,
        adapter: this.deps.getAdapter() as never,
        messageId: stored.messageId ?? "",
        raw: { source: "linq-card-link", cardId, actionId, value },
        threadId: stored.threadId,
        user: stored.actor,
        value,
      },
      options,
    );

    return jsonResponse({ ok: true }, 200);
  }

  private tokenFromRequest(request: Request): string | null {
    const { pathname } = new URL(request.url);

    if (!pathname.startsWith(`${this.pathPrefix}/`)) {
      return null;
    }

    const rest = pathname.slice(this.pathPrefix.length + 1);

    // Card tokens are a single path segment: `{uuid}.{expiry}.{signature}`.
    return rest && !rest.includes("/") ? rest : null;
  }

  private verifyToken(token: string): { cardId: string } | null {
    const match = /^([0-9a-f-]{36})\.(\d+)\.([0-9a-f]{64})$/.exec(token);
    const [, cardId, expiresAt, signature] = match ?? [];

    if (!cardId || !expiresAt || !signature) {
      return null;
    }
    const expected = this.sign(cardId, Number(expiresAt));
    const provided = Buffer.from(signature, "hex");
    const wanted = Buffer.from(expected, "hex");

    if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) {
      return null;
    }

    return { cardId };
  }

  private sign(cardId: string, expiresAt: number): string {
    return createHmac("sha256", this.secret).update(`${cardId}.${expiresAt}`).digest("hex");
  }

  private prune(): void {
    const now = Date.now();

    for (const [cardId, stored] of this.cards) {
      if (stored.expiresAt < now) {
        this.cards.delete(cardId);
      }
    }
  }
}

// Every action the card declares, including inside sections. Dispatch is
// restricted to this set.
export function collectCardActions(card: CardElement): CardAction[] {
  const actions: CardAction[] = [];

  collectChildActions(card.children, actions);

  return actions;
}

function collectChildActions(children: CardChild[], actions: CardAction[]): void {
  for (const child of children) {
    if (child.type === "section") {
      collectChildActions(child.children, actions);
    } else if (child.type === "actions") {
      for (const element of child.children) {
        if (element.type === "button") {
          actions.push({
            id: element.id,
            kind: "button",
            value: element.value,
            disabled: element.disabled,
          });
        } else if (element.type === "select" || element.type === "radio_select") {
          actions.push({ id: element.id, kind: "select", options: element.options });
        }
      }
    }
  }
}

// HTML rendering

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/'/g, "&#39;");
}

function textToHtml(markdown: string): string {
  return escapeHtml(markdownToPlainText(markdown).trim()).replace(/\n/g, "<br>");
}

function firstImageUrl(card: CardElement): string | null {
  if (card.imageUrl) {
    return card.imageUrl;
  }

  for (const child of card.children) {
    if (child.type === "image") {
      return child.url;
    }
  }

  return null;
}

function ogDescription(card: CardElement): string | null {
  if (card.subtitle) {
    return card.subtitle;
  }

  for (const child of card.children) {
    if (child.type === "text") {
      return markdownToPlainText(child.content).trim() || null;
    }
  }

  return null;
}

function renderCardPage(card: CardElement): string {
  const title = card.title || "Card";
  const description = ogDescription(card);
  const image = firstImageUrl(card);

  // A large og:image (and the summary_large_image hint) is what makes iMessage
  // render the big card-style preview instead of a compact thumbnail row.
  const og = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeAttr(title)}">`,
    description ? `<meta property="og:description" content="${escapeAttr(description)}">` : "",
    image ? `<meta property="og:image" content="${escapeAttr(image)}">` : "",
    image ? `<meta name="twitter:card" content="summary_large_image">` : "",
    image ? `<meta name="twitter:image" content="${escapeAttr(image)}">` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const body: string[] = [];

  if (card.imageUrl) {
    body.push(`<img class="hero" src="${escapeAttr(card.imageUrl)}" alt="">`);
  }

  const header: string[] = [];

  if (card.title) {
    header.push(`<h1>${escapeHtml(card.title)}</h1>`);
  }

  if (card.subtitle) {
    header.push(`<p class="subtitle">${escapeHtml(card.subtitle)}</p>`);
  }

  if (header.length > 0) {
    body.push(`<header>${header.join("")}</header>`);
  }

  for (const child of card.children) {
    const html = renderChildHtml(child);

    if (html) {
      body.push(html);
    }
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${og}
<style>${PAGE_CSS}</style>
</head>
<body>
<main class="card">
${body.join("\n")}
<p class="status" id="status" hidden></p>
</main>
<script>${PAGE_JS}</script>
</body>
</html>`;
}

function renderChildHtml(child: CardChild): string | null {
  switch (child.type) {
    case "text":
      return `<p class="text">${textToHtml(child.content)}</p>`;
    case "fields":
      return `<dl class="fields">${child.children
        .map(
          (field) =>
            `<div><dt>${escapeHtml(field.label)}</dt><dd>${escapeHtml(field.value)}</dd></div>`,
        )
        .join("")}</dl>`;
    case "link":
      return `<a class="row-link" href="${escapeAttr(child.url)}" target="_blank" rel="noopener">${escapeHtml(child.label || child.url)}</a>`;
    case "divider":
      return `<hr>`;
    case "image":
      return `<img class="inline" src="${escapeAttr(child.url)}" alt="${escapeAttr(child.alt || "")}">`;
    case "table":
      return renderTableHtml(child.headers, child.rows);
    case "section": {
      const parts = child.children
        .map((sectionChild) => renderChildHtml(sectionChild))
        .filter((html): html is string => Boolean(html));

      return parts.length > 0 ? `<section>${parts.join("\n")}</section>` : null;
    }
    case "actions":
      return renderActionsHtml(child);
    default:
      return null;
  }
}

function renderTableHtml(headers: string[], rows: string[][]): string {
  const head = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const bodyRows = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("");

  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
}

function renderActionsHtml(actions: ActionsElement): string | null {
  const parts: string[] = [];

  for (const element of actions.children) {
    if (element.type === "button") {
      const style = element.style === "primary" || element.style === "danger" ? element.style : "default";

      parts.push(
        `<button class="btn ${style}" data-action-id="${escapeAttr(element.id)}"${element.disabled ? " disabled" : ""}>${escapeHtml(element.label)}</button>`,
      );
    } else if (element.type === "link-button") {
      parts.push(
        `<a class="btn default" href="${escapeAttr(element.url)}" target="_blank" rel="noopener">${escapeHtml(element.label)}</a>`,
      );
    } else if (element.type === "select" || element.type === "radio_select") {
      const options = element.options
        .map(
          (option) =>
            `<option value="${escapeAttr(option.value)}"${option.value === element.initialOption ? " selected" : ""}>${escapeHtml(option.label)}</option>`,
        )
        .join("");
      const placeholder =
        ("placeholder" in element ? element.placeholder : undefined) || element.label || "Choose…";

      parts.push(
        `<select class="select" data-action-id="${escapeAttr(element.id)}"><option value="" disabled${element.initialOption ? "" : " selected"}>${escapeHtml(placeholder)}</option>${options}</select>`,
      );
    }
  }

  return parts.length > 0 ? `<div class="actions">${parts.join("")}</div>` : null;
}

function renderGonePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Card expired</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<main class="card gone">
<h1>This card has expired</h1>
<p class="subtitle">Ask for a new one in the chat.</p>
</main>
</body>
</html>`;
}

function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const PAGE_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; margin: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
  background: #f2f2f7; color: #1c1c1e;
  min-height: 100vh; display: flex; align-items: flex-start; justify-content: center;
  padding: 24px 16px;
}
.card {
  width: 100%; max-width: 430px; background: #fff; border-radius: 18px;
  box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.08);
  overflow: hidden; padding-bottom: 20px;
}
.card > *:not(.hero) { margin-left: 20px; margin-right: 20px; }
.hero { width: 100%; display: block; max-height: 260px; object-fit: cover; }
header { padding-top: 18px; }
h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.3px; }
.subtitle { color: #6e6e73; font-size: 15px; margin-top: 2px; }
.text { margin-top: 14px; font-size: 16px; line-height: 1.45; }
.fields { margin-top: 14px; display: grid; gap: 8px; }
.fields div { display: flex; justify-content: space-between; gap: 12px; font-size: 15px; }
.fields dt { color: #6e6e73; }
.fields dd { font-weight: 600; text-align: right; }
.row-link { display: block; margin-top: 14px; color: #0a84ff; font-size: 16px; text-decoration: none; font-weight: 500; }
hr { border: none; border-top: 1px solid rgba(60,60,67,.15); margin: 16px 20px 0; }
.inline { width: calc(100% - 40px); border-radius: 12px; margin-top: 14px; display: block; }
.table-wrap { overflow-x: auto; margin-top: 14px; }
table { border-collapse: collapse; font-size: 14px; min-width: 100%; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid rgba(60,60,67,.12); white-space: nowrap; }
th { color: #6e6e73; font-weight: 600; }
section { margin-top: 4px; }
.actions { margin-top: 18px; display: grid; gap: 10px; }
.btn {
  display: block; width: 100%; padding: 13px 16px; border: none; border-radius: 12px;
  font-size: 16px; font-weight: 600; text-align: center; text-decoration: none;
  cursor: pointer; transition: opacity .15s, transform .05s;
  -webkit-tap-highlight-color: transparent;
}
.btn:active { transform: scale(.98); }
.btn.primary { background: #0a84ff; color: #fff; }
.btn.danger { background: #ff3b30; color: #fff; }
.btn.default { background: rgba(118,118,128,.12); color: #0a84ff; }
.btn:disabled { opacity: .45; cursor: default; }
.select {
  width: 100%; padding: 12px 14px; border-radius: 12px; font-size: 16px;
  border: 1px solid rgba(60,60,67,.2); background: inherit; color: inherit;
  appearance: none; -webkit-appearance: none;
}
.status { margin-top: 14px; font-size: 15px; font-weight: 600; text-align: center; color: #30d158; }
.status.error { color: #ff3b30; }
.gone { padding: 28px 0 8px; text-align: center; }
@media (prefers-color-scheme: dark) {
  body { background: #000; color: #fff; }
  .card { background: #1c1c1e; }
  .subtitle, .fields dt, th { color: #98989f; }
  hr, th, td { border-color: rgba(84,84,88,.5); }
  .btn.default { background: rgba(118,118,128,.24); }
  .select { border-color: rgba(84,84,88,.6); }
}
`;

const PAGE_JS = `
// Not named "status": assigning to a global named status hits window.status,
// which coerces to a string and silently breaks.
var statusEl = document.getElementById("status");
function done(ok, message) {
  statusEl.hidden = false;
  statusEl.textContent = message;
  statusEl.className = ok ? "status" : "status error";
  if (ok) {
    document.querySelectorAll(".btn[data-action-id], .select").forEach(function (el) {
      el.disabled = true;
    });
  }
}
function dispatch(actionId, value, label) {
  fetch(location.pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actionId: actionId, value: value }),
  })
    .then(function (res) { return res.json().catch(function () { return {}; }); })
    .then(function (body) {
      if (body && body.ok) {
        done(true, (label ? label + " " : "") + "✓ sent");
      } else {
        done(false, (body && body.error) || "Something went wrong — try again.");
      }
    })
    .catch(function () { done(false, "Network error — try again."); });
}
document.querySelectorAll(".btn[data-action-id]").forEach(function (button) {
  button.addEventListener("click", function () {
    dispatch(button.dataset.actionId, undefined, button.textContent.trim());
  });
});
document.querySelectorAll(".select").forEach(function (select) {
  select.addEventListener("change", function () {
    if (select.value) {
      dispatch(select.dataset.actionId, select.value, select.selectedOptions[0].textContent.trim());
    }
  });
});
`;

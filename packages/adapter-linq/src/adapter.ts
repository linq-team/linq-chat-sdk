import { LinqAPIV3 } from "@linqapp/sdk";
import {
  ConsoleLogger,
  Message,
  NotImplementedError,
  defaultEmojiResolver,
  parseMarkdown,
  stringifyMarkdown,
} from "chat";
import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  LinkPreview,
  Logger,
  RawMessage,
  StreamChunk,
  ThreadInfo,
  WebhookOptions,
} from "chat";

import { LinqFormatConverter } from "./format-converter.js";
import { verifyLinqWebhookRequest } from "./verification.js";

type LinqMessageSendResponse = Awaited<ReturnType<LinqAPIV3["chats"]["messages"]["send"]>>;
type LinqRetrievedMessage = LinqAPIV3.Message;
type LinqRawMessage =
  | LinqAPIV3.EventsWebhookEvent["data"]
  | LinqMessageSendResponse
  | LinqRetrievedMessage;
type LinqMessageEvent = LinqAPIV3.MessageEventV2;
type LinqMessagePart =
  | {
      type: "text" | "link";
      value: string;
    }
  | {
      type: "media";
      id?: string;
      url: string;
      filename: string;
      mime_type: string;
      size_bytes: number;
      width?: number;
      height?: number;
      width_px?: number;
      height_px?: number;
    };

type LinqThreadId = {
  chatId: string;
  isGroup?: boolean;
};

export interface LinqAdapterConfig {
  apiKey: string;
  baseURL?: string;
  signingSecret: string;
}

class LinqAdapter implements Adapter<LinqThreadId, LinqRawMessage> {
  readonly name: string = "linq";
  readonly userName: string = "linq";
  private readonly apiClient: LinqAPIV3;
  private readonly converter = new LinqFormatConverter();
  private readonly signingSecret: string;

  private chat: ChatInstance | null = null;
  private logger: Logger;

  constructor(config: LinqAdapterConfig) {
    this.apiClient = new LinqAPIV3({ apiKey: config.apiKey, baseURL: config.baseURL });
    this.signingSecret = config.signingSecret;
    this.logger = new ConsoleLogger();
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = chat.getLogger("linq");
  }

  // Thread ID
  encodeThreadId(platformData: LinqThreadId): string {
    if (platformData.isGroup === undefined) {
      return `linq-${platformData.chatId}`;
    }

    return `linq-${platformData.chatId}-${platformData.isGroup ? "group" : "dm"}`;
  }

  decodeThreadId(threadId: string): LinqThreadId {
    const value = threadId.replace("linq-", "");

    if (value.endsWith("-group")) {
      return { chatId: value.slice(0, -"-group".length), isGroup: true };
    }

    if (value.endsWith("-dm")) {
      return { chatId: value.slice(0, -"-dm".length), isGroup: false };
    }

    return { chatId: value };
  }

  // Messages
  async fetchMessages(
    threadId: string,
    options?: FetchOptions,
  ): Promise<FetchResult<LinqRawMessage>> {
    const { chatId } = this.decodeThreadId(threadId);
    const page = await this.apiClient.chats.messages.list(chatId, {
      cursor: options?.cursor,
      limit: options?.limit,
    });

    return {
      messages: page.messages.map((message) => this.parseMessage(message)).sort(compareMessages),
      nextCursor: page.next_cursor || undefined,
    };
  }

  async fetchMessage(
    _threadId: string,
    messageId: string,
  ): Promise<Message<LinqRawMessage> | null> {
    try {
      const message = await this.apiClient.messages.retrieve(messageId);

      return this.parseMessage(message);
    } catch (error) {
      if (isRecord(error) && error.status === 404) {
        return null;
      }

      throw error;
    }
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<LinqRawMessage>> {
    const { chatId } = this.decodeThreadId(threadId);
    const text = this.converter.renderPostable(message).trim();

    if (!text) {
      throw new Error("Linq message text cannot be empty.");
    }

    const response = await this.apiClient.chats.messages.send(chatId, {
      message: {
        parts: [{ type: "text", value: text }],
      },
    });

    return {
      id: response.message.id,
      threadId: this.encodeThreadId({ chatId: response.chat_id || chatId }),
      raw: response,
    };
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<LinqRawMessage>> {
    const { chatId } = this.decodeThreadId(threadId);
    const text = this.converter.renderPostable(message).trim();

    if (!text) {
      throw new Error("Linq message text cannot be empty.");
    }

    const response = await this.apiClient.messages.update(messageId, {
      text,
      part_index: 0,
    });

    return {
      id: response.id,
      threadId: this.encodeThreadId({ chatId: response.chat_id || chatId }),
      raw: response,
    };
  }

  deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    throw new NotImplementedError("deleteMessage is not implemented");
  }

  // Reactions
  async addReaction(
    _threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    await this.apiClient.messages.addReaction(messageId, {
      operation: "add",
      ...toLinqReaction(emoji),
    });
  }

  async removeReaction(
    _threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    await this.apiClient.messages.addReaction(messageId, {
      operation: "remove",
      ...toLinqReaction(emoji),
    });
  }

  // Threads
  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { chatId } = this.decodeThreadId(threadId);
    const chat = await this.apiClient.chats.retrieve(chatId);

    return {
      id: this.encodeThreadId({ chatId: chat.id, isGroup: chat.is_group }),
      channelId: this.encodeThreadId({ chatId: chat.id, isGroup: chat.is_group }),
      channelName: chat.display_name ?? undefined,
      isDM: !chat.is_group,
      metadata: {
        chat,
      },
    };
  }

  async startTyping(threadId: string, _status?: string): Promise<void> {
    const { chatId, isGroup } = this.decodeThreadId(threadId);

    if (isGroup === true) {
      return;
    }

    try {
      await this.apiClient.chats.typing.start(chatId);
    } catch (error) {
      if (isRecord(error) && error.status === 403) {
        return;
      }

      throw error;
    }
  }

  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
  ): Promise<RawMessage<LinqRawMessage>> {
    let text = "";

    for await (const chunk of textStream) {
      if (typeof chunk === "string") {
        text += chunk;
        continue;
      }

      if (chunk.type === "markdown_text") {
        text += chunk.text;
      }
    }

    return this.postMessage(threadId, text.trim() ? { markdown: text } : " ");
  }

  // handle webhook
  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    type LinqWebhookEvent = LinqAPIV3.EventsWebhookEvent;

    const verification = await verifyLinqWebhookRequest(request, this.signingSecret);

    if (!verification.ok) {
      return verification.response;
    }

    let event: LinqWebhookEvent;

    try {
      event = JSON.parse(new TextDecoder().decode(verification.rawBody)) as LinqWebhookEvent;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (this.chat && isMessageReceivedWebhookEvent(event) && event.data.direction === "inbound") {
      const threadId = this.encodeThreadId({
        chatId: event.data.chat.id,
        isGroup: event.data.chat.is_group ?? undefined,
      });

      const factory = async (): Promise<Message<unknown>> => {
        const msg = this.parseMessage(event.data);

        return msg;
      };

      this.chat.processMessage(this, threadId, factory, options);
    }

    return new Response("OK", { status: 200 });

    function isMessageReceivedWebhookEvent(
      event: LinqWebhookEvent,
    ): event is LinqAPIV3.Webhooks.MessageReceivedWebhookEvent {
      return event.event_type === "message.received";
    }
  }

  parseMessage(raw: LinqRawMessage): Message<LinqRawMessage> {
    const message = normalizeMessage(raw);
    const attachments = message.parts.flatMap((part): Attachment[] => {
      if (part.type !== "media") {
        return [];
      }

      return [toAttachment(part)];
    });
    const text = messageText(message.parts, attachments);
    const links = messageLinks(message.parts);

    const isMe = message.isMe;
    const senderId = message.sender?.id || message.sender?.handle || "unknown";
    const senderName = message.sender?.handle || message.sender?.id || "unknown";

    return new Message({
      id: message.id,
      threadId: this.encodeThreadId({ chatId: message.chatId, isGroup: message.isGroup }),
      text,
      formatted: parseMarkdown(text),
      raw,
      author: {
        userId: senderId,
        userName: senderName,
        fullName: senderName,
        isBot: isMe,
        isMe,
      },
      metadata: {
        dateSent: dateFrom(message.sentAt),
        edited: message.edited,
        editedAt: message.editedAt ? dateFrom(message.editedAt) : undefined,
      },
      attachments,
      links,
    });

    function normalizeMessage(value: LinqRawMessage): {
      id: string;
      chatId: string;
      isGroup?: boolean;
      parts: LinqMessagePart[];
      isMe: boolean;
      sender: LinqAPIV3.ChatHandle | null | undefined;
      sentAt: string | null | undefined;
      edited: boolean;
      editedAt?: string | null;
    } {
      if (isMessageEvent(value)) {
        return {
          id: value.id,
          chatId: value.chat.id,
          isGroup: value.chat.is_group ?? undefined,
          parts: value.parts,
          isMe: value.direction === "outbound" || value.sender_handle.is_me === true,
          sender: value.sender_handle,
          sentAt: value.sent_at,
          edited: false,
        };
      }

      if (isMessageSendResponse(value)) {
        return {
          id: value.message.id,
          chatId: value.chat_id,
          isGroup: undefined,
          parts: value.message.parts,
          isMe: true,
          sender: value.message.from_handle,
          sentAt: value.message.sent_at || value.message.created_at,
          edited: false,
        };
      }

      if (isRetrievedMessage(value)) {
        const edited = value.updated_at !== value.created_at;

        return {
          id: value.id,
          chatId: value.chat_id,
          isGroup: undefined,
          parts: value.parts ?? [],
          isMe: value.is_from_me || value.from_handle?.is_me === true,
          sender: value.from_handle,
          sentAt: value.sent_at || value.created_at,
          edited,
          editedAt: edited ? value.updated_at : undefined,
        };
      }

      throw new NotImplementedError("parseMessage only supports Linq message payloads");
    }

    function isMessageEvent(value: LinqRawMessage): value is LinqMessageEvent {
      return isRecord(value) && "chat" in value && "direction" in value && "sender_handle" in value;
    }

    function isMessageSendResponse(value: LinqRawMessage): value is LinqMessageSendResponse {
      return isRecord(value) && "chat_id" in value && "message" in value && isRecord(value.message);
    }

    function isRetrievedMessage(value: LinqRawMessage): value is LinqRetrievedMessage {
      return (
        isRecord(value) && "chat_id" in value && "is_from_me" in value && "created_at" in value
      );
    }

    function dateFrom(value: string | null | undefined): Date {
      if (value) {
        const date = new Date(value);

        if (!Number.isNaN(date.getTime())) {
          return date;
        }
      }

      return new Date();
    }

    function messageText(parts: LinqMessagePart[], attachments: Attachment[]): string {
      const textParts = parts.flatMap((part) => {
        if ((part.type === "text" || part.type === "link") && typeof part.value === "string") {
          return [part.value];
        }

        return [];
      });
      const attachmentSummaries = attachments.map((attachment) => {
        const label = attachment.name || attachment.mimeType || attachment.type;

        return `[${attachment.type} attachment: ${label}]`;
      });

      return [...textParts, ...attachmentSummaries].join("\n").trim();
    }

    function messageLinks(parts: LinqMessagePart[]): LinkPreview[] {
      const urls = new Set<string>();

      for (const part of parts) {
        if (part.type === "link") {
          urls.add(part.value);
          continue;
        }

        if (part.type === "text") {
          for (const url of urlsFromText(part.value)) {
            urls.add(url);
          }
        }
      }

      return [...urls].map((url) => ({ url }));
    }

    function toAttachment(part: Extract<LinqMessagePart, { type: "media" }>): Attachment {
      return {
        type: attachmentType(part.mime_type),
        url: part.url,
        name: part.filename,
        mimeType: part.mime_type,
        size: part.size_bytes,
        width: part.width ?? part.width_px,
        height: part.height ?? part.height_px,
        fetchData: async () => {
          const response = await fetch(part.url);

          if (!response.ok) {
            throw new Error(
              `Failed to fetch Linq attachment ${part.id || part.url}: ${response.status}`,
            );
          }

          return Buffer.from(await response.arrayBuffer());
        },
      };
    }

    function attachmentType(mimeType: string): Attachment["type"] {
      if (mimeType.startsWith("image/")) {
        return "image";
      }

      if (mimeType.startsWith("video/")) {
        return "video";
      }

      if (mimeType.startsWith("audio/")) {
        return "audio";
      }

      return "file";
    }
  }

  // Random
  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content).trim();
  }

  channelIdFromThreadId(threadId: string): string {
    return threadId;
  }

  isDM(threadId: string): boolean {
    return this.decodeThreadId(threadId).isGroup !== true;
  }
}

function compareMessages(left: Message<LinqRawMessage>, right: Message<LinqRawMessage>): number {
  return left.metadata.dateSent.getTime() - right.metadata.dateSent.getTime();
}

function urlsFromText(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>()]+/gi) ?? [];

  return matches.map((url) => url.replace(/[.,!?;:]+$/g, ""));
}

function toLinqReaction(emoji: EmojiValue | string): {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createLinqAdapter(config: LinqAdapterConfig) {
  return new LinqAdapter(config);
}

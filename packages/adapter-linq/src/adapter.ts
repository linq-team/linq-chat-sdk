import { LinqAPIV3 } from "@linqapp/sdk";
import { ConsoleLogger, Message, NotImplementedError, parseMarkdown } from "chat";
import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
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
      url: string;
      filename: string;
      mime_type: string;
      size_bytes: number;
    };

type LinqThreadId = {
  chatId: string;
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
    return `linq-${platformData.chatId}`;
  }

  decodeThreadId(_threadId: string): LinqThreadId {
    const chatId = _threadId.replace("linq-", "");
    return { chatId };
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

  editMessage(
    _threadId: string,
    _messageId: string,
    _message: AdapterPostableMessage,
  ): Promise<RawMessage<LinqRawMessage>> {
    throw new NotImplementedError("editMessage is not implemented");
  }

  deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    throw new NotImplementedError("deleteMessage is not implemented");
  }

  // Reactions
  addReaction(_threadId: string, _messageId: string, _emoji: EmojiValue | string): Promise<void> {
    throw new NotImplementedError("addReaction is not implemented");
  }

  removeReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    throw new NotImplementedError("removeReaction is not implemented");
  }

  // Threads
  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { chatId } = this.decodeThreadId(threadId);
    const chat = await this.apiClient.chats.retrieve(chatId);

    return {
      id: this.encodeThreadId({ chatId: chat.id }),
      channelId: this.encodeThreadId({ chatId: chat.id }),
      channelName: chat.display_name ?? undefined,
      isDM: !chat.is_group,
      metadata: {
        chat,
      },
    };
  }

  async startTyping(threadId: string, _status?: string): Promise<void> {
    const { chatId } = this.decodeThreadId(threadId);

    // todo: disable in group chat
    await this.apiClient.chats.typing.start(chatId);
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

    const text = message.parts
      .flatMap((part) => {
        if ((part.type === "text" || part.type === "link") && typeof part.value === "string") {
          return [part.value];
        }

        return [];
      })
      .join("\n")
      .trim();

    const isMe = message.isMe;
    const senderId = message.sender?.id || message.sender?.handle || "unknown";
    const senderName = message.sender?.handle || message.sender?.id || "unknown";

    return new Message({
      id: message.id,
      threadId: this.encodeThreadId({ chatId: message.chatId }),
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
        edited: false,
      },
      attachments: message.parts.flatMap((part): Attachment[] => {
        if (part.type !== "media") {
          return [];
        }

        return [
          {
            type: attachmentType(part.mime_type),
            url: part.url,
            name: part.filename,
            mimeType: part.mime_type,
            size: part.size_bytes,
          },
        ];
      }),
    });

    function normalizeMessage(value: LinqRawMessage): {
      id: string;
      chatId: string;
      parts: LinqMessagePart[];
      isMe: boolean;
      sender: LinqAPIV3.ChatHandle | null | undefined;
      sentAt: string | null | undefined;
    } {
      if (isMessageEvent(value)) {
        return {
          id: value.id,
          chatId: value.chat.id,
          parts: value.parts,
          isMe: value.direction === "outbound" || value.sender_handle.is_me === true,
          sender: value.sender_handle,
          sentAt: value.sent_at,
        };
      }

      if (isMessageSendResponse(value)) {
        return {
          id: value.message.id,
          chatId: value.chat_id,
          parts: value.message.parts,
          isMe: true,
          sender: value.message.from_handle,
          sentAt: value.message.sent_at || value.message.created_at,
        };
      }

      if (isRetrievedMessage(value)) {
        return {
          id: value.id,
          chatId: value.chat_id,
          parts: value.parts ?? [],
          isMe: value.is_from_me || value.from_handle?.is_me === true,
          sender: value.from_handle,
          sentAt: value.sent_at || value.created_at,
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
  renderFormatted(_content: FormattedContent): string {
    throw new NotImplementedError("renderFormatted is not implemented");
  }

  channelIdFromThreadId(threadId: string): string {
    return threadId;
  }

  isDM(_threadId: string): boolean {
    return true;
  }
}

function compareMessages(left: Message<LinqRawMessage>, right: Message<LinqRawMessage>): number {
  return left.metadata.dateSent.getTime() - right.metadata.dateSent.getTime();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createLinqAdapter(config: LinqAdapterConfig) {
  return new LinqAdapter(config);
}

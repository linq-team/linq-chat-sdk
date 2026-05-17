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
  ThreadInfo,
  WebhookOptions,
} from "chat";

import { LinqFormatConverter } from "./format-converter.js";
import { verifyLinqWebhookRequest } from "./verification.js";

type LinqMessageSendResponse = Awaited<ReturnType<LinqAPIV3["chats"]["messages"]["send"]>>;
type LinqRawMessage = LinqAPIV3.EventsWebhookEvent["data"] | LinqMessageSendResponse;
type LinqMessageEvent = LinqAPIV3.MessageEventV2;

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
  fetchMessages(_threadId: string, _options?: FetchOptions): Promise<FetchResult<LinqRawMessage>> {
    throw new NotImplementedError("fetchMessages is not implemented");
  }

  fetchMessage(_threadId: string, _messageId: string): Promise<Message<LinqRawMessage> | null> {
    throw new NotImplementedError("fetchMessage is not implemented");
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
  fetchThread(_threadId: string): Promise<ThreadInfo> {
    throw new NotImplementedError("fetchThread is not implemented");
  }

  startTyping(_threadId: string, _status?: string): Promise<void> {
    throw new NotImplementedError("startTyping is not implemented");
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
    if (!isMessageEvent(raw)) {
      throw new NotImplementedError("parseMessage only supports Linq message events");
    }

    const text = raw.parts
      .flatMap((part) => {
        if ((part.type === "text" || part.type === "link") && typeof part.value === "string") {
          return [part.value];
        }

        return [];
      })
      .join("\n")
      .trim();

    const isMe = raw.direction === "outbound" || raw.sender_handle.is_me === true;
    const senderId = raw.sender_handle.id || raw.sender_handle.handle || "unknown";
    const senderName = raw.sender_handle.handle || raw.sender_handle.id || "unknown";

    return new Message({
      id: raw.id,
      threadId: this.encodeThreadId({ chatId: raw.chat.id }),
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
        dateSent: dateFrom(raw.sent_at),
        edited: false,
      },
      attachments: raw.parts.flatMap((part): Attachment[] => {
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

    function isMessageEvent(value: LinqRawMessage): value is LinqMessageEvent {
      return (
        typeof value === "object" &&
        value !== null &&
        "id" in value &&
        "chat" in value &&
        "direction" in value &&
        "parts" in value &&
        "sender_handle" in value
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

export function createLinqAdapter(config: LinqAdapterConfig) {
  return new LinqAdapter(config);
}

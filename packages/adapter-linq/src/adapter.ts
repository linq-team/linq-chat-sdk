import { LinqAPIV3 } from "@linqapp/sdk";
import { ConsoleLogger, Message, NotImplementedError } from "chat";
import type {
  Adapter,
  AdapterPostableMessage,
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

import { verifyLinqWebhookRequest } from "./verification.js";

type LinqRawMessage = LinqAPIV3.EventsWebhookEvent["data"];

type LinqThreadId = {
  chatId: string;
};

export interface LinqAdapterConfig {
  signingSecret: string;
}

class LinqAdapter implements Adapter<LinqThreadId, LinqRawMessage> {
  readonly name: string = "linq";
  readonly userName: string = "linq";
  private readonly signingSecret: string;

  private chat: ChatInstance | null = null;
  private logger: Logger;

  constructor(config: LinqAdapterConfig) {
    this.signingSecret = config.signingSecret;
    this.logger = new ConsoleLogger();
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = chat.getLogger("linq");
  }

  // Thread ID
  encodeThreadId(_platformData: LinqThreadId): string {
    throw new NotImplementedError("encodeThreadId is not implemented");
  }

  decodeThreadId(_threadId: string): LinqThreadId {
    throw new NotImplementedError("decodeThreadId is not implemented");
  }

  // Messages
  fetchMessages(_threadId: string, _options?: FetchOptions): Promise<FetchResult<LinqRawMessage>> {
    throw new NotImplementedError("fetchMessages is not implemented");
  }

  fetchMessage(_threadId: string, _messageId: string): Promise<Message<LinqRawMessage> | null> {
    throw new NotImplementedError("fetchMessage is not implemented");
  }

  postMessage(
    _threadId: string,
    _message: AdapterPostableMessage,
  ): Promise<RawMessage<LinqRawMessage>> {
    throw new NotImplementedError("postMessage is not implemented");
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

  parseMessage(_raw: LinqRawMessage): Message<LinqRawMessage> {
    throw new NotImplementedError("parseMessage is not implemented");
  }

  // Random
  renderFormatted(_content: FormattedContent): string {
    throw new NotImplementedError("renderFormatted is not implemented");
  }

  channelIdFromThreadId(_threadId: string): string {
    throw new NotImplementedError("channelIdFromThreadId is not implemented");
  }
}

export function createLinqAdapter(config: LinqAdapterConfig) {
  return new LinqAdapter(config);
}

import { LinqAPIV3 } from "@linqapp/sdk";
import { Message, NotImplementedError } from "chat";
import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  RawMessage,
  ThreadInfo,
  WebhookOptions,
} from "chat";

import { LinqFormatConverter } from "./format-converter.js";
import { verifyLinqWebhookRequest } from "./verification.js";

type LinqMessageReceivedWebhook = LinqAPIV3.MessageReceivedWebhookEvent;
type LinqMessageSendResponse = Awaited<ReturnType<LinqAPIV3["chats"]["messages"]["send"]>>;
type LinqMessagePart = { type?: string; value?: string };

type LinqRawMessage = LinqMessageReceivedWebhook;

type LinqThreadId = {
  chatId: string;
  isGroup: boolean;
};

class LinqAdapter implements Adapter<LinqThreadId, LinqRawMessage> {
  readonly name: string = "linq";
  readonly userName: string = "linq";

  initialize(chat: ChatInstance): Promise<void> {
    throw new NotImplementedError("initialize is not implemented");
  }

  // Thread ID
  encodeThreadId(platformData: LinqThreadId): string {
    throw new NotImplementedError("encodeThreadId is not implemented");
  }

  decodeThreadId(threadId: string): LinqThreadId {
    throw new NotImplementedError("decodeThreadId is not implemented");
  }

  // Messages
  fetchMessages(threadId: string, options?: FetchOptions): Promise<FetchResult<LinqRawMessage>> {
    throw new NotImplementedError("fetchMessages is not implemented");
  }

  fetchMessage(threadId: string, messageId: string): Promise<Message<LinqRawMessage> | null> {
    throw new NotImplementedError("fetchMessage is not implemented");
  }

  postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<LinqRawMessage>> {
    throw new NotImplementedError("postMessage is not implemented");
  }

  editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<LinqRawMessage>> {
    throw new NotImplementedError("editMessage is not implemented");
  }

  deleteMessage(threadId: string, messageId: string): Promise<void> {
    throw new NotImplementedError("deleteMessage is not implemented");
  }

  // Reactions
  addReaction(threadId: string, messageId: string, emoji: EmojiValue | string): Promise<void> {
    throw new NotImplementedError("addReaction is not implemented");
  }

  removeReaction(threadId: string, messageId: string, emoji: EmojiValue | string): Promise<void> {
    throw new NotImplementedError("removeReaction is not implemented");
  }

  // Threads
  fetchThread(threadId: string): Promise<ThreadInfo> {
    throw new NotImplementedError("fetchThread is not implemented");
  }

  startTyping(threadId: string, status?: string): Promise<void> {
    throw new NotImplementedError("startTyping is not implemented");
  }

  // handle webhook
  handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    throw new NotImplementedError("handleWebhook is not implemented");
  }

  parseMessage(raw: LinqRawMessage): Message<LinqRawMessage> {
    throw new NotImplementedError("parseMessage is not implemented");
  }

  // Random
  renderFormatted(content: FormattedContent): string {
    throw new NotImplementedError("renderFormatted is not implemented");
  }

  channelIdFromThreadId(threadId: string): string {
    throw new NotImplementedError("channelIdFromThreadId is not implemented");
  }
}

export function createLinqAdapter() {
  return new LinqAdapter();
}

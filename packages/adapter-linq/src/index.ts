import {
  Message,
  NotImplementedError,
  parseMarkdown,
  toPlainText,
} from "chat"
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
} from "chat"

const DEFAULT_LINQ_API_BASE_URL = "https://api.linqapp.com/api/partner"
const LINQ_SIGNATURE_HEADER = "x-webhook-signature"
const LINQ_SUBSCRIPTION_ID_HEADER = "x-webhook-subscription-id"
const LINQ_TIMESTAMP_HEADER = "x-webhook-timestamp"
const LINQ_EVENT_HEADER = "x-webhook-event"
const MAX_WEBHOOK_AGE_SECONDS = 5 * 60

type MaybePromise<T> = T | Promise<T>

export interface LinqThreadId {
  chatId: string
  isGroup?: boolean
}

export interface LinqAdapterConfig {
  apiBaseUrl?: string
  apiToken?: string | (() => MaybePromise<string | null | undefined>)
  getSigningSecret?: () => MaybePromise<string | null | undefined>
  signingSecret?: string
  userName?: string
  onWebhookEvent?: (event: LinqWebhookEventRecord) => MaybePromise<void>
}

export interface LinqWebhookEventRecord {
  eventId: string | null
  eventType: string | null
  headers: Record<string, string>
  payload: unknown
  subscriptionId: string | null
}

export interface LinqWebhookEnvelope<TData = unknown> {
  api_version?: string
  created_at?: string
  data?: TData
  event_id?: string
  event_type?: string
  partner_id?: string
  trace_id?: string
  webhook_version?: string
}

export interface LinqMessageReceivedData {
  chat?: {
    id?: string
    is_group?: boolean
    owner_handle?: LinqHandle
  }
  delivered_at?: string | null
  direction?: "inbound" | "outbound" | string
  id?: string
  parts?: LinqMessagePart[]
  read_at?: string | null
  sender_handle?: LinqHandle
  sent_at?: string | null
}

export type LinqMessageReceivedWebhook = LinqWebhookEnvelope<LinqMessageReceivedData>

export type LinqHandle = string | {
  handle?: string
  id?: string
  is_me?: boolean
  service?: string
}

export type LinqMessagePart =
  | { type?: "text" | string; value?: string }
  | { type?: "media" | string; filename?: string; mime_type?: string; url?: string }
  | { type?: "link" | string; value?: string }

export interface LinqSendMessageResponse {
  chat_id: string
  message: {
    created_at?: string
    id: string
    parts?: LinqMessagePart[]
    sent_at?: string | null
  }
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value)
}

function decodeSegment(value: string): string {
  return decodeURIComponent(value)
}

function normalizeHeaders(headers: Headers): Record<string, string> {
  const entries: Record<string, string> = {}

  headers.forEach((value, key) => {
    entries[key] = value
  })

  return entries
}

function isFreshTimestamp(timestamp: string): boolean {
  const sentAt = Number(timestamp)

  if (!Number.isFinite(sentAt)) {
    return false
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - sentAt)
  return ageSeconds <= MAX_WEBHOOK_AGE_SECONDS
}

function fromHex(hex: string): Uint8Array | null {
  const normalized = hex.startsWith("sha256=") ? hex.slice("sha256=".length) : hex

  if (normalized.length % 2 !== 0 || /[^a-f0-9]/i.test(normalized)) {
    return null
  }

  const bytes = new Uint8Array(normalized.length / 2)

  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16)
  }

  return bytes
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false
  }

  let mismatch = 0

  for (let index = 0; index < left.length; index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }

  return mismatch === 0
}

async function signWebhookPayload(secret: string, timestamp: string, rawBody: Uint8Array): Promise<Uint8Array> {
  const encoder = new TextEncoder()
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const prefix = encoder.encode(`${timestamp}.`)
  const signedPayload = new Uint8Array(prefix.length + rawBody.length)
  signedPayload.set(prefix)
  signedPayload.set(rawBody, prefix.length)

  return new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, signedPayload))
}

async function verifyLinqSignature(
  timestamp: string,
  signature: string,
  secret: string,
  rawBody: Uint8Array,
): Promise<boolean> {
  const providedSignature = fromHex(signature)

  if (!providedSignature) {
    return false
  }

  const expectedSignature = await signWebhookPayload(secret, timestamp, rawBody)
  return constantTimeEqual(providedSignature, expectedSignature)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getEventType(payload: unknown, headers: Record<string, string>): string | null {
  if (isRecord(payload) && typeof payload.event_type === "string") {
    return payload.event_type
  }

  return headers[LINQ_EVENT_HEADER] ?? null
}

function extractText(parts: LinqMessagePart[] | undefined): string {
  if (!parts) {
    return ""
  }

  return parts
    .map((part) => {
      if (part.type === "text" && "value" in part && typeof part.value === "string") {
        return part.value
      }

      if (part.type === "link" && "value" in part && typeof part.value === "string") {
        return part.value
      }

      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function handleToString(handle: LinqHandle | undefined): string {
  if (!handle) {
    return "unknown"
  }

  if (typeof handle === "string") {
    return handle
  }

  return handle.handle || handle.id || "unknown"
}

function handleId(handle: LinqHandle | undefined): string {
  if (!handle) {
    return "unknown"
  }

  if (typeof handle === "string") {
    return handle
  }

  return handle.id || handle.handle || "unknown"
}

function handleIsMe(handle: LinqHandle | undefined): boolean {
  return typeof handle === "object" && handle !== null && handle.is_me === true
}

function dateFrom(...values: Array<string | null | undefined>): Date {
  for (const value of values) {
    if (!value) {
      continue
    }

    const date = new Date(value)

    if (!Number.isNaN(date.getTime())) {
      return date
    }
  }

  return new Date()
}

function notImplemented(feature: string): NotImplementedError {
  return new NotImplementedError(`Linq adapter does not support ${feature} yet.`, feature)
}

export class LinqAdapter implements Adapter<LinqThreadId, unknown> {
  readonly name = "linq"
  readonly persistMessageHistory = true
  readonly userName: string

  private chat: ChatInstance | null = null
  private readonly apiBaseUrl: string
  private readonly config: LinqAdapterConfig
  private readonly messageCache = new Map<string, Message<unknown>[]>()

  constructor(config: LinqAdapterConfig = {}) {
    this.config = config
    this.apiBaseUrl = config.apiBaseUrl?.trim() || DEFAULT_LINQ_API_BASE_URL
    this.userName = config.userName?.trim() || "linqbot"
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat
  }

  encodeThreadId(platformData: LinqThreadId): string {
    const base = `linq:${encodeSegment(platformData.chatId)}`

    if (platformData.isGroup === undefined) {
      return base
    }

    return `${base}:${platformData.isGroup ? "group" : "dm"}`
  }

  decodeThreadId(threadId: string): LinqThreadId {
    const parts = threadId.split(":")

    if (parts[0] !== "linq" || parts.length < 2 || parts.length > 3 || !parts[1]) {
      throw new Error(`Invalid Linq thread ID: ${threadId}`)
    }

    return {
      chatId: decodeSegment(parts[1]),
      isGroup: parts[2] === undefined ? undefined : parts[2] === "group",
    }
  }

  channelIdFromThreadId(threadId: string): string {
    const { chatId } = this.decodeThreadId(threadId)
    return `linq:${encodeSegment(chatId)}`
  }

  isDM(threadId: string): boolean {
    return this.decodeThreadId(threadId).isGroup !== true
  }

  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    const timestamp = request.headers.get(LINQ_TIMESTAMP_HEADER)?.trim() || ""
    const signature = request.headers.get(LINQ_SIGNATURE_HEADER)?.trim() || ""

    if (!timestamp || !signature) {
      return new Response("Missing Linq webhook signature headers", { status: 401 })
    }

    if (!isFreshTimestamp(timestamp)) {
      return new Response("Linq webhook timestamp is too old or invalid", { status: 401 })
    }

    const signingSecret = await this.resolveSigningSecret()

    if (!signingSecret) {
      return new Response("Linq webhook signing secret is not configured", { status: 503 })
    }

    const rawBody = new Uint8Array(await request.arrayBuffer())

    if (!await verifyLinqSignature(timestamp, signature, signingSecret, rawBody)) {
      return new Response("Invalid Linq webhook signature", { status: 401 })
    }

    let payload: unknown

    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody)) as unknown
    } catch {
      return new Response("Invalid JSON", { status: 400 })
    }

    const headers = normalizeHeaders(request.headers)
    const eventType = getEventType(payload, headers)
    this.recordWebhookEvent(payload, headers, options)

    if (eventType === "message.received") {
      this.processMessageReceived(payload as LinqMessageReceivedWebhook, options)
    }

    return new Response("OK", { status: 200 })
  }

  parseMessage(raw: unknown): Message<unknown> {
    const payload = raw as LinqMessageReceivedWebhook
    const data = payload.data
    const chatId = data?.chat?.id

    if (!data || !chatId || !data.id) {
      throw new Error("Invalid Linq message.received payload")
    }

    const threadId = this.encodeThreadId({
      chatId,
      isGroup: data.chat?.is_group,
    })
    const text = extractText(data.parts)
    const sender = data.sender_handle
    const isMe = data.direction === "outbound" || handleIsMe(sender)

    const message = new Message({
      id: data.id,
      threadId,
      text,
      formatted: parseMarkdown(text),
      raw,
      author: {
        userId: handleId(sender),
        userName: handleToString(sender),
        fullName: handleToString(sender),
        isBot: isMe ? true : "unknown",
        isMe,
      },
      metadata: {
        dateSent: dateFrom(data.sent_at, payload.created_at),
        edited: false,
      },
      attachments: [],
    })

    this.cacheMessage(message)
    return message
  }

  renderFormatted(content: FormattedContent): string {
    return toPlainText(content)
  }

  async postMessage(threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> {
    const { chatId, isGroup } = this.decodeThreadId(threadId)
    const text = this.renderPostable(message).trim()

    if (!text) {
      throw new Error("Linq message text cannot be empty.")
    }

    const response = await this.callLinqApi<LinqSendMessageResponse>(`v3/chats/${encodeURIComponent(chatId)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        message: {
          parts: [
            {
              type: "text",
              value: text,
            },
          ],
        },
      }),
    })
    const resultingThreadId = this.encodeThreadId({
      chatId: response.chat_id || chatId,
      isGroup,
    })

    return {
      id: response.message.id,
      threadId: resultingThreadId,
      raw: response,
    }
  }

  async postChannelMessage(channelId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> {
    return this.postMessage(channelId, message)
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const decoded = this.decodeThreadId(threadId)

    return {
      id: this.encodeThreadId(decoded),
      channelId: this.channelIdFromThreadId(threadId),
      isDM: decoded.isGroup !== true,
      metadata: {
        chatId: decoded.chatId,
        isGroup: decoded.isGroup,
      },
    }
  }

  async fetchMessages(threadId: string, options: FetchOptions = {}): Promise<FetchResult<unknown>> {
    const messages = [...this.messageCache.get(threadId) ?? []]
    messages.sort((left, right) => left.metadata.dateSent.getTime() - right.metadata.dateSent.getTime())

    const limit = options.limit ?? messages.length
    const start = options.cursor ? Number(options.cursor) : 0
    const safeStart = Number.isFinite(start) && start >= 0 ? start : 0
    const page = messages.slice(safeStart, safeStart + limit)
    const nextIndex = safeStart + page.length

    return {
      messages: page,
      nextCursor: nextIndex < messages.length ? String(nextIndex) : undefined,
    }
  }

  async startTyping(_threadId: string, _status?: string): Promise<void> {
    // Linq typing support can be added after receive/reply is stable.
  }

  async addReaction(_threadId: string, _messageId: string, _emoji: EmojiValue | string): Promise<void> {
    throw notImplemented("addReaction")
  }

  async removeReaction(_threadId: string, _messageId: string, _emoji: EmojiValue | string): Promise<void> {
    throw notImplemented("removeReaction")
  }

  async deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    throw notImplemented("deleteMessage")
  }

  async editMessage(_threadId: string, _messageId: string, _message: AdapterPostableMessage): Promise<RawMessage<unknown>> {
    throw notImplemented("editMessage")
  }

  private processMessageReceived(payload: LinqMessageReceivedWebhook, options?: WebhookOptions): void {
    if (!this.chat || payload.data?.direction !== "inbound" || !payload.data.chat?.id) {
      return
    }

    const threadId = this.encodeThreadId({
      chatId: payload.data.chat.id,
      isGroup: payload.data.chat.is_group,
    })

    this.chat.processMessage(this, threadId, () => Promise.resolve(this.parseMessage(payload)), options)
  }

  private recordWebhookEvent(payload: unknown, headers: Record<string, string>, options?: WebhookOptions): void {
    if (!this.config.onWebhookEvent) {
      return
    }

    const payloadRecord = isRecord(payload) ? payload : {}
    const task = Promise.resolve(this.config.onWebhookEvent({
      eventId: typeof payloadRecord.event_id === "string" ? payloadRecord.event_id : null,
      eventType: getEventType(payload, headers),
      headers,
      payload,
      subscriptionId: headers[LINQ_SUBSCRIPTION_ID_HEADER] ?? null,
    })).catch((error) => {
      console.warn("Failed to store Linq webhook event", error)
    })

    if (options?.waitUntil) {
      options.waitUntil(task)
    }
  }

  private cacheMessage(message: Message<unknown>): void {
    const messages = this.messageCache.get(message.threadId) ?? []
    const existingIndex = messages.findIndex((cached) => cached.id === message.id)

    if (existingIndex >= 0) {
      messages[existingIndex] = message
    } else {
      messages.push(message)
    }

    this.messageCache.set(message.threadId, messages.slice(-100))
  }

  private renderPostable(message: AdapterPostableMessage): string {
    if (typeof message === "string") {
      return message
    }

    if ("raw" in message) {
      return message.raw
    }

    if ("markdown" in message) {
      return message.markdown
    }

    if ("ast" in message) {
      return toPlainText(message.ast)
    }

    if ("fallbackText" in message && typeof message.fallbackText === "string") {
      return message.fallbackText
    }

    return "[card]"
  }

  private async resolveSigningSecret(): Promise<string | null> {
    const secret = this.config.signingSecret ?? await this.config.getSigningSecret?.()
    return secret?.trim() || null
  }

  private async resolveApiToken(): Promise<string> {
    const configuredToken = typeof this.config.apiToken === "function"
      ? await this.config.apiToken()
      : this.config.apiToken
    const token = configuredToken?.trim()

    if (!token) {
      throw new Error("LINQ_API_TOKEN is not configured.")
    }

    return token
  }

  private async callLinqApi<T>(path: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set("authorization", `Bearer ${await this.resolveApiToken()}`)
    headers.set("content-type", "application/json")

    const response = await fetch(new URL(path, `${this.apiBaseUrl}/`).toString(), {
      ...init,
      headers,
    })
    const responseText = await response.text()
    const data = responseText ? JSON.parse(responseText) as T & { message?: string; error?: { message?: string } } : null

    if (!response.ok || data === null) {
      throw new Error(data?.error?.message || data?.message || `Linq API request to ${path} failed.`)
    }

    return data as T
  }

}

export function createLinqAdapter(config: LinqAdapterConfig = {}): LinqAdapter {
  return new LinqAdapter(config)
}

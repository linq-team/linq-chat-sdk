import { HTTPError } from "nitro"

const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org"

interface TelegramApiEnvelope<T> {
  ok: boolean
  result?: T
  description?: string
}

export interface TelegramBotProfile {
  first_name: string
  id: number
  is_bot: boolean
  username?: string
}

export interface TelegramWebhookInfo {
  has_custom_certificate: boolean
  ip_address?: string
  last_error_date?: number
  last_error_message?: string
  max_connections?: number
  pending_update_count: number
  url: string
}

export function getTelegramApiBaseUrl(): string {
  return process.env.TELEGRAM_API_BASE_URL?.trim() || DEFAULT_TELEGRAM_API_BASE_URL
}

export function getTelegramBotToken(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || null
}

export function hasTelegramBotToken(): boolean {
  return getTelegramBotToken() !== null
}

export function getConfiguredTelegramUserName(): string | null {
  return process.env.TELEGRAM_BOT_USERNAME?.trim() || null
}

export function buildTelegramWebhookUrl(publicBaseUrl: string): string {
  let base: URL

  try {
    base = new URL(publicBaseUrl)
  } catch {
    throw new HTTPError({
      status: 400,
      message: "Public app URL must be a valid absolute URL.",
    })
  }

  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new HTTPError({
      status: 400,
      message: "Public app URL must use http or https.",
    })
  }

  const normalizedBase = new URL(base.toString())
  if (!normalizedBase.pathname.endsWith("/")) {
    normalizedBase.pathname = `${normalizedBase.pathname}/`
  }

  return new URL("api/webhooks/telegram", normalizedBase).toString()
}

async function callTelegramApi<T>(method: string, body?: unknown): Promise<T> {
  const botToken = getTelegramBotToken()

  if (!botToken) {
    throw new HTTPError({
      status: 400,
      message: "TELEGRAM_BOT_TOKEN is not configured.",
    })
  }

  const response = await fetch(`${getTelegramApiBaseUrl()}/bot${botToken}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  const data = await response.json() as TelegramApiEnvelope<T>

  if (!response.ok || !data.ok || data.result === undefined) {
    throw new HTTPError({
      status: 502,
      message: data.description || `Telegram ${method} failed.`,
    })
  }

  return data.result
}

export async function getTelegramBotProfile(): Promise<TelegramBotProfile> {
  return callTelegramApi<TelegramBotProfile>("getMe")
}

export async function getTelegramWebhookInfo(): Promise<TelegramWebhookInfo> {
  return callTelegramApi<TelegramWebhookInfo>("getWebhookInfo")
}

export async function setTelegramWebhook(url: string, secretToken: string): Promise<true> {
  return callTelegramApi<true>("setWebhook", {
    url,
    secret_token: secretToken,
  })
}

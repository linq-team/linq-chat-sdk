import { randomBytes } from "node:crypto"

import { defineHandler, HTTPError } from "nitro"

import {
  deleteTelegramWebhookSecret,
  ensureAppSettingsTable,
  getTelegramWebhookSecretRecord,
  hasDatabaseUrl,
  setTelegramWebhookSecret,
} from "../../../lib/database"
import { requireSetupAccess } from "../../../lib/setup-auth"
import {
  buildTelegramWebhookUrl,
  getTelegramBotProfile,
  getTelegramWebhookInfo,
  hasTelegramBotToken,
  setTelegramWebhook,
} from "../../../lib/telegram-api"

function maskSecret(secret: string): string {
  if (secret.length <= 8) {
    return "*".repeat(secret.length)
  }

  return `${secret.slice(0, 4)}...${secret.slice(-4)}`
}

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return "Unknown error"
}

export default defineHandler(async (event) => {
  requireSetupAccess(event)

  if (!hasDatabaseUrl()) {
    throw new HTTPError({
      status: 400,
      message: "POSTGRES_URL or DATABASE_URL must be configured before registering the webhook.",
    })
  }

  if (!hasTelegramBotToken()) {
    throw new HTTPError({
      status: 400,
      message: "TELEGRAM_BOT_TOKEN must be configured before registering the webhook.",
    })
  }

  const body = await event.req.json().catch(() => ({})) as {
    publicBaseUrl?: string
    rotateSecret?: boolean
  }

  const publicBaseUrl = body.publicBaseUrl?.trim() || new URL("/", event.req.url).toString()
  const rotateSecret = body.rotateSecret === true
  const webhookUrl = buildTelegramWebhookUrl(publicBaseUrl)

  await ensureAppSettingsTable()

  const previousSecret = await getTelegramWebhookSecretRecord()
  const nextSecret = previousSecret?.value && !rotateSecret
    ? previousSecret.value
    : randomBytes(24).toString("hex")

  const shouldPersistSecret = !previousSecret || rotateSecret

  if (shouldPersistSecret) {
    await setTelegramWebhookSecret(nextSecret)
  }

  try {
    await setTelegramWebhook(webhookUrl, nextSecret)

    const [bot, webhookInfo] = await Promise.all([
      getTelegramBotProfile(),
      getTelegramWebhookInfo(),
    ])

    return {
      ok: true,
      publicBaseUrl,
      webhookUrl,
      rotatedSecret: shouldPersistSecret,
      webhookSecretPreview: maskSecret(nextSecret),
      bot,
      webhookInfo,
    }
  } catch (error) {
    if (shouldPersistSecret) {
      if (previousSecret) {
        await setTelegramWebhookSecret(previousSecret.value)
      } else {
        await deleteTelegramWebhookSecret()
      }
    }

    throw new HTTPError({
      status: 502,
      message: `Unable to register Telegram webhook: ${toMessage(error)}`,
    })
  }
})

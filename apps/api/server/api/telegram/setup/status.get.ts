import { defineHandler } from "nitro"

import {
  getTelegramWebhookSecretRecord,
  hasDatabaseUrl,
  ensureAppSettingsTable,
} from "../../../lib/database"
import {
  SETUP_ACCESS_TOKEN_ENV_NAME,
  isSetupAccessTokenConfigured,
  requireSetupAccess,
} from "../../../lib/setup-auth"
import {
  buildTelegramWebhookUrl,
  getConfiguredTelegramUserName,
  getTelegramBotProfile,
  getTelegramWebhookInfo,
  hasTelegramBotToken,
} from "../../../lib/telegram-api"

function maskSecret(secret: string | null): string | null {
  if (!secret) {
    return null
  }

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

  const defaultPublicBaseUrl = new URL("/", event.req.url).toString()
  const expectedWebhookUrl = buildTelegramWebhookUrl(defaultPublicBaseUrl)

  const database = {
    configured: hasDatabaseUrl(),
    connected: false,
    error: null as string | null,
  }

  let secretRecord: Awaited<ReturnType<typeof getTelegramWebhookSecretRecord>> = null

  if (database.configured) {
    try {
      await ensureAppSettingsTable()
      secretRecord = await getTelegramWebhookSecretRecord()
      database.connected = true
    } catch (error) {
      database.error = toMessage(error)
    }
  }

  const telegram = {
    tokenConfigured: hasTelegramBotToken(),
    configuredUserName: getConfiguredTelegramUserName(),
    reachable: false,
    bot: null as Awaited<ReturnType<typeof getTelegramBotProfile>> | null,
    webhookInfo: null as Awaited<ReturnType<typeof getTelegramWebhookInfo>> | null,
    error: null as string | null,
  }

  if (telegram.tokenConfigured) {
    try {
      const [bot, webhookInfo] = await Promise.all([
        getTelegramBotProfile(),
        getTelegramWebhookInfo(),
      ])

      telegram.reachable = true
      telegram.bot = bot
      telegram.webhookInfo = webhookInfo
    } catch (error) {
      telegram.error = toMessage(error)
    }
  }

  return {
    access: {
      required: isSetupAccessTokenConfigured(),
      envName: SETUP_ACCESS_TOKEN_ENV_NAME,
    },
    environment: {
      database,
      telegram: {
        tokenConfigured: telegram.tokenConfigured,
        configuredUserName: telegram.configuredUserName,
      },
    },
    setup: {
      ready: database.connected && telegram.tokenConfigured,
      defaultPublicBaseUrl,
      expectedWebhookUrl,
      webhookSecretConfigured: Boolean(secretRecord),
      webhookSecretPreview: maskSecret(secretRecord?.value ?? null),
      webhookSecretUpdatedAt: secretRecord?.updatedAt ?? null,
    },
    telegram: {
      reachable: telegram.reachable,
      bot: telegram.bot,
      webhookInfo: telegram.webhookInfo,
      webhookMatchesExpected: telegram.webhookInfo?.url === expectedWebhookUrl,
      error: telegram.error,
    },
  }
})

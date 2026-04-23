import { defineHandler, HTTPError } from "nitro"

import { getBot } from "../../lib/bot"
import { getTelegramWebhookSecret } from "../../lib/database"

export default defineHandler(async (event) => {
  const secret = await getTelegramWebhookSecret()

  if (!secret) {
    throw new HTTPError({
      status: 503,
      message: "Telegram webhook secret is not configured yet. Open the setup page first.",
    })
  }

  const providedSecret = event.req.headers.get("x-telegram-bot-api-secret-token")

  if (providedSecret !== secret) {
    throw new HTTPError({
      status: 401,
      message: "Invalid Telegram webhook secret.",
    })
  }

  return getBot().webhooks.telegram(event.req, {
    waitUntil: (task) => event.req.waitUntil?.(task),
  })
})

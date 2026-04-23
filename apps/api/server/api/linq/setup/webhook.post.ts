import { defineHandler, HTTPError } from "nitro"

import {
  ensureAppSettingsTable,
  getLinqWebhookSubscriptionId,
  hasDatabaseUrl,
  setLinqWebhookSecret,
  setLinqWebhookSubscriptionId,
} from "../../../lib/database"
import {
  LINQ_API_TOKEN_ENV_NAME,
  buildLinqWebhookUrl,
  createLinqWebhookSubscription,
  hasLinqApiToken,
} from "../../../lib/linq-api"
import { requireSetupAccess } from "../../../lib/setup-auth"

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
      message: "POSTGRES_URL or DATABASE_URL must be configured before registering the Linq webhook.",
    })
  }

  if (!hasLinqApiToken()) {
    throw new HTTPError({
      status: 400,
      message: `${LINQ_API_TOKEN_ENV_NAME} must be configured before registering the Linq webhook.`,
    })
  }

  const body = await event.req.json().catch(() => ({})) as {
    publicBaseUrl?: string
  }

  const publicBaseUrl = body.publicBaseUrl?.trim() || new URL("/", event.req.url).toString()
  const webhookUrl = buildLinqWebhookUrl(publicBaseUrl)

  await ensureAppSettingsTable()

  const existingSubscriptionId = await getLinqWebhookSubscriptionId()

  try {
    const subscription = await createLinqWebhookSubscription(webhookUrl)

    await setLinqWebhookSecret(subscription.signing_secret)
    await setLinqWebhookSubscriptionId(subscription.id)

    return {
      ok: true,
      existingSubscriptionId,
      publicBaseUrl,
      webhookUrl,
      subscription: {
        createdAt: subscription.created_at,
        id: subscription.id,
        isActive: subscription.is_active,
        subscribedEvents: subscription.subscribed_events,
        targetUrl: subscription.target_url,
        updatedAt: subscription.updated_at,
      },
      signingSecretPreview: maskSecret(subscription.signing_secret),
    }
  } catch (error) {
    throw new HTTPError({
      status: 502,
      message: `Unable to register Linq webhook: ${toMessage(error)}`,
    })
  }
})

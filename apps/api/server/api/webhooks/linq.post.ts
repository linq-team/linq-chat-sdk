import { defineHandler } from "nitro"

import { getBot } from "../../lib/bot"
import { storeLinqWebhookEvent } from "../../lib/database"

const LINQ_EVENT_HEADER = "x-webhook-event"
const LINQ_SUBSCRIPTION_ID_HEADER = "x-webhook-subscription-id"

function normalizeHeaders(headers: Headers): Record<string, string> {
  const entries: Record<string, string> = {}

  headers.forEach((value, key) => {
    entries[key] = value
  })

  return entries
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

async function storeWebhookEvent(request: Request): Promise<void> {
  const headers = normalizeHeaders(request.headers)
  const payload = await request.json().catch(() => null)
  const payloadRecord = isRecord(payload) ? payload : {}

  await storeLinqWebhookEvent({
    eventId: typeof payloadRecord.event_id === "string" ? payloadRecord.event_id : null,
    eventType: getEventType(payload, headers),
    headers,
    payload,
    subscriptionId: headers[LINQ_SUBSCRIPTION_ID_HEADER] ?? null,
  })
}

export default defineHandler(async (event) => {
  const requestForStorage = event.req.clone()
  const response = await (await getBot()).webhooks.linq(
    event.req,
    event.req.waitUntil
      ? { waitUntil: (task) => event.req.waitUntil?.(task) }
      : undefined,
  )

  if (!response.ok) {
    return response
  }

  const storeTask = storeWebhookEvent(requestForStorage).catch((error) => {
    console.warn("Failed to store Linq webhook event", error)
  })

  if (event.req.waitUntil) {
    event.req.waitUntil(storeTask)
  } else {
    await storeTask
  }

  return response
})

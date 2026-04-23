import { createHmac, timingSafeEqual } from "node:crypto"

import { defineHandler, HTTPError } from "nitro"

import { getLinqWebhookSecret, storeLinqWebhookEvent } from "../../lib/database"

const MAX_WEBHOOK_AGE_SECONDS = 5 * 60

function normalizeHeaders(headers: Headers): Record<string, string> {
  const entries: Record<string, string> = {}

  headers.forEach((value, key) => {
    entries[key] = value
  })

  return entries
}

function verifyLinqSignature(timestamp: string, signature: string, secret: string, rawBody: Buffer): boolean {
  const signedPayload = Buffer.concat([
    Buffer.from(`${timestamp}.`, "utf8"),
    rawBody,
  ])

  const expectedSignature = createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex")

  const providedBuffer = Buffer.from(signature, "hex")
  const expectedBuffer = Buffer.from(expectedSignature, "hex")

  if (providedBuffer.length !== expectedBuffer.length) {
    return false
  }

  return timingSafeEqual(providedBuffer, expectedBuffer)
}

function isFreshTimestamp(timestamp: string): boolean {
  const sentAt = Number(timestamp)

  if (!Number.isFinite(sentAt)) {
    return false
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - sentAt)
  return ageSeconds <= MAX_WEBHOOK_AGE_SECONDS
}

export default defineHandler(async (event) => {
  const secret = await getLinqWebhookSecret()

  if (!secret) {
    throw new HTTPError({
      status: 503,
      message: "Linq webhook secret is not configured yet. Run the Linq setup endpoint first.",
    })
  }

  const timestamp = event.req.headers.get("x-webhook-timestamp")?.trim() || ""
  const signature = event.req.headers.get("x-webhook-signature")?.trim() || ""

  if (!timestamp || !signature) {
    throw new HTTPError({
      status: 400,
      message: "Missing Linq webhook signature headers.",
    })
  }

  if (!isFreshTimestamp(timestamp)) {
    throw new HTTPError({
      status: 401,
      message: "Linq webhook timestamp is too old or invalid.",
    })
  }

  const rawBody = Buffer.from(await event.req.arrayBuffer())

  if (!verifyLinqSignature(timestamp, signature, secret, rawBody)) {
    throw new HTTPError({
      status: 401,
      message: "Invalid Linq webhook signature.",
    })
  }

  let payload: unknown

  try {
    payload = JSON.parse(rawBody.toString("utf8")) as unknown
  } catch {
    throw new HTTPError({
      status: 400,
      message: "Linq webhook body must be valid JSON.",
    })
  }

  const payloadRecord = payload as {
    event_id?: string
    event_type?: string
  }
  const headers = normalizeHeaders(event.req.headers)
  const subscriptionId = event.req.headers.get("x-webhook-subscription-id")?.trim() || null

  const writeTask = storeLinqWebhookEvent({
    eventId: payloadRecord.event_id ?? null,
    eventType: payloadRecord.event_type ?? headers["x-webhook-event"] ?? null,
    headers,
    payload,
    subscriptionId,
  })

  if (event.req.waitUntil) {
    event.req.waitUntil(writeTask)
  } else {
    await writeTask
  }

  return {
    ok: true,
    eventId: payloadRecord.event_id ?? null,
    eventType: payloadRecord.event_type ?? headers["x-webhook-event"] ?? null,
    subscriptionId,
  }
})

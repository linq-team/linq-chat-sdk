import { defineHandler, HTTPError } from "nitro"

import { sendFunMessageToThread } from "../../lib/bot"
import { requireSetupAccess } from "../../lib/setup-auth"

export default defineHandler(async (event) => {
  requireSetupAccess(event)

  const body = await event.req.json().catch(() => ({})) as {
    threadId?: string
  }
  const threadId = body.threadId?.trim()

  if (!threadId) {
    throw new HTTPError({
      status: 400,
      message: "threadId is required.",
    })
  }

  try {
    return {
      ok: true,
      ...await sendFunMessageToThread(threadId),
    }
  } catch (error) {
    throw new HTTPError({
      status: 500,
      message: error instanceof Error ? error.message : "Unable to send fun message.",
    })
  }
})

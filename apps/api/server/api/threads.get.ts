import { defineHandler, HTTPError } from "nitro"

import { hasDatabaseUrl, listChatThreads } from "../lib/database"
import { requireSetupAccess } from "../lib/setup-auth"

export default defineHandler(async (event) => {
  requireSetupAccess(event)

  if (!hasDatabaseUrl()) {
    throw new HTTPError({
      status: 400,
      message: "POSTGRES_URL or DATABASE_URL must be configured before listing threads.",
    })
  }

  return {
    threads: await listChatThreads(),
  }
})

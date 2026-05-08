import { defineHandler } from "nitro"

import { getBot } from "../../lib/bot"

export default defineHandler(async (event) => {
  return (await getBot())
    .webhooks.linq(event.req,
      event.req.waitUntil
        ? { waitUntil: (task) => event.req.waitUntil?.(task) }
        : undefined)
})

import { defineHandler } from "nitro"

import { getBot } from "../../lib/bot"

export default defineHandler(async (event) => {
  return (await getBot()).webhooks.whatsapp(event.req)
})

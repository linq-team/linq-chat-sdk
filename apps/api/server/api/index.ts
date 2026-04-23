import { defineHandler } from "nitro"

export default defineHandler(() => {
  return {
    service: "linq-chat-sdk telegram bot",
    setupPage: "/",
    routes: {
      webhook: "/api/webhooks/telegram",
      setupStatus: "/api/telegram/setup/status",
      setupWebhook: "/api/telegram/setup/webhook",
    },
  }
})

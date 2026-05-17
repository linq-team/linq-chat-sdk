import { defineHandler } from "nitro"

export default defineHandler(() => {
  return {
    service: "linq-chat-sdk bot",
    setupPage: "/",
    routes: {
      telegram: {
        webhook: "/api/webhooks/telegram",
        setupStatus: "/api/telegram/setup/status",
        setupWebhook: "/api/telegram/setup/webhook",
      },
      whatsapp: {
        webhook: "/api/webhooks/whatsapp",
      },
      linq: {
        webhook: "/api/webhooks/linq?version=2026-02-03",
        setupWebhook: "/api/linq/setup/webhook",
      },
    },
  }
})

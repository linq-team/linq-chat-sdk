import { createLinqAdapter } from "@linq-chat-sdk/adapter-linq"
import { createPostgresState } from "@chat-adapter/state-pg"
import { createTelegramAdapter } from "@chat-adapter/telegram"
import { Chat } from "chat"

import {
  getLinqWebhookSecret,
  getPostgresPool,
  getTelegramWebhookSecret,
  storeLinqWebhookEvent,
} from "./database"
import { getLinqApiBaseUrl, getLinqApiToken } from "./linq-api"

let bot: Chat<{
  linq: ReturnType<typeof createLinqAdapter>
  telegram: ReturnType<typeof createTelegramAdapter>
}> | undefined

function buildReply(text: string): string {
  if (!text.trim()) {
    return "Chat SDK is connected to this API. Replace this starter reply with your real bot workflow."
  }

  return [
    "Chat SDK is connected to this API.",
    "",
    "Replace this starter reply with your real bot workflow.",
    "",
    `Latest message: ${text}`,
  ].join("\n")
}

async function createBot() {
  const telegramSecret = await getTelegramWebhookSecret()
  const telegram = createTelegramAdapter({ mode: "webhook", secretToken: telegramSecret ?? undefined })
  const linq = createLinqAdapter({
    apiBaseUrl: getLinqApiBaseUrl(),
    apiToken: getLinqApiToken,
    getSigningSecret: getLinqWebhookSecret,
    onWebhookEvent: async (record) => {
      await storeLinqWebhookEvent(record)
    },
    userName: process.env.LINQ_BOT_USERNAME?.trim() || process.env.TELEGRAM_BOT_USERNAME?.trim() || "linqbot",
  })

  const chat = new Chat({
    userName: process.env.TELEGRAM_BOT_USERNAME?.trim() || "linqbot",
    adapters: {
      linq,
      telegram,
    },
    state: createPostgresState({
      client: getPostgresPool(),
      keyPrefix: "linq-chat-sdk",
    }),
    concurrency: {
      strategy: "debounce",
      debounceMs: 1500,
    },
    fallbackStreamingPlaceholderText: null,
  })

  chat.onDirectMessage(async (thread, message) => {
    await thread.subscribe()
    await thread.post(buildReply(message.text))
  })

  chat.onNewMention(async (thread, message) => {
    await thread.subscribe()
    await thread.post(buildReply(message.text))
  })

  chat.onSubscribedMessage(async (thread, message) => {
    await thread.post(buildReply(message.text))
  })

  return chat
}

export async function getBot() {
  if (!bot) {
    bot = await createBot()
  }

  return bot
}

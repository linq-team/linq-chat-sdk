import { createPostgresState } from "@chat-adapter/state-pg"
import { createTelegramAdapter } from "@chat-adapter/telegram"
import { Chat } from "chat"

import { getPostgresPool } from "./database"

let bot: Chat<{ telegram: ReturnType<typeof createTelegramAdapter> }> | undefined

function buildReply(text: string): string {
  if (!text.trim()) {
    return "Telegram is connected to this API. Replace this starter reply with your real bot workflow."
  }

  return [
    "Telegram is connected to this API.",
    "",
    "Replace this starter reply with your real bot workflow.",
    "",
    `Latest message: ${text}`,
  ].join("\n")
}

function createBot() {
  const telegram = createTelegramAdapter({ mode: "webhook" })

  const chat = new Chat({
    userName: process.env.TELEGRAM_BOT_USERNAME?.trim() || "linqbot",
    adapters: {
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

export function getBot() {
  if (!bot) {
    bot = createBot()
  }

  return bot
}

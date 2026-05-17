import { createLinqAdapter } from "@linq-chat-sdk/adapter-linq"
import { createPostgresState } from "@chat-adapter/state-pg"
import { createTelegramAdapter } from "@chat-adapter/telegram"
import { ToolLoopAgent } from "ai"
import { Chat } from "chat"
import type { Message, Thread } from "chat"

import {
  getLinqWebhookSecret,
  getPostgresPool,
  getTelegramWebhookSecret,
} from "./database"
import { getLinqApiBaseUrl, getLinqApiToken } from "./linq-api"

let bot: Chat<{
  linq: ReturnType<typeof createLinqAdapter>
  telegram: ReturnType<typeof createTelegramAdapter>
}> | undefined

const AI_MODEL = "anthropic/claude-haiku-4.5"
const TYPING_REFRESH_MS = 4_000

function createAgent() {
  return new ToolLoopAgent({
    model: AI_MODEL,
    instructions: [
      "You are a friendly AI assistant replying in a chat conversation.",
      "Reply like a warm, goofy, fun chat companion: playful, uplifting, and a little cheeky, but never disrespectful.",
      "Keep replies concise, useful, and easy to read in a text message.",
    ].join("\n"),
  })
}

async function postAiReply(thread: Thread, message: Message) {
  const prompt = message.text.trim()

  if (!prompt) {
    await thread.post("I can reply to text messages. Send me a message and I'll help.")
    return
  }

  const refreshTyping = () => {
    void thread.startTyping().catch(() => {})
  }
  refreshTyping()
  const typingInterval = setInterval(refreshTyping, TYPING_REFRESH_MS)

  try {
    const result = await createAgent().stream({ prompt })
    await thread.post(result.fullStream)
  } finally {
    clearInterval(typingInterval)
  }
}

async function createBot() {
  const telegramSecret = await getTelegramWebhookSecret()
  const telegram = createTelegramAdapter({ mode: "webhook", secretToken: telegramSecret ?? undefined })
  const linqSigningSecret = await getLinqWebhookSecret()
  const linq = createLinqAdapter({
    apiKey: getLinqApiToken() ?? "",
    baseURL: getLinqApiBaseUrl(),
    signingSecret: linqSigningSecret ?? "",
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
    await postAiReply(thread, message)
  })

  chat.onNewMention(async (thread, message) => {
    await thread.subscribe()
    await postAiReply(thread, message)
  })

  chat.onSubscribedMessage(async (thread, message) => {
    await postAiReply(thread, message)
  })

  return chat
}

export async function getBot() {
  if (!bot) {
    bot = await createBot()
  }

  return bot
}

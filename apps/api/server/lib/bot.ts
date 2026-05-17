import { createLinqAdapter } from "@linq-chat-sdk/adapter-linq"
import { createPostgresState } from "@chat-adapter/state-pg"
import { createTelegramAdapter } from "@chat-adapter/telegram"
import { ToolLoopAgent, tool } from "ai"
import { Chat, toAiMessages } from "chat"
import type { Message, Thread } from "chat"
import { z } from "zod"

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
const INITIAL_TYPING_PAUSE_MS = 1_500
const TYPING_REFRESH_MS = 4_000

const reactionToolInputSchema = z
  .object({
    messageId: z
      .string()
      .describe(
        "Optional message_id from the conversation context. Omit this to react to the latest user message.",
      )
      .optional(),
    reaction: z
      .string()
      .describe(
        "Reaction to use. Supports like/thumbs_up/👍, dislike/thumbs_down/👎, love/heart/❤️, laugh/😂, emphasize/!, question/?, or any emoji.",
      ),
  })
  .strict()

type ReactionToolInput = z.infer<typeof reactionToolInputSchema>

type ReactionToolOutput = {
  action: "added" | "removed"
  messageId: string
  reaction: string
}

function createAgent(thread: Thread, defaultMessageId: string) {
  return new ToolLoopAgent({
    model: AI_MODEL,
    instructions: [
      "You are a friendly AI assistant replying in a chat conversation.",
      "Reply like a warm, fun chat companion: playful and a little cheeky when it fits, but never disrespectful.",
      "Keep replies concise, useful, and easy to read in a text message.",
      "Use emojis sparingly in text replies; at most one, and only when it genuinely adds tone.",
      "You can add or remove reactions on messages. Use reactions occasionally when they naturally fit, and always use the reaction tools when the user asks you to react or remove a reaction.",
      "Do not announce that you used a reaction tool unless the user explicitly asks what you did.",
      "If the user explicitly asks for only a reaction, use the tool and reply with a very short acknowledgement.",
    ].join("\n"),
    tools: createReactionTools(thread, defaultMessageId),
  })
}

function createReactionTools(thread: Thread, defaultMessageId: string) {
  return {
    addReaction: tool<ReactionToolInput, ReactionToolOutput>({
      description:
        "Add a reaction to a chat message. If messageId is omitted, reacts to the latest user message.",
      inputSchema: reactionToolInputSchema,
      execute: async ({ messageId, reaction }) => {
        const targetMessageId = messageId || defaultMessageId
        await thread.adapter.addReaction(thread.id, targetMessageId, reaction)

        return { action: "added", messageId: targetMessageId, reaction }
      },
    }),
    removeReaction: tool<ReactionToolInput, ReactionToolOutput>({
      description:
        "Remove one of your reactions from a chat message. If messageId is omitted, removes it from the latest user message.",
      inputSchema: reactionToolInputSchema,
      execute: async ({ messageId, reaction }) => {
        const targetMessageId = messageId || defaultMessageId
        await thread.adapter.removeReaction(thread.id, targetMessageId, reaction)

        return { action: "removed", messageId: targetMessageId, reaction }
      },
    }),
  }
}

async function postAiReply(thread: Thread, message: Message) {
  const prompt = await buildPrompt(thread, message)

  if (!prompt.length) {
    await thread.post("I can reply to text messages. Send me a message and I'll help.")
    return
  }

  const refreshTyping = () => {
    void thread.startTyping().catch(() => {})
  }
  refreshTyping()
  const typingInterval = setInterval(refreshTyping, TYPING_REFRESH_MS)

  try {
    await sleep(INITIAL_TYPING_PAUSE_MS)
    const result = await createAgent(thread, message.id).stream({ prompt })
    await thread.post(result.fullStream)
  } finally {
    clearInterval(typingInterval)
  }
}

async function buildPrompt(thread: Thread, message: Message) {
  try {
    await thread.refresh()

    const messages = thread.recentMessages.some((recent) => recent.id === message.id)
      ? thread.recentMessages
      : [...thread.recentMessages, message]

    return toAiMessages(messages, {
      includeNames: !thread.isDM,
      transformMessage: (aiMessage, source) => {
        const prefix = `[message_id: ${source.id}] `

        if (aiMessage.role === "assistant" || typeof aiMessage.content === "string") {
          return { ...aiMessage, content: `${prefix}${aiMessage.content}` }
        }

        return {
          ...aiMessage,
          content: [{ type: "text", text: prefix }, ...aiMessage.content],
        }
      },
    })
  } catch {
    return toAiMessages(message.text.trim() ? [message] : [])
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

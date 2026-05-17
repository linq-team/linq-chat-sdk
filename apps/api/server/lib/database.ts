import pg from "pg"

const APP_SETTINGS_TABLE = "app_runtime_settings"
const LINQ_WEBHOOK_EVENTS_TABLE = "linq_webhook_events"
const LINQ_WEBHOOK_SECRET_KEY = "linq_webhook_secret"
const LINQ_WEBHOOK_SUBSCRIPTION_ID_KEY = "linq_webhook_subscription_id"
const TELEGRAM_WEBHOOK_SECRET_KEY = "telegram_webhook_secret"
const CHAT_STATE_KEY_PREFIX = "linq-chat-sdk"
const MESSAGE_HISTORY_PREFIX = "msg-history:"

let pool: pg.Pool | undefined

export interface AppSettingRecord {
  key: string
  value: string
  updatedAt: string
}

export interface StoreLinqWebhookEventInput {
  eventId: string | null
  eventType: string | null
  headers: Record<string, string>
  payload: unknown
  subscriptionId: string | null
}

export interface ChatThreadSummaryRecord {
  id: string
  latestMessage: {
    authorName: string | null
    dateSent: string | null
    text: string
  } | null
  messageCount: number
}

function getDatabaseUrl(): string | null {
  return process.env.POSTGRES_URL?.trim() || process.env.DATABASE_URL?.trim() || null
}

export function hasDatabaseUrl(): boolean {
  return getDatabaseUrl() !== null
}

export function getPostgresPool(): pg.Pool {
  const connectionString = getDatabaseUrl()

  if (!connectionString) {
    throw new Error("POSTGRES_URL or DATABASE_URL must be configured.")
  }

  if (!pool) {
    pool = new pg.Pool({ connectionString })
  }

  return pool
}

export async function ensureAppSettingsTable(): Promise<void> {
  await getPostgresPool().query(`
    CREATE TABLE IF NOT EXISTS ${APP_SETTINGS_TABLE} (
      key text PRIMARY KEY,
      value text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
}

export async function ensureLinqWebhookEventsTable(): Promise<void> {
  await getPostgresPool().query(`
    CREATE TABLE IF NOT EXISTS ${LINQ_WEBHOOK_EVENTS_TABLE} (
      id bigserial PRIMARY KEY,
      event_id text UNIQUE,
      event_type text,
      subscription_id text,
      headers jsonb NOT NULL,
      payload jsonb NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now()
    )
  `)
}

async function tableExists(tableName: string): Promise<boolean> {
  const result = await getPostgresPool().query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [tableName],
  )

  return result.rows[0]?.exists === true
}

export async function getAppSettingRecord(key: string): Promise<AppSettingRecord | null> {
  await ensureAppSettingsTable()

  const result = await getPostgresPool().query<{
    key: string
    value: string
    updated_at: Date | string
  }>(
    `
      SELECT key, value, updated_at
      FROM ${APP_SETTINGS_TABLE}
      WHERE key = $1
    `,
    [key],
  )

  const row = result.rows[0]

  if (!row) {
    return null
  }

  return {
    key: row.key,
    value: row.value,
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

export async function getAppSetting(key: string): Promise<string | null> {
  const record = await getAppSettingRecord(key)
  return record?.value ?? null
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  await ensureAppSettingsTable()

  await getPostgresPool().query(
    `
      INSERT INTO ${APP_SETTINGS_TABLE} (key, value)
      VALUES ($1, $2)
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `,
    [key, value],
  )
}

export async function deleteAppSetting(key: string): Promise<void> {
  await ensureAppSettingsTable()

  await getPostgresPool().query(
    `DELETE FROM ${APP_SETTINGS_TABLE} WHERE key = $1`,
    [key],
  )
}

export async function getTelegramWebhookSecretRecord(): Promise<AppSettingRecord | null> {
  return getAppSettingRecord(TELEGRAM_WEBHOOK_SECRET_KEY)
}

export async function getTelegramWebhookSecret(): Promise<string | null> {
  return getAppSetting(TELEGRAM_WEBHOOK_SECRET_KEY)
}

export async function setTelegramWebhookSecret(secret: string): Promise<void> {
  await setAppSetting(TELEGRAM_WEBHOOK_SECRET_KEY, secret)
}

export async function deleteTelegramWebhookSecret(): Promise<void> {
  await deleteAppSetting(TELEGRAM_WEBHOOK_SECRET_KEY)
}

export async function getLinqWebhookSecretRecord(): Promise<AppSettingRecord | null> {
  return getAppSettingRecord(LINQ_WEBHOOK_SECRET_KEY)
}

export async function getLinqWebhookSecret(): Promise<string | null> {
  return getAppSetting(LINQ_WEBHOOK_SECRET_KEY)
}

export async function setLinqWebhookSecret(secret: string): Promise<void> {
  await setAppSetting(LINQ_WEBHOOK_SECRET_KEY, secret)
}

export async function getLinqWebhookSubscriptionId(): Promise<string | null> {
  return getAppSetting(LINQ_WEBHOOK_SUBSCRIPTION_ID_KEY)
}

export async function setLinqWebhookSubscriptionId(subscriptionId: string): Promise<void> {
  await setAppSetting(LINQ_WEBHOOK_SUBSCRIPTION_ID_KEY, subscriptionId)
}

export async function storeLinqWebhookEvent(input: StoreLinqWebhookEventInput): Promise<boolean> {
  await ensureLinqWebhookEventsTable()

  const result = await getPostgresPool().query(
    `
      INSERT INTO ${LINQ_WEBHOOK_EVENTS_TABLE} (
        event_id,
        event_type,
        subscription_id,
        headers,
        payload
      )
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
      ON CONFLICT (event_id)
      DO NOTHING
      RETURNING id
    `,
    [
      input.eventId,
      input.eventType,
      input.subscriptionId,
      JSON.stringify(input.headers),
      JSON.stringify(input.payload),
    ],
  )

  return (result.rowCount ?? 0) > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function getStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === "string" ? value : null
}

function summarizeMessage(value: string): ChatThreadSummaryRecord["latestMessage"] {
  const parsed = parseJson(value)

  if (!isRecord(parsed)) {
    return null
  }

  const author = isRecord(parsed.author) ? parsed.author : null
  const metadata = isRecord(parsed.metadata) ? parsed.metadata : null

  return {
    authorName: author ? getStringField(author, "name") : null,
    dateSent: metadata ? getStringField(metadata, "dateSent") : null,
    text: getStringField(parsed, "text") ?? "",
  }
}

export async function listChatThreads(limit = 50): Promise<ChatThreadSummaryRecord[]> {
  const hasHistoryTable = await tableExists("chat_state_lists")
  const hasSubscriptionsTable = await tableExists("chat_state_subscriptions")
  const threads = new Map<string, ChatThreadSummaryRecord>()

  if (!hasHistoryTable && !hasSubscriptionsTable) {
    return []
  }

  if (hasHistoryTable) {
    const historyResult = await getPostgresPool().query<{
      list_key: string
      message_count: string
      latest_value: string
    }>(
      `
        SELECT
          list_key,
          count(*)::text AS message_count,
          (array_agg(value ORDER BY seq DESC))[1] AS latest_value
        FROM chat_state_lists
        WHERE key_prefix = $1
          AND list_key LIKE $2
          AND (expires_at IS NULL OR expires_at > now())
        GROUP BY list_key
        ORDER BY max(seq) DESC
        LIMIT $3
      `,
      [CHAT_STATE_KEY_PREFIX, `${MESSAGE_HISTORY_PREFIX}%`, limit],
    )

    for (const row of historyResult.rows) {
      const id = row.list_key.slice(MESSAGE_HISTORY_PREFIX.length)

      threads.set(id, {
        id,
        latestMessage: summarizeMessage(row.latest_value),
        messageCount: Number(row.message_count),
      })
    }
  }

  if (hasSubscriptionsTable && threads.size < limit) {
    const subscriptionResult = await getPostgresPool().query<{
      thread_id: string
    }>(
      `
        SELECT thread_id
        FROM chat_state_subscriptions
        WHERE key_prefix = $1
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [CHAT_STATE_KEY_PREFIX, limit],
    )

    for (const row of subscriptionResult.rows) {
      if (threads.size >= limit) {
        break
      }

      if (threads.has(row.thread_id)) {
        continue
      }

      threads.set(row.thread_id, {
        id: row.thread_id,
        latestMessage: null,
        messageCount: 0,
      })
    }
  }

  return [...threads.values()]
}

export async function getChatThreadMessages(threadId: string, limit = 20): Promise<unknown[]> {
  if (!await tableExists("chat_state_lists")) {
    return []
  }

  const result = await getPostgresPool().query<{ value: string }>(
    `
      SELECT value
      FROM chat_state_lists
      WHERE key_prefix = $1
        AND list_key = $2
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY seq DESC
      LIMIT $3
    `,
    [CHAT_STATE_KEY_PREFIX, `${MESSAGE_HISTORY_PREFIX}${threadId}`, limit],
  )

  return result.rows.reverse().map((row) => parseJson(row.value))
}

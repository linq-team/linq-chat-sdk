import pg from "pg"

const APP_SETTINGS_TABLE = "app_runtime_settings"
const LINQ_WEBHOOK_EVENTS_TABLE = "linq_webhook_events"
const LINQ_WEBHOOK_SECRET_KEY = "linq_webhook_secret"
const LINQ_WEBHOOK_SUBSCRIPTION_ID_KEY = "linq_webhook_subscription_id"
const TELEGRAM_WEBHOOK_SECRET_KEY = "telegram_webhook_secret"

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

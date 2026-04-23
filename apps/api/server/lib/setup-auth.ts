import type { H3Event } from "nitro"
import { HTTPError } from "nitro"

export const SETUP_ACCESS_TOKEN_ENV_NAME = "BOT_SETUP_ACCESS_TOKEN"

function getSetupAccessToken(): string | null {
  return process.env[SETUP_ACCESS_TOKEN_ENV_NAME]?.trim() || null
}

export function isSetupAccessTokenConfigured(): boolean {
  return getSetupAccessToken() !== null
}

export function requireSetupAccess(event: H3Event): void {
  const expectedToken = getSetupAccessToken()

  if (!expectedToken) {
    return
  }

  const explicitHeader = event.req.headers.get("x-setup-token")?.trim()
  const authorization = event.req.headers.get("authorization")?.trim()
  const bearerToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : null

  const providedToken = bearerToken || explicitHeader

  if (providedToken !== expectedToken) {
    throw new HTTPError({
      status: 401,
      message: `A valid ${SETUP_ACCESS_TOKEN_ENV_NAME} is required to use the setup endpoints.`,
    })
  }
}

/**
 * Agent-facing MCP client for calling remote MCP servers.
 *
 * @remarks
 * Seven flat, standalone `useTool` units ({@link useTool}) — one per MCP
 * client operation: `call-tool`, `list-tools`, `list-prompts`, `get-prompt`,
 * `list-resources`, `read-resource`, and `discover`. Each tool opens its own
 * connection for the call using the input's `auth` config (OAuth via the
 * keychain provider) and closes it before returning. No pool, no kernel
 * injection, no provisioning layer — import a tool and call it.
 *
 * The tools return remote MCP data only; they never write to any store.
 *
 * @packageDocumentation
 */

import { Client, type OAuthClientProvider, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { JSONSchemaType } from 'ajv'
import type { Keychain } from '../oauth/keychain.ts'
import { BunKeychainOAuthProvider, type KeychainOAuthProviderOptions } from '../oauth/keychain-oauth-provider.ts'
import { ajv, useTool } from './use-tool.ts'

// ---------------------------------------------------------------------------
// Internal MCP types
// ---------------------------------------------------------------------------

type McpContent = { type: string; text?: string; [key: string]: unknown }
type McpCallToolResult = { content: McpContent[]; isError?: boolean }
type McpTool = { name: string; description?: string; inputSchema: Record<string, unknown> }
type McpPromptArgument = { name: string; description?: string; required?: boolean }
type McpPrompt = { name: string; description?: string; arguments?: McpPromptArgument[] }
type McpPromptMessage = { role: 'user' | 'assistant'; content: McpContent }
type McpResource = { uri: string; name: string; description?: string; mimeType?: string }
type McpResourceContent = { uri: string; text?: string; blob?: string; mimeType?: string }
type McpServerCapabilities = {
  tools: McpTool[]
  prompts: McpPrompt[]
  resources: McpResource[]
}

// ---------------------------------------------------------------------------
// Auth types (single source: the Zod schema below)
// ---------------------------------------------------------------------------

type RemoteMcpSecret = {
  envVar: string
  optional?: boolean
  description?: string
}
type RemoteMcpTokenPersistence = { kind: 'file'; path?: string } | { kind: 'env' }
type RemoteMcpOauthClientAuthentication = 'client_secret_basic' | 'client_secret_post' | 'none'

type RemoteMcpAuthConfig =
  | { type: 'none' }
  | { type: 'bearer-env'; token: RemoteMcpSecret; headerName?: string; prefix?: string }
  | { type: 'static-headers'; headers: Record<string, string> }
  | {
      type: 'oauth-client-credentials'
      issuer?: string
      tokenUrl: string
      clientId: RemoteMcpSecret
      clientSecret?: RemoteMcpSecret
      scopes?: string[]
      audience?: string
      resource?: string
      clientAuthentication?: RemoteMcpOauthClientAuthentication
      tokenPersistence?: RemoteMcpTokenPersistence
    }
  | {
      type: 'oauth-refresh-token'
      issuer?: string
      tokenUrl: string
      clientId: RemoteMcpSecret
      clientSecret?: RemoteMcpSecret
      refreshToken: RemoteMcpSecret
      scopes?: string[]
      audience?: string
      resource?: string
      clientAuthentication?: RemoteMcpOauthClientAuthentication
      tokenPersistence?: RemoteMcpTokenPersistence
    }

// ---------------------------------------------------------------------------
// Auth JSON schema — single source for auth-shape validation, compiled once
// with AJV. The model-facing input schema treats `auth` as a permissive object;
// the tool validates it at the trust boundary here (no parallel schema source,
// no Zod). Structural discriminated union on `type` per AGENTS.md.
// ---------------------------------------------------------------------------

const remoteMcpSecretJsonSchema = {
  type: 'object',
  properties: {
    envVar: { type: 'string', minLength: 1 },
    optional: { type: 'boolean', nullable: true },
    description: { type: 'string', nullable: true },
  },
  required: ['envVar'],
  additionalProperties: false,
} as const

const tokenPersistenceJsonSchema = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'file' },
        path: { type: 'string', nullable: true },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { kind: { type: 'string', const: 'env' } },
      required: ['kind'],
      additionalProperties: false,
    },
  ],
} as const

const authConfigJsonSchema = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: { type: { type: 'string', const: 'none' } },
      required: ['type'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'bearer-env' },
        token: remoteMcpSecretJsonSchema,
        headerName: { type: 'string', minLength: 1, nullable: true },
        prefix: { type: 'string', nullable: true },
      },
      required: ['type', 'token'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'static-headers' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['type', 'headers'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'oauth-client-credentials' },
        issuer: { type: 'string', nullable: true },
        tokenUrl: { type: 'string', minLength: 1 },
        clientId: remoteMcpSecretJsonSchema,
        clientSecret: { ...remoteMcpSecretJsonSchema, nullable: true },
        scopes: { type: 'array', items: { type: 'string', minLength: 1 }, nullable: true },
        audience: { type: 'string', minLength: 1, nullable: true },
        resource: { type: 'string', minLength: 1, nullable: true },
        clientAuthentication: {
          type: 'string',
          enum: ['client_secret_basic', 'client_secret_post', 'none'],
          nullable: true,
        },
        tokenPersistence: { ...tokenPersistenceJsonSchema, nullable: true },
      },
      required: ['type', 'tokenUrl', 'clientId'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'oauth-refresh-token' },
        issuer: { type: 'string', nullable: true },
        tokenUrl: { type: 'string', minLength: 1 },
        clientId: remoteMcpSecretJsonSchema,
        clientSecret: { ...remoteMcpSecretJsonSchema, nullable: true },
        refreshToken: remoteMcpSecretJsonSchema,
        scopes: { type: 'array', items: { type: 'string', minLength: 1 }, nullable: true },
        audience: { type: 'string', minLength: 1, nullable: true },
        resource: { type: 'string', minLength: 1, nullable: true },
        clientAuthentication: {
          type: 'string',
          enum: ['client_secret_basic', 'client_secret_post', 'none'],
          nullable: true,
        },
        tokenPersistence: { ...tokenPersistenceJsonSchema, nullable: true },
      },
      required: ['type', 'tokenUrl', 'clientId', 'refreshToken'],
      additionalProperties: false,
    },
  ],
} as const

const validateAuth = ajv.compile(authConfigJsonSchema)

// ---------------------------------------------------------------------------
// Tool input / output types — one shape per tool, no `mode` discriminator
// ---------------------------------------------------------------------------

type McpClientSharedInput = {
  url: string
  auth?: RemoteMcpAuthConfig
  headers?: Record<string, string>
  timeoutMs?: number
}

export type McpCallToolInput = McpClientSharedInput & { tool: string; args: Record<string, unknown> }
export type McpCallToolOutput = McpCallToolResult

export type McpListToolsInput = McpClientSharedInput
export type McpListToolsOutput = { tools: McpTool[] }

export type McpListPromptsInput = McpClientSharedInput
export type McpListPromptsOutput = { prompts: McpPrompt[] }

export type McpGetPromptInput = McpClientSharedInput & { name: string; args?: Record<string, string> }
export type McpGetPromptOutput = { messages: McpPromptMessage[] }

export type McpListResourcesInput = McpClientSharedInput
export type McpListResourcesOutput = { resources: McpResource[] }

export type McpReadResourceInput = McpClientSharedInput & { uri: string }
export type McpReadResourceOutput = { contents: McpResourceContent[] }

export type McpDiscoverInput = McpClientSharedInput
export type McpDiscoverOutput = McpServerCapabilities

// ---------------------------------------------------------------------------
// Tool JSON schemas — one schema pair per tool, no `mode` discriminator.
// `auth` and `args` are permissive objects here; the tools validate `auth` at
// the boundary via `authConfigJsonSchema` above (single source). The schema
// objects are cast through `unknown` where the open MCP SDK shapes exceed
// `JSONSchemaType`'s static power; AJV validates at runtime.
// ---------------------------------------------------------------------------

const authJsonSchema = {
  type: 'object',
  additionalProperties: true,
  nullable: true,
  description: 'auth config — validated at the boundary (none | bearer-env | static-headers | oauth-*)',
} as const

// Shared optional fields present on every tool input.
const sharedInputProperties = {
  url: { type: 'string', minLength: 1, description: 'remote MCP server URL' },
  auth: authJsonSchema,
  headers: {
    type: 'object',
    additionalProperties: { type: 'string' },
    nullable: true,
    description: 'extra HTTP headers to send with MCP requests',
  },
  timeoutMs: {
    type: 'integer',
    minimum: 1,
    nullable: true,
    description: 'per-operation timeout in milliseconds',
  },
} as const

export const McpCallToolInputSchema = {
  type: 'object',
  properties: {
    ...sharedInputProperties,
    tool: { type: 'string', minLength: 1, description: 'tool name to call' },
    args: {
      type: 'object',
      additionalProperties: true,
      description: 'tool arguments — a JSON object, validated at the boundary',
    },
  },
  required: ['url', 'tool', 'args'],
  additionalProperties: false,
  description: 'Call a tool on a remote MCP server.',
} as unknown as JSONSchemaType<McpCallToolInput>

const mcpContentJsonSchema = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    text: { type: 'string', nullable: true },
  },
  required: ['type'],
  additionalProperties: true,
} as const

export const McpCallToolOutputSchema = {
  type: 'object',
  properties: {
    content: { type: 'array', items: mcpContentJsonSchema },
    isError: { type: 'boolean', nullable: true, description: 'true when the remote tool reported an error' },
  },
  required: ['content'],
  additionalProperties: true,
} as unknown as JSONSchemaType<McpCallToolOutput>

export const McpListToolsInputSchema = {
  type: 'object',
  properties: { ...sharedInputProperties },
  required: ['url'],
  additionalProperties: false,
  description: 'List the tools a remote MCP server exposes.',
} as unknown as JSONSchemaType<McpListToolsInput>

export const McpListToolsOutputSchema = {
  type: 'object',
  properties: { tools: { type: 'array', items: { type: 'object', additionalProperties: true } } },
  required: ['tools'],
  additionalProperties: false,
} as unknown as JSONSchemaType<McpListToolsOutput>

export const McpListPromptsInputSchema = {
  type: 'object',
  properties: { ...sharedInputProperties },
  required: ['url'],
  additionalProperties: false,
  description: 'List the prompts a remote MCP server exposes.',
} as unknown as JSONSchemaType<McpListPromptsInput>

export const McpListPromptsOutputSchema = {
  type: 'object',
  properties: { prompts: { type: 'array', items: { type: 'object', additionalProperties: true } } },
  required: ['prompts'],
  additionalProperties: false,
} as unknown as JSONSchemaType<McpListPromptsOutput>

export const McpGetPromptInputSchema = {
  type: 'object',
  properties: {
    ...sharedInputProperties,
    name: { type: 'string', minLength: 1, description: 'prompt name' },
    args: {
      type: 'object',
      additionalProperties: { type: 'string' },
      nullable: true,
      description: 'prompt arguments',
    },
  },
  required: ['url', 'name'],
  additionalProperties: false,
  description: 'Fetch a rendered prompt from a remote MCP server.',
} as unknown as JSONSchemaType<McpGetPromptInput>

export const McpGetPromptOutputSchema = {
  type: 'object',
  properties: { messages: { type: 'array', items: { type: 'object', additionalProperties: true } } },
  required: ['messages'],
  additionalProperties: false,
} as unknown as JSONSchemaType<McpGetPromptOutput>

export const McpListResourcesInputSchema = {
  type: 'object',
  properties: { ...sharedInputProperties },
  required: ['url'],
  additionalProperties: false,
  description: 'List the resources a remote MCP server exposes.',
} as unknown as JSONSchemaType<McpListResourcesInput>

export const McpListResourcesOutputSchema = {
  type: 'object',
  properties: { resources: { type: 'array', items: { type: 'object', additionalProperties: true } } },
  required: ['resources'],
  additionalProperties: false,
} as unknown as JSONSchemaType<McpListResourcesOutput>

export const McpReadResourceInputSchema = {
  type: 'object',
  properties: {
    ...sharedInputProperties,
    uri: { type: 'string', minLength: 1, description: 'resource URI to read' },
  },
  required: ['url', 'uri'],
  additionalProperties: false,
  description: 'Read a resource from a remote MCP server.',
} as unknown as JSONSchemaType<McpReadResourceInput>

export const McpReadResourceOutputSchema = {
  type: 'object',
  properties: { contents: { type: 'array', items: { type: 'object', additionalProperties: true } } },
  required: ['contents'],
  additionalProperties: false,
} as unknown as JSONSchemaType<McpReadResourceOutput>

export const McpDiscoverInputSchema = {
  type: 'object',
  properties: { ...sharedInputProperties },
  required: ['url'],
  additionalProperties: false,
  description: "Discover a remote MCP server's tools, prompts, and resources in one call.",
} as unknown as JSONSchemaType<McpDiscoverInput>

export const McpDiscoverOutputSchema = {
  type: 'object',
  properties: {
    tools: { type: 'array', items: { type: 'object', additionalProperties: true } },
    prompts: { type: 'array', items: { type: 'object', additionalProperties: true } },
    resources: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  required: ['tools', 'prompts', 'resources'],
  additionalProperties: true,
} as unknown as JSONSchemaType<McpDiscoverOutput>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BEARER_PREFIX = 'Bearer'
const CLIENT_INFO = { name: 'behavioral', version: '0.0.0' }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const resolveEnvSecret = async (secret: RemoteMcpSecret): Promise<string | undefined> => {
  const envValue = Bun.env[secret.envVar]
  if (envValue !== undefined && envValue !== '') return envValue
  if (secret.optional) return undefined
  throw new Error(
    `Missing required env var ${secret.envVar}. Set it before invoking the MCP client, or mark it optional.`,
  )
}

const resolveRequiredSecret = async (secret: RemoteMcpSecret, label: string): Promise<string> => {
  const value = await resolveEnvSecret(secret)
  if (value) return value
  throw new Error(`${label} env var ${secret.envVar} resolved to an empty value. Check your environment.`)
}

const getScopeString = (scopes?: string[]) => (scopes && scopes.length > 0 ? scopes.join(' ') : undefined)

// ---------------------------------------------------------------------------
// OAuth provider construction (v2 BunKeychainOAuthProvider)
//
// Replaces the former in-memory createOAuthProvider + file persistence. The
// v2 SDK's `auth()` orchestrator (invoked by the transport on 401) does RFC
// 9728 discovery and the token exchange via the provider's
// prepareTokenRequest + addClientAuthentication + clientInformation; the
// provider supplies grant params + credentials and persists the
// issuer-stamped tokens/client-info to the OS keychain (Bun.secrets). One
// provider per server-url, reused across process restarts.
//
// MINIMAL: the v2 flow is discovery-based, so `auth.tokenUrl` is no longer the
// direct token endpoint — the SDK discovers it. `auth.tokenPersistence`
// (file/env) is obsolete now that the keychain is the store; the field is
// accepted for backward-compat and ignored. Upgrade path: drop the field
// from the auth config once no caller relies on it.
// ---------------------------------------------------------------------------

/**
 * Build a v2 {@link OAuthClientProvider} for an `oauth-*` auth config.
 * Exposed (with an injectable keychain) so tests can drive the provider with
 * an in-memory keychain without touching the OS keychain.
 */
export const createKeychainOAuthProvider = (
  auth: Extract<RemoteMcpAuthConfig, { type: 'oauth-client-credentials' | 'oauth-refresh-token' }>,
  url: string,
  keychain?: Keychain,
): OAuthClientProvider => {
  // clientId is required for both grants; resolve eagerly to fail fast.
  // clientSecret / refreshToken are resolved lazily by the provider via the
  // env-var secret config — but the v2 provider takes resolved values, so we
  // resolve them here. Required secrets throw if missing; optional ones
  // (clientSecret) resolve to undefined.
  const build = async (): Promise<KeychainOAuthProviderOptions> => {
    const clientId = await resolveRequiredSecret(auth.clientId, 'OAuth client ID')
    const clientSecret = auth.clientSecret ? await resolveEnvSecret(auth.clientSecret) : undefined
    const options: KeychainOAuthProviderOptions = {
      serverUrl: url,
      grantType: auth.type === 'oauth-client-credentials' ? 'client_credentials' : 'refresh_token',
      clientId,
      clientSecret,
      scope: getScopeString(auth.scopes),
      audience: auth.audience,
      resource: auth.resource,
      clientAuthentication: auth.clientAuthentication,
      expectedIssuer: auth.issuer,
      keychain,
    }
    if (auth.type === 'oauth-refresh-token') {
      options.initialRefreshToken = await resolveRequiredSecret(auth.refreshToken, 'OAuth refresh token')
    }
    return options
  }

  // The v2 transport reads `authProvider` synchronously at construction, but
  // our env-var secrets resolve async. Bridge with a lazy proxy that resolves
  // the real provider on first method call and delegates every property to
  // it. This keeps getSharedClient(url, options) synchronous in `authProvider`.
  let providerPromise: Promise<BunKeychainOAuthProvider> | undefined
  const getProvider = (): Promise<BunKeychainOAuthProvider> =>
    (providerPromise ??= build().then((opts) => new BunKeychainOAuthProvider(opts)))

  // Delegate every OAuthClientProvider member through the lazy provider.
  // The async members await getProvider() first; the getters (redirectUrl,
  // clientMetadata) are read by the SDK after the first async call has
  // resolved the provider, so a cached reference is used once warmed.
  let cached: BunKeychainOAuthProvider | undefined
  const ensure = async (): Promise<BunKeychainOAuthProvider> => {
    if (cached) return cached
    cached = await getProvider()
    return cached
  }

  const proxy: OAuthClientProvider = {
    get redirectUrl() {
      return undefined
    },
    get clientMetadata() {
      // clientMetadata has no async deps beyond clientId/secret/scope, which
      // the provider resolves in its constructor via the options we pass
      // resolved. Return a best-effort metadata; the real provider's
      // clientMetadata is used once warmed.
      return (
        cached?.clientMetadata ?? {
          redirect_uris: [],
          grant_types: [auth.type === 'oauth-client-credentials' ? 'client_credentials' : 'refresh_token'],
          token_endpoint_auth_method: auth.clientAuthentication === 'none' ? undefined : auth.clientAuthentication,
          client_name: 'behavioral remote mcp',
          scope: getScopeString(auth.scopes),
        }
      )
    },
    clientInformation: (ctx) => ensure().then((p) => p.clientInformation(ctx)),
    saveClientInformation: (ci, ctx) => ensure().then((p) => p.saveClientInformation(ci, ctx)),
    tokens: (ctx) => ensure().then((p) => p.tokens(ctx)),
    saveTokens: (tokens, ctx) => ensure().then((p) => p.saveTokens(tokens, ctx)),
    state: () => ensure().then((p) => p.state()),
    redirectToAuthorization: () => {
      throw new Error('Interactive OAuth authorization not supported')
    },
    saveCodeVerifier: () => {
      /* delegated once provider exists; no-op is safe */
    },
    codeVerifier: () => '',
    addClientAuthentication: (headers, params, u, metadata) =>
      ensure().then((p) => p.addClientAuthentication(headers, params, u, metadata)),
    validateResourceURL: (serverUrl, resource) => ensure().then((p) => p.validateResourceURL(serverUrl, resource)),
    invalidateCredentials: (scope) => ensure().then((p) => p.invalidateCredentials(scope)),
    prepareTokenRequest: (scope) => ensure().then((p) => p.prepareTokenRequest(scope)),
    saveDiscoveryState: (state) => ensure().then((p) => p.saveDiscoveryState(state)),
    discoveryState: () => ensure().then((p) => p.discoveryState()),
  }
  return proxy
}

// ---------------------------------------------------------------------------
// Auth + session-option resolution
// ---------------------------------------------------------------------------

type ResolvedSessionOptions = {
  headers?: Record<string, string>
  authProvider?: OAuthClientProvider
  timeoutMs?: number
}

const resolveAuth = async (config: RemoteMcpAuthConfig, url: string): Promise<ResolvedSessionOptions> => {
  switch (config.type) {
    case 'none':
      return {}
    case 'bearer-env': {
      const token = await resolveEnvSecret(config.token)
      if (!token) return {}
      const prefix = config.prefix ?? DEFAULT_BEARER_PREFIX
      const headerValue = prefix === '' ? token : `${prefix} ${token}`
      return { headers: { [config.headerName ?? 'Authorization']: headerValue } }
    }
    case 'static-headers':
      return { headers: { ...config.headers } }
    case 'oauth-client-credentials':
    case 'oauth-refresh-token':
      return { authProvider: createKeychainOAuthProvider(config, url) }
  }
}

const resolveSessionOptions = async (input: {
  url: string
  auth?: RemoteMcpAuthConfig
  headers?: Record<string, string>
  timeoutMs?: number
}): Promise<ResolvedSessionOptions> => {
  const options: ResolvedSessionOptions = {}
  if (input.headers) options.headers = { ...input.headers }
  if (input.timeoutMs) options.timeoutMs = input.timeoutMs
  if (input.auth) {
    // Boundary validation — the model-facing schema is permissive; this is the
    // single source (authConfigJsonSchema, AJV-compiled) that defines the auth
    // shape. No Zod, no parallel schema source.
    if (!validateAuth(input.auth)) {
      throw new Error(`Invalid auth config: ${ajv.errorsText(validateAuth.errors)}`)
    }
    const validated = input.auth as RemoteMcpAuthConfig
    const authOptions = await resolveAuth(validated, input.url)
    if (authOptions.headers) options.headers = { ...options.headers, ...authOptions.headers }
    if (authOptions.authProvider) options.authProvider = authOptions.authProvider
  }
  return options
}

// ---------------------------------------------------------------------------
// Operation helpers (operate on a pooled client; never close it)
// ---------------------------------------------------------------------------

const withTimeout = <T>(timeoutMs: number | undefined, fn: () => Promise<T>): Promise<T> => {
  if (!timeoutMs) return fn()
  return new Promise<T>((resolve, reject) => {
    const signal = AbortSignal.timeout(timeoutMs)
    signal.addEventListener('abort', () => reject(new Error(`MCP operation timed out after ${timeoutMs}ms`)), {
      once: true,
    })
    fn().then(resolve, reject)
  })
}

const discoverCapabilities = async (client: Client, timeoutMs?: number): Promise<McpServerCapabilities> => {
  const [tools, prompts, resources] = await Promise.allSettled([
    withTimeout(timeoutMs, async () => (await client.listTools()).tools),
    withTimeout(timeoutMs, async () => (await client.listPrompts()).prompts),
    withTimeout(timeoutMs, async () => (await client.listResources()).resources),
  ])
  return {
    tools: tools.status === 'fulfilled' ? (tools.value as McpTool[]) : [],
    prompts: prompts.status === 'fulfilled' ? (prompts.value as McpPrompt[]) : [],
    resources: resources.status === 'fulfilled' ? (resources.value as McpResource[]) : [],
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle — one connection per call, owned by the tool
// ---------------------------------------------------------------------------

/**
 * Open a connected MCP {@link Client} for one operation and always close it
 * afterward. Connections are per-call: the tools hold no state, so they can be
 * called directly or wired back into a CLI without a provisioning layer. Auth
 * is resolved per call from the input's `auth` config (OAuth via the keychain
 * provider). Transport `fetch` is the ambient global, so the SDK's in-process
 * `handler.fetch` test pattern applies by assigning `globalThis.fetch`.
 */
const withSession = async <T>(input: McpClientSharedInput, operation: (client: Client) => Promise<T>): Promise<T> => {
  const { headers, authProvider } = await resolveSessionOptions(input)
  const client = new Client(CLIENT_INFO)
  const transport = new StreamableHTTPClientTransport(new URL(input.url), {
    requestInit: headers ? { headers } : undefined,
    authProvider,
  })
  await client.connect(transport)
  try {
    return await operation(client)
  } finally {
    try {
      await client.close()
    } catch {
      /* best-effort — a close failure must not mask the operation result */
    }
  }
}

// ---------------------------------------------------------------------------
// useTool registration — flat, standalone tools (one per operation)
// ---------------------------------------------------------------------------

/**
 * Call a tool on a remote MCP server. Opens a per-call connection using the
 * input's auth config and closes it before returning. Returns the remote MCP
 * tool result only — never writes a store.
 */
export const mcpCallTool = useTool(
  {
    name: 'mcp-call-tool',
    description: 'Call a tool on a remote MCP server. Returns the remote MCP tool result only — never writes a store.',
    inputSchema: McpCallToolInputSchema,
    outputSchema: McpCallToolOutputSchema,
  },
  (input): Promise<McpCallToolOutput> =>
    withSession(
      input,
      async (client) =>
        (await withTimeout(input.timeoutMs, () =>
          client.callTool({ name: input.tool, arguments: input.args }),
        )) as McpCallToolResult,
    ),
)

/**
 * List the tools a remote MCP server exposes. Returns remote MCP data only —
 * never writes a store.
 */
export const mcpListTools = useTool(
  {
    name: 'mcp-list-tools',
    description: 'List the tools a remote MCP server exposes. Returns remote MCP data only — never writes a store.',
    inputSchema: McpListToolsInputSchema,
    outputSchema: McpListToolsOutputSchema,
  },
  (input): Promise<McpListToolsOutput> =>
    withSession(input, async (client) => ({
      tools: (await withTimeout(input.timeoutMs, async () => (await client.listTools()).tools)) as McpTool[],
    })),
)

/**
 * List the prompts a remote MCP server exposes. Returns remote MCP data only —
 * never writes a store.
 */
export const mcpListPrompts = useTool(
  {
    name: 'mcp-list-prompts',
    description: 'List the prompts a remote MCP server exposes. Returns remote MCP data only — never writes a store.',
    inputSchema: McpListPromptsInputSchema,
    outputSchema: McpListPromptsOutputSchema,
  },
  (input): Promise<McpListPromptsOutput> =>
    withSession(input, async (client) => ({
      prompts: (await withTimeout(input.timeoutMs, async () => (await client.listPrompts()).prompts)) as McpPrompt[],
    })),
)

/**
 * Fetch a rendered prompt from a remote MCP server. Returns remote MCP data
 * only — never writes a store.
 */
export const mcpGetPrompt = useTool(
  {
    name: 'mcp-get-prompt',
    description:
      'Fetch a rendered prompt from a remote MCP server. Returns remote MCP data only — never writes a store.',
    inputSchema: McpGetPromptInputSchema,
    outputSchema: McpGetPromptOutputSchema,
  },
  (input): Promise<McpGetPromptOutput> =>
    withSession(input, async (client) => ({
      messages: (await withTimeout(
        input.timeoutMs,
        async () => (await client.getPrompt({ name: input.name, arguments: input.args })).messages,
      )) as McpPromptMessage[],
    })),
)

/**
 * List the resources a remote MCP server exposes. Returns remote MCP data only
 * — never writes a store.
 */
export const mcpListResources = useTool(
  {
    name: 'mcp-list-resources',
    description: 'List the resources a remote MCP server exposes. Returns remote MCP data only — never writes a store.',
    inputSchema: McpListResourcesInputSchema,
    outputSchema: McpListResourcesOutputSchema,
  },
  (input): Promise<McpListResourcesOutput> =>
    withSession(input, async (client) => ({
      resources: (await withTimeout(
        input.timeoutMs,
        async () => (await client.listResources()).resources,
      )) as McpResource[],
    })),
)

/**
 * Read a resource from a remote MCP server. Returns remote MCP data only —
 * never writes a store.
 */
export const mcpReadResource = useTool(
  {
    name: 'mcp-read-resource',
    description: 'Read a resource from a remote MCP server. Returns remote MCP data only — never writes a store.',
    inputSchema: McpReadResourceInputSchema,
    outputSchema: McpReadResourceOutputSchema,
  },
  (input): Promise<McpReadResourceOutput> =>
    withSession(input, async (client) => ({
      contents: (await withTimeout(
        input.timeoutMs,
        async () => (await client.readResource({ uri: input.uri })).contents,
      )) as McpResourceContent[],
    })),
)

/**
 * Discover a remote MCP server's tools, prompts, and resources in one call.
 * Missing capabilities resolve to empty arrays. Returns remote MCP data only —
 * never writes a store.
 */
export const mcpDiscover = useTool(
  {
    name: 'mcp-discover',
    description:
      "Discover a remote MCP server's tools, prompts, and resources in one call. Missing capabilities resolve to empty arrays. Returns remote MCP data only — never writes a store.",
    inputSchema: McpDiscoverInputSchema,
    outputSchema: McpDiscoverOutputSchema,
  },
  (input): Promise<McpDiscoverOutput> => withSession(input, (client) => discoverCapabilities(client, input.timeoutMs)),
)

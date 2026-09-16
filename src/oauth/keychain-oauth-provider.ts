/**
 * `BunKeychainOAuthProvider` — a v2 {@link OAuthClientProvider} that persists
 * OAuth tokens and client information to the OS keychain (via
 * {@link BunKeychain}), implementing the agentskills.io / MCP v2 issuer-binding
 * and RFC 9207 `iss` validation shape.
 *
 * @remarks
 * One provider per server-url, reused across process restarts: the keychain
 * persists, the connection doesn't, but a reconnect reads tokens back via
 * {@link BunKeychainOAuthProvider.tokens | tokens()}.
 *
 * Backs the non-interactive `client_credentials` and `refresh_token` grants.
 * The v2 SDK's `auth()` orchestrator (invoked by the transport on 401) does
 * RFC 9728 discovery and the token exchange via `prepareTokenRequest` +
 * `addClientAuthentication` + `clientInformation`; this provider supplies the
 * grant parameters and credentials and persists the issuer-stamped results.
 *
 * Issuer-binding: `clientInformation(ctx)` and `tokens(ctx)` key persisted
 * blobs by the SDK-stamped `issuer`; a blob whose `issuer` does not match the
 * resolved authorization server is treated as absent (the SDK's
 * `discardIfIssuerMismatch` enforces this at the `auth()` layer). When
 * `ctx === undefined` (the resource-server `token()` read, pre-discovery),
 * the most-recently-saved blob for the server is returned, per the v2
 * adapter contract.
 *
 * MINIMAL: `validateResourceURL` enforces origin (scheme+host+port) binding
 * between the MCP server URL and a requested `resource` (RFC 8707). Upgrade
 * path: full RFC 8707 + RFC 9207 `iss` validation lives in the SDK's `auth()`
 * (`validateAuthorizationResponseIssuer`); this hook covers the
 * resource-binding leg that `auth()` delegates to the provider.
 *
 * @packageDocumentation
 */

import type {
  AddClientAuthentication,
  OAuthClientInformationContext,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthDiscoveryState,
  OAuthTokens,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client'
import { IssuerMismatchError, selectClientAuthMethod } from '@modelcontextprotocol/client'
import type { Keychain } from './keychain.ts'
import { BunKeychain } from './keychain.ts'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type OAuthGrantType = 'client_credentials' | 'refresh_token'

export type KeychainOAuthProviderOptions = {
  /** The remote MCP server URL — keys the keychain slots (one per server). */
  serverUrl: string
  /** The OAuth grant to use. */
  grantType: OAuthGrantType
  /** Resolved client_id (from the auth config's env-var secret). */
  clientId: string
  /** Resolved client_secret, if any (public clients omit it). */
  clientSecret?: string
  /** Space-separated scopes to request. */
  scope?: string
  /** RFC 8707 resource indicator to request. */
  resource?: string
  /** Authorization-server `audience` to request (some ASes use this). */
  audience?: string
  /** Initial refresh token for the `refresh_token` grant (from env). */
  initialRefreshToken?: string
  /** Client-auth method preference; defaults to basic/post/none selection. */
  clientAuthentication?: 'client_secret_basic' | 'client_secret_post' | 'none'
  /**
   * The authorization server's `issuer` these credentials are registered with.
   * Stamped onto stored client information for SEP-2352 issuer-binding. May be
   * omitted when the issuer is only known after discovery.
   */
  expectedIssuer?: string
  /** Keychain to persist to. Defaults to the OS keychain via BunKeychain. */
  keychain?: Keychain
}

// ---------------------------------------------------------------------------
// Key naming
// ---------------------------------------------------------------------------

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

const tokensKey = (serverUrl: string): string => `${hostOf(serverUrl)}:tokens`
const clientInfoKey = (serverUrl: string): string => `${hostOf(serverUrl)}:clientinfo`
const discoveryKey = (serverUrl: string): string => `${hostOf(serverUrl)}:discovery`

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class BunKeychainOAuthProvider {
  readonly #serverUrl: string
  readonly #grantType: OAuthGrantType
  readonly #clientId: string
  readonly #clientSecret?: string
  readonly #scope?: string
  readonly #resource?: string
  readonly #audience?: string
  readonly #initialRefreshToken?: string
  readonly #clientAuthentication?: 'client_secret_basic' | 'client_secret_post' | 'none'
  readonly #expectedIssuer?: string
  readonly #keychain: Keychain
  // In-process cache so repeated tokens()/clientInformation() calls in one
  // process don't round-trip the keychain on every request.
  #cachedTokens?: StoredOAuthTokens
  #cachedClientInfo?: StoredOAuthClientInformation
  #cachedDiscovery?: OAuthDiscoveryState

  constructor(options: KeychainOAuthProviderOptions) {
    this.#serverUrl = options.serverUrl
    this.#grantType = options.grantType
    this.#clientId = options.clientId
    this.#clientSecret = options.clientSecret
    this.#scope = options.scope
    this.#resource = options.resource
    this.#audience = options.audience
    this.#initialRefreshToken = options.initialRefreshToken
    this.#clientAuthentication = options.clientAuthentication
    this.#expectedIssuer = options.expectedIssuer
    this.#keychain = options.keychain ?? BunKeychain()
  }

  // -- OAuthClientProvider: non-interactive basics -------------------------

  get redirectUrl(): undefined {
    return undefined
  }

  get clientMetadata(): OAuthClientMetadata {
    const grant = this.#grantType
    const method = this.#resolvedAuthMethod()
    return {
      redirect_uris: [],
      grant_types: [grant],
      token_endpoint_auth_method: method === 'none' ? undefined : method,
      client_name: 'behavioral remote mcp',
      scope: this.#scope,
    }
  }

  // -- state / code verifier (interactive flow only; stubbed) -------------

  state(): string {
    return crypto.randomUUID()
  }

  redirectToAuthorization(): void {
    throw new Error('Interactive OAuth authorization not supported by BunKeychainOAuthProvider')
  }

  saveCodeVerifier(): void {
    // No-op: PKCE is for the interactive authorization-code flow, which this
    // non-interactive provider never enters.
  }

  codeVerifier(): string {
    return ''
  }

  // -- client information (issuer-keyed) ----------------------------------

  async clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    const cached = this.#cachedClientInfo ?? (await this.#loadClientInfo())
    // Issuer-binding: a persisted blob bound to a different AS is treated as
    // absent — the SDK will re-stamp from the resolved issuer (or fall back to
    // the statically-configured credentials below).
    if (cached && this.#issuerMatches(cached.issuer, ctx?.issuer)) {
      return cached
    }
    // No usable persisted info — return the statically-configured credentials
    // (unstamped); the SDK stamps + saves them on first auth.
    if (this.#clientId) {
      return {
        client_id: this.#clientId,
        ...(this.#clientSecret ? { client_secret: this.#clientSecret } : {}),
        ...(this.#expectedIssuer ? { issuer: this.#expectedIssuer } : {}),
      }
    }
    return undefined
  }

  async saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
    _ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    this.#cachedClientInfo = clientInformation
    await this.#keychain.set(clientInfoKey(this.#serverUrl), JSON.stringify(clientInformation))
  }

  // -- tokens (issuer-keyed; most-recently-saved when ctx undefined) ------

  async tokens(_ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    if (this.#cachedTokens) return this.#cachedTokens
    this.#cachedTokens = await this.#loadTokens()
    return this.#cachedTokens
  }

  async saveTokens(tokens: StoredOAuthTokens, _ctx?: OAuthClientInformationContext): Promise<void> {
    this.#cachedTokens = tokens
    await this.#keychain.set(tokensKey(this.#serverUrl), JSON.stringify(tokens))
  }

  // -- discovery state (keyed by server; pre-issuer) ----------------------

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    if (this.#cachedDiscovery) return this.#cachedDiscovery
    const raw = await this.#keychain.get(discoveryKey(this.#serverUrl))
    if (!raw) return undefined
    try {
      this.#cachedDiscovery = JSON.parse(raw) as OAuthDiscoveryState
      return this.#cachedDiscovery
    } catch {
      return undefined
    }
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.#cachedDiscovery = state
    await this.#keychain.set(discoveryKey(this.#serverUrl), JSON.stringify(state))
  }

  // -- token request ------------------------------------------------------

  /**
   * Builds the grant-specific token-request body. The v2 SDK's `fetchToken`
   * calls this (plus {@link addClientAuthentication}) to perform the exchange.
   */
  prepareTokenRequest(scope?: string): URLSearchParams {
    const params = new URLSearchParams()
    const effectiveScope = scope ?? this.#scope
    if (this.#grantType === 'refresh_token') {
      params.set('grant_type', 'refresh_token')
      const refreshToken = this.#currentRefreshToken()
      if (refreshToken) params.set('refresh_token', refreshToken)
    } else {
      params.set('grant_type', 'client_credentials')
    }
    if (effectiveScope) params.set('scope', effectiveScope)
    if (this.#audience) params.set('audience', this.#audience)
    if (this.#resource) params.set('resource', this.#resource)
    return params
  }

  /**
   * Adds client credentials to a token request per the configured method.
   * Mirrors the SDK's `selectClientAuthMethod` default ordering when no
   * method is configured.
   */
  addClientAuthentication: AddClientAuthentication = (headers, params, _url, _metadata) => {
    const method = this.#resolvedAuthMethod()
    switch (method) {
      case 'client_secret_basic': {
        if (!this.#clientSecret) throw new Error('client_secret_basic requires a client secret')
        const basic = Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString('base64')
        headers.set('Authorization', `Basic ${basic}`)
        break
      }
      case 'client_secret_post':
        params.set('client_id', this.#clientId)
        if (this.#clientSecret) params.set('client_secret', this.#clientSecret)
        break
      case 'none':
        params.set('client_id', this.#clientId)
        break
    }
  }

  // -- RFC 8707 resource binding ------------------------------------------

  async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    if (!resource) return undefined
    let resourceUrl: URL
    try {
      resourceUrl = new URL(resource)
    } catch {
      return undefined
    }
    const server = new URL(serverUrl)
    // Origin binding: the resource indicator MUST be the MCP server itself
    // (RFC 8707 + MCP spec). A resource on a different origin is an issuer/
    // resource mismatch — reject rather than silently sending a token minted
    // for another server.
    if (resourceUrl.origin !== server.origin) {
      throw new IssuerMismatchError('authorization_response', server.origin, resourceUrl.origin)
    }
    return resourceUrl
  }

  // -- credential invalidation -------------------------------------------

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    switch (scope) {
      case 'tokens':
        this.#cachedTokens = undefined
        await this.#keychain.delete(tokensKey(this.#serverUrl))
        break
      case 'client':
        this.#cachedClientInfo = undefined
        await this.#keychain.delete(clientInfoKey(this.#serverUrl))
        break
      case 'discovery':
        this.#cachedDiscovery = undefined
        await this.#keychain.delete(discoveryKey(this.#serverUrl))
        break
      case 'verifier':
        // No PKCE state held — nothing to clear.
        break
      case 'all':
        this.#cachedTokens = undefined
        this.#cachedClientInfo = undefined
        this.#cachedDiscovery = undefined
        await Promise.all([
          this.#keychain.delete(tokensKey(this.#serverUrl)),
          this.#keychain.delete(clientInfoKey(this.#serverUrl)),
          this.#keychain.delete(discoveryKey(this.#serverUrl)),
        ])
        break
    }
  }

  // -- private helpers ----------------------------------------------------

  #resolvedAuthMethod(): 'client_secret_basic' | 'client_secret_post' | 'none' {
    if (this.#clientAuthentication) return this.#clientAuthentication
    // Default selection matches the SDK's selectClientAuthMethod priority.
    return selectClientAuthMethod(
      {
        client_id: this.#clientId,
        ...(this.#clientSecret ? { client_secret: this.#clientSecret } : {}),
      } as OAuthClientInformationMixed,
      ['client_secret_basic', 'client_secret_post', 'none'],
    )
  }

  #currentRefreshToken(): string | undefined {
    return this.#cachedTokens?.refresh_token ?? this.#initialRefreshToken
  }

  #issuerMatches(stored: string | undefined, requested: string | undefined): boolean {
    // ctx === undefined (resource-server read) → accept the most-recently-saved.
    if (requested === undefined) return true
    if (stored === undefined) return true
    return stored === requested
  }

  async #loadTokens(): Promise<StoredOAuthTokens | undefined> {
    const raw = await this.#keychain.get(tokensKey(this.#serverUrl))
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as StoredOAuthTokens
    } catch {
      return undefined
    }
  }

  async #loadClientInfo(): Promise<StoredOAuthClientInformation | undefined> {
    const raw = await this.#keychain.get(clientInfoKey(this.#serverUrl))
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as StoredOAuthClientInformation
    } catch {
      return undefined
    }
  }
}

export type { OAuthDiscoveryState, OAuthTokens, StoredOAuthClientInformation, StoredOAuthTokens }

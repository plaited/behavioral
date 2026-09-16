import { describe, expect, test } from 'bun:test'
import { IssuerMismatchError } from '@modelcontextprotocol/client'
import { InMemoryKeychain } from '../keychain.ts'
import { BunKeychainOAuthProvider } from '../keychain-oauth-provider.ts'

const SERVER_URL = 'https://mcp.example.com/mcp'
const baseOptions = (keychain: ReturnType<typeof InMemoryKeychain>) => ({
  serverUrl: SERVER_URL,
  grantType: 'client_credentials' as const,
  clientId: 'client-1',
  clientSecret: 'secret-1',
  scope: 'read',
  keychain,
})

describe('BunKeychainOAuthProvider — token round-trip across a reconnect', () => {
  test('saveTokens persists to the keychain; a new provider instance reads them back', async () => {
    const keychain = InMemoryKeychain()

    // First process: the SDK exchanges and saves issuer-stamped tokens.
    const first = new BunKeychainOAuthProvider(baseOptions(keychain))
    await first.saveTokens(
      {
        access_token: 'atk-1',
        token_type: 'Bearer',
        refresh_token: 'rtk-1',
        expires_in: 3600,
        issuer: 'https://as.example.com',
      },
      { issuer: 'https://as.example.com' },
    )

    // Simulate a process restart: a brand-new provider with the SAME keychain
    // (keychain persists; the connection does not). tokens() reads back.
    const second = new BunKeychainOAuthProvider(baseOptions(keychain))
    const recovered = await second.tokens({ issuer: 'https://as.example.com' })
    expect(recovered).toBeDefined()
    expect(recovered!.access_token).toBe('atk-1')
    expect(recovered!.refresh_token).toBe('rtk-1')
    expect(recovered!.issuer).toBe('https://as.example.com')
  })

  test('ctx === undefined returns the most-recently-saved token set (resource-server read)', async () => {
    const keychain = InMemoryKeychain()
    const provider = new BunKeychainOAuthProvider(baseOptions(keychain))
    await provider.saveTokens(
      { access_token: 'atk-2', token_type: 'Bearer', issuer: 'https://as.example.com' },
      { issuer: 'https://as.example.com' },
    )
    // No ctx — the v2 adapter calls tokens() pre-discovery.
    const tokens = await provider.tokens()
    expect(tokens?.access_token).toBe('atk-2')
  })

  test('refresh_token grant uses the persisted refresh token after a reconnect', async () => {
    const keychain = InMemoryKeychain()
    const first = new BunKeychainOAuthProvider({
      ...baseOptions(keychain),
      grantType: 'refresh_token',
      initialRefreshToken: 'initial-rt',
    })
    // SDK refreshes and saves a rotated refresh token.
    await first.saveTokens(
      { access_token: 'atk-3', token_type: 'Bearer', refresh_token: 'rotated-rt', issuer: 'https://as.example.com' },
      { issuer: 'https://as.example.com' },
    )

    // Reconnect: prepareTokenRequest must use the rotated refresh token, not
    // the initial one.
    const second = new BunKeychainOAuthProvider({
      ...baseOptions(keychain),
      grantType: 'refresh_token',
      initialRefreshToken: 'initial-rt',
    })
    // Warm the token cache (tokens() loads from keychain).
    await second.tokens({ issuer: 'https://as.example.com' })
    const params = second.prepareTokenRequest()
    expect(params.get('grant_type')).toBe('refresh_token')
    expect(params.get('refresh_token')).toBe('rotated-rt')
  })
})

describe('BunKeychainOAuthProvider — issuer binding', () => {
  test('clientInformation returns issuer-bound persisted info only when the issuer matches', async () => {
    const keychain = InMemoryKeychain()
    const provider = new BunKeychainOAuthProvider(baseOptions(keychain))

    // SDK stamps issuer A and saves client info.
    await provider.saveClientInformation(
      { client_id: 'client-1', client_secret: 'secret-1', issuer: 'https://as-a.example.com' },
      { issuer: 'https://as-a.example.com' },
    )

    // Same issuer → bound info returned.
    const bound = await provider.clientInformation({ issuer: 'https://as-a.example.com' })
    expect(bound?.issuer).toBe('https://as-a.example.com')

    // Different issuer → persisted info is NOT returned; falls back to the
    // statically-configured (unstamped) credentials. This is the issuer-binding
    // that the old provider lacked.
    const mismatched = await provider.clientInformation({ issuer: 'https://as-b.example.com' })
    expect(mismatched?.issuer).toBeUndefined()
    expect(mismatched?.client_id).toBe('client-1')
  })

  test('validateResourceURL rejects a resource on a different origin', async () => {
    const provider = new BunKeychainOAuthProvider(baseOptions(InMemoryKeychain()))
    await expect(provider.validateResourceURL(SERVER_URL, 'https://evil.example.com/resource')).rejects.toBeInstanceOf(
      IssuerMismatchError,
    )
  })

  test('validateResourceURL accepts a resource on the same origin', async () => {
    const provider = new BunKeychainOAuthProvider(baseOptions(InMemoryKeychain()))
    const resolved = await provider.validateResourceURL(SERVER_URL, 'https://mcp.example.com/other')
    expect(resolved?.origin).toBe('https://mcp.example.com')
  })

  test('validateResourceURL returns undefined when no resource is requested', async () => {
    const provider = new BunKeychainOAuthProvider(baseOptions(InMemoryKeychain()))
    expect(await provider.validateResourceURL(SERVER_URL, undefined)).toBeUndefined()
  })
})

describe('BunKeychainOAuthProvider — invalidateCredentials clears by scope', () => {
  test("invalidateCredentials('tokens') drops the token slot", async () => {
    const keychain = InMemoryKeychain()
    const provider = new BunKeychainOAuthProvider(baseOptions(keychain))
    await provider.saveTokens(
      { access_token: 'atk', token_type: 'Bearer', issuer: 'https://as.example.com' },
      { issuer: 'https://as.example.com' },
    )
    await provider.invalidateCredentials('tokens')
    expect(await provider.tokens()).toBeUndefined()
  })

  test("invalidateCredentials('all') drops every slot", async () => {
    const keychain = InMemoryKeychain()
    const provider = new BunKeychainOAuthProvider(baseOptions(keychain))
    await provider.saveTokens(
      { access_token: 'atk', token_type: 'Bearer', issuer: 'https://as.example.com' },
      { issuer: 'https://as.example.com' },
    )
    await provider.saveClientInformation(
      { client_id: 'client-1', issuer: 'https://as.example.com' },
      { issuer: 'https://as.example.com' },
    )
    await provider.saveDiscoveryState({ authorizationServerUrl: 'https://as.example.com' })
    await provider.invalidateCredentials('all')
    expect(await provider.tokens()).toBeUndefined()
    expect((await provider.clientInformation({ issuer: 'https://as.example.com' }))?.issuer).toBeUndefined()
    expect(await provider.discoveryState()).toBeUndefined()
  })
})

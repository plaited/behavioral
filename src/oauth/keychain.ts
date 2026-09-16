/**
 * OS-keychain abstraction for the MCP OAuth provider.
 *
 * @remarks
 * `BunKeychain` wraps {@link Bun.secrets} (macOS Keychain / libsecret /
 * Windows Credential Manager) so OAuth refresh tokens and client information
 * persist across process restarts without a plaintext file under
 * `~/.behavioral/mcp/tokens/`. `InMemoryKeychain` is the test double — the only
 * keychain boundary that gets mocked, per the slice's testing contract.
 *
 * All values are JSON strings; the provider serializes `StoredOAuthTokens` /
 * `StoredOAuthClientInformation` / `OAuthDiscoveryState` blobs before storing.
 *
 * @packageDocumentation
 */

/** A name/value secret store keyed by `name` within a fixed `service`. */
export type Keychain = {
  /** Returns the stored value, or `null` if absent. */
  get(name: string): Promise<string | null>
  /** Stores (replacing) or, with an empty value, deletes the entry. */
  set(name: string, value: string): Promise<void>
  /** Deletes the entry; returns whether one was present. */
  delete(name: string): Promise<boolean>
}

/** The fixed keychain service label — unique to the behavioral MCP client. */
export const KEYCHAIN_SERVICE = 'behavioral.mcp'

/**
 * Default keychain backed by {@link Bun.secrets}.
 *
 * `Bun.secrets` is `{ service, name, value }`-keyed; an empty `value` deletes
 * the entry, mirroring `delete()`.
 */
export const BunKeychain = (service: string = KEYCHAIN_SERVICE): Keychain => ({
  get: (name) => Bun.secrets.get({ service, name }),
  set: (name, value) => Bun.secrets.set({ service, name, value }),
  delete: (name) => Bun.secrets.delete({ service, name }),
})

/**
 * In-memory keychain for tests — the only keychain boundary that is mocked.
 * Not for production: holds values in a `Map`, never touching the OS keychain.
 */
export const InMemoryKeychain = (): Keychain => {
  const store = new Map<string, string>()
  return {
    get: async (name) => store.get(name) ?? null,
    set: async (name, value) => {
      if (value === '') store.delete(name)
      else store.set(name, value)
    },
    delete: async (name) => store.delete(name),
  }
}

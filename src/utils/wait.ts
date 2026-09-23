/**
 * Type definition for a Promise-based delay function.
 * Provides type safety for time-based Promise creation.
 *
 * @param ms - Duration to wait in milliseconds
 * @returns Promise that resolves to unknown after the delay
 */
export type Wait = (ms: number) => Promise<unknown>

/**
 * Promise-based delay utility for async flow control.
 * Cleaner alternative to setTimeout.
 *
 * @param ms - Milliseconds to wait
 * @returns Promise resolving after delay
 *
 * @remarks
 * Non-blocking, works with async/await.
 * Min delay ~4ms (browser limitation).
 * Use for: retries, rate limiting, animations.
 */
export const wait: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

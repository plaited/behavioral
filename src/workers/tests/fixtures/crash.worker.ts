/* Test fixture: throws on first message so the host sees Worker.onerror. */
self.onmessage = (): void => {
  throw new Error('satellite crashed')
}

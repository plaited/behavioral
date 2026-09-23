/*
 * Probe process fixture — long-running, speaks the unchanged wire over
 * stdio lines: one JSON request per line in, one result-event line out.
 * The `die` op exits 3 mid-stream (crash synthesis); everything else
 * answers the ok envelope and keeps serving — the primitive's respawn
 * brings a fresh instance only after a death.
 */
const encoder = new TextEncoder()

const reader = Bun.stdin.stream().getReader()
const decoder = new TextDecoder()
let carry = ''

for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  carry += decoder.decode(value, { stream: true })
  const lines = carry.split('\n')
  carry = lines.pop() ?? ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const message = JSON.parse(trimmed) as {
      type: string
      detail: { id: string; input: { op: string } }
      space?: string
    }
    if (message.detail.input.op === 'die') {
      process.exit(3)
    }
    const response = {
      type: 'shell_request_result',
      detail: { id: message.detail.id, ok: true, result: { echoed: message.detail.input.op } },
      ...(message.space === undefined ? {} : { space: message.space }),
    }
    process.stdout.write(encoder.encode(`${JSON.stringify(response)}\n`))
  }
}

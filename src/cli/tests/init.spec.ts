import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ajv } from '../../behavioral/behavioral.types.ts'
import { type Ask, collectInitInput, type InitInput, InitInputSchema, init } from '../init.ts'

/**
 * `behavioral init` — the config generator — through its real CLI handler
 * (makeCli: JSON positional in, validated JSON out), against a temp
 * BEHAVIORAL_HOME. The locked contract:
 *
 * - absent families default on (TypeSafe/OpenAI urls, env-NAME secrets);
 *   `null` omits a family; objects customize over the defaults;
 * - no literal secrets: api keys ride as `env('<NAME>')` references that fail
 *   fast when the variable is unset;
 * - an existing config is never clobbered without `force`;
 * - provider scaffolding writes `<home>/providers/<file>` (import-safe bare
 *   specifiers, thanks to the global-install resolution) and points the
 *   family's `entry` at it.
 */

describe('behavioral init — the runner', () => {
  let home: string
  let logs: string[]
  let originalLog: typeof console.log

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'behavioral-init-'))
    process.env.BEHAVIORAL_HOME = home
    logs = []
    originalLog = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.join(' '))
    }
  })

  afterEach(() => {
    console.log = originalLog
    delete process.env.BEHAVIORAL_HOME
    rmSync(home, { recursive: true, force: true })
  })

  const configPath = (): string => join(home, 'config.ts')
  const readConfig = (): string => readFileSync(configPath(), 'utf8')
  const runInit = async (json: string): Promise<{ home: string; configPath: string; files: string[] }> => {
    await init([json])
    return JSON.parse(logs.join('\n')) as { home: string; configPath: string; files: string[] }
  }

  test('an empty input generates the default config — both families, env-name secrets', async () => {
    const output = await runInit('{}')
    expect(output.configPath).toBe(configPath())
    expect(output.files).toEqual(['config.ts'])
    const content = readConfig()
    expect(content).toContain("import { defineConfig } from '@behavioral/sh'")
    expect(content).toContain("import { useSystemOne, useSystemTwo } from '@behavioral/sh/behaviors'")
    expect(content).toContain('https://api.typesafe.ai/v1/systemone')
    expect(content).toContain("'jev-latest'")
    expect(content).toContain("apiKey: env('TYPESAFE_API_KEY')")
    expect(content).toContain('https://api.openai.com/v1')
    expect(content).toContain("apiKey: env('OPENAI_API_KEY')")
    // No literal secrets anywhere.
    expect(content).not.toMatch(/sk-[a-zA-Z0-9]/)
  })

  test('a null family is omitted; a custom spec overrides the defaults', async () => {
    await runInit(
      JSON.stringify({
        systemOne: { url: 'http://localhost:9999/systemone', model: 'my-model', apiKeyEnv: 'MY_KEY' },
        systemTwo: null,
      }),
    )
    const content = readConfig()
    expect(content).toContain('http://localhost:9999/systemone')
    expect(content).toContain("'my-model'")
    expect(content).toContain("apiKey: env('MY_KEY')")
    expect(content).not.toContain('systemTwo')
    expect(content).not.toContain('TYPESAFE_API_KEY')
  })

  test('an existing config fails fast with the path; force overwrites', async () => {
    await runInit('{}')
    await expect(init(['{}'])).rejects.toThrow(/already exists.*config\.ts.*force/s)
    logs.length = 0
    await runInit('{"force": true}')
    expect(readConfig()).toContain('defineConfig')
  })

  test('provider scaffolding writes the entry and points the family at it', async () => {
    const output = await runInit(
      JSON.stringify({
        providers: [{ family: 'systemOne', file: 'my-one.behavior.ts' }],
      }),
    )
    expect(output.files).toContain('providers/my-one.behavior.ts')
    const entry = readFileSync(join(home, 'providers', 'my-one.behavior.ts'), 'utf8')
    expect(entry).toContain('configSystemOne')
    expect(entry).toContain('SystemOneRespond')
    expect(readConfig()).toContain("entry: 'providers/my-one.behavior.ts'")
  })

  test('two providers for one family are rejected', async () => {
    const input = JSON.stringify({
      providers: [
        { family: 'systemOne', file: 'a.behavior.ts' },
        { family: 'systemOne', file: 'b.behavior.ts' },
      ],
    })
    await expect(init([input])).rejects.toThrow(/one provider per family/)
  })

  test('the input schema rejects path traversal in a provider file name', () => {
    const validate = ajv.compile(InitInputSchema)
    const bad: InitInput = { providers: [{ family: 'systemOne', file: '../evil.ts' }] }
    expect(validate(bad)).toBe(false)
    const ok: InitInput = { providers: [{ family: 'systemOne', file: 'my-one.behavior.ts' }] }
    expect(validate(ok)).toBe(true)
  })
})

describe('behavioral init — the interactive collector', () => {
  const scriptedAsk = (answers: string[]): Ask => {
    const queue = [...answers]
    return async () => queue.shift() ?? ''
  }

  test('empty answers keep every default', async () => {
    const input = await collectInitInput(scriptedAsk(['', '', '', '', '', '', '', '']))
    expect(input.systemOne).toEqual({
      url: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-latest',
      apiKeyEnv: 'TYPESAFE_API_KEY',
    })
    expect(input.systemTwo).toEqual({
      endpoints: { openai: { url: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' } },
    })
    expect(input.providers).toBeUndefined()
  })

  test("answering 'n' disables a family", async () => {
    const input = await collectInitInput(scriptedAsk(['n', 'y', '', '', 'n']))
    expect(input.systemOne).toBeNull()
    expect(input.systemTwo).not.toBeNull()
  })

  test('the scaffold tour collects the provider', async () => {
    const input = await collectInitInput(
      scriptedAsk(['', '', '', '', '', '', '', 'y', 'systemTwo', 'my-two.behavior.ts']),
    )
    expect(input.providers).toEqual([{ family: 'systemTwo', file: 'my-two.behavior.ts' }])
  })
})

describe('behavioral init — the real CLI boundary', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'behavioral-init-e2e-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  const repoRoot = (): string => resolve(import.meta.dir, '..', '..', '..')

  const readConfig = async (): Promise<string | undefined> => {
    const configPath = join(home, 'config.ts')
    return (await Bun.file(configPath).exists()) ? await Bun.file(configPath).text() : undefined
  }

  test('the registered bin command generates the default config from JSON', async () => {
    const proc = Bun.spawn(['bun', 'run', 'bin/behavioral.ts', 'init', '{}'], {
      cwd: repoRoot(),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, BEHAVIORAL_HOME: home },
    })
    const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({ configPath: join(home, 'config.ts') })
    expect(await readConfig()).toContain("apiKey: env('TYPESAFE_API_KEY')")
  })

  // The isTTY branch: behind a real PTY, no input means the prompt tour — the
  // default interactive mode. Each answer lands after its prompt renders.
  test('the default interactive tour runs behind a real PTY', async () => {
    const chunks: string[] = []
    const decoder = new TextDecoder()
    const proc = Bun.spawn(['bun', 'run', 'bin/behavioral.ts', 'init'], {
      cwd: repoRoot(),
      env: { ...process.env, BEHAVIORAL_HOME: home },
      terminal: {
        cols: 80,
        rows: 24,
        data: (_terminal, data) => {
          chunks.push(decoder.decode(data))
        },
      },
    })
    const seen = (): string => chunks.join('')
    const waitFor = async (text: string): Promise<void> => {
      const deadline = Date.now() + 10_000
      while (!seen().includes(text)) {
        if (Date.now() > deadline) throw new Error(`never saw '${text}'; saw: ${JSON.stringify(seen())}`)
        await Bun.sleep(20)
      }
    }

    await waitFor('Enable System One')
    proc.terminal?.write('\n')
    await waitFor('System One URL')
    proc.terminal?.write('\n')
    await waitFor('System One model')
    proc.terminal?.write('\n')
    await waitFor('System One API key env var')
    proc.terminal?.write('\n')
    await waitFor('Enable System Two')
    proc.terminal?.write('\n')
    await waitFor('System Two URL')
    proc.terminal?.write('\n')
    await waitFor('System Two API key env var')
    proc.terminal?.write('\n')
    await waitFor('Scaffold a custom provider entry')
    proc.terminal?.write('n\n')

    await proc.exited
    expect(proc.exitCode).toBe(0)
    expect(await readConfig()).toContain("apiKey: env('TYPESAFE_API_KEY')")
    expect(await readConfig()).toContain("apiKey: env('OPENAI_API_KEY')")
  }, 20_000)
})

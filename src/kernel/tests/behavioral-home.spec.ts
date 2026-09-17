import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'
import {
  loadBehavioralConfig,
  parseBehavioralConfig,
  provisionBehavioralHome,
  ROOT_SPACE,
  spacePaths,
} from '../behavioral-home.ts'

const tempHome = async (): Promise<string> => (await Bun.$`mktemp -d`.quiet().text()).trim()

describe('behavioral-home — git init + seed files', () => {
  test('git inits, writes .gitignore (db.sqlite, logs/), seeds config.json', async () => {
    const home = await tempHome()
    try {
      const result = await provisionBehavioralHome(home)
      expect(result.gitInitialized).toBe(true)
      expect(result.gitignoreWritten).toBe(true)
      expect(result.configSeeded).toBe(true)
      expect((await Bun.$`test -d ${path.join(home, '.git')}`.quiet()).exitCode).toBe(0)
      expect(await Bun.file(path.join(home, '.gitignore')).text()).toBe('db.sqlite\nlogs/\n')
      expect(JSON.parse(await Bun.file(path.join(home, 'config.json')).text())).toEqual({ models: [] })
    } finally {
      await Bun.$`rm -rf ${home}`.quiet().nothrow()
    }
  })

  test('second provision reports nothing new written', async () => {
    const home = await tempHome()
    try {
      await provisionBehavioralHome(home)
      const second = await provisionBehavioralHome(home)
      expect(second.gitInitialized).toBe(false)
      expect(second.gitignoreWritten).toBe(false)
      expect(second.configSeeded).toBe(false)
    } finally {
      await Bun.$`rm -rf ${home}`.quiet().nothrow()
    }
  })

  test('git repo works — a commit succeeds in the provisioned home', async () => {
    const home = await tempHome()
    try {
      await provisionBehavioralHome(home)
      await Bun.$`git -C ${home} -c user.email=t@t -c user.name=t add -A`.quiet()
      await Bun.$`git -C ${home} -c user.email=t@t -c user.name=t commit --no-gpg-sign -qm init`.quiet()
      const log = await Bun.$`git -C ${home} log --oneline`.quiet().text()
      expect(log.trim().length).toBeGreaterThan(0)
    } finally {
      await Bun.$`rm -rf ${home}`.quiet().nothrow()
    }
  })
})

describe('behavioral-home — config.json validation', () => {
  test('valid models load; a raw apiKey is rejected', () => {
    const valid = parseBehavioralConfig(
      JSON.stringify({
        models: [
          {
            provider: 'openai',
            modelId: 'gpt-4o',
            endpointUrl: 'https://api.openai.com/v1',
            apiKeyRef: 'OPENAI_API_KEY',
            locality: 'remote',
          },
        ],
      }),
    )
    if (!valid.ok) throw new Error(`expected ok, got: ${valid.message}`)
    expect(valid.config.models).toEqual([
      {
        provider: 'openai',
        modelId: 'gpt-4o',
        endpointUrl: 'https://api.openai.com/v1',
        apiKeyRef: 'OPENAI_API_KEY',
        locality: 'remote',
      },
    ])

    const rawKey = parseBehavioralConfig(
      JSON.stringify({
        models: [
          { provider: 'openai', modelId: 'gpt-4o', endpointUrl: 'https://api.openai.com/v1', apiKey: 'sk-secret' },
        ],
      }),
    )
    expect(rawKey.ok).toBe(false)
    if (!rawKey.ok) expect(rawKey.message).toContain('apiKeyRef')

    const bad = parseBehavioralConfig('not json')
    expect(bad.ok).toBe(false)
  })

  test('loadBehavioralConfig — absent file = empty model fleet; invalid file = not ok', async () => {
    const home = await tempHome()
    try {
      const absent = await loadBehavioralConfig(home)
      if (!absent.ok) throw new Error(`expected ok, got: ${absent.message}`)
      expect(absent.config.models).toEqual([])

      await Bun.write(path.join(home, 'config.json'), '{"models":[{"apiKey":"sk"}]}')
      const invalid = await loadBehavioralConfig(home)
      expect(invalid.ok).toBe(false)
    } finally {
      await Bun.$`rm -rf ${home}`.quiet().nothrow()
    }
  })
})

describe('behavioral-home — skeleton creation', () => {
  test('provisions the root space tree at an empty home', async () => {
    const home = await tempHome()
    try {
      const result = await provisionBehavioralHome(home)
      expect(result.root).toBe(home)
      const tree = spacePaths(home, ROOT_SPACE)
      for (const dir of [tree.space, tree.threads, tree.html, tree.logs, tree.logsArchive]) {
        expect((await Bun.$`test -d ${dir}`.quiet()).exitCode).toBe(0)
      }
    } finally {
      await Bun.$`rm -rf ${home}`.quiet().nothrow()
    }
  })

  test('is idempotent — re-provisioning an existing home changes nothing', async () => {
    const home = await tempHome()
    try {
      const first = await provisionBehavioralHome(home)
      // user edits config.json between runs — idempotency must not clobber it
      await Bun.write(path.join(home, 'config.json'), '{"models":[]}')
      const second = await provisionBehavioralHome(home)
      expect(second.root).toBe(first.root)
      expect(await Bun.file(path.join(home, 'config.json')).text()).toBe('{"models":[]}')
    } finally {
      await Bun.$`rm -rf ${home}`.quiet().nothrow()
    }
  })
})

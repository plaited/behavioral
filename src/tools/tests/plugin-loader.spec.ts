import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'
import {
  PluginLoaderInputSchema,
  type PluginLoaderOutput,
  PluginLoaderOutputSchema,
  type PluginManifest,
  pluginLoader,
} from '../plugin-loader.ts'
import { ajv } from '../use-tool.ts'

const validateInput = ajv.compile(PluginLoaderInputSchema)
const validateOutput = ajv.compile(PluginLoaderOutputSchema)

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'

// ---------------------------------------------------------------------------
// Helpers — create a temp plugin dir with plugin.json, mcp.json, skills/, threads/
// ---------------------------------------------------------------------------

const tempDir = async (): Promise<string> => (await Bun.$`mktemp -d`.quiet().text()).trim()

type PluginFiles = {
  pluginJson?: unknown
  mcpJson?: unknown
  skills?: Record<string, string> // dir name → SKILL.md content
  threads?: Record<string, string> // file name → content
}

const makePlugin = async (dir: string, files: PluginFiles): Promise<string> => {
  await Bun.write(
    path.join(dir, 'plugin.json'),
    JSON.stringify(
      files.pluginJson ?? {
        $schema: PLUGIN_SCHEMA,
        name: 'test-plugin',
      },
    ),
  )
  if (files.mcpJson !== undefined) {
    await Bun.write(path.join(dir, 'mcp.json'), JSON.stringify(files.mcpJson))
  }
  if (files.skills) {
    for (const [skillDir, skillContent] of Object.entries(files.skills)) {
      const skillPath = path.join(dir, 'skills', skillDir)
      await Bun.$`mkdir -p ${skillPath}`.quiet()
      await Bun.write(path.join(skillPath, 'SKILL.md'), skillContent)
    }
  }
  if (files.threads) {
    const threadsDir = path.join(dir, 'threads')
    await Bun.$`mkdir -p ${threadsDir}`.quiet()
    for (const [fileName, content] of Object.entries(files.threads)) {
      await Bun.write(path.join(threadsDir, fileName), content)
    }
  }
  return dir
}

const run = (dir: string): Promise<PluginLoaderOutput> =>
  pluginLoader({ path: 'plugin.json', cwd: dir }) as Promise<PluginLoaderOutput>

const ok = (r: PluginLoaderOutput): r is PluginManifest => !('isError' in r)
const err = (r: PluginLoaderOutput): r is { isError: true; message: string } => 'isError' in r

/** Access a field from a PluginLoaderOutput, asserting it's a manifest first. */
const manifest = (r: PluginLoaderOutput): PluginManifest => {
  if ('isError' in r) throw new Error(`expected manifest, got error: ${r.message}`)
  return r
}

/** Access a field from a PluginLoaderOutput, asserting it's an error first. */
const errorMsg = (r: PluginLoaderOutput): string => {
  if (!('isError' in r)) throw new Error('expected error, got manifest')
  return r.message
}

// ---------------------------------------------------------------------------
// Input / output schema contract
// ---------------------------------------------------------------------------

describe('plugin-loader — input/output schema', () => {
  test('input schema requires path + cwd', () => {
    expect(validateInput({ path: 'plugin.json' })).toBe(false)
    expect(validateInput({ cwd: '/x' })).toBe(false)
    expect(validateInput({ path: 'plugin.json', cwd: '/x' })).toBe(true)
  })

  test('output schema accepts a success manifest', () => {
    expect(
      validateOutput({
        name: 'test',
        version: '0.0.1',
        mcps: {},
        skills: ['behavioral'],
        models: [],
        threads: [],
        spaces: {},
      }),
    ).toBe(true)
  })

  test('output schema accepts an error', () => {
    expect(validateOutput({ isError: true, message: 'bad' })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// plugin.json validation — fatal vs report-and-ignore
// ---------------------------------------------------------------------------

describe('plugin-loader — plugin.json validation', () => {
  test('parses a minimal valid plugin.json (only $schema + name)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {})
      const result = await run(dir)
      expect(validateOutput(result)).toBe(true)
      expect(ok(result)).toBe(true)
      expect(manifest(result).name).toBe('test-plugin')
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('parses a full valid plugin.json with all metadata fields', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        pluginJson: {
          $schema: PLUGIN_SCHEMA,
          name: 'my.plugin',
          version: '1.2.3',
          description: 'test',
          author: { name: 'dev', email: 'dev@x.com', url: 'https://x.com' },
          homepage: 'https://x.com',
          repository: 'https://github.com/x/y',
          license: 'ISC',
          keywords: ['test'],
          extensions: { 'sh.behavioral': { models: [] } },
        },
      })
      const result = await run(dir)
      expect(validateOutput(result)).toBe(true)
      expect(ok(result)).toBe(true)
      expect(manifest(result).name).toBe('my.plugin')
      expect(manifest(result).version).toBe('1.2.3')
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('rejects missing $schema (fatal)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, { pluginJson: { name: 'test-plugin' } })
      const result = await run(dir)
      expect(validateOutput(result)).toBe(true)
      expect(err(result)).toBe(true)
      expect(errorMsg(result)).toContain('schema')
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('rejects missing name (fatal)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, { pluginJson: { $schema: PLUGIN_SCHEMA } })
      const result = await run(dir)
      expect(validateOutput(result)).toBe(true)
      expect(err(result)).toBe(true)
      expect(errorMsg(result)).toContain('name')
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('rejects invalid name — uppercase (fatal)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, { pluginJson: { $schema: PLUGIN_SCHEMA, name: 'My-Plugin' } })
      const result = await run(dir)
      expect(err(result)).toBe(true)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('rejects invalid name — leading hyphen (fatal)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, { pluginJson: { $schema: PLUGIN_SCHEMA, name: '-start' } })
      const result = await run(dir)
      expect(err(result)).toBe(true)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('rejects invalid name — consecutive hyphens (fatal)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, { pluginJson: { $schema: PLUGIN_SCHEMA, name: 'has--double' } })
      const result = await run(dir)
      expect(err(result)).toBe(true)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('rejects invalid name — consecutive periods (fatal)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, { pluginJson: { $schema: PLUGIN_SCHEMA, name: 'too.many..dots' } })
      const result = await run(dir)
      expect(err(result)).toBe(true)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('reports and ignores unknown top-level field (non-fatal, plugin still loads)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        pluginJson: {
          $schema: PLUGIN_SCHEMA,
          name: 'test-plugin',
          unknownField: 'should-be-ignored',
        },
      })
      const result = await run(dir)
      expect(validateOutput(result)).toBe(true)
      expect(ok(result)).toBe(true)
      expect(manifest(result).name).toBe('test-plugin')
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('rejects invalid author object — unknown field in author (fatal)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        pluginJson: {
          $schema: PLUGIN_SCHEMA,
          name: 'test-plugin',
          author: { name: 'dev', bad: 1 },
        },
      })
      const result = await run(dir)
      expect(err(result)).toBe(true)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })
})

// ---------------------------------------------------------------------------
// mcp.json validation — two-stage, failure isolation
// ---------------------------------------------------------------------------

describe('plugin-loader — mcp.json validation', () => {
  test('missing mcp.json = valid absence, mcps output is empty', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {})
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({})
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('parses a valid mcp.json with streamable-http server', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        mcpJson: {
          $schema: MCP_SCHEMA,
          mcpServers: {
            'you-web': { type: 'streamable-http', url: 'https://api.you.com/mcp' },
          },
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({
        'you-web': { type: 'streamable-http', url: 'https://api.you.com/mcp' },
      })
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('parses a valid mcp.json with stdio server', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        mcpJson: {
          $schema: MCP_SCHEMA,
          mcpServers: {
            local: { type: 'stdio', command: './bin/server', args: ['--x'] },
          },
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({
        local: { type: 'stdio', command: './bin/server', args: ['--x'] },
      })
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('parses a valid mcp.json with sse server', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        mcpJson: {
          $schema: MCP_SCHEMA,
          mcpServers: {
            legacy: { type: 'sse', url: 'https://legacy.example.com/sse' },
          },
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({
        legacy: { type: 'sse', url: 'https://legacy.example.com/sse' },
      })
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('empty mcpServers is valid', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        mcpJson: { $schema: MCP_SCHEMA, mcpServers: {} },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({})
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('bad mcp.json entry is skipped, siblings still load', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        mcpJson: {
          $schema: MCP_SCHEMA,
          mcpServers: {
            good: { type: 'streamable-http', url: 'https://x.com/mcp' },
            bad: { type: 'streamable-http', url: 'https://y.com/mcp', unknownField: 1 },
          },
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({
        good: { type: 'streamable-http', url: 'https://x.com/mcp' },
      })
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('mcp.json $schema mismatch with plugin.json $schema → MCP disabled, skills still load', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        pluginJson: {
          $schema: PLUGIN_SCHEMA,
          name: 'test-plugin',
        },
        mcpJson: {
          $schema: 'https://agent-plugins.org/schemas/2.0.0/mcp.schema.json',
          mcpServers: {
            x: { type: 'streamable-http', url: 'https://x.com/mcp' },
          },
        },
        skills: { echo: '# echo skill' },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({})
      expect(manifest(result).skills).toEqual(['echo'])
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('mcp.json with unknown top-level field is rejected (fatal for mcp)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        mcpJson: {
          $schema: MCP_SCHEMA,
          mcpServers: {},
          extra: 1,
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({})
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('mcp.json missing mcpServers is rejected (fatal for mcp)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        mcpJson: { $schema: MCP_SCHEMA },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({})
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })
})

// ---------------------------------------------------------------------------
// Skills discovery from skills/
// ---------------------------------------------------------------------------

describe('plugin-loader — skills discovery', () => {
  test('missing skills/ = valid absence, skills output is empty', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {})
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).skills).toEqual([])
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('discovers skill subdirs with SKILL.md', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        skills: { echo: '---\nname: echo\n---\n# Echo', grep: '---\nname: grep\n---\n# Grep' },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).skills.sort()).toEqual(['echo', 'grep'])
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('skips non-conformant skill dirs (no SKILL.md), keeps loading others', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        skills: { echo: '---\nname: echo\n---\n# Echo' },
      })
      // Add a dir without SKILL.md
      await Bun.$`mkdir -p ${path.join(dir, 'skills', 'no-skill-md')}`.quiet()
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).skills).toEqual(['echo'])
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })
})

// ---------------------------------------------------------------------------
// extensions."sh.behavioral" — models, mcps/skills/threads gating, spaces
// ---------------------------------------------------------------------------

describe('plugin-loader — sh.behavioral extension', () => {
  test('reads models from extensions.sh.behavioral', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        pluginJson: {
          $schema: PLUGIN_SCHEMA,
          name: 'test-plugin',
          extensions: {
            'sh.behavioral': {
              models: [
                {
                  provider: 'openai',
                  modelId: 'gpt-4o',
                  endpointUrl: 'https://api.openai.com/v1',
                  apiKeyRef: 'OPENAI_API_KEY',
                  locality: 'remote',
                },
              ],
            },
          },
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).models).toEqual([
        {
          provider: 'openai',
          modelId: 'gpt-4o',
          endpointUrl: 'https://api.openai.com/v1',
          apiKeyRef: 'OPENAI_API_KEY',
          locality: 'remote',
        },
      ])
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('rejects a raw apiKey on a model (apiKeyRef rule)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        pluginJson: {
          $schema: PLUGIN_SCHEMA,
          name: 'test-plugin',
          extensions: {
            'sh.behavioral': {
              models: [
                {
                  provider: 'openai',
                  modelId: 'gpt-4o',
                  endpointUrl: 'https://api.openai.com/v1',
                  apiKey: 'sk-secret',
                },
              ],
            },
          },
        },
      })
      const result = await run(dir)
      expect(err(result)).toBe(true)
      expect(errorMsg(result)).toContain('apiKey')
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('reads a model entry with a base-with-path endpoint URL', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        pluginJson: {
          $schema: PLUGIN_SCHEMA,
          name: 'test-plugin',
          extensions: {
            'sh.behavioral': {
              models: [
                {
                  provider: 'example',
                  modelId: 'example-model',
                  endpointUrl: 'https://example.com/api/v1',
                  apiKeyRef: 'example',
                  locality: 'cloud',
                },
              ],
            },
          },
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).models).toEqual([
        {
          provider: 'example',
          modelId: 'example-model',
          endpointUrl: 'https://example.com/api/v1',
          apiKeyRef: 'example',
          locality: 'cloud',
        },
      ])
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('reads mcps gating from extensions.sh.behavioral', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        pluginJson: {
          $schema: PLUGIN_SCHEMA,
          name: 'test-plugin',
          extensions: {
            'sh.behavioral': { mcps: { include: ['you-web'] } },
          },
        },
        mcpJson: {
          $schema: MCP_SCHEMA,
          mcpServers: {
            'you-web': { type: 'streamable-http', url: 'https://api.you.com/mcp' },
            other: { type: 'streamable-http', url: 'https://other.com/mcp' },
          },
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({
        'you-web': { type: 'streamable-http', url: 'https://api.you.com/mcp' },
      })
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('reads spaces from extensions.sh.behavioral', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        pluginJson: {
          $schema: PLUGIN_SCHEMA,
          name: 'test-plugin',
          extensions: {
            'sh.behavioral': {
              spaces: {
                'project-a': { mcps: { include: ['you-web'] } },
              },
            },
          },
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).spaces).toEqual({
        'project-a': { mcps: { include: ['you-web'] } },
      })
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('ignores unknown extension namespaces without validating contents', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        pluginJson: {
          $schema: PLUGIN_SCHEMA,
          name: 'test-plugin',
          extensions: {
            'com.other.client': { arbitrary: 'data', bad: 123 },
            'sh.behavioral': { models: [] },
          },
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).models).toEqual([])
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('absent extensions = valid, output has empty models/spaces', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {})
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).models).toEqual([])
      expect(manifest(result).spaces).toEqual({})
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })
})

// ---------------------------------------------------------------------------
// Threads — resolve against threads/, containment enforcement
// ---------------------------------------------------------------------------

describe('plugin-loader — threads', () => {
  test('absent threads/ + no threads extension → empty threads output', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {})
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).threads).toEqual([])
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('threads/ exists but no extension gating → all threads included', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        threads: { 'provision.ts': '// thread', 'cleanup.ts': '// thread' },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).threads.sort()).toEqual(['cleanup.ts', 'provision.ts'])
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('threads.include gates to specified files', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        pluginJson: {
          $schema: PLUGIN_SCHEMA,
          name: 'test-plugin',
          extensions: {
            'sh.behavioral': { threads: { include: ['provision.ts'] } },
          },
        },
        threads: { 'provision.ts': '// thread', 'cleanup.ts': '// thread' },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).threads).toEqual(['provision.ts'])
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('threads.exclude removes specified files', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        pluginJson: {
          $schema: PLUGIN_SCHEMA,
          name: 'test-plugin',
          extensions: {
            'sh.behavioral': { threads: { exclude: ['cleanup.ts'] } },
          },
        },
        threads: { 'provision.ts': '// thread', 'cleanup.ts': '// thread' },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).threads).toEqual(['provision.ts'])
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('threads.include path escaping plugin root → rejected', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        pluginJson: {
          $schema: PLUGIN_SCHEMA,
          name: 'test-plugin',
          extensions: {
            'sh.behavioral': { threads: { include: ['../../escape.ts'] } },
          },
        },
        threads: { 'provision.ts': '// thread' },
      })
      const result = await run(dir)
      expect(err(result)).toBe(true)
      expect(errorMsg(result)).toContain('root')
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })
})

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('plugin-loader — error cases', () => {
  test('returns isError when plugin.json does not exist', async () => {
    const dir = await tempDir()
    try {
      const result = await run(dir)
      expect(validateOutput(result)).toBe(true)
      expect(err(result)).toBe(true)
      expect(errorMsg(result)).toContain('not found')
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('returns isError when plugin.json is not valid JSON', async () => {
    const dir = await tempDir()
    try {
      await Bun.write(path.join(dir, 'plugin.json'), '{ not json')
      const result = await run(dir)
      expect(err(result)).toBe(true)
      expect(errorMsg(result)).toContain('JSON')
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('returns isError when plugin.json is not an object', async () => {
    const dir = await tempDir()
    try {
      await Bun.write(path.join(dir, 'plugin.json'), '[]')
      const result = await run(dir)
      expect(err(result)).toBe(true)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })
})

// ---------------------------------------------------------------------------
// Real default plugin at repo root
// ---------------------------------------------------------------------------

describe('plugin-loader — real default plugin', () => {
  test('parses the src/plugin default plugin clean', async () => {
    const pluginDir = `${import.meta.dir}/../../../src/plugin`
    const resolved = path.resolve(pluginDir)
    const result = await run(resolved)
    expect(validateOutput(result)).toBe(true)
    expect(ok(result)).toBe(true)
    expect(manifest(result).name).toBe('behavioral')
    // skills/behavioral/ should be discovered
    expect(manifest(result).skills).toContain('behavioral')
    // mcp.json has you-web server
    expect(manifest(result).mcps).toHaveProperty('you-web')
    // sh.behavioral extension models
    expect(Array.isArray(manifest(result).models)).toBe(true)
  })
})

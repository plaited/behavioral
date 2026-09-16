/**
 * TypeScript LSP tool — TypeScript 7 native API passthrough.
 *
 * @remarks
 * Replaces the old typescript-language-server (which needed tsserver.js,
 * removed in TS 5.8+) with TypeScript 7's native async API.
 *
 * Two modes via the `mode` discriminant:
 *   - `execute`: open file, run method handlers, return results
 *   - `discover`: return list of supported method→capability mappings
 *
 * Verbatim port of the removed `src/cli/typescript-lsp.ts` (Zod CLI) to a
 * `useTool` unit with AJV schemas. Input/output shapes are unchanged.
 *
 * @internal
 */

import { isAbsolute, normalize, relative, resolve } from 'node:path'
import type { JSONSchemaType } from 'ajv'
import type { SourceFile, Statement } from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import {
  isClassDeclaration,
  isEnumDeclaration,
  isFunctionDeclaration,
  isInterfaceDeclaration,
  isModuleDeclaration,
  isTypeAliasDeclaration,
  isVariableStatement,
} from 'typescript/unstable/ast/is'
import type { Project, Snapshot } from 'typescript/unstable/async'
import { API } from 'typescript/unstable/async'
import { useTool } from './use-tool.ts'

// ============================================================================
// Constants
// ============================================================================

export const TYPESCRIPT_LSP_TOOL_NAME = 'typescript-lsp'

// ============================================================================
// Helpers
// ============================================================================

const resolveFilePath = (filePath: string, base?: string): string => {
  if (isAbsolute(filePath)) return normalize(filePath)
  return normalize(resolve(base ?? process.cwd(), filePath))
}

const toPosixPath = (path: string): string => path.replace(/\\/g, '/')

const makeDisplayPath = (absolutePath: string, base: string) => {
  const relativePath = toPosixPath(relative(base, absolutePath))
  if (relativePath === '' || relativePath === '.') return '.'
  return relativePath.startsWith('..') ? absolutePath : relativePath
}

const resolveUriPath = (uri: string): string | undefined => {
  if (!uri.startsWith('file://')) return
  try {
    return normalize(decodeURIComponent(new URL(uri).pathname))
  } catch {
    return
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ============================================================================
// Project Resolution Helpers
// ============================================================================

/**
 * Find the fully-initialized Project (with program/checker) that contains the
 * given file path. Falls back to the first project if no match.
 *
 * `getDefaultProjectForFile` returns a shallow proxy that lacks program/checker;
 * only the Project instances from `getProjects()` are fully wired.
 */
const findProjectForFile = (snapshot: Snapshot, filePath: string): Project | undefined => {
  const projects = snapshot.getProjects()
  for (const p of projects) {
    if (p.rootFiles?.includes(filePath)) return p
  }
  return projects[0]
}

// ============================================================================
// LSP Method → TS 7 API Handlers
// ============================================================================

type MethodHandler = (params: {
  snapshot: Snapshot
  rootDir: string
  requestParams: Record<string, unknown>
}) => Promise<unknown>

/** Map of LSP method names to TypeScript 7 API handlers. */
const METHOD_HANDLERS: Record<string, MethodHandler> = {
  'textDocument/documentSymbol': async ({ snapshot, requestParams }) => {
    const uri = (requestParams.textDocument as { uri?: string } | undefined)?.uri
    if (!uri) throw new Error('textDocument/documentSymbol requires textDocument.uri')
    const absolutePath = resolveUriPath(uri)
    if (!absolutePath) throw new Error(`Invalid URI: ${uri}`)

    const project = findProjectForFile(snapshot, absolutePath)
    if (!project) throw new Error(`No project found for file: ${absolutePath}`)

    const sourceFile = await project.program.getSourceFile(absolutePath)
    if (!sourceFile) throw new Error(`Source file not found: ${absolutePath}`)

    return extractDocumentSymbols(sourceFile)
  },

  'textDocument/hover': async ({ snapshot, requestParams }) => {
    const uri = (requestParams.textDocument as { uri?: string } | undefined)?.uri
    if (!uri) throw new Error('textDocument/hover requires textDocument.uri')
    const absolutePath = resolveUriPath(uri)
    if (!absolutePath) throw new Error(`Invalid URI: ${uri}`)

    const position = requestParams.position as { line?: number; character?: number } | undefined
    if (position?.line === undefined || position?.character === undefined) {
      throw new Error('textDocument/hover requires position.line and position.character')
    }

    const project = findProjectForFile(snapshot, absolutePath)
    if (!project) throw new Error(`No project found for file: ${absolutePath}`)

    const sourceFile = await project.program.getSourceFile(absolutePath)
    if (!sourceFile) throw new Error(`Source file not found: ${absolutePath}`)

    const offset = sourceFile.getPositionOfLineAndCharacter(position.line, position.character)
    const symbol = await project.checker.getSymbolAtPosition(absolutePath, offset)
    if (!symbol) return undefined

    const type = await project.checker.getTypeOfSymbol(symbol)
    const typeStr = type ? project.checker.typeToString(type) : undefined
    const docComment = await project.checker.getDocumentationCommentOfSymbol(symbol)
    const jsdoc = await project.checker.getJsDocTagsOfSymbol(symbol)

    return {
      name: symbol.name,
      kind: symbol.flags,
      type: typeStr,
      documentation: docComment,
      tags: jsdoc.map((t) => ({ name: t.name, text: t.text })),
    }
  },

  'textDocument/completion': async ({ snapshot, requestParams }) => {
    const uri = (requestParams.textDocument as { uri?: string } | undefined)?.uri
    if (!uri) throw new Error('textDocument/completion requires textDocument.uri')
    const absolutePath = resolveUriPath(uri)
    if (!absolutePath) throw new Error(`Invalid URI: ${uri}`)

    const position = requestParams.position as { line?: number; character?: number } | undefined
    if (position?.line === undefined || position?.character === undefined) {
      throw new Error('textDocument/completion requires position.line and position.character')
    }

    const project = findProjectForFile(snapshot, absolutePath)
    if (!project) throw new Error(`No project found for file: ${absolutePath}`)

    const sourceFile = await project.program.getSourceFile(absolutePath)
    if (!sourceFile) throw new Error(`Source file not found: ${absolutePath}`)

    const offset = sourceFile.getPositionOfLineAndCharacter(position.line, position.character)
    const info = await project.checker.getCompletionsAtPosition(absolutePath, offset)
    if (!info) return { isIncomplete: false, entries: [] }

    return {
      isIncomplete: info.isIncomplete,
      entries: info.entries.map((e) => ({
        name: e.name,
        kind: e.kind,
        sortText: e.sortText,
        insertText: e.insertText,
        detail: e.detail,
      })),
    }
  },

  'textDocument/definition': async ({ snapshot, requestParams }) => {
    const uri = (requestParams.textDocument as { uri?: string } | undefined)?.uri
    if (!uri) throw new Error('textDocument/definition requires textDocument.uri')
    const absolutePath = resolveUriPath(uri)
    if (!absolutePath) throw new Error(`Invalid URI: ${uri}`)

    const position = requestParams.position as { line?: number; character?: number } | undefined
    if (position?.line === undefined || position?.character === undefined) {
      throw new Error('textDocument/definition requires position.line and position.character')
    }

    const project = findProjectForFile(snapshot, absolutePath)
    if (!project) throw new Error(`No project found for file: ${absolutePath}`)

    const sourceFile = await project.program.getSourceFile(absolutePath)
    if (!sourceFile) throw new Error(`Source file not found: ${absolutePath}`)

    const offset = sourceFile.getPositionOfLineAndCharacter(position.line, position.character)
    const symbol = await project.checker.getSymbolAtPosition(absolutePath, offset)
    if (!symbol) return undefined

    const decl = symbol.valueDeclaration
    if (!decl) return undefined

    const resolvedNode = await decl.resolve(project)
    if (!resolvedNode) return undefined

    const declFile = resolvedNode.getSourceFile()
    const start = resolvedNode.getStart()
    const end = resolvedNode.getEnd()
    const lineChar = declFile.getLineAndCharacterOfPosition(start)
    const endLineChar = declFile.getLineAndCharacterOfPosition(end)

    return [
      {
        uri: `file://${declFile.fileName}`,
        range: {
          start: { line: lineChar.line, character: lineChar.character },
          end: { line: endLineChar.line, character: endLineChar.character },
        },
      },
    ]
  },
}

/** Map of TS 7 capability names to LSP method names. */
const CAPABILITY_TO_METHOD: Record<string, string> = {
  documentSymbolProvider: 'textDocument/documentSymbol',
  hoverProvider: 'textDocument/hover',
  completionProvider: 'textDocument/completion',
  definitionProvider: 'textDocument/definition',
}

// ============================================================================
// Document Symbol Extraction
// ============================================================================

type DocumentSymbolEntry = {
  name: string
  kind: string
  range: [number, number]
}

const SYMBOL_KIND_NAMES: Record<number, string> = {
  [SyntaxKind.VariableStatement]: 'Variable',
  [SyntaxKind.FunctionDeclaration]: 'Function',
  [SyntaxKind.ClassDeclaration]: 'Class',
  [SyntaxKind.InterfaceDeclaration]: 'Interface',
  [SyntaxKind.TypeAliasDeclaration]: 'TypeAlias',
  [SyntaxKind.EnumDeclaration]: 'Enum',
  [SyntaxKind.ModuleDeclaration]: 'Module',
}

const extractNameFromStatement = (stmt: Statement, sourceFile: SourceFile): string | undefined => {
  if (isVariableStatement(stmt)) {
    const decl = stmt.declarationList.declarations[0]
    if (!decl) return
    const name = decl.name
    if ('escapedText' in name) return (name as { escapedText: string }).escapedText
    return name.getText(sourceFile)
  }
  if (isFunctionDeclaration(stmt) || isClassDeclaration(stmt)) {
    return stmt.name?.text
  }
  if (isInterfaceDeclaration(stmt) || isTypeAliasDeclaration(stmt) || isEnumDeclaration(stmt)) {
    return stmt.name.text
  }
  if (isModuleDeclaration(stmt)) {
    return stmt.name?.text
  }
  return
}

/**
 * Extract top-level symbols from a source file for documentSymbol response.
 */
const extractDocumentSymbols = (sourceFile: SourceFile): DocumentSymbolEntry[] => {
  const symbols: DocumentSymbolEntry[] = []

  for (const stmt of sourceFile.statements) {
    const name = extractNameFromStatement(stmt, sourceFile)
    if (!name) continue

    const kindNum = stmt.kind
    const kindName = SYMBOL_KIND_NAMES[kindNum] ?? `Unknown(${kindNum})`
    const start = stmt.getStart(sourceFile)
    const end = stmt.getEnd()

    symbols.push({
      name,
      kind: kindName,
      range: [start, end],
    })
  }

  return symbols
}

// ============================================================================
// Types
// ============================================================================

export type LspExecuteRequest = {
  method: string
  params?: unknown
}

export type TypeScriptLspInput =
  | {
      /** Execute LSP-style requests against a file */
      mode: 'execute'
      /** Path to a TypeScript/JavaScript file */
      file: string
      /** Workspace root for file:// URI resolution */
      rootDir?: string
      /** Requests to execute in a single session */
      requests: LspExecuteRequest[]
    }
  | {
      /** Discover available LSP methods supported by the server */
      mode: 'discover'
      /** Workspace root for file:// URI resolution */
      rootDir?: string
    }

export type LspExecuteResult = {
  /** LSP method that was called */
  method: string
  /** Successful response payload */
  result?: unknown
  /** Error message if the request failed */
  error?: string
}

export type LspExecuteOutput = {
  mode: 'execute'
  /** Relative path to the analyzed file */
  file: string
  /** Results array matching input requests order */
  results: LspExecuteResult[]
}

export type LspDiscoverOutput = {
  mode: 'discover'
  /** Supported LSP methods from TypeScript 7 API */
  capabilities: Array<{
    /** LSP method name */
    method: string
    /** LSP capability flag name (from TypeScript 7 API) */
    capability: string
  }>
}

export type TypeScriptLspOutput = LspExecuteOutput | LspDiscoverOutput

// ============================================================================
// Schemas
// ============================================================================

const ExecuteModeSchema = {
  type: 'object',
  properties: {
    mode: { type: 'string', const: 'execute', description: 'Execute LSP-style requests against a file' },
    file: { type: 'string', minLength: 1, description: 'Path to a TypeScript/JavaScript file' },
    rootDir: { type: 'string', default: '.', description: 'Workspace root for file:// URI resolution' },
    requests: {
      type: 'array',
      minItems: 1,
      description: 'Requests to execute in a single session',
      items: {
        type: 'object',
        properties: {
          method: { type: 'string', description: 'LSP method name, e.g. textDocument/documentSymbol' },
          params: { description: 'LSP method params' },
        },
        required: ['method'],
        additionalProperties: false,
      },
    },
  },
  required: ['mode', 'file', 'requests'],
  additionalProperties: false,
  description: 'Execute LSP-style requests against a file in a single server session',
} as const

const DiscoverModeSchema = {
  type: 'object',
  properties: {
    mode: { type: 'string', const: 'discover', description: 'Discover available LSP methods supported by the server' },
    rootDir: { type: 'string', default: '.', description: 'Workspace root for file:// URI resolution' },
  },
  required: ['mode'],
  additionalProperties: false,
  description: 'Discover TypeScript 7 API capabilities',
} as const

export const TypeScriptLspInputSchema = {
  oneOf: [ExecuteModeSchema, DiscoverModeSchema],
  description: 'TypeScript LSP tool input',
} as unknown as JSONSchemaType<TypeScriptLspInput>

export const TypeScriptLspOutputSchema = {
  oneOf: [
    {
      type: 'object',
      properties: {
        mode: { type: 'string', const: 'execute' },
        file: { type: 'string', description: 'Relative path to the analyzed file' },
        results: {
          type: 'array',
          description: 'Results array matching input requests order',
          items: {
            type: 'object',
            properties: {
              method: { type: 'string', description: 'LSP method that was called' },
              result: { description: 'Successful response payload' },
              error: { type: 'string', description: 'Error message if the request failed' },
            },
            required: ['method'],
            additionalProperties: false,
          },
        },
      },
      required: ['mode', 'file', 'results'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        mode: { type: 'string', const: 'discover' },
        capabilities: {
          type: 'array',
          description: 'Supported LSP methods from TypeScript 7 API',
          items: {
            type: 'object',
            properties: {
              method: { type: 'string', description: 'LSP method name' },
              capability: { type: 'string', description: 'LSP capability flag name (from TypeScript 7 API)' },
            },
            required: ['method', 'capability'],
            additionalProperties: false,
          },
        },
      },
      required: ['mode', 'capabilities'],
      additionalProperties: false,
    },
  ],
  description: 'TypeScript LSP tool output',
} as unknown as JSONSchemaType<TypeScriptLspOutput>

// ============================================================================
// executeLsp — run requests against a file
// ============================================================================

/**
 * Execute LSP-style requests against a TypeScript/JavaScript file.
 *
 * @remarks
 * Spawns a TypeScript 7 native server, opens the target file, sends each
 * request via the TS 7 API, then stops the server. Each request is
 * independent — if one fails, the others still run.
 */
export const executeLsp = async (
  input: Extract<TypeScriptLspInput, { mode: 'execute' }>,
): Promise<LspExecuteOutput> => {
  const rootDir = resolve(input.rootDir ?? '.')
  const absolutePath = resolveFilePath(input.file, rootDir)

  const file = Bun.file(absolutePath)
  if (!(await file.exists())) {
    throw new Error(`File not found: ${absolutePath}`)
  }

  const api = new API({ cwd: rootDir })

  try {
    const snap = await api.updateSnapshot({ openFiles: [absolutePath] })

    try {
      const results: LspExecuteResult[] = []

      for (const req of input.requests) {
        try {
          const handler = METHOD_HANDLERS[req.method]
          if (!handler) {
            results.push({ method: req.method, error: `Unsupported method: ${req.method}` })
            continue
          }

          const result = await handler({
            snapshot: snap,
            rootDir,
            requestParams: (req.params as Record<string, unknown>) ?? {},
          })
          results.push({ method: req.method, result })
        } catch (error) {
          results.push({
            method: req.method,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      return { mode: 'execute', file: makeDisplayPath(absolutePath, rootDir), results }
    } finally {
      snap.dispose()
    }
  } finally {
    // MINIMAL: fixed 200ms drain so close() does not reject in-flight
    // responses (TS 7.0.2). Upgrade path: poll API connection state if a
    // lifecycle hook ever lands on the unstable API.
    await sleep(200)
    await api.close().catch(() => {})
  }
}

// ============================================================================
// discover — list server capabilities
// ============================================================================

const handleDiscover = async (): Promise<LspDiscoverOutput> => {
  const capabilities = Object.entries(CAPABILITY_TO_METHOD).map(([capability, method]) => ({
    method,
    capability,
  }))

  return { mode: 'discover', capabilities }
}

// ============================================================================
// Tool
// ============================================================================

const runLspMode = async (input: TypeScriptLspInput): Promise<TypeScriptLspOutput> => {
  if (input.mode === 'discover') {
    return handleDiscover()
  }
  return executeLsp(input)
}

/**
 * LSP-style queries over the TypeScript 7 native API — execute mode opens a
 * file and runs LSP method requests (documentSymbol, hover, completion,
 * definition) in a single server session; discover mode lists the supported
 * method→capability mappings.
 */
export const typescriptLsp = useTool(
  {
    name: TYPESCRIPT_LSP_TOOL_NAME,
    description:
      'LSP-style queries over the TypeScript 7 native API. Two modes via the mode discriminant: execute (open a file and run LSP method requests — documentSymbol, hover, completion, definition — in a single server session) and discover (list the supported method→capability mappings). Each request is independent; a failed request becomes an error entry while the others still run.',
    inputSchema: TypeScriptLspInputSchema,
    outputSchema: TypeScriptLspOutputSchema,
  },
  runLspMode,
)

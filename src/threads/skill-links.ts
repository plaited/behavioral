/**
 * The skill-links thread library — the CONTRACT pair of the ICL
 * architecture: extract-links and validate-links as STORED RECIPES
 * (test-pinned semantics replayed verbatim — zero tokens, zero variance;
 * the 2026-09-19 ruling's recipe flavor).
 *
 * Three thread roles, orchestration only:
 * - `seeder` — boot: put both recipes into the store (`skill-recipes`
 *   collection) — recipes-as-tenant, the model/ICL surface (progressive
 *   disclosure: the model reads a recipe from the store when authoring its
 *   own variants).
 * - `dispatcher-extract` / `dispatcher-validate` — a `links_request
 *   { id, recipe, input }` event (model- or host-issued) becomes a
 *   `tool_call` directly: the recipe text rides `stdin` (embedded in the
 *   transform query via JSON.stringify — a valid jq string literal — so the
 *   text is STATIC THREAD DATA, never model context) and the markdown rides
 *   the `env` channel (`LINKS_INPUT`; `LINKS_ROOT_RELATIVE`), the tools
 *   worker's designed per-call input seam. One event in, one tool_call out —
 *   no store round-trip at call time (transforms are memoryless: the recipe
 *   text and the request input never co-occur in a store result, so a
 *   get-then-replay chain cannot carry the input).
 *
 * The recipes transcribe the retired tool's parser: escape-aware inline
 * markdown link extraction (bracket-depth scan, backslash escape skip),
 * inline-HTML <a>/<img> fallbacks, HTMLRewriter over Bun.markdown.html,
 * external/fragment-only drops, normalize+sort+dedupe, and validate-links'
 * cwd resolution with rootRelative semantics. The recipe IS the stdin
 * script (`bun run -` reads its script from stdin), so per-call data arrives
 * via env — markdown in, JSON out.
 *
 * @packageDocumentation
 */

import type { Thread } from '../behavioral/behavioral.types.ts'
import { WORKER_MESSAGE_KINDS } from '../workers/workers.constants.ts'

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** Model-facing request event: one recipe call, one correlation id. */
export const LINKS_EVENT_TYPES = { request: 'links_request' } as const

/** The store collection holding skill recipes (the literal recipe home). */
export const LINKS_RECIPES_COLLECTION = 'skill-recipes'

/** The extract-links recipe's store key. */
export const LINKS_EXTRACT_RECIPE_KEY = 'extract-links'

/** The validate-links recipe's store key. */
export const LINKS_VALIDATE_RECIPE_KEY = 'validate-links'

/** The logical recipe executor names — routes through the tools worker. */
export const SKILL_EXTRACT_LINKS_TOOL = 'skill-extract-links'
export const SKILL_VALIDATE_LINKS_TOOL = 'skill-validate-links'

// ── Shared parser core (transcribed verbatim from the retired tool) ─────────

/** Escape-aware link parsing + collection + normalization — shared by both recipes. */
const PARSER_CORE = `
import * as path from 'node:path'

const normalizeMarkdownLink = (value) => {
  if (
    !value ||
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('mailto:') ||
    value.startsWith('#')
  ) {
    return null
  }
  const linkPath = value.split('#')[0]
  if (!linkPath) return null
  return path.normalize(linkPath)
}

const extractMarkdownLinkDestination = (value) => {
  const trimmedValue = value.trim()
  if (!trimmedValue) return trimmedValue
  if (trimmedValue.startsWith('<')) {
    const closingBracketIndex = trimmedValue.indexOf('>')
    if (closingBracketIndex > 0) return trimmedValue.slice(1, closingBracketIndex)
  }
  const firstWhitespaceIndex = trimmedValue.search(/\\s/)
  if (firstWhitespaceIndex === -1) return trimmedValue
  return trimmedValue.slice(0, firstWhitespaceIndex)
}

const stripHtmlTags = (value) => {
  const textParts = []
  let pendingTag = null
  for (const character of value) {
    if (pendingTag) {
      pendingTag.push(character)
      if (character === '>') pendingTag = null
      continue
    }
    if (character === '<') {
      pendingTag = ['<']
      continue
    }
    textParts.push(character)
  }
  if (pendingTag) textParts.push(...pendingTag)
  return textParts.join('')
}

const isEscapedCharacter = (value, index) => {
  let slashCount = 0
  for (let currentIndex = index - 1; currentIndex >= 0 && value[currentIndex] === '\\\\'; currentIndex -= 1) {
    slashCount += 1
  }
  return slashCount % 2 === 1
}

const findInlineDestinationEnd = (value, startIndex) => {
  for (let index = startIndex; index < value.length; index += 1) {
    const character = value[index]
    if (character === '\\n' || character === '\\r') return -1
    if (value[index] !== ')' || isEscapedCharacter(value, index)) continue
    return index
  }
  return -1
}

const extractInlineMarkdownLinks = (markdownBody) => {
  const links = []
  for (let index = 0; index < markdownBody.length; index += 1) {
    const character = markdownBody[index]
    if (character === undefined) continue
    const startsImageLink = character === '!' && markdownBody[index + 1] === '[' && !isEscapedCharacter(markdownBody, index)
    const startsTextLink = character === '[' && !isEscapedCharacter(markdownBody, index)
    if (!startsImageLink && !startsTextLink) continue
    const openBracketIndex = startsImageLink ? index + 1 : index
    let scanIndex = openBracketIndex + 1
    let bracketDepth = 1
    let closeBracketIndex = -1
    while (scanIndex < markdownBody.length) {
      const scanCharacter = markdownBody[scanIndex]
      if (scanCharacter === undefined) break
      if (scanCharacter === '[' && !isEscapedCharacter(markdownBody, scanIndex)) bracketDepth += 1
      else if (scanCharacter === ']' && !isEscapedCharacter(markdownBody, scanIndex)) {
        bracketDepth -= 1
        if (bracketDepth === 0) {
          closeBracketIndex = scanIndex
          break
        }
      }
      scanIndex += 1
    }
    if (closeBracketIndex === -1) {
      index = openBracketIndex
      continue
    }
    const openParenIndex = closeBracketIndex + 1
    if (markdownBody[openParenIndex] !== '(') {
      index = closeBracketIndex
      continue
    }
    const destinationStartIndex = openParenIndex + 1
    const destinationEndIndex = findInlineDestinationEnd(markdownBody, destinationStartIndex)
    if (destinationEndIndex === -1) {
      index = openParenIndex
      continue
    }
    const destination = markdownBody.slice(destinationStartIndex, destinationEndIndex)
    if (destination.trim().length > 0) {
      links.push({ text: markdownBody.slice(openBracketIndex + 1, closeBracketIndex), destination })
    }
    index = destinationEndIndex
  }
  return links
}

const extractLocalLinksFromMarkdown = async (markdownBody) => {
  const links = new Set()
  const html = Bun.markdown.html(markdownBody)
  const rewriter = new HTMLRewriter()
  const linkTextByTarget = new Map()
  const setText = (target, text) => {
    if (!target || linkTextByTarget.has(target)) return
    linkTextByTarget.set(target, text.trim() || target)
  }
  for (const link of extractInlineMarkdownLinks(markdownBody)) {
    setText(normalizeMarkdownLink(extractMarkdownLinkDestination(link.destination)), link.text)
  }
  const htmlAnchorPattern = /<a\\b[^>]*\\bhref=(['"])(.*?)\\1[^>]*>([\\s\\S]*?)<\\/a>/gi
  for (const match of markdownBody.matchAll(htmlAnchorPattern)) {
    setText(normalizeMarkdownLink(match[2] ?? ''), stripHtmlTags(match[3] ?? ''))
  }
  const htmlImagePattern = /<img\\b[^>]*>/gi
  for (const match of markdownBody.matchAll(htmlImagePattern)) {
    const imageTag = match[0] ?? ''
    const sourceMatch = imageTag.match(/\\bsrc=(['"])(.*?)\\1/i)
    const altMatch = imageTag.match(/\\balt=(['"])(.*?)\\1/i)
    setText(sourceMatch ? normalizeMarkdownLink(sourceMatch[2] ?? '') : null, altMatch?.[2] ?? '')
  }
  for (const selector of ['a', 'img']) {
    rewriter.on(selector, {
      element(element) {
        const attribute = selector === 'a' ? 'href' : 'src'
        const value = element.getAttribute(attribute)
        const normalizedLink = value === null ? null : normalizeMarkdownLink(value)
        if (normalizedLink) links.add(normalizedLink)
      },
    })
  }
  const rewritten = rewriter.transform(html)
  if (typeof rewritten === 'string') void rewritten
  else if (rewritten instanceof Response || rewritten instanceof Blob) await rewritten.text()
  else await new Response(rewritten).text()
  return [...links].sort().map((value) => ({ value, text: linkTextByTarget.get(value) ?? value }))
}
`

// ── The extract-links recipe ─────────────────────────────────────────────────

/** Extract sorted, de-duplicated local links from env-carried markdown — the recipe verbatim. */
export const SKILL_EXTRACT_LINKS_SCRIPT = `
${PARSER_CORE}
const input = process.env.LINKS_INPUT ?? ''
const links = await extractLocalLinksFromMarkdown(input)
console.log(JSON.stringify({ links }))
`

// ── The validate-links recipe ────────────────────────────────────────────────

/** Resolve env-carried markdown's local links against cwd, present/missing — the recipe verbatim. */
export const SKILL_VALIDATE_LINKS_SCRIPT = `
${PARSER_CORE}
const input = process.env.LINKS_INPUT ?? ''
const rootRelative = process.env.LINKS_ROOT_RELATIVE === '1'
const links = await extractLocalLinksFromMarkdown(input)
const present = []
const missing = []
for (const link of links) {
  const linkPath = rootRelative && link.value.startsWith('/') ? link.value.slice(1) : link.value
  const absolutePath = path.resolve(process.cwd(), linkPath)
  if (await Bun.file(absolutePath).exists()) {
    present.push({ value: link.value, text: link.text || link.value })
  } else {
    missing.push({ value: link.value, text: link.text || link.value })
  }
}
const byValueThenText = (left, right) =>
  left.value.localeCompare(right.value) || left.text.localeCompare(right.text)
present.sort(byValueThenText)
missing.sort(byValueThenText)
console.log(JSON.stringify({ present, missing }))
`

// ── Threads ───────────────────────────────────────────────────────────────────

/** seeder — boot (once): both recipes filed in the store; the recipe home exists. */
const linksSeeder: Thread = {
  label: 'skill-links/seeder',
  once: true,
  rules: [
    {
      request: {
        type: WORKER_MESSAGE_KINDS.store_request,
        detail: {
          id: 'seed-extract-links',
          op: 'put',
          input: {
            collection: LINKS_RECIPES_COLLECTION,
            key: LINKS_EXTRACT_RECIPE_KEY,
            value: SKILL_EXTRACT_LINKS_SCRIPT,
          },
        },
      },
    },
    {
      request: {
        type: WORKER_MESSAGE_KINDS.store_request,
        detail: {
          id: 'seed-validate-links',
          op: 'put',
          input: {
            collection: LINKS_RECIPES_COLLECTION,
            key: LINKS_VALIDATE_RECIPE_KEY,
            value: SKILL_VALIDATE_LINKS_SCRIPT,
          },
        },
      },
    },
  ],
}

/** The links_request detail schema — shared by both dispatchers. */
const LINKS_REQUEST_DETAIL_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    recipe: { type: 'string', minLength: 1 },
    input: { type: 'object' },
  },
  required: ['id', 'recipe', 'input'],
} as const

/** dispatcher-extract — links_request becomes the extract tool_call; recipe static, markdown via env. */
const dispatcherExtract: Thread = {
  label: 'skill-links/dispatch-extract',
  rules: [
    {
      transform: [
        {
          type: LINKS_EVENT_TYPES.request,
          query: `. as $d | select($d.recipe == "${LINKS_EXTRACT_RECIPE_KEY}") | {id: $d.id, tool: "${SKILL_EXTRACT_LINKS_TOOL}", input: {script: "bun run -", stdin: ${JSON.stringify(SKILL_EXTRACT_LINKS_SCRIPT)}, format: "json", env: {LINKS_INPUT: $d.input.markdown}}}`,
          target: WORKER_MESSAGE_KINDS.tool_call,
          detailSchema: LINKS_REQUEST_DETAIL_SCHEMA,
        },
      ],
    },
  ],
}

/** dispatcher-validate — links_request becomes the validate tool_call; rootRelative rides env too. */
const dispatcherValidate: Thread = {
  label: 'skill-links/dispatch-validate',
  rules: [
    {
      transform: [
        {
          type: LINKS_EVENT_TYPES.request,
          query: `. as $d | select($d.recipe == "${LINKS_VALIDATE_RECIPE_KEY}") | {id: $d.id, tool: "${SKILL_VALIDATE_LINKS_TOOL}", input: {script: "bun run -", stdin: ${JSON.stringify(SKILL_VALIDATE_LINKS_SCRIPT)}, format: "json", env: {LINKS_INPUT: $d.input.markdown, LINKS_ROOT_RELATIVE: (if ($d.input.rootRelative // false) then "1" else "0" end)}}}`,
          target: WORKER_MESSAGE_KINDS.tool_call,
          detailSchema: LINKS_REQUEST_DETAIL_SCHEMA,
        },
      ],
    },
  ],
}

/** The skill-links thread library — add to the program alongside the satellites. */
export const skillLinksThreads: Thread[] = [linksSeeder, dispatcherExtract, dispatcherValidate]

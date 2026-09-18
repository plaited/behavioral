/// <reference path="../../scripts/types/css-tree.d.ts" />
import type { JSONSchemaType } from 'ajv'
import { parse, walk } from 'css-tree'
import {
  B_META,
  B_SCALE,
  B_TARGET,
  BOOLEAN_ATTRS,
  SCALE,
  SCALE_RANK,
  SWAP_MODES,
  SWAP_TARGETS,
} from '../controller/controller.constants.ts'
import { swapBoundary } from '../controller/swap-boundary.ts'
import { CSSPropertiesSchema, CUSTOM_PROPERTY_REF_PATTERN, validateCSSValue } from './css.schemas.ts'
import { ElementAttributeListSchema, validateAttribute } from './html.schemas.ts'
import {
  type Meta,
  type MetaParseResult,
  MetaSchema,
  type MetaStamp,
  type MetaStatus,
  validateMeta,
} from './meta.schema.ts'
import { ajv, useTool } from './use-tool.ts'

// ── b-meta block parsing (the html carrier's read + validate) ─────────────

/** Parse + validate a serialized b-meta payload (the html carrier's JSON). */
export const parseMeta = (text: string): MetaParseResult => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return {
      ok: false,
      message: `${B_META} block is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!validateMeta(parsed)) {
    return { ok: false, message: `${B_META} block fails the meta schema: ${ajv.errorsText(validateMeta.errors)}` }
  }
  return { ok: true, meta: parsed as Meta }
}

/**
 * Serialize a Meta into the b-meta block payload (the html carrier's JSON).
 * The inverse of `parseMeta` — the round-trip
 * `parseMeta(stringifyMeta(meta))` is the shared-vocabulary invariant both
 * carriers rely on (threads embed the same serialization in
 * `export const meta: BMeta = {...}`).
 */
export const stringifyMeta = (meta: Meta): string => JSON.stringify(meta, null, 2)

/**
 * Extract the first b-meta block's text from a document (the html carrier's
 * read mechanics). A `script[b-meta]` without `type="application/json"` is
 * inert — the same contract `html-validate-and-escape` enforces.
 */
const extractBMetaBlock = (html: string): string | null => {
  let inside = false
  let found: string | null = null
  new HTMLRewriter()
    .on(`script[${B_META}]`, {
      element(el) {
        if (found !== null || el.getAttribute('type') !== 'application/json') return
        inside = true
        el.onEndTag(() => {
          inside = false
        })
      },
      text(chunk) {
        if (inside) found = (found ?? '') + chunk.text
      },
    })
    .transform(html)
  return found
}

/**
 * Pattern for lowercase custom element tags after template tag normalization.
 * Must contain a hyphen (per the custom elements spec) — e.g. `my-widget`, `x-app-root`.
 * @public
 */
export const CUSTOM_ELEMENT_TAG_PATTERN = /^[a-z][.0-9_a-z-]*-[.0-9_a-z-]*$/

/**
 * A Set containing HTML and SVG tag names that are considered "void elements".
 * Void elements cannot have any content (neither HTML nor text nodes) and are
 * represented with a self-closing tag in HTML serialization (e.g., `<br />`, `<img src="..." />`).
 * This set is used during template creation to determine if a closing tag is needed.
 */
export const VOID_TAGS = new Set([
  // HTML void elements per HTML5 spec.
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'menuitem',
  'meta',
  'source',
  'track',
  'wbr',
  // SVG elements treated as self-closing during serialization.
  'circle',
  'ellipse',
  'line',
  'path',
  'polygon',
  'polyline',
  'rect',
  'stop',
  'use',
])

/**
 * One HTML attribute validation violation found in an HTML string.
 *
 * @public
 */
export type HtmlViolation = {
  /** 1-based line number within the input HTML string, when available. */
  line?: number
  /** The element tag name. */
  tag: string
  /** The offending attribute name (when applicable). */
  attribute?: string
  /** Human-readable explanation. */
  message: string
}

/**
 * One invalid CSS declaration found in a `<style>` block.
 *
 * @public
 */
export type CssViolation = {
  /** 1-based line number within the input HTML string. */
  line: number
  /** The CSS property name (e.g. `box-sizing`). */
  property: string
  /** The invalid value as it appears in the source. */
  value: string
  /** Human-readable explanation. */
  message: string
}

// ── Shared scalar types ───────────────────────────────────────────────────

/** A `b-target` selector match operator. `match` defaults to `=`. */
type MatchOp = '=' | '^=' | '~=' | '*='

/** A `SWAP_MODES` value: the insertion/replacement mode of a render. */
type SwapMode = (typeof SWAP_MODES)[keyof typeof SWAP_MODES]

/** A `SCALE` value: the resolved structural scale of a target boundary. */
type ScaleValue = (typeof SCALE)[keyof typeof SCALE]

/** An attribute value as accepted by the attribute tools. */
type AttrValue = string | number | boolean | null

// ── Module-private primitives ─────────────────────────────────────────────
//
// The raw validators run the existing HTMLRewriter / schema passes unchanged
// but return violations as data instead of throwing. The useTool wrappers
// below call these, never the tools, and map the result union to the tool
// output shape. No try/catch is needed for validation flow — a failure is a
// plain `{ ok: false, ... }` value.

const lineNumberOf = (lineBreakOffsets: number[], absoluteOffset: number): number => {
  let line = 1
  for (const offset of lineBreakOffsets) {
    if (absoluteOffset > offset) line++
    else break
  }
  return line
}

type ValidateAndEscapeHtmlResult =
  | { ok: true; html: string }
  | { ok: false; htmlViolations: HtmlViolation[]; cssViolations: CssViolation[] }

/**
 * Validate and sanitize an HTML string — both HTML attributes and CSS inside
 * `<style>` blocks — in a single HTMLRewriter pass, returning violations as data.
 *
 * @returns `{ ok: true, html }` with the escaped markup, or `{ ok: false,
 *   htmlViolations, cssViolations }` carrying every violation in one shot.
 */
const validateAndEscapeHtmlRaw = (html: string): ValidateAndEscapeHtmlResult => {
  const lineBreakOffsets: number[] = []
  for (let i = 0; i < html.length; i++) if (html[i] === '\n') lineBreakOffsets.push(i)

  const htmlViolations: HtmlViolation[] = []
  const cssViolations: CssViolation[] = []
  let currentStyleBlock = ''
  let searchFrom = 0
  // b-meta carrier accumulator — script elements cannot nest, so one slot
  // suffices: element() opens it, text() fills it, onEndTag validates it.
  let bMetaBlock: string | null = null

  const out = new HTMLRewriter()
    .on('*', {
      element(el) {
        const tag = el.tagName
        if (VOID_TAGS.has(tag) && el.canHaveContent) {
          htmlViolations.push({
            tag,
            attribute: '',
            message: `Void element [${tag}] cannot have content`,
          })
        }
        const isKnownTag = tag in (ElementAttributeListSchema.properties as Record<string, unknown>)
        if (!isKnownTag && !CUSTOM_ELEMENT_TAG_PATTERN.test(tag)) {
          htmlViolations.push({
            tag,
            attribute: '',
            message: `Unknown tag [${tag}] is not a known HTML/SVG element or a valid custom element`,
          })
        }
        const names = [...el.attributes].map(([name]) => name)
        for (const name of names) {
          if (name.startsWith('on')) {
            htmlViolations.push({
              tag: el.tagName,
              attribute: name,
              message: `Event handler attributes are not allowed: [${name}]`,
            })
            continue
          }
          const value = el.getAttribute(name) ?? ''
          el.setAttribute(name, value)
          if (!validateAttribute(el.tagName, { [name]: value })) {
            htmlViolations.push({ tag: el.tagName, attribute: name, message: `Invalid value for attribute [${name}]` })
          }
        }
      },
    })
    .on('style', {
      text(chunk) {
        currentStyleBlock += chunk.text
        if (!chunk.lastInTextNode) return
        const block = currentStyleBlock
        currentStyleBlock = ''
        const blockStart = html.indexOf(block, searchFrom)
        searchFrom = blockStart + block.length
        const blockLine = lineNumberOf(lineBreakOffsets, blockStart)
        const ast = parse(block, { positions: true })
        walk(ast, (node) => {
          if (node.type !== 'Declaration') return
          const property = node.property!
          const valueLoc = node.value!.loc
          if (!valueLoc) return
          const value = block.slice(valueLoc.start.offset, valueLoc.end.offset).trim()
          if (property.startsWith('--')) return
          if (!(property in (CSSPropertiesSchema.properties as Record<string, unknown>))) return
          if (!validateCSSValue(property, value) && !CUSTOM_PROPERTY_REF_PATTERN.test(value)) {
            const declLine = node.loc?.start.line ?? 1
            cssViolations.push({
              line: blockLine + declLine - 1,
              property,
              value,
              message: `Invalid value "${value}" for property "${property}"`,
            })
          }
        })
      },
    })
    .on(`script[${B_META}]`, {
      // b-meta carrier: `<script type="application/json" b-meta>` — locate,
      // parse, and validate the embedded BMeta block; violations flow through
      // the existing violation channel. Non-JSON scripts and non-b-meta
      // scripts are inert.
      element(el) {
        if (el.getAttribute('type') !== 'application/json') return
        bMetaBlock = ''
        el.onEndTag(() => {
          const block = bMetaBlock ?? ''
          bMetaBlock = null
          const result = parseMeta(block)
          if (!result.ok) {
            htmlViolations.push({ tag: 'script', attribute: B_META, message: result.message })
          }
        })
      },
      text(chunk) {
        if (bMetaBlock !== null) bMetaBlock += chunk.text
      },
    })
    .transform(html)

  if (htmlViolations.length || cssViolations.length) {
    return { ok: false, htmlViolations, cssViolations }
  }
  return { ok: true, html: out }
}

type ValidateAttributeValueResult = { ok: true } | { ok: false; htmlViolations: HtmlViolation[] }

/**
 * Validate a single attribute value against the per-tag schema and the `on*`
 * inline event handler blocklist, returning violations as data.
 *
 * @returns `{ ok: true }`, or `{ ok: false, htmlViolations }` when the
 *   attribute is an `on*` handler or fails per-tag schema validation.
 */
const validateAttributeValueRaw = ({
  tag,
  attr,
  val,
}: {
  tag: string
  attr: string
  val: AttrValue
}): ValidateAttributeValueResult => {
  if (attr.startsWith('on')) {
    return {
      ok: false,
      htmlViolations: [{ tag, attribute: attr, message: `Event handler attributes are not allowed: [${attr}]` }],
    }
  }
  if (!validateAttribute(tag, { [attr]: val })) {
    return {
      ok: false,
      htmlViolations: [{ tag, attribute: attr, message: `Invalid value for attribute [${attr}]` }],
    }
  }
  return { ok: true }
}

/**
 * Apply one swap-mode insertion to a matching HTMLRewriter element. Each mode
 * maps to a single HTMLRewriter element method, all with `{ html: true }` since
 * the payload is a markup fragment. Mirrors the Controller's `#performSwap`.
 */
const applySwap = ({ element, html, swap }: { element: HTMLRewriterTypes.Element; html: string; swap: SwapMode }) => {
  switch (swap) {
    case SWAP_MODES.innerHTML:
      return element.setInnerContent(html, { html: true })
    case SWAP_MODES.outerHTML:
      return element.replace(html, { html: true })
    case SWAP_MODES.afterbegin:
      return element.prepend(html, { html: true })
    case SWAP_MODES.beforeend:
      return element.append(html, { html: true })
    case SWAP_MODES.beforebegin:
      return element.before(html, { html: true })
    case SWAP_MODES.afterend:
      return element.after(html, { html: true })
  }
}

/**
 * Apply one attribute update to a Bun {@link HTMLRewriter} element, collecting
 * violations instead of throwing. Rules: null + present → removeAttribute;
 * null + absent → no-op; {@link BOOLEAN_ATTRS} member → set bare when absent;
 * otherwise setAttribute (when changed) after validating the value via
 * {@link validateAttributeValueRaw}. On a validation failure the violation is
 * pushed onto `violations` and the attribute mutation is skipped so a failing
 * pass leaves the caller's document unchanged (the wrapper discards the
 * partially-mutated transform and returns the original input html).
 */
const updateAttributes = ({
  element,
  attr,
  val,
  violations,
}: {
  element: HTMLRewriterTypes.Element
  attr: string
  val: AttrValue
  violations: HtmlViolation[]
}): void => {
  if (val === null && element.hasAttribute(attr)) {
    element.removeAttribute(attr)
    return
  }
  if (val === null) return
  if (BOOLEAN_ATTRS.has(attr)) {
    if (!element.hasAttribute(attr)) element.setAttribute(attr, '')
    return
  }
  if (element.getAttribute(attr) !== `${val}`) {
    const result = validateAttributeValueRaw({ tag: element.tagName, attr, val })
    if (!result.ok) {
      violations.push(...result.htmlViolations)
      return
    }
    element.setAttribute(attr, `${val}`)
  }
}

// ── Schemas (shared violation shapes) ─────────────────────────────────────

const htmlViolationSchema = {
  type: 'object',
  properties: {
    line: { type: 'integer', nullable: true, description: '1-based line number within the input, when available' },
    tag: { type: 'string', description: 'the element tag name' },
    attribute: { type: 'string', nullable: true, description: 'the offending attribute name, when applicable' },
    message: { type: 'string', description: 'human-readable explanation' },
  },
  required: ['tag', 'message'],
  additionalProperties: false,
} as unknown as JSONSchemaType<HtmlViolation>

const cssViolationSchema = {
  type: 'object',
  properties: {
    line: { type: 'integer', description: '1-based line number within the input' },
    property: { type: 'string', description: 'the CSS property name (e.g. "box-sizing")' },
    value: { type: 'string', description: 'the invalid value as it appears in the source' },
    message: { type: 'string', description: 'human-readable explanation' },
  },
  required: ['line', 'property', 'value', 'message'],
  additionalProperties: false,
} as unknown as JSONSchemaType<CssViolation>

const swapEnum = ['afterbegin', 'afterend', 'beforebegin', 'beforeend', 'innerHTML', 'outerHTML'] as const
const matchEnum = ['=', '^=', '~=', '*='] as const
const scaleEnum = ['s1', 's2', 's3', 's4', 's5', 's6', 'rel'] as const

const attrValueSchema = {
  anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
} as const

// ── html-validate-and-escape ───────────────────────────────────────────────

type HtmlValidateAndEscapeInput = { html: string }

export const HtmlValidateAndEscapeInputSchema = {
  type: 'object',
  properties: {
    html: {
      type: 'string',
      description: 'the markup string to validate and escape — a full HTML document or a fragment',
    },
  },
  required: ['html'],
  additionalProperties: false,
  description:
    'Validate and escape an HTML markup string — attributes and CSS inside <style> blocks — in a single HTMLRewriter pass. Returns the escaped markup on success, or every HTML/CSS violation at once on failure (no throws).',
} as unknown as JSONSchemaType<HtmlValidateAndEscapeInput>

type HtmlValidateAndEscapeOutput = {
  html: string | null
  isError?: boolean
  message?: string
  htmlViolations?: HtmlViolation[]
  cssViolations?: CssViolation[]
}

export const HtmlValidateAndEscapeOutputSchema = {
  type: 'object',
  properties: {
    html: {
      type: 'string',
      nullable: true,
      description: 'the validated + escaped markup; null on validation failure',
    },
    isError: { type: 'boolean', nullable: true, description: 'true when the input failed validation' },
    message: { type: 'string', nullable: true, description: 'human-readable summary of the validation failure' },
    htmlViolations: {
      type: 'array',
      nullable: true,
      items: htmlViolationSchema,
      description: 'every HTML attribute violation found (tag, attribute, message, optional line)',
    },
    cssViolations: {
      type: 'array',
      nullable: true,
      items: cssViolationSchema,
      description: 'every invalid CSS declaration found (line, property, value, message)',
    },
  },
  required: ['html'],
  additionalProperties: false,
  description:
    'On success: { html } with the escaped markup. On validation failure: { html: null, isError, message, htmlViolations, cssViolations }.',
} as unknown as JSONSchemaType<HtmlValidateAndEscapeOutput>

/**
 * Validate and sanitize an HTML markup string — both HTML attributes and CSS
 * inside `<style>` blocks — in a single HTMLRewriter pass.
 *
 * @remarks
 * Two handlers are chained on one rewriter:
 *
 * 1. `.on('*', { element })` — for every element: (a) block `on*` inline event
 *    handler attributes (security: events must use `b-trigger`); (b) validate
 *    attributes against the per-tag schema via {@link validateAttribute}; (c)
 *    re-serialize every non-`on*` attribute via `setAttribute`, which
 *    normalizes to double-quoted form and escapes `"` (the only character that
 *    can break out of a double-quoted attribute). Idempotent on already-escaped
 *    input — `setAttribute` only escapes `"`, preserving existing
 *    `&amp;`/`&lt;`/`&gt;` entities (no double-escape).
 *
 * 2. `.on('style', { text })` — accumulate each `<style>` block's text chunks,
 *    parse with `css-tree` (correctly handling `@media` queries, `&` nesting,
 *    and line numbers), and validate each declaration's value against
 *    {@link CSSPropertiesSchema}: `--*` custom properties are always valid;
 *    known properties are validated against their per-property schema (with
 *    `var(--…)` references passed through); unknown properties are
 *    browser-handled.
 *
 * All violations are collected and returned as data — never thrown. On failure
 * the output is `{ html: null, isError: true, message, htmlViolations,
 * cssViolations }`; on success `{ html }`.
 */
export const htmlValidateAndEscape = useTool(
  {
    name: 'html-validate-and-escape',
    description:
      'Validate and escape an HTML markup string (attributes + CSS in <style> blocks) in a single pass. Returns the escaped markup, or every HTML/CSS violation at once on failure — no throws.',
    inputSchema: HtmlValidateAndEscapeInputSchema,
    outputSchema: HtmlValidateAndEscapeOutputSchema,
  },
  ({ html }) => {
    const result = validateAndEscapeHtmlRaw(html)
    if (!result.ok) {
      return {
        html: null,
        isError: true,
        message: `${result.htmlViolations.length + result.cssViolations.length} validation violation(s) (${result.htmlViolations.length} HTML, ${result.cssViolations.length} CSS)`,
        htmlViolations: result.htmlViolations,
        cssViolations: result.cssViolations,
      }
    }
    return { html: result.html }
  },
)

// ── html-validate-attribute-value ──────────────────────────────────────────

type HtmlValidateAttributeValueInput = { tag: string; attr: string; val: AttrValue }

export const HtmlValidateAttributeValueInputSchema = {
  type: 'object',
  properties: {
    tag: { type: 'string', description: 'the element tag name (lowercase, e.g. "div", "a")' },
    attr: { type: 'string', description: 'the attribute name to validate' },
    val: { ...attrValueSchema, description: 'the attribute value (string, number, boolean, or null)' },
  },
  required: ['tag', 'attr', 'val'],
  additionalProperties: false,
  description:
    'Validate one attribute value against the per-tag schema and the on* inline event handler blocklist. Substrate-neutral — plain { tag, attr, val }, no DOM or HTMLRewriter element.',
} as unknown as JSONSchemaType<HtmlValidateAttributeValueInput>

type HtmlValidateAttributeValueOutput = {
  valid: boolean | null
  isError?: boolean
  message?: string
  htmlViolations?: HtmlViolation[]
}

export const HtmlValidateAttributeValueOutputSchema = {
  type: 'object',
  properties: {
    valid: { type: 'boolean', nullable: true, description: 'true when the value passes; null on validation failure' },
    isError: { type: 'boolean', nullable: true, description: 'true when the value failed validation' },
    message: { type: 'string', nullable: true, description: 'human-readable summary of the validation failure' },
    htmlViolations: {
      type: 'array',
      nullable: true,
      items: htmlViolationSchema,
      description: 'the HTML attribute violation(s) found (tag, attribute, message)',
    },
  },
  required: ['valid'],
  additionalProperties: false,
  description: 'On success: { valid: true }. On validation failure: { valid: null, isError, message, htmlViolations }.',
} as unknown as JSONSchemaType<HtmlValidateAttributeValueOutput>

/**
 * Validate a single attribute value against the per-tag schema and the `on*`
 * inline event handler blocklist.
 *
 * @remarks
 * Substrate-neutral — takes `{ tag, attr, val }` (plain strings), not a DOM or
 * {@link HTMLRewriter} element. Both the SSR HTMLRewriter-based
 * {@link htmlUpdateAttributes} tool and a b-thread validating a dynamic
 * `attrs` message before sending it to the browser can use this same check.
 *
 * Rules: `on*` attributes are always blocked (security: events must use
 * `b-trigger`); otherwise the value is validated against the per-tag attribute
 * schema. Violations are returned as data — never thrown. On failure the
 * output is `{ valid: null, isError: true, message, htmlViolations }`; on
 * success `{ valid: true }`.
 */
export const htmlValidateAttributeValue = useTool(
  {
    name: 'html-validate-attribute-value',
    description:
      'Validate one attribute value against the per-tag schema and the on* event handler blocklist. Returns { valid: true } or the violation(s) as data — no throws.',
    inputSchema: HtmlValidateAttributeValueInputSchema,
    outputSchema: HtmlValidateAttributeValueOutputSchema,
  },
  ({ tag, attr, val }) => {
    const result = validateAttributeValueRaw({ tag, attr, val })
    if (!result.ok) {
      return {
        valid: null,
        isError: true,
        message: result.htmlViolations[0]?.message ?? `attribute [${attr}] failed validation for tag [${tag}]`,
        htmlViolations: result.htmlViolations,
      }
    }
    return { valid: true }
  },
)

// ── html-render ────────────────────────────────────────────────────────────

type HtmlRenderInput = {
  html: string
  target: string
  fragment: string
  swap: SwapMode
  id: string
  match?: MatchOp
}

export const HtmlRenderInputSchema = {
  type: 'object',
  properties: {
    html: { type: 'string', description: 'the full HTML document' },
    target: { type: 'string', description: 'the b-target value to match' },
    fragment: {
      type: 'string',
      description: 'the markup payload to insert or swap in (validated before the rewriter pass)',
    },
    swap: { type: 'string', enum: swapEnum, description: 'the insertion/replacement mode' },
    id: { type: 'string', description: 'the request id, threaded to the output' },
    match: {
      type: 'string',
      enum: matchEnum,
      nullable: true,
      description: 'attribute selector match operator (default "=")',
    },
  },
  required: ['html', 'target', 'fragment', 'swap', 'id'],
  additionalProperties: false,
  description:
    'Insert or replace content at every element matching the b-target selector. The fragment payload is validated before the pass; on validation failure the document html is returned unchanged.',
} as unknown as JSONSchemaType<HtmlRenderInput>

type HtmlRenderOutput = {
  id: string
  target: string
  html: string
  isError?: boolean
  message?: string
  htmlViolations?: HtmlViolation[]
  cssViolations?: CssViolation[]
}

export const HtmlRenderOutputSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'the request id' },
    target: { type: 'string', description: 'the matched b-target value' },
    html: {
      type: 'string',
      description:
        'the resulting HTML document — the new document on success, or the original input html unchanged on validation failure',
    },
    isError: { type: 'boolean', nullable: true, description: 'true when the fragment payload failed validation' },
    message: { type: 'string', nullable: true, description: 'human-readable summary of the validation failure' },
    htmlViolations: {
      type: 'array',
      nullable: true,
      items: htmlViolationSchema,
      description: 'HTML attribute violations found in the fragment payload',
    },
    cssViolations: {
      type: 'array',
      nullable: true,
      items: cssViolationSchema,
      description: 'CSS declaration violations found in the fragment payload <style> blocks',
    },
  },
  required: ['id', 'target', 'html'],
  additionalProperties: false,
  description:
    'On success: { id, target, html } with the new document. On validation failure: { id, target, html: <original input html>, isError, message, htmlViolations?, cssViolations? }.',
} as unknown as JSONSchemaType<HtmlRenderOutput>

/**
 * Insert or replace content at every element matching the `b-target` selector.
 *
 * @remarks
 * The `fragment` payload is validated via {@link validateAndEscapeHtmlRaw}
 * before the rewriter pass — an invalid payload returns an error with the
 * original input `html` unchanged, even when no `[b-target]` element matches
 * (security: never silently accept a dangerous payload). Targets all matches
 * (mirroring `querySelectorAll`): the `match` operator interpolates into
 * `[b-target${match}"${target}"]`, and `HTMLRewriter.on` fires the handler for
 * every match. Zero matches leaves the document unchanged.
 *
 * The tools are stateless: `html` is both the input document and the output's
 * resulting document. Thread each output `html` back in as the next call's
 * `html` input.
 */
export const htmlRender = useTool(
  {
    name: 'html-render',
    description:
      'Insert or replace content at every element matching a b-target selector. Validates the fragment payload first; returns the new document, or the original document unchanged with violations on failure.',
    inputSchema: HtmlRenderInputSchema,
    outputSchema: HtmlRenderOutputSchema,
  },
  ({ html, target, fragment, swap, id, match = '=' }) => {
    const validated = validateAndEscapeHtmlRaw(fragment)
    if (!validated.ok) {
      return {
        id,
        target,
        html,
        isError: true,
        message: `${validated.htmlViolations.length + validated.cssViolations.length} fragment validation violation(s) (${validated.htmlViolations.length} HTML, ${validated.cssViolations.length} CSS)`,
        htmlViolations: validated.htmlViolations,
        cssViolations: validated.cssViolations,
      }
    }
    const next = new HTMLRewriter()
      .on(`[${B_TARGET}${match}"${target}"]`, {
        element: (element) => {
          applySwap({ element, html: validated.html, swap })
        },
      })
      .transform(html)
    return { id, target, html: next }
  },
)

// ── html-update-attributes ─────────────────────────────────────────────────

type HtmlUpdateAttributesInput = {
  html: string
  target: string
  attr: Record<string, AttrValue>
  id: string
  match?: MatchOp
}

export const HtmlUpdateAttributesInputSchema = {
  type: 'object',
  properties: {
    html: { type: 'string', description: 'the full HTML document' },
    target: { type: 'string', description: 'the b-target value to match' },
    attr: {
      type: 'object',
      additionalProperties: attrValueSchema,
      description:
        'attribute map to merge into every match: null + present → remove; null + absent → no-op; boolean attributes set bare; otherwise the value is validated and set',
    },
    id: { type: 'string', description: 'the request id, threaded to the output' },
    match: {
      type: 'string',
      enum: matchEnum,
      nullable: true,
      description: 'attribute selector match operator (default "=")',
    },
  },
  required: ['html', 'target', 'attr', 'id'],
  additionalProperties: false,
  description:
    'Merge an attribute map into every element matching the b-target selector. Each value is validated before it is applied; on any validation failure the document html is returned unchanged.',
} as unknown as JSONSchemaType<HtmlUpdateAttributesInput>

type HtmlUpdateAttributesOutput = {
  id: string
  target: string
  html: string
  isError?: boolean
  message?: string
  htmlViolations?: HtmlViolation[]
}

export const HtmlUpdateAttributesOutputSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'the request id' },
    target: { type: 'string', description: 'the matched b-target value' },
    html: {
      type: 'string',
      description:
        'the resulting HTML document — the new document on success, or the original input html unchanged on validation failure',
    },
    isError: { type: 'boolean', nullable: true, description: 'true when an attribute value failed validation' },
    message: { type: 'string', nullable: true, description: 'human-readable summary of the validation failure' },
    htmlViolations: {
      type: 'array',
      nullable: true,
      items: htmlViolationSchema,
      description: 'the HTML attribute violation(s) found (tag, attribute, message)',
    },
  },
  required: ['id', 'target', 'html'],
  additionalProperties: false,
  description:
    'On success: { id, target, html } with the new document. On validation failure: { id, target, html: <original input html>, isError, message, htmlViolations }.',
} as unknown as JSONSchemaType<HtmlUpdateAttributesOutput>

/**
 * Merge an attribute map into every element matching the `b-target` selector.
 *
 * @remarks
 * Each attribute value is validated via {@link validateAttributeValueRaw}
 * inside the rewriter callback (the tag is only known there). When a value
 * fails, its violation is collected and that mutation is skipped; if any
 * violation was collected the wrapper discards the partially-mutated transform
 * and returns the original input `html` unchanged (error returns never
 * mutate). Zero matches is a no-op. Rules per {@link updateAttributes}: null +
 * present → removeAttribute; null + absent → no-op; {@link BOOLEAN_ATTRS}
 * member → set bare when absent; otherwise setAttribute after validation.
 *
 * Stateless: `html` is both the input document and the output's resulting
 * document. Thread each output `html` back in as the next call's `html` input.
 */
export const htmlUpdateAttributes = useTool(
  {
    name: 'html-update-attributes',
    description:
      'Merge an attribute map into every element matching a b-target selector. Validates each value first; returns the new document, or the original document unchanged with violations on failure.',
    inputSchema: HtmlUpdateAttributesInputSchema,
    outputSchema: HtmlUpdateAttributesOutputSchema,
  },
  ({ html, target, attr, id, match = '=' }) => {
    const violations: HtmlViolation[] = []
    const next = new HTMLRewriter()
      .on(`[${B_TARGET}${match}"${target}"]`, {
        element: (el) => {
          for (const key in attr) {
            updateAttributes({ element: el, attr: key, val: attr[key] ?? null, violations })
          }
        },
      })
      .transform(html)
    if (violations.length) {
      return {
        id,
        target,
        html,
        isError: true,
        message: `${violations.length} attribute validation violation(s)`,
        htmlViolations: violations,
      }
    }
    return { id, target, html: next }
  },
)

// ── html-scale-check ───────────────────────────────────────────────────────

type HtmlScaleCheckInput = {
  html: string
  target: string
  swap: SwapMode
  id: string
  match?: MatchOp
}

export const HtmlScaleCheckInputSchema = {
  type: 'object',
  properties: {
    html: { type: 'string', description: 'the full HTML document to walk (read-only)' },
    target: { type: 'string', description: 'the b-target value to match' },
    swap: {
      type: 'string',
      enum: swapEnum,
      description: 'the swap mode whose structural boundary to resolve (into vs beside)',
    },
    id: { type: 'string', description: 'the request id, threaded to the output' },
    match: {
      type: 'string',
      enum: matchEnum,
      nullable: true,
      description: 'attribute selector match operator (default "=")',
    },
  },
  required: ['html', 'target', 'swap', 'id'],
  additionalProperties: false,
  description:
    'Pre-flight read: resolve the structural scale context a render into or beside this target would nest inside. Zero matches or no b-scale found anywhere → rel.',
} as unknown as JSONSchemaType<HtmlScaleCheckInput>

type HtmlScaleCheckOutput = { id: string; target: string; effectiveScale: ScaleValue }

export const HtmlScaleCheckOutputSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'the request id' },
    target: { type: 'string', description: 'the matched b-target value' },
    effectiveScale: {
      type: 'string',
      enum: scaleEnum,
      description: 'the most restrictive (lowest-rank) effective scale across all matches, or rel',
    },
  },
  required: ['id', 'target', 'effectiveScale'],
  additionalProperties: false,
  description: 'Read-only result: { id, target, effectiveScale }.',
} as unknown as JSONSchemaType<HtmlScaleCheckOutput>

/**
 * Pre-flight read: resolve the structural scale context a `render` into or
 * beside this `target` would nest inside.
 *
 * @remarks
 * Walks the document `html` with a single read-only `HTMLRewriter` pass,
 * maintaining an open-element stack to track ancestor `b-scale` values. For
 * every `[b-target]` match, resolves the effective structural boundary:
 *
 * - **Into modes** (`afterbegin`, `beforeend`, `innerHTML`): the target IS the
 *   container → read its own `b-scale`; if absent, inherit the nearest
 *   ancestor's.
 * - **Replace/beside modes** (`beforebegin`, `afterend`, `outerHTML`): the
 *   target's PARENT is the container → read the nearest ancestor's `b-scale`
 *   (the target's own scale does not govern).
 *
 * Across multiple matches, returns the **most restrictive** (lowest-rank)
 * effective scale, so a single content blob respects every target's boundary.
 * Zero matches or no `b-scale` found anywhere → `rel` (scale-less,
 * permissive). Advisory only — does not enforce nesting.
 */
export const htmlScaleCheck = useTool(
  {
    name: 'html-scale-check',
    description:
      'Resolve the structural scale a render into or beside a b-target would nest inside. Returns the most restrictive effective scale across matches, or rel.',
    inputSchema: HtmlScaleCheckInputSchema,
    outputSchema: HtmlScaleCheckOutputSchema,
  },
  ({ html, target, swap, id, match = '=' }) => {
    const boundary = swapBoundary(swap)
    const stack: (string | null)[] = []
    const scales: ScaleValue[] = []

    new HTMLRewriter()
      .on('*', {
        element(el) {
          if (el.canHaveContent) {
            stack.push(el.getAttribute(B_SCALE))
            el.onEndTag(() => void stack.pop())
          }
        },
      })
      .on(`[${B_TARGET}${match}"${target}"]`, {
        element(el) {
          const ownScale = el.getAttribute(B_SCALE)
          let scale: string | null = null
          if (boundary === SWAP_TARGETS.self && ownScale) {
            scale = ownScale
          } else {
            const ancestorStart = el.canHaveContent ? stack.length - 2 : stack.length - 1
            for (let i = ancestorStart; i >= 0; i--) {
              const pScale = stack[i]
              if (pScale) {
                scale = pScale
                break
              }
            }
          }
          scales.push((scale ?? SCALE.rel) as ScaleValue)
        },
      })
      .transform(html)

    const effectiveScale: ScaleValue =
      scales.filter((s) => s !== SCALE.rel).sort((a, b) => SCALE_RANK[a] - SCALE_RANK[b])[0] ?? SCALE.rel

    return { id, target, effectiveScale }
  },
)

// ── html-meta-read ─────────────────────────────────────────────────────────

type HtmlMetaReadInput = { html: string }
type HtmlMetaReadOutput = { meta: Meta | null; isError?: boolean; message?: string }

export const HtmlMetaReadInputSchema = {
  type: 'object',
  properties: {
    html: {
      type: 'string',
      description: 'the markup string containing a `<script type="application/json" b-meta>` block',
    },
  },
  required: ['html'],
  additionalProperties: false,
} as unknown as JSONSchemaType<HtmlMetaReadInput>

export const HtmlMetaReadOutputSchema = {
  type: 'object',
  properties: {
    meta: { ...MetaSchema, nullable: true, description: 'the validated BMeta — null on failure' },
    isError: { type: 'boolean', nullable: true, description: 'true when no valid b-meta block exists' },
    message: { type: 'string', nullable: true, description: 'failure detail when isError is true' },
  },
  additionalProperties: false,
} as unknown as JSONSchemaType<HtmlMetaReadOutput>

export const htmlMetaRead = useTool(
  {
    name: 'html-meta-read',
    description:
      'Extract and validate the `<script type="application/json" b-meta>` block from an html artifact, returning the structured BMeta. Errors as data when the document has no block or the block fails the meta schema.',
    inputSchema: HtmlMetaReadInputSchema,
    outputSchema: HtmlMetaReadOutputSchema,
  },
  ({ html }) => {
    const block = extractBMetaBlock(html)
    if (block === null) {
      return { meta: null, isError: true, message: 'no b-meta block found in the document' }
    }
    const result = parseMeta(block)
    if (!result.ok) {
      return { meta: null, isError: true, message: result.message }
    }
    return { meta: result.meta }
  },
)

// ── html-meta-validate ─────────────────────────────────────────────────────

type HtmlMetaValidateInput = { text: string }
type HtmlMetaValidateOutput = { ok: boolean; message?: string }

export const HtmlMetaValidateInputSchema = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: 'the b-meta block content in-hand — the JSON text, not the surrounding document',
    },
  },
  required: ['text'],
  additionalProperties: false,
} as unknown as JSONSchemaType<HtmlMetaValidateInput>

export const HtmlMetaValidateOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'true when the text parses and passes the meta schema' },
    message: { type: 'string', nullable: true, description: 'failure detail when ok is false' },
  },
  required: ['ok'],
  additionalProperties: false,
} as unknown as JSONSchemaType<HtmlMetaValidateOutput>

export const htmlMetaValidate = useTool(
  {
    name: 'html-meta-validate',
    description:
      'Validate b-meta block content held in-hand (the JSON text, not a document) against the shared Meta schema. A failed validation is data ({ ok: false, message }), not an error — for whole-document validation including the b-meta block, use html-validate-and-escape.',
    inputSchema: HtmlMetaValidateInputSchema,
    outputSchema: HtmlMetaValidateOutputSchema,
  },
  ({ text }) => {
    const result = parseMeta(text)
    return result.ok ? { ok: true } : { ok: false, message: result.message }
  },
)

// ── html-meta-stamp ────────────────────────────────────────────────────────

type HtmlMetaStampInput = { html: string; stamp: MetaStamp; status?: MetaStatus }
type HtmlMetaStampOutput = { html: string | null; isError?: boolean; message?: string }

export const HtmlMetaStampInputSchema = {
  type: 'object',
  properties: {
    html: { type: 'string', description: 'the markup string containing the b-meta block to stamp' },
    stamp: {
      type: 'object',
      properties: {
        by: { type: 'string', minLength: 1, description: 'what stamped it — a tool, model, or turn id' },
        at: { type: 'string', minLength: 1, description: 'ISO timestamp of the stamp' },
      },
      required: ['by', 'at'],
      additionalProperties: false,
    },
    status: {
      type: 'string',
      enum: ['draft', 'stable', 'deprecated'],
      nullable: true,
      description: 'optional lifecycle transition to apply with the stamp',
    },
  },
  required: ['html', 'stamp'],
  additionalProperties: false,
} as unknown as JSONSchemaType<HtmlMetaStampInput>

export const HtmlMetaStampOutputSchema = {
  type: 'object',
  properties: {
    html: { type: 'string', nullable: true, description: 'the stamped document — the original on failure' },
    isError: { type: 'boolean', nullable: true },
    message: { type: 'string', nullable: true, description: 'failure detail when isError is true' },
  },
  additionalProperties: false,
} as unknown as JSONSchemaType<HtmlMetaStampOutput>

export const htmlMetaStamp = useTool(
  {
    name: 'html-meta-stamp',
    description:
      'Stamp the b-meta block of an html artifact in place: append a verified keep-decision (the promotion ladder) and optionally transition status. Reads, validates, merges, and surgically replaces the block; returns the updated document, or the original with isError on failure.',
    inputSchema: HtmlMetaStampInputSchema,
    outputSchema: HtmlMetaStampOutputSchema,
  },
  ({ html, stamp, status }) => {
    const block = extractBMetaBlock(html)
    if (block === null) {
      return { html, isError: true, message: 'no b-meta block found in the document' }
    }
    const result = parseMeta(block)
    if (!result.ok) {
      return { html, isError: true, message: result.message }
    }
    const stamped: Meta = {
      ...result.meta,
      verified: [...(result.meta.verified ?? []), stamp],
      ...(status === undefined ? {} : { status }),
    }
    // `</` in the serialized JSON (e.g. a title containing `</script>`) would
    // close the block early — `\/` is a valid JSON escape the parser unescapes.
    const serialized = stringifyMeta(stamped).replace(/<\//g, '<\\/')
    const nextBlock = `<script type="application/json" ${B_META}>\n${serialized}\n</script>`
    let replaced = false
    const next = new HTMLRewriter()
      .on(`script[${B_META}]`, {
        element(el) {
          if (replaced || el.getAttribute('type') !== 'application/json') return
          replaced = true
          el.before(nextBlock, { html: true })
          el.remove()
        },
      })
      .transform(html)
    return { html: next }
  },
)

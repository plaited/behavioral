import { describe, expect, test } from 'bun:test'
import { B_SCALE, B_TARGET, SCALE, SWAP_MODES } from '../../controller/controller.constants.ts'
import {
  htmlMetaRead,
  htmlMetaStamp,
  htmlMetaValidate,
  htmlRender,
  htmlScaleCheck,
  htmlUpdateAttributes,
  htmlValidateAndEscape,
  htmlValidateAttributeValue,
  parseMeta,
  stringifyMeta,
} from '../html.ts'
import type { Meta } from '../meta.schema.ts'
import { MetaSchema } from '../meta.schema.ts'
import { ajv } from '../use-tool.ts'

// ── html-validate-and-escape ──────────────────────────────────────────────

describe('htmlValidateAndEscape — happy path', () => {
  test('valid HTML with no on* handlers returns the HTML unchanged', async () => {
    const html = `<div class="card"><p>hello &amp; world</p></div>`
    const result = await htmlValidateAndEscape({ html })
    expect(result.isError).toBeFalsy()
    expect(result.html).toBe(html)
  })
})

describe('htmlValidateAndEscape — on* security', () => {
  test('on* attribute returns isError with tag and attribute', async () => {
    const result = await htmlValidateAndEscape({ html: `<div onclick="alert(1)">x</div>` })
    expect(result.isError).toBe(true)
    expect(result.htmlViolations).toHaveLength(1)
    expect(result.htmlViolations![0]).toMatchObject({ tag: 'div', attribute: 'onclick' })
    expect(result.htmlViolations![0]!.message).toContain('onclick')
  })

  test('data-on is NOT an on* handler (allowed); on-foo IS blocked (starts with on)', async () => {
    const ok = await htmlValidateAndEscape({ html: `<div data-on="keep">x</div>` })
    expect(ok.isError).toBeFalsy()
    expect(ok.html).toBe(`<div data-on="keep">x</div>`)

    const blocked = await htmlValidateAndEscape({ html: `<div on-foo="bar">x</div>` })
    expect(blocked.isError).toBe(true)
    expect(blocked.htmlViolations![0]!.attribute).toBe('on-foo')
  })
})

describe('htmlValidateAndEscape — schema validation', () => {
  test('schema-invalid attribute value returns isError', async () => {
    const result = await htmlValidateAndEscape({ html: `<a href="#" target="_invalid">link</a>` })
    expect(result.isError).toBe(true)
    expect(result.htmlViolations).toHaveLength(1)
    expect(result.htmlViolations![0]).toMatchObject({ tag: 'a', attribute: 'target' })
  })

  test('schema-valid enum value does not error', async () => {
    expect((await htmlValidateAndEscape({ html: `<a href="#" target="_blank">link</a>` })).isError).toBeFalsy()
    expect((await htmlValidateAndEscape({ html: `<input type="text" />` })).isError).toBeFalsy()
  })
})

describe('htmlValidateAndEscape — aggregate violations', () => {
  test('collects violations across multiple elements', async () => {
    const result = await htmlValidateAndEscape({ html: `<div onclick="a()"><a target="_bad">x</a></div>` })
    expect(result.isError).toBe(true)
    expect(result.htmlViolations).toHaveLength(2)
    const attrs = result.htmlViolations!.map((e) => e.attribute).sort()
    expect(attrs).toEqual(['onclick', 'target'])
    expect(result.htmlViolations!.some((e) => e.tag === 'div' && e.attribute === 'onclick')).toBe(true)
    expect(result.htmlViolations!.some((e) => e.tag === 'a' && e.attribute === 'target')).toBe(true)
  })
})

describe('htmlValidateAndEscape — b-meta carrier', () => {
  const validMeta = {
    type: 'html',
    title: 'Space briefing',
    description: 'Shared context about the space',
    generated: { by: 'turn-42', at: '2026-09-17T00:00:00Z' },
    status: 'stable',
  }

  test('a well-formed b-meta JSON script in head passes and its content is preserved', async () => {
    const html =
      `<html><head><script type="application/json" b-meta>${JSON.stringify(validMeta)}</script></head>` +
      '<body><p>x</p></body></html>'
    const result = await htmlValidateAndEscape({ html })
    expect(result.isError).toBeFalsy()
    expect(result.html).toContain('"title":"Space briefing"')
  })

  test('malformed JSON in a b-meta block → violation on script/b-meta', async () => {
    const html = `<head><script type="application/json" b-meta>{ not json }</script></head>`
    const result = await htmlValidateAndEscape({ html })
    expect(result.isError).toBe(true)
    expect(result.htmlViolations).toHaveLength(1)
    expect(result.htmlViolations![0]).toMatchObject({ tag: 'script', attribute: 'b-meta' })
    expect(result.htmlViolations![0]!.message).toContain('JSON')
  })

  test('schema-invalid b-meta blocks → violations (missing required, unknown field, bad status)', async () => {
    const cases = [
      // missing title/description/generated/status
      { type: 'html' },
      // unknown field (additionalProperties: false)
      { ...validMeta, apiKey: 'sk-secret' },
      // status outside the enum
      { ...validMeta, status: 'published' },
    ]
    for (const meta of cases) {
      const html = `<head><script type="application/json" b-meta>${JSON.stringify(meta)}</script></head>`
      const result = await htmlValidateAndEscape({ html })
      expect(result.isError).toBe(true)
      expect(result.htmlViolations).toHaveLength(1)
      expect(result.htmlViolations![0]).toMatchObject({ tag: 'script', attribute: 'b-meta' })
    }
  })

  test('empty b-meta block → violation', async () => {
    const html = `<head><script type="application/json" b-meta></script></head>`
    const result = await htmlValidateAndEscape({ html })
    expect(result.isError).toBe(true)
    expect(result.htmlViolations![0]).toMatchObject({ tag: 'script', attribute: 'b-meta' })
  })

  test('a script[type=application/json] without b-meta is inert (not validated)', async () => {
    const html = `<head><script type="application/json">{"arbitrary":true}</script></head>`
    const result = await htmlValidateAndEscape({ html })
    expect(result.isError).toBeFalsy()
    expect(result.html).toContain('"arbitrary":true')
  })

  test('b-meta attribute is a valid attribute on script (b-* vocabulary)', async () => {
    // the bare b-meta attribute must not trip the per-tag attribute schema
    const result = await htmlValidateAndEscape({ html: '<head><script b-meta></script></head>' })
    expect(result.isError).toBeFalsy()
    expect(result.htmlViolations).toBeUndefined()
  })
})

describe('htmlValidateAndEscape — text not escaped', () => {
  test('text entities are preserved (no double-escaping)', async () => {
    const html = `<p>Tom &amp; Jerry &lt;raw&gt;</p>`
    expect((await htmlValidateAndEscape({ html })).html).toBe(html)
  })
})

describe('htmlValidateAndEscape — element coverage', () => {
  test('void and nested elements are validated; valid void HTML passes unchanged', async () => {
    const html = `<div><img src="x.png" alt="pic" /><br /><span>ok</span></div>`
    expect((await htmlValidateAndEscape({ html })).html).toBe(html)
  })

  test('on* on a void element is caught', async () => {
    const result = await htmlValidateAndEscape({ html: `<img src="x" onerror="alert(1)" />` })
    expect(result.isError).toBe(true)
    expect(result.htmlViolations![0]).toMatchObject({ tag: 'img', attribute: 'onerror' })
  })
})

describe('htmlValidateAndEscape — attribute escape', () => {
  test('quote-breakout in a single-quoted attribute is neutralized', async () => {
    const html = `<div class='" onmouseover="alert(1)'>x</div>`
    const result = await htmlValidateAndEscape({ html })
    expect(result.isError).toBeFalsy()
    expect(result.html).toContain('class="')
    expect(result.html).not.toMatch(/onmouseover=alert/i)
    expect(result.html).toContain('&quot; onmouseover=&quot;alert(1)')
  })

  test('already-escaped attribute entities are preserved (no double-escape)', async () => {
    const html = `<div class="a &amp; b" data-x="&lt;raw&gt;">hi</div>`
    expect((await htmlValidateAndEscape({ html })).html).toBe(html)
  })
})

describe('htmlValidateAndEscape — combined HTML + CSS violations', () => {
  test('document with both HTML attribute and CSS violations returns both bags', async () => {
    const html = [
      `<html><head>`,
      `<style>.a { box-sizing: mah-box; }</style>`,
      `</head><body>`,
      `<div onclick="alert(1)">x</div>`,
      `</body></html>`,
    ].join('\n')
    const result = await htmlValidateAndEscape({ html })
    expect(result.isError).toBe(true)
    expect(result.htmlViolations).toHaveLength(1)
    expect(result.htmlViolations![0]).toMatchObject({ tag: 'div', attribute: 'onclick' })
    expect(result.cssViolations).toHaveLength(1)
    expect(result.cssViolations![0]).toMatchObject({ property: 'box-sizing', value: 'mah-box' })
  })
})

describe('htmlValidateAndEscape — CSS validation', () => {
  test('HTML with no <style> block does not error', async () => {
    expect((await htmlValidateAndEscape({ html: '<html><body><p>hi</p></body></html>' })).isError).toBeFalsy()
  })

  test('valid known declarations do not error', async () => {
    const html = `<style>.a { color: red; box-sizing: content-box; flex-direction: row; }</style>`
    expect((await htmlValidateAndEscape({ html })).html).toBe(html)
  })

  test('var() reference on an enum property does not error', async () => {
    const html = `<style>.a { box-sizing: var(--bs); flex-direction: var( --fd ); }</style>`
    expect((await htmlValidateAndEscape({ html })).html).toBe(html)
  })

  test('custom property --* declarations do not error', async () => {
    const html = `<style>.a { --my-var: 10px; --color: red; }</style>`
    expect((await htmlValidateAndEscape({ html })).html).toBe(html)
  })

  test('unknown property names are browser-handled (no error)', async () => {
    const html = `<style>.a { colr: red; -x-unknown: 1px; }</style>`
    expect((await htmlValidateAndEscape({ html })).html).toBe(html)
  })

  test('invalid enum value returns isError with line, property, value', async () => {
    const result = await htmlValidateAndEscape({ html: `<style>.a { box-sizing: mah-box; }</style>` })
    expect(result.isError).toBe(true)
    expect(result.cssViolations).toHaveLength(1)
    expect(result.cssViolations![0]).toMatchObject({ property: 'box-sizing', value: 'mah-box' })
    expect(result.cssViolations![0]!.line).toBe(1)
    expect(result.cssViolations![0]!.message).toContain('box-sizing')
  })

  test('@media prelude is not mistaken for a declaration; inner decl is validated', async () => {
    const html = `<style>
@media (max-width: 600px) {
  .a { flex-direction: sideways; }
}
</style>`
    const result = await htmlValidateAndEscape({ html })
    expect(result.isError).toBe(true)
    expect(result.cssViolations).toHaveLength(1)
    expect(result.cssViolations![0]).toMatchObject({ property: 'flex-direction', value: 'sideways' })
    expect(result.cssViolations!.some((e) => e.property === 'max-width')).toBe(false)
  })

  test('collects all invalid CSS declarations, not just the first', async () => {
    const result = await htmlValidateAndEscape({
      html: `<style>.a { box-sizing: mah-box; flex-direction: sideways; }</style>`,
    })
    expect(result.isError).toBe(true)
    expect(result.cssViolations).toHaveLength(2)
    expect(result.cssViolations!.map((e) => e.property).sort()).toEqual(['box-sizing', 'flex-direction'])
  })

  test('line numbers are absolute across multiple lines and style blocks', async () => {
    const html = [
      `<html><head>`,
      `<style>.a { box-sizing: bad; }</style>`,
      `<style>`,
      `@media (min-width: 1px) {`,
      `  .b { flex-direction: sideways; }`,
      `}`,
      `</style>`,
      `</head></html>`,
    ].join('\n')
    const result = await htmlValidateAndEscape({ html })
    expect(result.isError).toBe(true)
    expect(result.cssViolations).toHaveLength(2)
    const boxErr = result.cssViolations!.find((e) => e.property === 'box-sizing')!
    const flexErr = result.cssViolations!.find((e) => e.property === 'flex-direction')!
    expect(boxErr.line).toBe(2)
    expect(flexErr.line).toBe(5)
  })

  test('& nesting: declarations inside & selectors are validated', async () => {
    const html = [
      `<style>`,
      `.container {`,
      `  display: flex;`,
      `  & .card { box-sizing: mah-box; }`,
      `}`,
      `</style>`,
    ].join('\n')
    const result = await htmlValidateAndEscape({ html })
    expect(result.isError).toBe(true)
    expect(result.cssViolations).toHaveLength(1)
    expect(result.cssViolations![0]).toMatchObject({ property: 'box-sizing', value: 'mah-box' })
    expect(result.cssViolations!.some((e) => e.property === 'display')).toBe(false)
  })

  test('empty <style> and @media with no declarations do not error', async () => {
    const html = `<style></style><style>@media (max-width: 600px) {}</style>`
    expect((await htmlValidateAndEscape({ html })).isError).toBeFalsy()
  })
})

describe('htmlValidateAndEscape — constructor-equivalent validation', () => {
  test('on* attribute in input returns isError', async () => {
    const result = await htmlValidateAndEscape({ html: `<div onclick="alert(1)">x</div>` })
    expect(result.isError).toBe(true)
  })

  test('escapes attributes in input — quote-breakout neutralized', async () => {
    const result = await htmlValidateAndEscape({ html: `<div class='"breakout'>x</div>` })
    expect(result.isError).toBeFalsy()
    expect(result.html).toContain('&quot;')
    expect(result.html).not.toMatch(/onclick|onerror/i)
  })
})

// ── html-validate-attribute-value ─────────────────────────────────────────

describe('htmlValidateAttributeValue — on* security', () => {
  test('on* attribute returns isError', async () => {
    const result = await htmlValidateAttributeValue({ tag: 'div', attr: 'onclick', val: 'alert(1)' })
    expect(result.isError).toBe(true)
    expect(result.htmlViolations![0]).toMatchObject({ tag: 'div', attribute: 'onclick' })
  })
})

describe('htmlValidateAttributeValue — schema validation', () => {
  test('valid b-scale value returns { valid: true }', async () => {
    const result = await htmlValidateAttributeValue({ tag: 'div', attr: 'b-scale', val: 's3' })
    expect(result.isError).toBeFalsy()
    expect(result.valid).toBe(true)
  })

  test('invalid b-scale value returns isError', async () => {
    const result = await htmlValidateAttributeValue({ tag: 'div', attr: 'b-scale', val: 's99' })
    expect(result.isError).toBe(true)
    expect(result.htmlViolations![0]).toMatchObject({ tag: 'div', attribute: 'b-scale' })
  })
})

// ── html-render ───────────────────────────────────────────────────────────

describe('htmlRender — swap modes', () => {
  test('innerHTML replaces inner content', async () => {
    const result = await htmlRender({
      html: `<div ${B_TARGET}="t">old</div>`,
      target: 't',
      fragment: '<b>new</b>',
      swap: SWAP_MODES.innerHTML,
      id: '1',
    })
    expect(result.isError).toBeFalsy()
    expect(result.html).toBe(`<div ${B_TARGET}="t"><b>new</b></div>`)
  })

  test('outerHTML replaces the element', async () => {
    const result = await htmlRender({
      html: `<p>x</p><div ${B_TARGET}="t">old</div><p>y</p>`,
      target: 't',
      fragment: `<b>new</b>`,
      swap: SWAP_MODES.outerHTML,
      id: '1',
    })
    expect(result.html).toBe(`<p>x</p><b>new</b><p>y</p>`)
  })

  test('afterbegin inserts at start of inner content', async () => {
    const result = await htmlRender({
      html: `<div ${B_TARGET}="t">old</div>`,
      target: 't',
      fragment: `<b>first</b>`,
      swap: SWAP_MODES.afterbegin,
      id: '1',
    })
    expect(result.html).toBe(`<div ${B_TARGET}="t"><b>first</b>old</div>`)
  })

  test('beforeend inserts at end of inner content', async () => {
    const result = await htmlRender({
      html: `<div ${B_TARGET}="t">old</div>`,
      target: 't',
      fragment: `<b>last</b>`,
      swap: SWAP_MODES.beforeend,
      id: '1',
    })
    expect(result.html).toBe(`<div ${B_TARGET}="t">old<b>last</b></div>`)
  })

  test('beforebegin inserts before the element', async () => {
    const result = await htmlRender({
      html: `<div ${B_TARGET}="t">old</div>`,
      target: 't',
      fragment: `<b>before</b>`,
      swap: SWAP_MODES.beforebegin,
      id: '1',
    })
    expect(result.html).toBe(`<b>before</b><div ${B_TARGET}="t">old</div>`)
  })

  test('afterend inserts after the element', async () => {
    const result = await htmlRender({
      html: `<div ${B_TARGET}="t">old</div>`,
      target: 't',
      fragment: `<b>after</b>`,
      swap: SWAP_MODES.afterend,
      id: '1',
    })
    expect(result.html).toBe(`<div ${B_TARGET}="t">old</div><b>after</b>`)
  })
})

describe('htmlRender — all-matches targeting', () => {
  test('two elements with the same b-target both get swapped', async () => {
    const result = await htmlRender({
      html: `<div ${B_TARGET}="t">a</div><div ${B_TARGET}="t">b</div>`,
      target: 't',
      fragment: 'x',
      swap: SWAP_MODES.innerHTML,
      id: '1',
    })
    expect(result.html).toBe(`<div ${B_TARGET}="t">x</div><div ${B_TARGET}="t">x</div>`)
  })
})

describe('htmlRender — match param', () => {
  test("default match ('=') requires exact value", async () => {
    const result = await htmlRender({
      html: `<div ${B_TARGET}="user">x</div><div ${B_TARGET}="user-name">y</div>`,
      target: 'user',
      fragment: 'z',
      swap: SWAP_MODES.innerHTML,
      id: '1',
    })
    expect(result.html).toBe(`<div ${B_TARGET}="user">z</div><div ${B_TARGET}="user-name">y</div>`)
  })

  test("match='^=' fills user-name and user-email but not other", async () => {
    const result = await htmlRender({
      html: `<div ${B_TARGET}="greeting">old</div><span ${B_TARGET}="user-name">name</span><span ${B_TARGET}="user-email">email</span><span ${B_TARGET}="other">keep</span>`,
      target: 'user',
      fragment: 'filled',
      match: '^=',
      swap: SWAP_MODES.innerHTML,
      id: '1',
    })
    expect(result.html).toContain(`<span ${B_TARGET}="user-name">filled</span>`)
    expect(result.html).toContain(`<span ${B_TARGET}="user-email">filled</span>`)
    expect(result.html).toContain(`<span ${B_TARGET}="other">keep</span>`)
  })

  test("match='*=' substring matches", async () => {
    const result = await htmlRender({
      html: `<div ${B_TARGET}="alpha">a</div><div ${B_TARGET}="zeta">z</div>`,
      target: 'lph',
      fragment: 'x',
      match: '*=',
      swap: SWAP_MODES.innerHTML,
      id: '1',
    })
    expect(result.html).toBe(`<div ${B_TARGET}="alpha">x</div><div ${B_TARGET}="zeta">z</div>`)
  })

  test("match='~=' space-list matches one of space-separated tokens", async () => {
    const result = await htmlRender({
      html: `<div ${B_TARGET}="a b c">x</div><div ${B_TARGET}="bc">y</div>`,
      target: 'b',
      fragment: 'z',
      match: '~=',
      swap: SWAP_MODES.innerHTML,
      id: '1',
    })
    expect(result.html).toBe(`<div ${B_TARGET}="a b c">z</div><div ${B_TARGET}="bc">y</div>`)
  })

  test('zero matches is a no-op — html unchanged, returns { id, target, html }', async () => {
    const html = `<div ${B_TARGET}="t">keep</div>`
    const result = await htmlRender({ html, target: 'nope', fragment: 'x', swap: SWAP_MODES.innerHTML, id: '1' })
    expect(result.isError).toBeFalsy()
    expect(result.html).toBe(html)
    expect(result).toEqual({ id: '1', target: 'nope', html })
  })
})

describe('htmlRender — output shape', () => {
  test('render returns { id, target, html } carrying the new state', async () => {
    const result = await htmlRender({
      html: `<div ${B_TARGET}="t">old</div>`,
      target: 't',
      fragment: 'new',
      swap: SWAP_MODES.innerHTML,
      id: 'i1',
    })
    expect(result).toEqual({ id: 'i1', target: 't', html: `<div ${B_TARGET}="t">new</div>` })
  })
})

describe('htmlRender — stateless threading', () => {
  test('a render → attrs → render sequence threads each output html into the next', async () => {
    let html = `<div ${B_TARGET}="t"></div>`
    html = (
      await htmlRender({ html, target: 't', fragment: '<span>first</span>', swap: SWAP_MODES.innerHTML, id: '1' })
    ).html
    html = (await htmlUpdateAttributes({ html, target: 't', attr: { 'data-n': '1' }, id: '2' })).html
    const result = await htmlRender({
      html,
      target: 't',
      fragment: '<b>second</b>',
      swap: SWAP_MODES.beforeend,
      id: '3',
    })
    expect(result.html).toBe(`<div ${B_TARGET}="t" data-n="1"><span>first</span><b>second</b></div>`)
  })
})

describe('htmlRender — no stylesheet handling', () => {
  test('render does not touch a <style> in the document html', async () => {
    const result = await htmlRender({
      html: `<style>.x{color:red}</style><div ${B_TARGET}="t">old</div>`,
      target: 't',
      fragment: 'new',
      swap: SWAP_MODES.innerHTML,
      id: '1',
    })
    expect(result.html).toBe(`<style>.x{color:red}</style><div ${B_TARGET}="t">new</div>`)
  })
})

describe('htmlRender — payload (fragment) validation', () => {
  test('on* attribute in fragment returns isError and leaves the document html unchanged', async () => {
    const html = `<div ${B_TARGET}="t">old</div>`
    const result = await htmlRender({
      html,
      target: 't',
      fragment: `<div onclick="alert(1)">x</div>`,
      swap: SWAP_MODES.innerHTML,
      id: '1',
    })
    expect(result.isError).toBe(true)
    expect(result.html).toBe(html)
  })

  test('fragment is validated even when no b-target matches', async () => {
    const html = `<div ${B_TARGET}="t">old</div>`
    const result = await htmlRender({
      html,
      target: 'nope',
      fragment: `<div onclick="alert(1)">x</div>`,
      swap: SWAP_MODES.innerHTML,
      id: '1',
    })
    expect(result.isError).toBe(true)
  })

  test('quote-breakout in fragment attributes is neutralized', async () => {
    const result = await htmlRender({
      html: `<div ${B_TARGET}="t">old</div>`,
      target: 't',
      fragment: `<b class='"breakout'>new</b>`,
      swap: SWAP_MODES.innerHTML,
      id: '1',
    })
    expect(result.isError).toBeFalsy()
    expect(result.html).toContain('&quot;')
    expect(result.html).not.toMatch(/onclick|onerror/i)
  })

  test('validates CSS in fragment <style> blocks', async () => {
    const result = await htmlRender({
      html: `<div ${B_TARGET}="t">old</div>`,
      target: 't',
      fragment: `<style>.a { box-sizing: mah-box; }</style>new`,
      swap: SWAP_MODES.innerHTML,
      id: '1',
    })
    expect(result.isError).toBe(true)
  })
})

// ── html-update-attributes ────────────────────────────────────────────────

describe('htmlUpdateAttributes — updateAttributes rules', () => {
  test('string set', async () => {
    const result = await htmlUpdateAttributes({
      html: `<div ${B_TARGET}="t" data-x="old"></div>`,
      target: 't',
      attr: { 'data-x': 'new' },
      id: '1',
    })
    expect(result.isError).toBeFalsy()
    expect(result.html).toBe(`<div ${B_TARGET}="t" data-x="new"></div>`)
  })

  test('null + present → removeAttribute', async () => {
    const result = await htmlUpdateAttributes({
      html: `<div ${B_TARGET}="t" data-x="old"></div>`,
      target: 't',
      attr: { 'data-x': null },
      id: '1',
    })
    expect(result.html).toBe(`<div ${B_TARGET}="t"></div>`)
  })

  test('null + absent → no-op', async () => {
    const html = `<div ${B_TARGET}="t"></div>`
    const result = await htmlUpdateAttributes({ html, target: 't', attr: { 'data-x': null }, id: '1' })
    expect(result.html).toBe(html)
  })

  test('BOOLEAN_ATTRS → set bare (present when absent)', async () => {
    const result = await htmlUpdateAttributes({
      html: `<input ${B_TARGET}="t"/>`,
      target: 't',
      attr: { disabled: true },
      id: '1',
    })
    expect(result.html).toBe(`<input ${B_TARGET}="t" disabled="" />`)
  })

  test('number coerced to string', async () => {
    const result = await htmlUpdateAttributes({
      html: `<div ${B_TARGET}="t"></div>`,
      target: 't',
      attr: { 'data-n': 5 },
      id: '1',
    })
    expect(result.html).toBe(`<div ${B_TARGET}="t" data-n="5"></div>`)
  })

  test('all-matches: same b-target on multiple elements → all updated', async () => {
    const result = await htmlUpdateAttributes({
      html: `<div ${B_TARGET}="t"></div><div ${B_TARGET}="t"></div>`,
      target: 't',
      attr: { 'data-n': '1' },
      id: '1',
    })
    expect(result.html).toBe(`<div ${B_TARGET}="t" data-n="1"></div><div ${B_TARGET}="t" data-n="1"></div>`)
  })

  test('match param on attrs (^=)', async () => {
    const result = await htmlUpdateAttributes({
      html: `<span ${B_TARGET}="user-name">name</span><span ${B_TARGET}="user-email">email</span><span ${B_TARGET}="other">keep</span>`,
      target: 'user',
      match: '^=',
      attr: { 'data-set': '1' },
      id: '1',
    })
    expect(result.html).toContain(`<span ${B_TARGET}="user-name" data-set="1">name</span>`)
    expect(result.html).toContain(`<span ${B_TARGET}="user-email" data-set="1">email</span>`)
    expect(result.html).toContain(`<span ${B_TARGET}="other">keep</span>`)
  })

  test('zero matches is a no-op — html unchanged, returns { id, target, html }', async () => {
    const html = `<div ${B_TARGET}="t">keep</div>`
    const result = await htmlUpdateAttributes({ html, target: 'nope', attr: { 'data-x': '1' }, id: '1' })
    expect(result.isError).toBeFalsy()
    expect(result.html).toBe(html)
    expect(result).toEqual({ id: '1', target: 'nope', html })
  })
})

describe('htmlUpdateAttributes — output shape', () => {
  test('attrs returns { id, target, html } carrying the new state', async () => {
    const result = await htmlUpdateAttributes({
      html: `<div ${B_TARGET}="t"></div>`,
      target: 't',
      attr: { 'data-n': 9 },
      id: 'i2',
    })
    expect(result).toEqual({ id: 'i2', target: 't', html: `<div ${B_TARGET}="t" data-n="9"></div>` })
  })
})

describe('htmlUpdateAttributes — on* and schema validation', () => {
  test('on* attribute returns isError and leaves the document html unchanged', async () => {
    const html = `<div ${B_TARGET}="t"></div>`
    const result = await htmlUpdateAttributes({ html, target: 't', attr: { onclick: 'alert(1)' }, id: '1' })
    expect(result.isError).toBe(true)
    expect(result.htmlViolations![0]).toMatchObject({ tag: 'div', attribute: 'onclick' })
    expect(result.html).toBe(html)
  })

  test('schema-invalid value returns isError', async () => {
    const html = `<a ${B_TARGET}="t" href="#"></a>`
    const result = await htmlUpdateAttributes({ html, target: 't', attr: { target: '_bad' }, id: '1' })
    expect(result.isError).toBe(true)
    expect(result.htmlViolations![0]).toMatchObject({ tag: 'a', attribute: 'target' })
  })

  test('schema-valid enum value is accepted', async () => {
    const result = await htmlUpdateAttributes({
      html: `<a ${B_TARGET}="t" href="#"></a>`,
      target: 't',
      attr: { target: '_blank' },
      id: '1',
    })
    expect(result.isError).toBeFalsy()
    expect(result.html).toBe(`<a ${B_TARGET}="t" href="#" target="_blank"></a>`)
  })
})

// ── html-scale-check ───────────────────────────────────────────────────────

describe('htmlScaleCheck — into modes (self boundary)', () => {
  test('target with own b-scale returns that scale', async () => {
    const result = await htmlScaleCheck({
      html: `<div ${B_TARGET}="t" ${B_SCALE}="s3">old</div>`,
      target: 't',
      swap: SWAP_MODES.innerHTML,
      id: '1',
    })
    expect(result).toEqual({ id: '1', target: 't', effectiveScale: SCALE.s3 })
  })

  test('target without own b-scale inherits nearest ancestor scale', async () => {
    const result = await htmlScaleCheck({
      html: `<section ${B_SCALE}="s5"><article ${B_SCALE}="s3"><span ${B_TARGET}="t">x</span></article></section>`,
      target: 't',
      swap: SWAP_MODES.innerHTML,
      id: '1',
    })
    expect(result).toEqual({ id: '1', target: 't', effectiveScale: SCALE.s3 })
  })
})

describe('htmlScaleCheck — replace/beside modes (parent boundary)', () => {
  test('outerHTML uses parent scale, ignores target own b-scale', async () => {
    const result = await htmlScaleCheck({
      html: `<section ${B_SCALE}="s5"><span ${B_TARGET}="t" ${B_SCALE}="s1">x</span></section>`,
      target: 't',
      swap: SWAP_MODES.outerHTML,
      id: '1',
    })
    expect(result).toEqual({ id: '1', target: 't', effectiveScale: SCALE.s5 })
  })
})

describe('htmlScaleCheck — no scale found', () => {
  test('no b-scale anywhere returns rel', async () => {
    const result = await htmlScaleCheck({
      html: `<div><span ${B_TARGET}="t">x</span></div>`,
      target: 't',
      swap: SWAP_MODES.innerHTML,
      id: '1',
    })
    expect(result).toEqual({ id: '1', target: 't', effectiveScale: SCALE.rel })
  })

  test('zero matches returns rel', async () => {
    const result = await htmlScaleCheck({
      html: `<div ${B_TARGET}="t">x</div>`,
      target: 'nope',
      swap: SWAP_MODES.innerHTML,
      id: '1',
    })
    expect(result).toEqual({ id: '1', target: 'nope', effectiveScale: SCALE.rel })
  })
})

describe('htmlScaleCheck — multiple matches', () => {
  test('most restrictive (lowest rank) across matches wins', async () => {
    const result = await htmlScaleCheck({
      html: `<section ${B_SCALE}="s5"><div ${B_TARGET}="t">a</div></section><article ${B_SCALE}="s2"><div ${B_TARGET}="t">b</div></article>`,
      target: 't',
      swap: SWAP_MODES.innerHTML,
      id: '1',
    })
    expect(result).toEqual({ id: '1', target: 't', effectiveScale: SCALE.s2 })
  })
})

// ── bmeta — shared OKF-vocabulary schema (meta.schema.ts + html.ts) ─────────

const validateBMeta = ajv.compile(MetaSchema)

const validMeta: Meta = {
  type: 'thread',
  title: 'Turn loop governor',
  description: 'Blocks discovery writes outside the reconcile scan',
  generated: { by: 'turn-42', at: '2026-09-17T00:00:00Z' },
  status: 'stable',
}

describe('bmeta — shared OKF-vocabulary schema', () => {
  test('a valid BMeta validates against the JSON schema', () => {
    expect(validateBMeta(validMeta)).toBe(true)
  })

  test('the thread carrier convention: meta typed as BMeta is a plain object', () => {
    // `export const meta: BMeta = {...}` — the type is structural; the same
    // object must validate against the JSON schema the html carrier uses.
    const meta: Meta = {
      ...validMeta,
      tags: ['governor', 'write-policy'],
      verified: [{ by: 'frontier-verify', at: '2026-09-17T01:00:00Z' }],
      stale_after: '2026-12-01',
      sources: ['research/self-improving-agents.md'],
    }
    expect(validateBMeta(meta)).toBe(true)
  })

  test('malformed metas are rejected — missing required, unknown field, bad status enum', () => {
    const cases: unknown[] = [
      // missing title/description/generated/status
      { type: 'thread' },
      // unknown field
      { ...validMeta, apiKey: 'sk-secret' },
      // status outside draft|stable|deprecated
      { ...validMeta, status: 'published' },
      // generated missing `at`
      { ...validMeta, generated: { by: 'turn-42' } },
    ]
    for (const meta of cases) {
      expect(validateBMeta(meta)).toBe(false)
    }
  })

  test('parseMeta — valid JSON parses, malformed JSON and schema violations are not ok', () => {
    const ok = parseMeta(JSON.stringify(validMeta))
    if (!ok.ok) throw new Error(`expected ok, got: ${ok.message}`)
    expect(ok.meta.title).toBe('Turn loop governor')

    const badJson = parseMeta('{ nope')
    expect(badJson.ok).toBe(false)
    if (!badJson.ok) expect(badJson.message).toContain('JSON')

    const badSchema = parseMeta(JSON.stringify({ type: 'thread' }))
    expect(badSchema.ok).toBe(false)
  })

  test('stringifyMeta — round-trips through parseMeta: serialized meta parses and deep-equals', () => {
    const meta: Meta = {
      ...validMeta,
      tags: ['governor', 'write-policy'],
      verified: [{ by: 'frontier-verify', at: '2026-09-17T02:00:00Z' }],
      stale_after: '2026-12-01',
      sources: ['research/self-improving-agents.md'],
    }
    const result = parseMeta(stringifyMeta(meta))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`expected ok, got: ${result.message}`)
    expect(result.meta).toEqual(meta)
  })
})

describe('htmlMetaRead — extract the b-meta block from a document', () => {
  const metaDoc = (metaText: string) =>
    `<div class="card"><script type="application/json" b-meta>${metaText}</script><p>content</p></div>`

  test('reads and validates the embedded meta', async () => {
    const result = await htmlMetaRead({ html: metaDoc(JSON.stringify(validMeta)) })
    expect(result.isError).toBeFalsy()
    expect(result.meta).toEqual(validMeta)
  })

  test('a document without a b-meta block errors', async () => {
    const result = await htmlMetaRead({ html: '<div>no meta here</div>' })
    expect(result.isError).toBe(true)
    expect(result.message).toContain('b-meta')
  })

  test('a malformed block errors with the parseMeta message', async () => {
    const result = await htmlMetaRead({ html: metaDoc('{ nope') })
    expect(result.isError).toBe(true)
    expect(result.message).toContain('JSON')
  })

  test('a b-meta script without the application/json type is inert (missing block)', async () => {
    const result = await htmlMetaRead({
      html: `<div><script b-meta>${JSON.stringify(validMeta)}</script></div>`,
    })
    expect(result.isError).toBe(true)
  })
})

describe('htmlMetaValidate — validate b-meta block content in-hand', () => {
  test('valid block content passes', async () => {
    const result = await htmlMetaValidate({ text: JSON.stringify(validMeta) })
    expect(result.ok).toBe(true)
  })

  test('malformed JSON is not ok with the parse message', async () => {
    const result = await htmlMetaValidate({ text: '{ nope' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('JSON')
  })

  test('a schema violation is not ok with the schema message', async () => {
    const result = await htmlMetaValidate({ text: JSON.stringify({ type: 'thread' }) })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('meta schema')
  })
})

describe('htmlMetaStamp — stamp the b-meta block in place', () => {
  const metaDoc = (metaText: string) =>
    `<div class="card"><script type="application/json" b-meta>${metaText}</script><p>content</p></div>`
  const stamp = { by: 'frontier-verify', at: '2026-09-18T00:00:00Z' }

  test('appends a verified stamp and preserves the rest of the document', async () => {
    const result = await htmlMetaStamp({ html: metaDoc(JSON.stringify(validMeta)), stamp })
    expect(result.isError).toBeFalsy()
    expect(result.html).toContain('<div class="card">')
    expect(result.html).toContain('<p>content</p>')
    const read = await htmlMetaRead({ html: result.html! })
    expect(read.isError).toBeFalsy()
    expect(read.meta!.verified).toEqual([stamp])
    expect(read.meta!.title).toBe(validMeta.title)
  })

  test('appending a second stamp keeps the first', async () => {
    const once = await htmlMetaStamp({ html: metaDoc(JSON.stringify(validMeta)), stamp })
    const twice = await htmlMetaStamp({
      html: once.html!,
      stamp: { by: 'harbor', at: '2026-09-19T00:00:00Z' },
    })
    expect(twice.isError).toBeFalsy()
    const read = await htmlMetaRead({ html: twice.html! })
    expect(read.meta!.verified).toEqual([stamp, { by: 'harbor', at: '2026-09-19T00:00:00Z' }])
  })

  test('a status transition rides along with the stamp', async () => {
    const draft: Meta = { ...validMeta, status: 'draft' }
    const result = await htmlMetaStamp({
      html: metaDoc(JSON.stringify(draft)),
      stamp,
      status: 'stable',
    })
    expect(result.isError).toBeFalsy()
    const read = await htmlMetaRead({ html: result.html! })
    expect(read.meta!.status).toBe('stable')
    expect(read.meta!.verified).toEqual([stamp])
  })

  test('a document without a b-meta block errors with the original returned', async () => {
    const result = await htmlMetaStamp({ html: '<div>no meta</div>', stamp })
    expect(result.isError).toBe(true)
    expect(result.html).toBe('<div>no meta</div>')
  })

  test('a malformed block errors with the original returned', async () => {
    const doc = metaDoc('{ nope')
    const result = await htmlMetaStamp({ html: doc, stamp })
    expect(result.isError).toBe(true)
    expect(result.html).toBe(doc)
  })

  test('a title containing </script> cannot break out of the block', async () => {
    const hostile: Meta = { ...validMeta, title: 'closes the tag </script><b>evil</b>' }
    // Blocks carrying `</` in strings are authored escaped (the same `\/`
    // convention the stamp write path applies) — raw `</script>` breaks the
    // block at write time, before any tool runs.
    const hostileDoc = metaDoc(JSON.stringify(hostile).replace(/<\//g, '<\\/'))
    const result = await htmlMetaStamp({ html: hostileDoc, stamp })
    expect(result.isError).toBeFalsy()
    const read = await htmlMetaRead({ html: result.html! })
    expect(read.isError).toBeFalsy()
    expect(read.meta!.title).toBe(hostile.title)
    expect(read.meta!.verified).toEqual([stamp])
  })
})

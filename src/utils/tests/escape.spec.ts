import { expect, test } from 'bun:test'
import { htmlEscape, htmlUnescape } from '../../utils.ts'

test('htmlEscape(): correct escape', () => {
  expect(htmlEscape('&<>\'"')).toBe('&amp;&lt;&gt;&#39;&quot;')
})
test('htmlEscape(): correct inverted escape', () => {
  expect(htmlEscape('<>\'"&')).toBe('&lt;&gt;&#39;&quot;&amp;')
})
test('htmlUnescape(): correct unescape', () => {
  expect(htmlUnescape('&amp;&lt;&gt;&#39;&quot;')).toBe('&<>\'"')
})
test('htmlUnescape(): correct inverted unescape', () => {
  expect(htmlUnescape('&lt;&gt;&#39;&quot;&amp;')).toBe('<>\'"&')
})

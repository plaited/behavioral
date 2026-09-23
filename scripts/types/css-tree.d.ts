declare module 'css-tree' {
  export const definitionSyntax: {
    parse(syntax: string): Record<string, unknown>
  }

  /** Minimal node-location shape returned by `parse(..., { positions: true })`. */
  interface CssLocation {
    start: { offset: number; line: number; column: number }
    end: { offset: number; line: number; column: number }
  }

  /** Minimal node shape walked by {@link walk}. Only `Declaration` nodes carry
   * `property`/`value`; the `node.type === 'Declaration'` runtime guard in
   * consumers guarantees their presence (hence the `!` at access sites). */
  interface CssNode {
    type: string
    property?: string
    value?: { loc: CssLocation }
    loc?: CssLocation
  }

  /** Options accepted by {@link parse}. */
  type ParseOptions = { positions?: boolean }

  /** Parse a CSS string into an AST. */
  export function parse(css: string, options?: ParseOptions): CssNode

  /** Walk every node in an AST, calling `handler` for each. */
  export function walk(ast: CssNode, handler: (node: CssNode) => void): void
}
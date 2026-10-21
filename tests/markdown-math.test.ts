import test from 'node:test'
import assert from 'node:assert/strict'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import type { Root, RootContent } from 'mdast'
import { normalizeMathDelimiters, remarkDisplayMath } from '../src/lib/markdown-math'

test('normalizes model math delimiters without changing dollar math or escaped prices', () => {
  const source = String.raw`Inline \(a+b\), display \[\frac{x}{y}\], existing $z$ and $$w$$, price \$5.`
  assert.equal(normalizeMathDelimiters(source), String.raw`Inline $a+b$, display $$\frac{x}{y}$$, existing $z$ and $$w$$, price \$5.`)
})

test('preserves fenced examples, including list and quotation fences, while normalizing following prose', () => {
  for (const fence of [
    ['```tex', String.raw`\(code\) and \[code\]`, '```'],
    ['~~~~text', String.raw`\(code\) and \[code\]`, '~~~~'],
    ['> ```tex', String.raw`> \(code\) and \[code\]`, '> ```'],
    ['- ```tex', String.raw`  \(code\) and \[code\]`, '  ```'],
  ]) {
    const example = fence.join('\n')
    assert.equal(normalizeMathDelimiters(example + '\n' + String.raw`Outside \(x\).`), example + '\nOutside $x$.')
  }
  const crlf = ['```tex', String.raw`\(code\)`, '```', String.raw`Outside \(x\).`].join('\r\n')
  assert.equal(normalizeMathDelimiters(crlf), ['```tex', String.raw`\(code\)`, '```', 'Outside $x$.'].join('\r\n'))
})

test('keeps inline and indented code literal instead of interpreting its math-looking content', () => {
  const inline = '``literal ` \\(code\\)`` and `\\[inline\\]` Outside \\(x\\).'
  assert.equal(normalizeMathDelimiters(inline), '``literal ` \\(code\\)`` and `\\[inline\\]` Outside $x$.')
  const indented = ['    \\(code\\)', '\t\\[also code\\]', 'Outside \\(x\\).'].join('\n')
  assert.equal(normalizeMathDelimiters(indented), ['    \\(code\\)', '\t\\[also code\\]', 'Outside $x$.'].join('\n'))
})

test('leaves incomplete, empty and escaped delimiters readable without dropping text', () => {
  for (const source of [String.raw`unfinished \(x`, String.raw`mismatched \[x\)`, String.raw`empty \(\) and \[  \]`, String.raw`escaped \\(literal\\) and \\[literal\\]`]) {
    assert.equal(normalizeMathDelimiters(source), source)
  }
})

test('renders same-line display math inside lists and quotations without breaking their Markdown structure', () => {
  const source = normalizeMathDelimiters('- Display \\[x\\]\n- Inline \\(y\\)\n\n> Display $$z$$')
  const parser = unified().use(remarkParse).use(remarkMath).use(remarkDisplayMath)
  const tree = parser.runSync(parser.parse(source), { value: source }) as Root
  assert.deepEqual(tree.children.map(node => node.type), ['list', 'blockquote'])
  const formulas: { value: string; classes: unknown }[] = []
  const collect = (node: Root | RootContent) => {
    if (node.type === 'inlineMath') formulas.push({ value: node.value, classes: node.data?.hProperties?.className })
    if ('children' in node) for (const child of node.children) collect(child)
  }
  collect(tree)
  assert.deepEqual(formulas, [
    { value: 'x', classes: ['language-math', 'math-display'] },
    { value: 'y', classes: ['language-math', 'math-inline'] },
    { value: 'z', classes: ['language-math', 'math-display'] },
  ])
})

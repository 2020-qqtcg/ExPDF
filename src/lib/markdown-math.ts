import type { Root, RootContent } from 'mdast'
import type { VFile } from 'vfile'
import type {} from 'mdast-util-math'

/** Normalize model-style delimiters for rendering; never mutate the stored answer. */
export function normalizeMathDelimiters(source: string): string {
  let result = ''
  let index = 0
  while (index < source.length) {
    if (index === 0 || source[index - 1] === '\n') {
      const lineEnd = source.indexOf('\n', index)
      const end = lineEnd < 0 ? source.length : lineEnd + 1
      const line = source.slice(index, end)
      // Include quoted/list fences, and conservatively preserve indented code.
      const fence = /^(?: {0,3}>[ \t]?)* {0,3}(?:(?:[-+*]|\d+[.)]) )?(`{3,}|~{3,})([^\r\n]*)/.exec(line)
      if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
        let blockEnd = end
        while (blockEnd < source.length) {
          const nextBreak = source.indexOf('\n', blockEnd)
          const nextEnd = nextBreak < 0 ? source.length : nextBreak + 1
          const close = /^(?: {0,3}>[ \t]?)*[ \t]*(`{3,}|~{3,})[ \t]*(?:\r?\n)?$/.exec(source.slice(blockEnd, nextEnd))
          blockEnd = nextEnd
          if (close && close[1][0] === fence[1][0] && close[1].length >= fence[1].length) break
        }
        result += source.slice(index, blockEnd)
        index = blockEnd
        continue
      }
      if (/^(?: {4}|\t)/.test(line)) { result += line; index = end; continue }
    }

    if (source[index] === '`') {
      const marker = /^`+/.exec(source.slice(index))![0]
      let close = source.indexOf(marker, index + marker.length)
      while (close >= 0 && (source[close - 1] === '`' || source[close + marker.length] === '`')) close = source.indexOf(marker, close + marker.length)
      if (close >= 0) {
        result += source.slice(index, close + marker.length)
        index = close + marker.length
        continue
      }
    }

    if (source[index] === '\\') {
      const delimiter = source[index + 1]
      if (delimiter === '(' || delimiter === '[') {
        const closing = delimiter === '(' ? ')' : ']'
        let close = index + 2
        for (; close < source.length; close++) {
          if (source[close] !== '\\') continue
          if (source[close + 1] === closing) break
          close++ // A doubled backslash cannot begin a delimiter.
        }
        if (close < source.length && source.slice(index + 2, close).trim()) {
          const marker = delimiter === '(' ? '$' : '$$'
          result += marker + source.slice(index + 2, close) + marker
          index = close + 2
          continue
        }
      }
      // Preserve escaped dollars and escaped backslashes exactly as supplied.
      result += source.slice(index, index + 2)
      index += 2
      continue
    }
    result += source[index++]
  }
  return result
}

/** remark-math permits same-line $$...$$; models intend those as display math. */
export function remarkDisplayMath() {
  return (tree: Root, file: VFile) => {
    const source = String(file.value)
    function walk(node: Root | RootContent) {
      if (node.type === 'inlineMath' && source.slice(node.position?.start.offset, (node.position?.start.offset ?? 0) + 2) === '$$') {
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, className: ['language-math', 'math-display'] } }
      }
      if ('children' in node) for (const child of node.children) walk(child)
    }
    walk(tree)
  }
}

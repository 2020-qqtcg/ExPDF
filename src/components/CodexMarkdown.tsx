import { Children, isValidElement, memo, useEffect, useMemo, useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import { normalizeMathDelimiters, remarkDisplayMath } from '../lib/markdown-math'
import { getDesktopBridge } from '../lib/desktop'
import 'katex/dist/katex.min.css'
import './codex-markdown.css'

function textContent(children: ReactNode): string {
  return Children.toArray(children).map(child => typeof child === 'string' || typeof child === 'number' ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? textContent(child.props.children) : '').join('')
}

function CodeBlock({ children }: ComponentProps<'pre'>) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const code = Children.toArray(children).find(child => isValidElement(child))
  const className = isValidElement<{ className?: string }>(code) ? code.props.className ?? '' : ''
  const language = /(?:^|\s)language-([^\s]+)/.exec(className)?.[1] ?? 'text'
  const content = textContent(children)
  useEffect(() => {
    if (copyState === 'idle') return
    const timer = setTimeout(() => setCopyState('idle'), 1800)
    return () => clearTimeout(timer)
  }, [copyState])
  async function copy() {
    try { await navigator.clipboard.writeText(content); setCopyState('copied') }
    catch { setCopyState('failed') }
  }
  return <div className="codex-code-block">
    <div className="codex-code-heading"><span className="codex-code-language">{language}</span><button type="button" aria-label="复制代码" onClick={() => void copy()}>{copyState === 'copied' ? <Check size={12} /> : <Copy size={12} />}<span>{copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制'}</span></button></div>
    <pre tabIndex={0} aria-label={`${language} 代码`}>{children}</pre>
  </div>
}

function localFileTarget(value: string) {
  if (/^file:/i.test(value)) {
    try { const url = new URL(value); return !url.hostname || url.hostname === 'localhost' ? value : null } catch { return null }
  }
  return value.startsWith('/') && !value.startsWith('//') ? value : null
}
function safeLink(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href
  } catch { /* Absolute artifact paths are handled through the desktop bridge. */ }
  return getDesktopBridge() && localFileTarget(value) ? value : undefined
}
function AnswerLink({ href, children }: { href?: string; children?: ReactNode }) {
  const [error, setError] = useState('')
  const [opening, setOpening] = useState(false)
  const target = href && localFileTarget(href)
  if (!href) return <span>{children}</span>
  if (!target) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
  return <span className="codex-agent-file-link"><a href={href} aria-disabled={opening || undefined} title="打开生成的文件" onClick={event => {
    event.preventDefault()
    if (opening) return
    setError(''); setOpening(true)
    const desktop = getDesktopBridge()
    if (!desktop) { setOpening(false); setError('请在桌面版打开生成的文件。'); return }
    void desktop.openAgentFile({ path: target }).then(result => { if (!result.ok) setError(result.error || '无法打开生成文件。') }).catch(() => setError('无法打开生成文件。')).finally(() => setOpening(false))
  }}>{children}</a>{error && <span role="alert">（{error}）</span>}</span>
}

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children, ...props }) => { const { node: _node, ...attributes } = props; return <div className="codex-table-scroll" tabIndex={0} role="region" aria-label="表格"><table {...attributes}>{children}</table></div> },
  a: ({ href, children }) => <AnswerLink href={href}>{children}</AnswerLink>,
  // Model output must never fetch remote image resources.
  img: ({ alt }) => <span className="codex-image-alt">{alt}</span>,
}

function CodexMarkdown({ content }: { content: string }) {
  const normalized = useMemo(() => normalizeMathDelimiters(content), [content])
  return <div className="codex-markdown"><Markdown skipHtml urlTransform={(url, key) => key === 'href' ? safeLink(url) : undefined} components={components} remarkPlugins={[remarkGfm, remarkMath, remarkDisplayMath]} rehypePlugins={[[rehypeKatex, { trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 }], [rehypeHighlight, { detect: false, plainText: ['text', 'txt', 'plaintext'] }]]}>{normalized}</Markdown></div>
}

export default memo(CodexMarkdown)

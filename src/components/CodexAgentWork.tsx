import { useState } from 'react'
import { Check, ChevronDown, CircleAlert, LoaderCircle, Terminal, Wrench, X } from 'lucide-react'
import type { AgentActivity, AgentRequest } from '../lib/codex-agent'
import './codex-agent-work.css'

function fieldOptions(field: FormField) {
  return field.enum?.map(value => ({ value, label: String(value) })) ?? field.oneOf?.map(option => ({ value: option.const, label: option.title || String(option.const) }))
}
function formValue(field: FormField, value: string): unknown {
  if (field.type === 'boolean') return value === 'true'
  if (field.type === 'number' || field.type === 'integer') return Number(value)
  if (field.type === 'array' || field.type === 'object') return JSON.parse(value)
  return fieldOptions(field)?.find(option => String(option.value) === value)?.value ?? value
}
function valueText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return JSON.stringify(value, null, 2)
}

export function CodexActivityList({ items, busy = false }: { items: AgentActivity[]; busy?: boolean }) {
  if (!items.length) return null
  const running = [...items].reverse().find(item => ['running', 'inProgress'].includes(item.status))
  return <details className="codex-work" aria-label="任务执行记录">
    <summary>{busy && running ? <LoaderCircle size={12} className="spin" /> : <Wrench size={12} />}<span>{busy && running ? running.title : `已执行 ${items.length} 个步骤`}</span><ChevronDown size={12} /></summary>
    <ol>{items.map(item => <li key={item.id} data-state={item.status}>
      {['running', 'inProgress'].includes(item.status) ? <LoaderCircle size={12} className="spin" /> : ['failed', 'declined', 'cancelled', 'interrupted'].includes(item.status) ? <CircleAlert size={12} /> : <Check size={12} />}
      <div><span>{item.title}</span>{item.detail && <details><summary>查看详情</summary><pre>{item.detail}</pre></details>}</div>
    </li>)}</ol>
  </details>
}

interface Question { id: string; question: string; header?: string; isSecret?: boolean; options?: { label: string; description?: string }[] }
interface FormField { type?: string; title?: string; description?: string; enum?: unknown[]; format?: string; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; oneOf?: { const: unknown; title?: string }[]; items?: FormField }

export function CodexAgentRequest({ request, onRespond }: { request: AgentRequest; onRespond: (result: unknown) => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const params = request.params
  const allows = (decision: string) => !Array.isArray(params.availableDecisions) || params.availableDecisions.includes(decision)
  const questions = Array.isArray(params.questions) ? params.questions as Question[] : []
  const schema = params.requestedSchema && typeof params.requestedSchema === 'object' ? params.requestedSchema as { properties?: Record<string, FormField>; required?: string[] } : null
  const titles = { command: '运行命令', fileChange: '修改文件', permissions: '需要访问权限', userInput: '需要你的补充', elicitation: '连接服务', tool: '执行工具' }
  async function submit(result: unknown) {
    setSubmitting(true); setError('')
    try { await onRespond(result) } catch (cause) { setError(cause instanceof Error ? cause.message : '提交失败，请重试。'); setSubmitting(false) }
  }
  const preview = request.kind === 'command' ? (Array.isArray(params.command) ? params.command.join(' ') : valueText(params.command))
    : request.kind === 'fileChange' ? valueText(params.changes ?? params.reason ?? params.grantRoot)
      : request.kind === 'permissions' ? valueText(params.permissions) : ''
  return <section className="codex-action-request" aria-label={titles[request.kind]}>
    <div className="codex-action-title"><Terminal size={14} /><strong>{titles[request.kind]}</strong></div>
    {typeof params.reason === 'string' && <p>{params.reason}</p>}
    {typeof params.message === 'string' && <p>{params.message}</p>}
    {preview && <pre className="codex-action-preview">{preview}</pre>}
    {typeof params.previewWarning === 'string' && <p>{params.previewWarning}</p>}
    {params.previewTruncated === true && <small>变更预览较长，已截取部分内容。</small>}
    {typeof params.cwd === 'string' && <small>{params.cwd}</small>}
    {request.kind === 'userInput' && <form onSubmit={event => { event.preventDefault(); void submit({ answers: Object.fromEntries(questions.map(question => [question.id, { answers: [answers[question.id]?.trim() ?? ''] }])) }) }}>
      {questions.map(question => <fieldset key={question.id} disabled={submitting}><legend>{question.question}</legend>
        {question.options?.map(option => <label className="codex-question-option" key={option.label}><input type="radio" name={question.id} value={option.label} checked={answers[question.id] === option.label} onChange={() => setAnswers(current => ({ ...current, [question.id]: option.label }))} /><span>{option.label}{option.description && <small>{option.description}</small>}</span></label>)}
        <input type={question.isSecret ? 'password' : 'text'} autoComplete="off" aria-label={question.header || question.question} value={answers[question.id] ?? ''} placeholder="输入你的回答…" onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))} />
      </fieldset>)}
      <div className="codex-action-buttons"><button type="submit" disabled={submitting || questions.some(question => !answers[question.id]?.trim())}>继续</button></div>
    </form>}
    {request.kind === 'elicitation' && <form onSubmit={event => {
      event.preventDefault()
      try {
        const content = Object.fromEntries(Object.entries(schema?.properties ?? {}).filter(([key]) => answers[key] !== undefined && answers[key] !== '').map(([key, field]) => [key, formValue(field, answers[key])]))
        void submit({ action: 'accept', content: schema ? content : null })
      } catch { setError('请检查 JSON 格式；多选值应写为数组，例如 ["A", "B"]。') }
    }}>
      {typeof params.url === 'string' && /^https?:\/\//i.test(params.url) && <a href={params.url} target="_blank" rel="noopener noreferrer">打开服务连接页面 ↗</a>}
      {Object.entries(schema?.properties ?? {}).map(([key, field]) => <div className="codex-service-field" key={key}>{field.title || key}
        {fieldOptions(field) || field.type === 'boolean' ? <select aria-label={field.title || key} required={schema?.required?.includes(key)} value={answers[key] ?? ''} onChange={event => setAnswers(current => ({ ...current, [key]: event.target.value }))}><option value="">请选择</option>{(fieldOptions(field) ?? [{ value: true, label: '是' }, { value: false, label: '否' }]).map(option => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}</select>
          : field.type === 'array' && field.items && fieldOptions(field.items) ? <span className="codex-service-options">{fieldOptions(field.items)!.map(option => <label key={String(option.value)}><input type="checkbox" checked={(JSON.parse(answers[key] || '[]') as unknown[]).includes(option.value)} onChange={event => {
            const selected = JSON.parse(answers[key] || '[]') as unknown[]
            const next = event.target.checked ? [...selected, option.value] : selected.filter(value => value !== option.value)
            setAnswers(current => ({ ...current, [key]: JSON.stringify(next) }))
          }} />{option.label}</label>)}</span>
          : field.type === 'array' || field.type === 'object' ? <textarea aria-label={field.title || key} required={schema?.required?.includes(key)} placeholder={field.type === 'array' ? '["A", "B"]' : '{"key": "value"}'} value={answers[key] ?? ''} onChange={event => setAnswers(current => ({ ...current, [key]: event.target.value }))} />
          : <input aria-label={field.title || key} required={schema?.required?.includes(key)} min={field.minimum} max={field.maximum} step={field.type === 'number' ? 'any' : undefined} minLength={field.minLength} maxLength={field.maxLength} type={field.type === 'number' || field.type === 'integer' ? 'number' : field.format === 'email' ? 'email' : 'text'} value={answers[key] ?? ''} onChange={event => setAnswers(current => ({ ...current, [key]: event.target.value }))} />}
        {field.description && <small>{field.description}</small>}
      </div>)}
      <div className="codex-action-buttons"><button type="button" disabled={submitting} onClick={() => void submit({ action: 'decline', content: null })}>拒绝</button><button type="submit" disabled={submitting}>已完成，继续</button></div>
    </form>}
    {['command', 'fileChange', 'permissions'].includes(request.kind) && <div className="codex-action-buttons">
      <button disabled={submitting || (request.kind !== 'permissions' && !allows('decline') && !allows('cancel'))} onClick={() => void submit(request.kind === 'permissions' ? { permissions: {}, scope: 'turn' } : { decision: allows('decline') ? 'decline' : 'cancel' })}><X size={12} />拒绝</button>
      {request.kind !== 'permissions' && allows('acceptForSession') && <button disabled={submitting} onClick={() => void submit({ decision: 'acceptForSession' })}>本次会话允许</button>}
      <button disabled={submitting || (request.kind !== 'permissions' && !allows('accept'))} onClick={() => void submit(request.kind === 'permissions' ? { permissions: params.permissions ?? {}, scope: 'turn' } : { decision: 'accept' })}><Check size={12} />允许一次</button>
    </div>}
    {error && <p role="alert" className="codex-action-error">{error}</p>}
    {submitting && <p className="codex-action-sending"><LoaderCircle size={12} className="spin" />正在继续…</p>}
  </section>
}

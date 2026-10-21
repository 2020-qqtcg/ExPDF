import assert from 'node:assert/strict'
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { _electron as electron, expect } from '@playwright/test'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('built desktop restricts explicit artifact opens and proxies the native agent JSON/SSE endpoints', { timeout: 100_000, skip: process.platform === 'win32' }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'folio-agent-desktop-'))
  const userData = path.join(temporary, 'profile'), bin = path.join(temporary, 'bin')
  await mkdir(bin)
  const executable = path.join(bin, 'codex')
  await copyFile(new URL('./fixtures/fake-codex-appserver.cjs', import.meta.url), executable)
  await chmod(executable, 0o700)
  const env = { ...process.env, FOLIO_USER_DATA_DIR: userData, FOLIO_START_HIDDEN: '1', PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` }
  delete env.ELECTRON_RUN_AS_NODE
  let application
  try {
    application = await electron.launch({ args: ['.'], cwd: project, env, timeout: 60_000 })
    const page = await application.firstWindow()
    await expect(page).toHaveURL('folio://app/index.html')
    await expect(page.locator('#page-1 .textLayer span').first()).toBeVisible({ timeout: 30_000 })
    const workspace = await application.evaluate(({ app, shell }) => {
      globalThis.__agentOpens = []
      globalThis.__agentReveals = []
      shell.openPath = async value => { globalThis.__agentOpens.push(value); return '' }
      shell.showItemInFolder = value => { globalThis.__agentReveals.push(value) }
      return `${app.getPath('userData')}/agent-workspaces`
    })
    assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), userData)
    const folder = path.join(workspace, 'output'), document = path.join(folder, '中文 report.txt')
    const outside = path.join(temporary, 'outside.txt'), script = path.join(folder, 'script.sh'), executableDocument = path.join(folder, 'executable.txt')
    await mkdir(folder)
    await Promise.all([writeFile(document, 'Test artifact, no external app should open.'), writeFile(outside, 'Outside workspace.'), writeFile(script, '#!/bin/sh\nexit 0\n', { mode: 0o700 }), writeFile(executableDocument, 'Executable mode must be rejected.', { mode: 0o700 })])
    const escaped = path.join(folder, 'outside-link.txt')
    await symlink(outside, escaped)
    const open = options => page.evaluate(value => window.folioDesktop.openAgentFile(value), options)
    assert.deepEqual(await open({ path: document }), { ok: true })
    assert.deepEqual(await open({ path: pathToFileURL(document).href, reveal: true }), { ok: true })
    assert.deepEqual(await open({ path: folder }), { ok: true })
    for (const filename of [outside, escaped, script, executableDocument, path.join(workspace, '..', 'outside.txt'), 'relative.txt', 'javascript:alert(1)']) assert.equal((await open({ path: filename })).ok, false, filename)
    let calls = await application.evaluate(() => ({ opened: globalThis.__agentOpens, revealed: globalThis.__agentReveals }))
    assert.deepEqual(calls.opened, [await realpath(document), await realpath(folder)])
    assert.deepEqual(calls.revealed, [await realpath(document)])

    const transport = await page.evaluate(async () => {
      const status = await (await fetch('/api/codex/agent/status')).json()
      const methods = []
      for (const [route, method] of [['status', 'POST'], ['run', 'GET'], ['respond', 'GET'], ['interrupt', 'GET']]) methods.push((await fetch(`/api/codex/agent/${route}`, { method })).status)
      const invalid = await fetch('/api/codex/agent/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const unknown = await fetch('/api/codex/agent/run/extra')
      const response = await fetch('/api/codex/agent/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId: 'desktop-agent-test', documentName: '隔离测试.pdf', page: 1, question: 'scenario:pending', model: 'agent-model', reasoningEffort: 'medium', messages: [] }) })
      if (!response.ok) throw new Error(`Native SSE failed: ${response.status} ${await response.text()}`)
      const events = [], reader = response.body.getReader(), decoder = new TextDecoder()
      let pending = ''
      while (true) {
        const chunk = await reader.read()
        pending += decoder.decode(chunk.value, { stream: !chunk.done })
        let boundary
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2)
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
          if (!data) continue
          const event = JSON.parse(data); events.push(event)
          if (event.type === 'request') {
            const result = await fetch('/api/codex/agent/respond', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: event.runId, requestId: event.requestId, result: { ok: true, name: '隔离测试.pdf', pageCount: 4 } }) })
            if (!result.ok) throw new Error(`Native respond failed: ${result.status}`)
          }
        }
        if (chunk.done) break
      }
      return { status, methods, invalid: invalid.status, unknown: unknown.status, mime: response.headers.get('content-type'), events }
    })
    assert.equal(transport.status.available, true)
    assert.equal(transport.status.desktopControl, false)
    assert.equal(transport.status.workspaceRoot, workspace)
    assert.deepEqual(transport.methods, [405, 405, 405, 405])
    assert.equal(transport.invalid, 400)
    assert.equal(transport.unknown, 404)
    assert.match(transport.mime, /text\/event-stream/)
    assert(transport.events.some(event => event.type === 'request' && event.params.tool === 'folio_pdf_get_document'))
    assert(transport.events.some(event => event.type === 'complete' && event.status === 'completed'))

    // Exercise the actual production-protocol UI and app-server bridge with
    // only the executable replaced. No LLM/provider request is possible here.
    await page.addInitScript(() => {
      const original = fetch.bind(window)
      window.__nativeConversationRuns = []
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href)
        if (url.pathname === '/api/codex/status') return Response.json({ available: true, loggedIn: true, agent: true })
        if (url.pathname === '/api/codex/models') return Response.json({ defaultModel: 'agent-model', models: [{ id: 'agent-model', name: 'Test model', reasoningLevels: [{ id: 'medium', label: '标准' }], defaultReasoningLevel: 'medium' }] })
        const response = await original(input, init)
        if (url.pathname === '/api/codex/agent/run') {
          const record = { body: JSON.parse(init.body), status: response.status, events: [] }
          window.__nativeConversationRuns.push(record)
          void response.clone().text().then(text => {
            record.events = text.split('\n\n').flatMap(frame => frame.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5).trim())))
          })
        }
        return response
      }
    })
    await page.reload()
    await expect(page.locator('#page-1 .textLayer span').first()).toBeVisible()
    await page.locator('.annotation-tools').getByRole('button', { name: 'Codex AI', exact: true }).click()
    const nativePanel = page.getByRole('complementary', { name: 'Codex 问答' })
    await expect(nativePanel.getByRole('combobox', { name: 'Codex 模型', exact: true })).toBeEnabled()
    const firstQuestion = 'scenario:pending 第一条独立会话'
    const secondQuestion = 'scenario:pending 第二条独立会话'
    const followup = 'scenario:pending 第一会话追问'
    const askNative = async (question, completedRuns) => {
      await nativePanel.getByRole('textbox', { name: '向 Codex 提问' }).fill(question)
      await nativePanel.getByRole('button', { name: '发送问题', exact: true }).click()
      await expect.poll(() => page.evaluate(() => window.__nativeConversationRuns.filter(run => run.events.some(event => event.type === 'complete')).length)).toBe(completedRuns)
      await expect(nativePanel.getByRole('button', { name: '发送问题', exact: true })).toBeVisible()
    }
    await askNative(firstQuestion, 1)
    await nativePanel.getByRole('button', { name: '新建会话', exact: true }).click()
    await expect(nativePanel.locator('.codex-message')).toHaveCount(0)
    await askNative(secondQuestion, 2)
    await expect(nativePanel.locator('.codex-message.user')).toHaveCount(1)
    await expect(nativePanel.locator('.codex-message.user')).toContainText(secondQuestion)
    await nativePanel.getByRole('button', { name: '切换会话', exact: true }).click()
    await nativePanel.getByRole('button', { name: `切换到会话：${firstQuestion}`, exact: true }).click()
    await expect(nativePanel.locator('.codex-message.user')).toHaveCount(1)
    await expect(nativePanel.locator('.codex-message.user')).toContainText(firstQuestion)
    await expect(nativePanel.getByText(secondQuestion, { exact: true })).toHaveCount(0)
    await expect(nativePanel.getByRole('combobox', { name: 'Codex 模型', exact: true })).toBeEnabled()
    await askNative(followup, 3)
    const nativeRuns = await page.evaluate(() => window.__nativeConversationRuns)
    assert.deepEqual(nativeRuns.map(run => run.status), [200, 200, 200])
    assert.equal(nativeRuns[0].body.conversationId, 'legacy')
    assert.match(nativeRuns[1].body.conversationId, /^[0-9a-f-]{36}$/)
    assert.equal(nativeRuns[2].body.conversationId, 'legacy')
    assert.equal(nativeRuns[1].body.threadId, undefined)
    assert.deepEqual(nativeRuns[1].body.messages, [], 'A new conversation must not inherit the old conversation transcript')
    const threadEvents = nativeRuns.map(run => run.events.find(event => event.type === 'thread'))
    assert.notEqual(threadEvents[0].threadId, threadEvents[1].threadId)
    assert.notEqual(threadEvents[0].workspace, threadEvents[1].workspace)
    assert.equal(threadEvents[2].threadId, threadEvents[0].threadId)
    assert.equal(threadEvents[2].workspace, threadEvents[0].workspace)
    assert.equal(nativeRuns[2].body.threadId, threadEvents[0].threadId)
    assert(nativeRuns[2].body.messages.some(message => message.content.includes(firstQuestion)))
    assert(!nativeRuns[2].body.messages.some(message => message.content.includes(secondQuestion)))
    assert(nativeRuns.every(run => run.body.documentId === nativeRuns[0].body.documentId))
    assert(nativeRuns.every(run => run.events.some(event => event.type === 'request' && event.params?.tool === 'folio_pdf_get_document')))
    await expect.poll(() => page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => { const request = indexedDB.open('folio-reader', 1); request.onsuccess = () => resolve(request.result); request.onerror = reject })
      try {
        const saved = await new Promise((resolve, reject) => { const request = database.transaction('sessions').objectStore('sessions').get(localStorage.getItem('folio:last-document')); request.onsuccess = () => resolve(request.result); request.onerror = reject })
        return saved?.codexConversations?.map(chat => ({ id: chat.id, messages: chat.messages.length }))
      } finally { database.close() }
    })).toEqual(expect.arrayContaining([{ id: 'legacy', messages: 4 }, { id: nativeRuns[1].body.conversationId, messages: 2 }]))
    await page.reload()
    await expect(page.locator('#page-1 .textLayer span').first()).toBeVisible()
    await page.locator('.annotation-tools').getByRole('button', { name: 'Codex AI', exact: true }).click()
    await expect(nativePanel.locator('.codex-message.user')).toHaveCount(2)
    await nativePanel.getByRole('button', { name: '切换会话', exact: true }).click()
    await nativePanel.getByRole('button', { name: `切换到会话：${secondQuestion}`, exact: true }).click()
    await expect(nativePanel.locator('.codex-message.user')).toHaveCount(1)
    await expect(nativePanel.locator('.codex-message.user')).toContainText(secondQuestion)
    await mkdir(path.join(project, 'tmp'), { recursive: true })
    await page.screenshot({ path: path.join(project, 'tmp/desktop-codex-conversations.png') })

    // Render an answer through the real UI. Only its network answer is stubbed;
    // clicking its file link still crosses the trusted preload/main bridge.
    await page.addInitScript(({ document, outside, workspace }) => {
      const original = fetch.bind(window)
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href)
        if (url.pathname === '/api/codex/status') return Response.json({ available: true, loggedIn: true, agent: true })
        if (url.pathname === '/api/codex/models') return Response.json({ defaultModel: 'agent-model', models: [{ id: 'agent-model', name: 'Test model', reasoningLevels: [{ id: 'medium', label: '标准' }], defaultReasoningLevel: 'medium' }] })
        if (url.pathname === '/api/codex/agent/status') return Response.json({ available: true, desktopControl: false, workspaceRoot: workspace, capabilities: [], mcpServers: [], skills: [] })
        if (url.pathname === '/api/codex/agent/run') return new Response(`data: ${JSON.stringify({ type: 'thread', runId: 'artifact-test', threadId: 'artifact-thread', workspace })}\n\ndata: ${JSON.stringify({ type: 'complete', runId: 'artifact-test', threadId: 'artifact-thread', status: 'completed', answer: `[测试文档](<${document}>)\n\n[越界文档](<${outside}>)\n\n[危险](javascript:alert(1))` })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
        return original(input, init)
      }
    }, { document, outside, workspace })
    await page.reload()
    await expect(page.locator('#page-1 .textLayer span').first()).toBeVisible()
    await page.locator('.annotation-tools').getByRole('button', { name: 'Codex AI', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Codex 问答' })
    await expect(panel.getByRole('combobox', { name: 'Codex 模型', exact: true })).toBeEnabled()
    await panel.getByRole('textbox', { name: '向 Codex 提问' }).fill('测试生成文件链接。')
    await panel.getByRole('button', { name: '发送问题', exact: true }).click()
    const link = panel.getByRole('link', { name: '测试文档', exact: true })
    await expect(link).toBeVisible()
    calls = await application.evaluate(() => ({ opened: globalThis.__agentOpens, revealed: globalThis.__agentReveals }))
    assert.equal(calls.opened.length, 2, 'an answer never opens its links automatically')
    await link.click()
    await expect.poll(() => application.evaluate(() => globalThis.__agentOpens.length)).toBe(3)
    await panel.getByRole('link', { name: '越界文档', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('只能打开 ExPDF')
    assert.equal(await application.evaluate(() => globalThis.__agentOpens.length), 3)
    assert.equal(await panel.locator('a[href^="javascript:"]').count(), 0)
    assert.equal(await page.url(), 'folio://app/index.html')
  } finally {
    await application?.close().catch(() => {})
    await rm(temporary, { recursive: true, force: true })
  }
})

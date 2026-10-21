import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { startLocalApi } from '../desktop/api-server.mjs'

test('desktop API requires a private token and reuses the safe APIs with a Finder-compatible executable', { skip: process.platform === 'win32' }, async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'folio-desktop-api-'))
  const executable = path.join(folder, 'mock-codex')
  const events = path.join(folder, 'events.txt')
  const oldPath = process.env.PATH
  await writeFile(events, '')
  await symlink(process.execPath, path.join(folder, 'node'))
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const marker = ${JSON.stringify(events)};
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli desktop-test'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in using ChatGPT'); process.exit(0); }
if (args[0] === 'debug' && args[1] === 'models') { console.log(JSON.stringify({ models: [{ slug: 'desktop-model', visibility: 'list', supported_in_api: true, input_modalities: ['text'], supported_reasoning_levels: [{ effort: 'medium' }], default_reasoning_level: 'medium' }] })); process.exit(0); }
if (args[0] !== 'exec') process.exit(1);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const question = JSON.parse(input.slice(input.indexOf('\\n') + 1)).question;
  fs.appendFileSync(marker, 'start:' + question + '\\n');
  if (question === 'cancel' || question === 'close') {
    process.on('SIGTERM', () => { fs.appendFileSync(marker, 'killed:' + question + '\\n'); process.exit(0); });
    setInterval(() => {}, 1000);
  } else console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '仅模拟回答。' } }));
});
`, { mode: 0o700 })
  process.env.PATH = '/usr/bin:/bin'
  const token = randomBytes(32).toString('hex')
  const api = await startLocalApi({ token, codexPath: executable })
  const headers = { 'X-Folio-Token': token }
  const question = { documentName: '本机测试.pdf', page: 1, quote: 'Selected text.', question: 'explain', model: 'desktop-model', reasoningEffort: 'medium' }
  const post = (value: string, signal?: AbortSignal) => fetch(`${api.origin}/api/codex/ask`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...question, question: value }), signal })
  const waitFor = async (text: string) => {
    const limit = Date.now() + 3_000
    while (Date.now() < limit) {
      if ((await readFile(events, 'utf8')).includes(text)) return
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    assert.fail(`Did not observe ${text}`)
  }
  try {
    assert.match(api.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal((await fetch(`${api.origin}/api/codex/status`)).status, 403)
    assert.equal((await fetch(`${api.origin}/api/codex/status`, { headers: { 'X-Folio-Token': `${token}wrong` } })).status, 403)
    assert.deepEqual(await (await fetch(`${api.origin}/api/codex/status`, { headers })).json(), { available: true, loggedIn: true, agent: true })
    assert.equal((await fetch(`${api.origin}/api/codex/status`, { headers: { ...headers, Origin: 'folio://app' } })).status, 403, 'The protocol handler must strip the renderer origin before proxying')
    assert.equal((await fetch(`${api.origin}/api/codex/status`, { headers: { ...headers, Origin: api.origin } })).status, 200)
    const forgedHost = await new Promise(resolve => http.get(`${api.origin}/api/codex/status`, { headers: { ...headers, Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode) }))
    assert.equal(forgedHost, 403)
    assert.equal((await fetch(`${api.origin}/api/fonts`, { method: 'POST', headers })).status, 405)
    assert.equal((await fetch(`${api.origin}/api/fonts/%2Fetc%2Fpasswd`, { headers })).status, 404)
    assert.equal((await fetch(`${api.origin}/index.html`, { headers })).status, 404)
    assert.equal((await fetch(`${api.origin}/api/unknown`, { headers })).status, 404)
    const models = await (await fetch(`${api.origin}/api/codex/models`, { headers })).json()
    assert.equal(models.defaultModel, 'desktop-model')
    const answered = await post('explain')
    assert.equal(answered.status, 200)
    assert.deepEqual(await answered.json(), { answer: '仅模拟回答。' })
    const controller = new AbortController()
    const cancelled = post('cancel', controller.signal).catch(() => undefined)
    await waitFor('start:cancel'); controller.abort(); await cancelled; await waitFor('killed:cancel')
    const closing = post('close').catch(() => undefined)
    await waitFor('start:close')
    await Promise.all([api.close(), api.close(), closing])
    assert((await readFile(events, 'utf8')).includes('killed:close'), 'close waits for the active Codex subprocess to terminate')
    await assert.rejects(fetch(`${api.origin}/api/codex/status`, { headers }))
  } finally {
    await api.close()
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath
    await rm(folder, { recursive: true, force: true })
  }
})

test('desktop API rejects a weak token or a relative CLI path before listening', async () => {
  await assert.rejects(startLocalApi({ token: 'short' }), /random ASCII API token/)
  await assert.rejects(startLocalApi({ token: 'x'.repeat(32), codexPath: '../codex' }), /absolute executable path/)
})

import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import localFontsPlugin from '../server/fonts.mjs'

test('local font API retains IDs across refresh, exposes localized names, and blocks arbitrary paths and origins', async () => {
  let middleware: (request: http.IncomingMessage, response: http.ServerResponse, next: () => void) => void
  const plugin = localFontsPlugin()
  plugin.configureServer({ middlewares: { use(value: typeof middleware) { middleware = value } } } as never)
  const server = http.createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end() }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    assert.equal((await fetch(`${base}/api/fonts`, { headers: { Origin: 'https://example.com' } })).status, 403)
    assert.equal((await fetch(`${base}/api/fonts`, { method: 'POST' })).status, 405)
    assert.equal((await fetch(`${base}/api/fonts/%2Fetc%2Fpasswd`)).status, 404)
    const forgedHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      http.get(`${base}/api/fonts`, { headers: { Host: '127.evil.example' } }, (response) => { response.resume(); resolve(response.statusCode) }).on('error', reject)
    })
    assert.equal(forgedHostStatus, 403)
    const response = await fetch(`${base}/api/fonts`)
    assert.equal(response.status, 200)
    const fonts = await response.json() as { id: string; family: string; fullName: string; postscriptName: string; localizedFullName: string; aliases: string[] }[]
    assert(Array.isArray(fonts))
    for (const font of fonts) {
      assert.match(font.id, /^[a-f0-9]{64}$/)
      assert.equal(typeof font.localizedFullName, 'string')
      assert.equal(new Set(font.aliases).size, font.aliases.length)
      assert(font.aliases.includes(font.fullName))
    }
    const refreshed = await Promise.all([fetch(`${base}/api/fonts?refresh=1`).then((value) => value.json()), fetch(`${base}/api/fonts?refresh=1`).then((value) => value.json())])
    assert.deepEqual(refreshed[0], refreshed[1])
    assert.deepEqual((refreshed[0] as typeof fonts).map((font) => font.id), fonts.map((font) => font.id))
    if (fonts.length) {
      const bytes = await fetch(`${base}/api/fonts/${fonts[0].id}`)
      assert.equal(bytes.status, 200)
      assert((await bytes.arrayBuffer()).byteLength > 12)
    }
    if (process.platform === 'darwin') {
      const songti = fonts.find((font) => font.postscriptName === 'STSongti-SC-Regular')
      assert(songti?.aliases.some((alias) => alias.includes('宋体')))
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

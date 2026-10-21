import { timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import codexPlugin from '../server/codex.mjs'
import codexAgentPlugin from '../server/codex-agent.mjs'
import localFontsPlugin from '../server/fonts.mjs'

function json(response, status, error) {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end(JSON.stringify({ error }))
}

/** Private loopback API used only by the desktop protocol handler. */
export async function startLocalApi({ token, codexPath, workspaceRoot } = {}) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 512 || !/^[!-~]+$/.test(token)) throw new TypeError('A random ASCII API token of at least 32 characters is required.')
  if (codexPath !== undefined && (typeof codexPath !== 'string' || !path.isAbsolute(codexPath))) throw new TypeError('codexPath must be an absolute executable path.')
  const expected = Buffer.from(token)
  const middlewares = []
  const adapter = { middlewares: { use(middleware) { middlewares.push(middleware) } } }
  localFontsPlugin().configureServer(adapter)
  codexPlugin({ executable: codexPath, agent: true }).configureServer(adapter)
  const agent = codexAgentPlugin({ executable: codexPath, workspaceRoot })
  agent.configureServer(adapter)
  const pendingQuestions = new Set()

  const server = http.createServer((request, response) => {
    const supplied = typeof request.headers['x-folio-token'] === 'string' ? Buffer.from(request.headers['x-folio-token']) : Buffer.alloc(0)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      request.resume()
      return json(response, 403, '此接口仅供 ExPDF 应用内部访问。')
    }
    // A cancelled font download must also close the underlying file stream.
    response.on('pipe', stream => response.once('close', () => stream.destroy()))
    async function dispatch(index) {
      if (response.destroyed || response.writableEnded) return
      const middleware = middlewares[index]
      if (!middleware) return json(response, 404, '未找到该接口。')
      try {
        await middleware(request, response, () => dispatch(index + 1))
      } catch { json(response, 500, '处理本机请求失败。') }
    }
    const pending = dispatch(0)
    if (['/api/codex/ask', '/api/codex/agent/run'].includes(request.url?.split('?')[0])) {
      pendingQuestions.add(pending)
      void pending.finally(() => pendingQuestions.delete(pending))
    }
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  const connections = new Set()
  server.on('connection', socket => {
    connections.add(socket)
    socket.once('close', () => connections.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })

  let closing
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close() {
      if (!closing) closing = new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
        // Destroying in-flight responses also triggers the Codex middleware's
        // existing abort handler, terminating its text-generation subprocess.
        server.closeAllConnections()
        for (const socket of connections) socket.destroy()
      }).then(() => agent.close()).then(() => Promise.allSettled([...pendingQuestions])).then(() => undefined)
      return closing
    },
  }
}

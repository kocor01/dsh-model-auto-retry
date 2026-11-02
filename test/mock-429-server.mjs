/**
 * 假 429 服务：给端到端验证用的 OpenAI 兼容端点。
 *
 * 行为：前 `FAILS` 次 `POST /v1/chat/completions` 返回 429（带 `retry-after`），
 * 之后返回一段正常的 SSE 流。用来验证插件能扛过真实的限流失败链。
 *
 * 用法：
 *   node test/mock-429-server.mjs [port] [fails]
 *   node test/mock-429-server.mjs 8123 3
 *
 * port 传 0 时由系统分配，启动后会在 stdout 打印实际地址。
 */

import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 8123)
const fails = Number(process.argv[3] ?? 2)

let requestCount = 0

/**
 * 返回一段 OpenAI 兼容的 SSE 补全流。
 * @param {import('node:http').ServerResponse} response - 响应对象。
 */
function sendCompletion(response) {
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta, finishReason) => JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created,
    model: 'mock-1',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  response.write(`data: ${chunk({ role: 'assistant', content: 'done' }, null)}\n\n`)
  response.write(`data: ${chunk({}, 'stop')}\n\n`)
  response.write('data: [DONE]\n\n')
  response.end()
}

/**
 * 返回一次限流失败。
 * @param {import('node:http').ServerResponse} response - 响应对象。
 */
function sendRateLimit(response) {
  response.writeHead(429, {
    'content-type': 'application/json; charset=utf-8',
    // 让插件走 failure.providerRetryAfterMs 分支（而不是指数退避）。
    'retry-after': '1',
  })
  response.end(JSON.stringify({
    error: {
      message: 'rps exhausted',
      type: 'quota_exceeded_error',
      code: '8',
    },
  }))
}

const server = createServer((request, response) => {
  const url = request.url ?? ''
  if (request.method === 'GET' && url.startsWith('/v1/models')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'mock-1', object: 'model', owned_by: 'mock' }],
    }))
    return
  }
  if (request.method !== 'POST' || !url.startsWith('/v1/chat/completions')) {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: `unexpected ${request.method} ${url}` } }))
    return
  }

  requestCount += 1
  if (requestCount <= fails) {
    console.log(`[mock] #${requestCount} -> 429 (rate limited)`)
    sendRateLimit(response)
    return
  }
  console.log(`[mock] #${requestCount} -> 200 (completion)`)
  sendCompletion(response)
})

server.listen(port, '127.0.0.1', () => {
  const address = server.address()
  console.log(`[mock] listening on http://127.0.0.1:${address.port}/v1  (first ${fails} request(s) -> 429)`)
})

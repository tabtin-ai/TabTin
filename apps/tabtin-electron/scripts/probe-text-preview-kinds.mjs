/**
 * Live 探针：在已启动的 Electron（--remote-debugging-port=9222）里
 * 动态 import 聊天文本预览推断 / 解码模块并断言 kind。
 *
 * 用法：node scripts/probe-text-preview-kinds.mjs
 */
import WebSocket from 'ws'

const CDP_LIST = 'http://127.0.0.1:9222/json/list'

async function findMainPageWs() {
  const pages = await fetch(CDP_LIST).then((r) => r.json())
  const page = pages.find(
    (p) =>
      p.type === 'page'
      && typeof p.url === 'string'
      && p.url.includes('127.0.0.1:5175/')
      && !p.url.includes('overlay.html'),
  )
  if (!page?.webSocketDebuggerUrl) {
    throw new Error('未找到 TabTin 主页面（需 pnpm dev + remote-debugging-port=9222）')
  }
  return page.webSocketDebuggerUrl
}

function createCdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString())
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  })

  const ready = new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })

  function send(method, params = {}) {
    const mid = ++id
    return new Promise((resolve, reject) => {
      pending.set(mid, { resolve, reject })
      ws.send(JSON.stringify({ id: mid, method, params }))
      setTimeout(() => {
        if (pending.has(mid)) {
          pending.delete(mid)
          reject(new Error(`timeout ${method}`))
        }
      }, 15000)
    })
  }

  return { ws, ready, send }
}

const wsUrl = await findMainPageWs()
const { ws, ready, send } = createCdp(wsUrl)
await ready
await send('Runtime.enable')

const expression = `(async () => {
  const mod = await import('/src/components/chat/preview/inferPreviewableKind.ts')
  const decode = await import('/src/components/chat/preview/decodeTextPreview.ts')
  return {
    txt: mod.inferPreviewableKind('text/plain', 'a.txt'),
    mdPlain: mod.inferPreviewableKind('text/plain', 'readme.md'),
    json: mod.inferPreviewableKind('application/json', 'x.json'),
    md: mod.inferPreviewableKind('text/markdown', 'x.md'),
    zip: mod.inferPreviewableKind('application/zip', 'a.zip'),
    decode: decode.decodeTextPreview(new TextEncoder().encode('hi').buffer),
  }
})()`

const r = await send('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
})

const value = r.result?.value
console.log(JSON.stringify(value, null, 2))

const ok =
  value?.txt === 'txt'
  && value?.mdPlain === 'md'
  && value?.json === 'json'
  && value?.md === 'md'
  && value?.zip === null
  && value?.decode?.text === 'hi'
  && value?.decode?.truncated === false

ws.close()
if (!ok) {
  console.error('ASSERT_FAILED')
  process.exit(1)
}
console.log('ASSERT_OK')

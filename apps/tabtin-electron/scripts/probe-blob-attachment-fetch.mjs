import WebSocket from 'ws'

const pages = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json())
const page = pages.find(
  (p) => p.type === 'page' && p.url?.includes('127.0.0.1:5175/') && !p.url.includes('overlay'),
)
if (!page) throw new Error('no main page')

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()

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

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
})

await new Promise((resolve, reject) => {
  ws.on('open', resolve)
  ws.on('error', reject)
})

await send('Runtime.enable')
const expression = `(async () => {
  const mod = await import('/src/components/chat/preview/attachmentBlobCache.ts?t=' + Date.now())
  const blob = new Blob(['# hello md'], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  try {
    const buf = await mod.getAttachmentBuffer({ url })
    return { ok: true, text: new TextDecoder().decode(buf) }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) }
  } finally {
    URL.revokeObjectURL(url)
  }
})()`

const r = await send('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
})
console.log(JSON.stringify(r.result?.value, null, 2))
ws.close()
if (!r.result?.value?.ok) process.exit(1)

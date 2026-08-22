import { PassThrough, Writable } from 'node:stream'
import { installMcpRemoteOptionalScopeCompat } from './mcp-remote-oauth-compat'

type ParentMessage =
  | { type: 'stdin'; data: string }
  | { type: 'stdin-end' }

const parentPort = process.parentPort
if (!parentPort) throw new Error('mcp-remote host requires an Electron utility process')

const stdin = new PassThrough()
const stdout = new Writable({
  write(chunk, _encoding, callback) {
    parentPort.postMessage({
      type: 'stdout',
      data: Buffer.from(chunk).toString('base64'),
    })
    callback()
  },
})

// mcp-remote 的 CLI 在加载后从 process.stdin/stdout 建立 stdio transport。
// utilityProcess 没有向父进程暴露 stdin，因此在加载 CLI 前把两端桥接到 parentPort。
Object.defineProperty(process, 'stdin', { configurable: true, get: () => stdin })
Object.defineProperty(process, 'stdout', { configurable: true, get: () => stdout })

parentPort.on('message', event => {
  const message = event.data as ParentMessage
  if (message?.type === 'stdin' && typeof message.data === 'string') {
    stdin.write(message.data)
  } else if (message?.type === 'stdin-end') {
    stdin.end()
  }
})

// 必须保持字面量动态 import：既要在替换 stdin/stdout 后再执行 CLI，又要让
// Rollup 把 mcp-remote 及其依赖闭包编进安装包，不能留给用户机器的 node_modules。
const { NodeOAuthClientProvider } = await import('mcp-remote/dist/chunk-65X3S4HB.js')
installMcpRemoteOptionalScopeCompat(NodeOAuthClientProvider)
await import('mcp-remote/dist/proxy.js')

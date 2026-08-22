import { utilityProcess, type UtilityProcess } from 'electron'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import { PassThrough } from 'node:stream'

type UtilityProcessFork = Pick<typeof utilityProcess, 'fork'>

export interface BundledMcpRemoteServerParameters {
  args: string[]
  cwd?: string
  env?: Record<string, string>
}

/**
 * 旧连接配置仍保存为 `npx -y mcp-remote@... <url>`。只识别这条固定桥接链路，
 * 不把任意 npx 包升级成受信任的内置运行时。
 */
export function extractBundledMcpRemoteArgs(
  command: string,
  args: readonly string[] = [],
): string[] | null {
  const normalizedCommand = command.replace(/\\/g, '/').split('/').pop()?.toLowerCase()
  if (normalizedCommand !== 'npx' && normalizedCommand !== 'npx.cmd') return null

  const packageIndex = args.findIndex(arg => /^(?:mcp-remote)(?:@[^/]+)?$/.test(arg))
  if (packageIndex < 0) return null
  return args.slice(packageIndex + 1)
}

/**
 * 用 Electron utility process 承载内置 mcp-remote。
 *
 * 生产包关闭了 RunAsNode fuse；utilityProcess.fork 是 Electron 提供的受控
 * Node 子进程边界，不依赖系统 node/npx，也不需要重新打开全局 RunAsNode。
 */
export class BundledMcpRemoteTransport implements Transport {
  private readonly readBuffer = new ReadBuffer()
  private readonly stderrStream = new PassThrough()
  private child?: UtilityProcess

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: <T extends JSONRPCMessage>(message: T) => void

  constructor(
    private readonly server: BundledMcpRemoteServerParameters,
    private readonly entryPath: string,
    private readonly processFactory: UtilityProcessFork = utilityProcess,
  ) {}

  get stderr(): NodeJS.ReadableStream {
    return this.stderrStream
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  async start(): Promise<void> {
    if (this.child) throw new Error('BundledMcpRemoteTransport already started')

    await new Promise<void>((resolve, reject) => {
      const child = this.processFactory.fork(this.entryPath, this.server.args, {
        cwd: this.server.cwd,
        env: this.server.env,
        // utilityProcess 不支持 pipe stdin；MCP 请求已通过 postMessage 传入。
        stdio: ['ignore', 'pipe', 'pipe'],
        serviceName: 'TabTin MCP Remote',
      })
      this.child = child

      let settled = false
      child.once('spawn', () => {
        settled = true
        resolve()
      })
      child.once('error', (type, location, report) => {
        const error = new Error(`mcp-remote utility process ${type} at ${location}: ${report}`)
        if (!settled) reject(error)
        this.onerror?.(error)
      })
      child.once('exit', () => {
        this.child = undefined
        this.onclose?.()
      })
      child.on('message', message => {
        if (!isStdoutMessage(message)) return
        this.readBuffer.append(Buffer.from(message.data, 'base64'))
        this.processReadBuffer()
      })
      child.stderr?.pipe(this.stderrStream, { end: false })
    })
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this.child) throw new Error('Not connected')
    this.child.postMessage({ type: 'stdin', data: serializeMessage(message) })
  }

  async close(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.readBuffer.clear()
    if (!child) return

    child.postMessage({ type: 'stdin-end' })
    child.kill()
  }

  private processReadBuffer(): void {
    while (true) {
      try {
        const message = this.readBuffer.readMessage()
        if (message === null) return
        this.onmessage?.(message)
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }
}

function isStdoutMessage(value: unknown): value is { type: 'stdout'; data: string } {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as { type?: unknown }).type === 'stdout'
    && typeof (value as { data?: unknown }).data === 'string',
  )
}

import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { utilityProcess } from 'electron'

vi.mock('electron', () => ({
  utilityProcess: { fork: vi.fn() },
}))

import {
  BundledMcpRemoteTransport,
  extractBundledMcpRemoteArgs,
} from '../bundled-mcp-remote-transport'

describe('extractBundledMcpRemoteArgs', () => {
  it('把推荐连接器的旧 npx 配置改写为内置 mcp-remote 参数', () => {
    expect(extractBundledMcpRemoteArgs('npx', [
      '-y',
      'mcp-remote@0.1.38',
      'https://mcp.notion.com/mcp',
      '--auth-timeout',
      '180',
    ])).toEqual([
      'https://mcp.notion.com/mcp',
      '--auth-timeout',
      '180',
    ])
  })

  it('兼容 Windows npx.cmd 和未钉版本的旧配置', () => {
    expect(extractBundledMcpRemoteArgs('C:\\Program Files\\nodejs\\npx.cmd', [
      '--yes',
      'mcp-remote',
      'https://mcp.stripe.com',
    ])).toEqual(['https://mcp.stripe.com'])
  })

  it('不接管任意 npx 包', () => {
    expect(extractBundledMcpRemoteArgs('npx', ['-y', 'dingtalk-mcp@latest'])).toBeNull()
  })

  it('不改写用户显式指定的其他命令', () => {
    expect(extractBundledMcpRemoteArgs('node', ['mcp-remote', 'https://example.com'])).toBeNull()
  })
})

describe('BundledMcpRemoteTransport', () => {
  it('通过 utility process IPC 双向传递 MCP JSON-RPC', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      stderr: new PassThrough(),
      stdout: null,
      postMessage: vi.fn(),
      kill: vi.fn(() => true),
    })
    const processFactory = {
      fork: vi.fn(() => child),
    } as unknown as Pick<typeof utilityProcess, 'fork'>
    const transport = new BundledMcpRemoteTransport(
      { args: ['https://mcp.notion.com/mcp'] },
      '/app/out/main/mcp-remote-host-process.mjs',
      processFactory,
    )

    const started = transport.start()
    child.emit('spawn')
    await started

    expect(processFactory.fork).toHaveBeenCalledWith(
      '/app/out/main/mcp-remote-host-process.mjs',
      ['https://mcp.notion.com/mcp'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    )

    const onmessage = vi.fn()
    transport.onmessage = onmessage
    const response = { jsonrpc: '2.0', id: 1, result: {} }
    child.emit('message', {
      type: 'stdout',
      data: Buffer.from(`${JSON.stringify(response)}\n`).toString('base64'),
    })
    expect(onmessage).toHaveBeenCalledWith(response)

    const request = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list' }
    await transport.send(request)
    expect(child.postMessage).toHaveBeenCalledWith({
      type: 'stdin',
      data: `${JSON.stringify(request)}\n`,
    })

    await transport.close()
    expect(child.postMessage).toHaveBeenCalledWith({ type: 'stdin-end' })
    expect(child.kill).toHaveBeenCalledOnce()
  })
})

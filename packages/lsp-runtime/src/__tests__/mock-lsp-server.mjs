#!/usr/bin/env node
/**
 * 最小的 mock LSP server，用于单测 LSPClient / LSPServerInstance / 等。
 *
 * 实现：
 *   - 'initialize' request → 返回 capabilities
 *   - 'initialized' notification → 主动推一条 'window/showMessage'
 *   - 'echo/test' request → 原样返回 params
 *   - 'echo/error' request → reject with error message
 *   - 'shutdown' request → 返回 null
 *   - 'exit' notification → process.exit(0)
 *
 * 设计目标：让 LSPClient 的所有公开 API（start / initialize / sendRequest /
 * sendNotification / onNotification / onRequest / stop）都能跑通端到端。
 */

import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  ResponseError,
} from 'vscode-jsonrpc/node.js';

const reader = new StreamMessageReader(process.stdin);
const writer = new StreamMessageWriter(process.stdout);
const connection = createMessageConnection(reader, writer);

connection.onRequest('initialize', async (_params) => {
  // 用于测试 startupTimeout：通过 MOCK_LSP_INIT_DELAY_MS env 让 initialize
  // 响应延迟，模拟慢启动的 LSP server（如 rust-analyzer indexing）
  if (INIT_DELAY > 0) {
    await new Promise((resolve) => setTimeout(resolve, INIT_DELAY));
  }
  return {
    capabilities: {
      textDocumentSync: 1,
      hoverProvider: true,
    },
    serverInfo: { name: 'mock-lsp', version: '0.0.1' },
  };
});

connection.onNotification('initialized', () => {
  // 主动推一条 notification，模拟 LSP server 的 server-to-client 行为
  // 用 setImmediate 让 client 端的 onNotification handler 有时间注册
  setImmediate(() => {
    connection.sendNotification('window/showMessage', {
      type: 1,
      message: 'hello from mock server',
    });
  });
});

// 让 client 显式触发 publishDiagnostics（测试 passiveFeedback wire 用）
// 客户端调 `client/triggerPublishDiagnostics` → server 推 textDocument/publishDiagnostics
connection.onRequest('client/triggerPublishDiagnostics', (params) => {
  const { uri, diagnostics } = params ?? {};
  connection.sendNotification('textDocument/publishDiagnostics', {
    uri: uri ?? 'file:///mock.ts',
    diagnostics: diagnostics ?? [
      {
        message: 'mock diagnostic',
        severity: 1, // Error
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        source: 'mock-lsp',
        code: 'E001',
      },
    ],
  });
  return null;
});

connection.onRequest('echo/test', (params) => params);

connection.onRequest('echo/error', (params) => {
  throw new Error(`echo/error invoked with ${JSON.stringify(params)}`);
});

// content-modified 重试测试支持：前 N 次抛 ContentModified (-32801)，
// 第 N+1 次返回成功。state 在 server 进程内累积。
let contentModifiedAttempts = 0;
connection.onRequest('echo/content-modified', (params) => {
  const expected = params?.failTimes ?? 2;
  contentModifiedAttempts++;
  if (contentModifiedAttempts <= expected) {
    // vscode-jsonrpc 的 onRequest handler 抛普通 Error 会被包成 ResponseError
    // 但 code 默认是 -32603 (InternalError)。要让 client 端看到自定义 code，
    // 必须抛 ResponseError 实例。
    throw new ResponseError(
      -32801,
      `ContentModified attempt ${contentModifiedAttempts}`,
    );
  }
  return { attempts: contentModifiedAttempts, params };
});

// 重置 content-modified 状态（多个测试之间）
connection.onRequest('echo/reset-content-modified', () => {
  contentModifiedAttempts = 0;
  return null;
});

// 延迟响应（测 startupTimeout）—— initialize 提前注册一个慢响应是不实际的，
// 直接给 mock server 一个 slow/initialize 选项：通过 INIT_DELAY_MS env 注入
// initialize 响应前 sleep。
const INIT_DELAY = parseInt(process.env.MOCK_LSP_INIT_DELAY_MS ?? '0', 10);

connection.onRequest('shutdown', () => null);

connection.onNotification('exit', () => {
  // eslint-disable-next-line no-process-exit
  process.exit(0);
});

// Reverse direction: server-to-client requests are supported in LSP
// (e.g., workspace/configuration). We don't test those here but having a
// handler-less channel doesn't break anything.

connection.listen();

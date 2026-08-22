/**
 * 第三方包未带完整 typings 时的最小声明（供主进程 tsc 解析 import）。
 */
declare module 'sql.js'
declare module 'tar'
// mcp-remote 的 CLI 类型文件只有 shebang，不是合法 TS module；该入口只靠导入副作用启动。
declare module 'mcp-remote/dist/proxy.js'
declare module 'mcp-remote/dist/chunk-65X3S4HB.js' {
  export class NodeOAuthClientProvider {
    constructor(options: Record<string, unknown>)
    getEffectiveScope(): string | undefined
    redirectToAuthorization(url: URL): Promise<void>
  }
}

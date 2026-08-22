/**
 * browser-container-mode — 内嵌浏览器容器实现的 feature flag（webview 迁移 Phase 2，）
 *
 * 单一判定入口（ 判定顺序，仍收口在本模块）：
 *   1. 运行时 `TABTIN_BROWSER_CONTAINER=webview|wcv`——dev（根 .env 经 electron-vite
 *      压进 process.env）与排障（终端启动 packaged app 时注入）双用，可覆盖烘焙值
 *   2. 构建期烘焙 `VITE_TABTIN_BROWSER_CONTAINER`（打包 profile 写入，esbuild 字面量
 *      替换进 main bundle）——安装包从 Finder/桌面启动没有 shell env，这是唯一通道
 *   3. 都缺省 → `wcv`
 *
 * 传播链路（判定只发生在这里，不允许散落 if）：
 *   1. 主进程：`resolveBrowserContainerMode(process.env)`（main-window.ts 创建窗口时读一次）
 *   2. 主 → preload：经 `webPreferences.additionalArguments` 注入
 *      `--tabtin-browser-container=<mode>`（sandboxed preload 读 process.argv 最可靠，
 *      不依赖 env 是否继承进 renderer 进程）
 *   3. preload → renderer：`window.tabtin.browserContainer.mode` 只读值
 *
 * flag 语义：
 *   - `wcv`（默认）：现状 WebContentsView 路径，行为一字不变
 *   - `webview`：TabWeb 显示链路走 <webview> tag 容器（渲染侧 WebviewManager +
 *     主进程 webview-host 安全装配）
 *
 * 注意：`webviewTag: true` 与 will-attach 安全 harden **不受本 flag 控制**（无论
 * flag 取值都开启/安装）——tag 能力对 Tin 沙箱是前置依赖，harden 是
 * 无条件的安全边界；flag 只控制 TabWeb 浏览器容器走哪条实现。
 */

export type BrowserContainerMode = 'wcv' | 'webview'

/** 环境变量名（主进程读取） */
export const BROWSER_CONTAINER_ENV_KEY = 'TABTIN_BROWSER_CONTAINER'

/** 主进程 → preload 的命令行参数前缀（additionalArguments） */
export const BROWSER_CONTAINER_ARGV_PREFIX = '--tabtin-browser-container='

/** 未知/缺省值一律回落 wcv（现状路径），保证 flag 关闭时零行为变化 */
export function parseBrowserContainerMode(raw: string | undefined | null): BrowserContainerMode {
  return raw === 'webview' ? 'webview' : 'wcv'
}

/**
 * 构建期烘焙值。打包 profile（.env.preprod 等）写
 * `VITE_TABTIN_BROWSER_CONTAINER`，esbuild 在 main bundle 编译时把下面的
 * `import.meta.env.VITE_TABTIN_BROWSER_CONTAINER` 替换成字面量——安装包从
 * Finder/桌面启动拿不到 shell env，烘焙是打包形态开 flag 的唯一通道。
 *
 * 必须**精确**写 `import.meta.env.VITE_TABTIN_BROWSER_CONTAINER`（不能加
 * `?.` / cast，规矩同 VITE_APP_VERSION，见 src/types/import-meta-env.d.ts）。
 * 本模块也被 preload / renderer 引用：两处 bundle 的该值缺省为 undefined，
 * 而且它们不调 resolveBrowserContainerMode（preload 走 argv，renderer 走
 * preload 只读值），烘焙值只对主进程判定生效。
 */
const BAKED_BROWSER_CONTAINER: string | undefined = import.meta.env.VITE_TABTIN_BROWSER_CONTAINER

/**
 * 主进程判定入口：显式传 env 便于测试。
 * 运行时 env 优先于构建期烘焙值（dev / 排障可覆盖渠道默认）。
 */
export function resolveBrowserContainerMode(
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
  bakedDefault: string | undefined = BAKED_BROWSER_CONTAINER,
): BrowserContainerMode {
  return parseBrowserContainerMode(env[BROWSER_CONTAINER_ENV_KEY] ?? bakedDefault)
}

/** 组装 additionalArguments 项（main-window.ts 使用） */
export function buildBrowserContainerArgv(mode: BrowserContainerMode): string {
  return `${BROWSER_CONTAINER_ARGV_PREFIX}${mode}`
}

/** preload 判定入口：从 process.argv 解析（sandboxed preload 可用） */
export function parseBrowserContainerModeFromArgv(argv: readonly string[]): BrowserContainerMode {
  const arg = argv.find((item) => item.startsWith(BROWSER_CONTAINER_ARGV_PREFIX))
  return parseBrowserContainerMode(arg?.slice(BROWSER_CONTAINER_ARGV_PREFIX.length))
}

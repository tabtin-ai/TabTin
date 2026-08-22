/**
 * Agent-Runtime 内部 API URL 拼接 helper —— **本地 zero-dep 版**。
 *
 * **为什么不直接用 `@tabtin/config` 的 `joinApiPath`**：
 * `packages/agent-runtime` 故意不依赖 `@tabtin/config`——这个包要可移植到
 * Electron / Daemon / Cloud / RN 等多种宿主，所有运行时配置走"宿主通过
 * `deps.apiBaseUrl` 注入"的依赖反转模式（见 `host/skill-credential-resolver.ts`
 * 顶部"零依赖原则"注释）。引 `@tabtin/config` 会反向引入 i18n / Vite env 等
 * 一系列宿主特定依赖，破坏可移植性。
 *
 * **行为契约（与 `@tabtin/config` 的 `joinApiPath` 完全一致）**：
 * - `apiBaseUrl` 约定**必须以 `/api` 结尾**（与 `getApiRuntimeConfig()` 的
 *   强制 assert 对齐，见 `packages/tabtin-config/src/index.ts:66-68`）。
 * - 传入的 `path` **不应**以 `/api` 开头，正确写法形如 `/plan/create` 或
 *   `/credential-vault/api-key/skill-reveal`。
 * - 若 `path` 错误地以 `/api` 开头：自动剥离前缀，dev 环境（NODE_ENV !==
 *   'production'）打 `console.warn` + 调用栈，便于定位调用方；生产静默修正
 *   保留可用性。
 * - 缺失分隔斜杠时自动补 `/`。
 *
 * **历史背景（为什么需要这层 helper）**：
 * agent-runtime 的 5 个 HTTP 工具（plan-tools / skill-credential-resolver /
 * web-tools / document-tools / data-tools）历史上多次写错 `${apiBaseUrl}/api/...`，
 * 配合测试 fixture 故意不带 `/api` 后缀让单测全绿，生产 baseUrl 真带 `/api`
 * 后缀 → 双 `/api` → Django 404（W2-A、W4 dogfood P0 反复翻车）。这层 helper
 * 加 dev 警告作为运行期兜底，配合 `scripts/infra-gate.sh` 的 lint 规则双重
 * 防护。
 */

/**
 * 安全拼接 API 路径：自动去除 path 中多余的 `/api` 前缀，防止 `/api/api` 重复。
 *
 * @example joinApiPath('http://localhost:6060/api', '/plan/create')
 *          // => 'http://localhost:6060/api/plan/create'
 * @example joinApiPath('http://localhost:6060/api', '/api/plan/create')
 *          // => 'http://localhost:6060/api/plan/create'  (自动修正 + dev 警告)
 */
export function joinApiPath(baseUrl: string, path: string): string {
  const hadApiPrefix = /^\/api(?=\/|$)/.test(path);
  const normalizedPath = hadApiPrefix ? path.replace(/^\/api(?=\/|$)/, '') : path;

  if (
    hadApiPrefix &&
    typeof process !== 'undefined' &&
    process.env?.NODE_ENV !== 'production'
  ) {
    const stack =
      new Error().stack?.split('\n').slice(2, 4).join('\n    ') ?? '';
    // 不直接抛错——保留可用性；但 dev 环境必须明确告警，定位调用方。
    // eslint-disable-next-line no-console
    console.warn(
      `[agent-runtime joinApiPath] path "${path}" 以 /api 开头，已自动修正为 "${normalizedPath}"。` +
        `请直接使用不含 /api 前缀的路径。\n    ${stack}`,
    );
  }

  const sep =
    normalizedPath.startsWith('/') ? '' : normalizedPath === '' ? '' : '/';
  return `${baseUrl}${sep}${normalizedPath}`;
}

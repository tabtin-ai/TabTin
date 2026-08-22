import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import checker from 'vite-plugin-checker'

function normalizeEnvUrl(value: string | undefined): string {
  return (value || '').trim().replace(/\/+$/, '')
}

/**
 * AdminDash 连 lite（ACK test）或 docker 预设 API 时，邀请链接公开 Web 基址跟随同套预设，
 * 避免仍用根 .env 的 127.0.0.1:5176 拼出不可分享的本地链接。
 */
function applyPublicWebPreset(env: Record<string, string>): void {
  const apiBase = normalizeEnvUrl(env.VITE_API_BASE_URL || env.TABTIN_API_BASE_URL)
  if (!apiBase) return

  const presets = [
    {
      apiBaseUrl: env.TABTIN_LITE_API_BASE_URL,
      publicWebBaseUrl: env.TABTIN_LITE_PUBLIC_WEB_BASE_URL,
      mode: 'lite',
    },
    {
      apiBaseUrl: env.TABTIN_DOCKER_API_BASE_URL,
      publicWebBaseUrl: env.TABTIN_DOCKER_PUBLIC_WEB_BASE_URL,
      mode: 'docker',
    },
  ] as const

  const preset = presets.find((item) => normalizeEnvUrl(item.apiBaseUrl) === apiBase)
  if (!preset?.publicWebBaseUrl) return

  const current = normalizeEnvUrl(env.VITE_PUBLIC_WEB_BASE_URL)
  const localDefault = normalizeEnvUrl(env.TABTIN_DOCKER_PUBLIC_WEB_BASE_URL) || 'http://127.0.0.1:5176'
  if (!current || current === localDefault) {
    env.VITE_PUBLIC_WEB_BASE_URL = normalizeEnvUrl(preset.publicWebBaseUrl)
    env.TABTIN_PUBLIC_WEB_BASE_URL = env.VITE_PUBLIC_WEB_BASE_URL
    console.log(
      `[admindash] VITE_PUBLIC_WEB_BASE_URL 跟随 ${preset.mode} API → ${env.VITE_PUBLIC_WEB_BASE_URL}`,
    )
  }
}

export default defineConfig(async ({ command, mode }) => {
  const repoRoot = path.resolve(__dirname, '../..')
  // 从仓库根目录加载统一的 .env
  const env = loadEnv(mode, repoRoot, '')
  // 本地验 AdminDash↔Django：TABTIN_ADMINDASH_USE_LOCAL_API=1 时强制走本机 6060，
  // 避免根 .env.local 的 lite/test 盖住存储组织名搜索等未部署接口。
  const useLocalApi = process.env.TABTIN_ADMINDASH_USE_LOCAL_API === '1'
  if (useLocalApi) {
    env.VITE_API_BASE_URL = ''
    env.TABTIN_API_BASE_URL = 'http://127.0.0.1:6060/api'
  }
  applyPublicWebPreset(env)
  Object.assign(process.env, env)

  let apiTarget = 'http://localhost:6060'
  if (command === 'serve') {
    const { resolveApiRuntimeConfig } = await import('@tabtin/config')
    // 获取 API 目标地址（从统一 API_BASE_URL 推导出 origin）
    const { apiOrigin } = resolveApiRuntimeConfig(env)
    apiTarget = useLocalApi ? 'http://127.0.0.1:6060' : apiOrigin
  }

  return {
    envDir: repoRoot,
    // dev：与 `pnpm build` 中 `tsc` 对齐的类型检查；build 已由 `tsc && vite build` 负责，避免重复跑 tsc
    plugins: [
      react(),
      checker({
        typescript: true,
        enableBuild: false,
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@tabtin/app-shell': path.resolve(__dirname, '../../packages/app-shell/src'),
      },
    },
    optimizeDeps: {
      // 排除有问题的包，让 Vite 正常处理
      exclude: [],
      // 确保 ESM/CommonJS 互操作性
      esbuildOptions: {
        target: 'es2020',
      },
    },
    build: {
      // 主业务路由按页面拆分后仍会有少量较大的独立包（如 doc-host-web），
      // 将提示阈值提升到 1024kB，避免 500kB 默认阈值产生噪声告警。
      chunkSizeWarningLimit: 1024,
      // 确保 CommonJS 依赖正确转换
      commonjsOptions: {
        transformMixedEsModules: true,
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5174,
      strictPort: true,
      proxy: {
        // 代理 /orchestration 开头的请求（Agent Debug API）
        // 重写为 /api/orchestration，因为后端实际路径带 /api 前缀
        '/orchestration': {
          target: apiTarget,
          changeOrigin: true,
          secure: false,
          rewrite: (path) => `/api${path}`, // /orchestration/xxx -> /api/orchestration/xxx
        },
        // 代理 /auth 开头的请求
        '/auth': {
          target: apiTarget,
          changeOrigin: true,
          secure: false,
          rewrite: (path) => `/api${path}`, // /auth/xxx -> /api/auth/xxx
        },
        // 代理 /api 开头的请求（直接转发，不重写）
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          secure: false,
        },
        // 代理 /tabdata 开头的请求
        '/tabdata': {
          target: apiTarget,
          changeOrigin: true,
          secure: false,
          rewrite: (path) => `/api${path}`, // /tabdata/xxx -> /api/tabdata/xxx
        },
      },
    },
  }
})

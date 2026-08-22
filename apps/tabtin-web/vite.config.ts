import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import type { Plugin } from 'vite'

function createChunkDebugPlugin(enabled: boolean): Plugin | null {
  if (!enabled) return null

  return {
    name: 'tabtin-web-chunk-debug',
    generateBundle(_, bundle) {
      const chunkNames = new Set(
        (process.env.TABTIN_WEB_CHUNK_DEBUG_CHUNKS || 'vendor-echarts,vendor-editor')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      )

      for (const [, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk') continue
        if (!chunkNames.has(output.name)) continue

        const modules = Object.keys(output.modules).sort()
        console.log(`\n[tabtin-web chunk-debug] chunk=${output.name} file=${output.fileName}`)
        console.log(`[tabtin-web chunk-debug] imports=${output.imports.join(',') || '(none)'}`)
        console.log(`[tabtin-web chunk-debug] dynamicImports=${output.dynamicImports.join(',') || '(none)'}`)
        console.log('[tabtin-web chunk-debug] modules:')
        for (const moduleId of modules) {
          console.log(`  - ${moduleId}`)
        }
      }
    },
  }
}

function resolveManualChunk(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined
  if (id.includes('vite/preload-helper')) return 'vendor-runtime'
  if (
    id.includes('node_modules/react/') ||
    id.includes('node_modules/react-dom/') ||
    id.includes('node_modules/scheduler/')
  ) {
    return 'vendor-react'
  }
  if (id.includes('@mathjax/')) return 'vendor-mathjax'
  if (id.includes('zrender')) return 'vendor-zrender'
  if (id.includes('echarts') || id.includes('echarts-for-react')) return 'vendor-echarts'
  if (id.includes('react-pdf') || id.includes('pdfjs-dist')) return 'vendor-pdf'
  if (id.includes('docx-preview') || id.includes('jszip')) return 'vendor-docx'
  if (id.includes('node_modules/lodash/')) return 'vendor-lodash'
  if (id.includes('@glideapps/glide-data-grid')) return 'vendor-glide-grid'
  if (id.includes('@teable/ui-lib')) return 'vendor-teable-ui'
  if (id.includes('@teable/core') || id.includes('@teable/icons')) return 'vendor-teable-core'
  if (id.includes('@teable/')) return 'vendor-teable-misc'
  if (id.includes('node_modules/prop-types/')) return 'vendor-utils'
  if (id.includes('antlr4ts')) return 'vendor-antlr'
  if (id.includes('@radix-ui') || id.includes('@tiptap/') || id.includes('prosemirror') || id.includes('novel')) {
    return 'vendor-editor'
  }
  if (id.includes('framer-motion') || id.includes('/motion-dom') || id.includes('/motion-utils')) {
    return 'vendor-motion'
  }
  if (id.includes('lucide-react')) return 'vendor-icons'
  if (id.includes('i18next') || id.includes('react-i18next')) return 'vendor-i18n'
  return undefined
}

export default defineConfig(async ({ mode }) => {
  const repoRoot = path.resolve(__dirname, '../..')
  const browserShimDir = path.resolve(__dirname, './src/shims/browser')
  const env = loadEnv(mode, repoRoot, '')
  const chunkDebugEnabled = env.TABTIN_WEB_CHUNK_DEBUG === '1' || process.env.TABTIN_WEB_CHUNK_DEBUG === '1'
  Object.assign(process.env, env)

  const { resolveApiRuntimeConfig } = await import('@tabtin/config')
  const { apiOrigin } = resolveApiRuntimeConfig(env)
  const apiTarget = apiOrigin

  return {
    envDir: repoRoot,
    plugins: [react(), createChunkDebugPlugin(chunkDebugEnabled)].filter(Boolean),
    define: {
      global: 'globalThis',
      process: JSON.stringify({ env: {} }),
      'process.env': '{}',
    },
    resolve: {
      alias: [
        { find: '@', replacement: path.resolve(__dirname, './src') },
        { find: '@tabtin/app-shell', replacement: path.resolve(__dirname, '../../packages/app-shell/src') },
        { find: '@tabtin/tabdoc-ui/editor/prosemirror.css', replacement: path.resolve(__dirname, '../../packages/tabdoc-ui/src/editor/prosemirror.css') },
        { find: /^assert$/, replacement: path.resolve(browserShimDir, 'assert.cjs') },
        { find: /^fs$/, replacement: path.resolve(browserShimDir, 'fs.cjs') },
        { find: /^path$/, replacement: path.resolve(browserShimDir, 'path.cjs') },
      ],
    },
    optimizeDeps: {
      esbuildOptions: {
        target: 'es2020',
        alias: {
          assert: path.resolve(browserShimDir, 'assert.cjs'),
          fs: path.resolve(browserShimDir, 'fs.cjs'),
          path: path.resolve(browserShimDir, 'path.cjs'),
        },
        define: {
          global: 'globalThis',
          process: JSON.stringify({ env: {} }),
        },
      },
    },
    build: {
      chunkSizeWarningLimit: 1024,
      commonjsOptions: {
        transformMixedEsModules: true,
      },
      rollupOptions: {
        onwarn(warning, warn) {
          const message = warning.message || ''
          if (message.includes('contains an annotation that Rollup cannot interpret')) {
            return
          }
          warn(warning)
        },
        output: {
          manualChunks: resolveManualChunk,
        },
      },
    },
    server: {
      // Electron dev 固定 5175（VITE_DEV_SERVER_PORT）；公开分享页走 tabtin-web，避免同端口抢路由。
      port: parseInt(env.VITE_TABTIN_WEB_DEV_PORT || '5176', 10),
      strictPort: true,
      host: '127.0.0.1',
      proxy: {
        '/auth': {
          target: apiTarget,
          changeOrigin: true,
          secure: false,
          rewrite: (p) => `/api${p}`,
        },
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          secure: false,
        },
      },
    },
  }
})

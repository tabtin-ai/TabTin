import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'hooks/index': 'src/hooks/index.ts',
    'components/index': 'src/components/index.ts'
  },
  format: ['esm'],
  dts: {
    resolve: true,  // 解析外部类型
  },
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ['react', 'react-dom', 'react-resizable-panels', 'lucide-react', '@tabtin/smartsheet-ui', 'framer-motion', 'clsx', 'tailwind-merge'],
  // 跳过node_modules检查
  skipNodeModulesBundle: true
})

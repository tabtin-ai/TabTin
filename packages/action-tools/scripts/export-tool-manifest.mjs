import { writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const packageRoot = path.resolve(__dirname, '..')
const distEntry = path.join(packageRoot, 'dist', 'manifest.js')
const outputPath = path.join(packageRoot, 'manifest.json')

if (!existsSync(distEntry)) {
  throw new Error('[action-tools] dist/manifest.js not found. Run `pnpm -C packages/action-tools build` first.')
}

// Node ≥20 在 Windows 上禁止 import() 裸盘符绝对路径（`C:\...` → ERR_UNSUPPORTED_ESM_URL_SCHEME，
// 协议被当成 'c:'），必须转成 file:// URL。POSIX 下 pathToFileURL 同样安全。
const { getToolManifests, getToolCapabilityMap } = await import(pathToFileURL(distEntry).href)

const tools = typeof getToolManifests === 'function' ? getToolManifests() : []
const toolCapabilityMap = typeof getToolCapabilityMap === 'function' ? getToolCapabilityMap() : {}

// 不写 generated_at —— manifest.json 是被仓库追踪的构建产物（Django 后端 /
// daemon 测试 / CI 都依赖它存在），所以**不能** .gitignore；但每次 build 写
// 时间戳又会让本地工作区凭空脏，触发"刚 build 完就有 untracked 改动"的噪声
// 提交（c9d1484f4 / d5247c8d5 都是被这个噪声拉出来的）。
//
// 解法：让 payload 完全由 tools 输入决定（deterministic）。同样的 manifest
// 输入 → 同样的 JSON 输出 → 工作区只有在工具真变了才会脏，CI 才会真触发。
// Django 端 `action_tool_manifest._normalize_manifest` 已用 `data.get(...)`
// 兼容字段缺失，无需配套改动。
const payload = {
  tools,
  toolCapabilityMap
}

await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
const info = await stat(outputPath)
console.log(`[action-tools] manifest generated: ${outputPath} (${info.size} bytes, ${tools.length} tools)`)

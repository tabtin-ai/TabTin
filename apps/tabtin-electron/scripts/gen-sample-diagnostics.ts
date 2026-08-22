/**
 * 诊断包样例生成器（演示 / 验证用，可复跑）
 *
 * 复用**真实**的 redact 脱敏函数 + jszip，喂入一段模拟「用户操作 Space」产生的
 * 日志（用 Space 模块本轮实际埋点的格式），生成一个真实的诊断包 zip 落到
 * ~/Downloads/TabTin/diagnostics/，用于直观查看：诊断包结构 / Space 埋点样子 /
 * 脱敏是否生效。
 *
 * 跑法：cd apps/tabtin-electron && npx tsx scripts/gen-sample-diagnostics.ts
 *
 * 注意：这是「样例」——日志是构造的（非真实运行时环形缓冲）。真实导出走客户端
 * 三处入口（帮助菜单 / 设置·关于页 / 崩溃兜底页），链路见
 * docs/agent/client-diagnostics.md。
 */

import JSZip from 'jszip'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { redact, redactJson } from '../src/shared/diagnostics-redact'

const meta = {
  generatedAt: new Date().toISOString(),
  reason: 'menu',
  profile: 'preprod',
  appVersion: '1.0.0-preprod.1',
  electronVersion: '41.0.0',
  gitCommit: 'e3646f2c8bd7',
  gitBranch: 'release-20260609-0.0.1',
  os: { name: 'macOS', version: '15.5', arch: 'arm64', locale: 'zh-CN' },
  host: {
    processArch: 'arm64',
    platform: 'darwin',
    cpuBrand: 'Apple M3 Pro',
    macTranslated: 0,
    macSupportsArm64: 1,
    osBuild: '24F74',
    execBasename: 'TabTin',
    runtimeLabel: 'apple-silicon-native',
  },
  session: { sessionId: 's_ab12cd', deviceId: 'd_ff9021' },
  context: {
    organizationId: 'wt_88f2',
    organizationName: '增长团队',
    spaceId: 'sp_3a1c',
    spaceName: null,
    agentId: 'ag_71bd',
    agentName: '调研助手',
  },
  user: { id: 'u_10293', nickname: '赛达', username: 'seda', phoneMasked: '138****5678' },
}

// 模拟用户一次 Space 操作序列——用本轮实际埋点会产生的日志文本
const rendererLog = [
  '2026-07-03T19:20:01.120Z [INFO] [SpaceList] handleOrganizationChange: {"organizationId":"wt_88f2"}',
  '2026-07-03T19:20:01.340Z [INFO] [Space] Space list loaded (merge): 6 for organization: wt_88f2',
  '2026-07-03T19:20:03.010Z [INFO] [Space] Space selected: {"id":"sp_3a1c","type":"workspace","organizationId":"wt_88f2"}',
  '2026-07-03T19:20:03.250Z [INFO] [CLIServer] Space context updated: {"spaceId":"sp_3a1c","crawlspaceId":null,"organizationId":"wt_88f2"}',
  '2026-07-03T19:20:03.510Z [DEBUG] [WorkspacePaths] workspace paths pushed: {"spaceId":"sp_3a1c","hasWorkingDir":true}',
  '2026-07-03T19:20:12.700Z [INFO] [Space] Space created: {"id":"sp_9f2d","name":"客户调研 2026Q3","type":"workspace"}',
  '2026-07-03T19:20:30.880Z [INFO] [Space] Space execution agent ensured: {"spaceId":"sp_9f2d","agentId":"ag_5521"}',
  '2026-07-03T19:20:45.900Z [INFO] [Space] Deleting space: {"id":"sp_9f2d"}',
  '2026-07-03T19:20:46.210Z [INFO] [Space] Space deleted: {"id":"sp_9f2d"}',
  '2026-07-03T19:21:02.330Z [WARN] [Space] selectSpace: 异步加载执行 Agent 失败（保持已选 Space）: Error: request timeout after 10000ms',
  '2026-07-03T19:21:05.010Z [INFO] [Space] Space removed via WS push: {"spaceId":"sp_1122","action":"deleted"}',
  // 演示脱敏：某处不小心把鉴权头 / 手机号 / 家目录路径打进日志——导出时会被 redact 打码
  '2026-07-03T19:21:10.400Z [ERROR] [ApiClient] request failed url=/api/spaces auth="Bearer eyJhbGciOiJIUzI1Ni.payloadpayloadpayload.sigsigsigsig" user_phone=13812345678 op_path=/Users/seda/workspace/secret-notes',
].join('\n')

const breadcrumbs = [
  { type: 'click', category: 'ui', message: 'button "切换团队"', timestamp: '2026-07-03T19:20:00.900Z' },
  { type: 'navigation', category: 'route', message: '/space/sp_3a1c', timestamp: '2026-07-03T19:20:03.000Z' },
  {
    type: 'http',
    category: 'fetch',
    message: 'DELETE /api/spaces/sp_9f2d → 200',
    timestamp: '2026-07-03T19:20:46.200Z',
    data: { duration_ms: 310, status: 200 },
  },
]

const recentErrors = [
  {
    error_type: 'Error',
    message: 'request timeout after 10000ms',
    level: 'warning',
    source: 'renderer',
    file: 'space-api.ts',
    line: 88,
    column: 12,
    app_version: '1.0.0-preprod.1',
    os_name: 'macOS',
    occurred_at: '2026-07-03T19:21:02.330Z',
  },
]

const README = [
  'TabTin 客户端诊断包（样例）',
  '='.repeat(40),
  '',
  `导出时间：${meta.generatedAt}`,
  '触发来源：menu（样例数据，非真实运行时）',
  `版本：${meta.appVersion}（${meta.profile}）`,
  `Git：${meta.gitCommit} @ ${meta.gitBranch}`,
  `系统：${meta.os.name} ${meta.os.version} ${meta.os.arch}`,
  meta.host
    ? `主机：${meta.host.cpuBrand ?? '(unknown CPU)'} · ${meta.host.runtimeLabel}${meta.host.macTranslated === 1 ? ' (Rosetta)' : ''}`
    : '',
  '',
  '文件说明：',
  '  meta.json          环境与运行上下文（含版本/git/系统/主机CPU·架构/当前 space/agent、登录用户，已脱敏）',
  '  renderer.log       界面层日志（本样例含 Space 模块埋点）',
  '  breadcrumbs.json   出错前操作时间线',
  '  recent-errors.json 最近前端错误',
  '',
  '内容已脱敏（token / 手机号 / 邮箱 / 家目录用户名）。',
  '',
].join('\n')

async function main(): Promise<void> {
  const zip = new JSZip()
  zip.file('README.txt', README)
  zip.file('meta.json', redactJson(meta))
  zip.file('renderer.log', redact(rendererLog))
  zip.file('breadcrumbs.json', redactJson(breadcrumbs))
  zip.file('recent-errors.json', redactJson(recentErrors))

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const outDir = join(homedir(), 'Downloads', 'TabTin', 'diagnostics')
  mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15)
  const outPath = join(outDir, `tabtin-diag-sample-${meta.profile}-${meta.appVersion}-${stamp}.zip`)
  writeFileSync(outPath, buf)
  console.log('WROTE', outPath, `(${buf.length} bytes)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

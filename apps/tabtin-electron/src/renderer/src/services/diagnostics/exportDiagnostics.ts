/**
 * 客户端诊断日志导出——渲染进程编排入口
 *
 * 三处 UI（帮助菜单 / 设置·关于页 / 崩溃兜底页）统一调 exportDiagnostics()：
 *   收集界面层日志（环形缓冲）+ 面包屑 + 最近错误 + 运行上下文
 *   → 全量脱敏 → jszip 打包 base64
 *   → 交主进程落盘（主进程本地注入 main.log，避免大日志过 IPC）。
 *
 * 组装放在渲染进程：这里才有环形缓冲 / 面包屑 / store 上下文，且 jszip 是
 * 现成依赖。主进程只做「读 main.log」和「安全落盘」两件文件系统的事。
 */

import JSZip from 'jszip'
import { toast } from '@tabtin/smartsheet-ui'
import { getLogEntries, formatLogEntries } from '@/services/logCollector'
import { getBreadcrumbsSnapshot, getRecentErrorsSnapshot } from '@/services/errorReporter'
import { collectDiagnosticsMeta, type DiagnosticsMeta } from './collectContext'
import type { DiagnosticsBundlePayload, DiagnosticsHostEnv } from '../../../../shared/diagnostics-types'
import {
  buildDiagnosticsClipboardText,
  prepareClipboardDiagnostics,
  CLIPBOARD_WINDOW_MS,
} from './buildDiagnosticsClipboardText'
import { redact, redactJson } from './redact'

// 防重复：导出 / 复制是重活，进行中再点只提示。
let diagnosticsActionInFlight = false

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function buildFilename(meta: DiagnosticsMeta): string {
  const d = new Date()
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const profile = (meta.profile || 'unknown').replace(/[^a-z0-9]/gi, '') || 'unknown'
  const version = (meta.appVersion || '0').replace(/[^a-z0-9.-]/gi, '') || '0'
  return `tabtin-diag-${profile}-${version}-${ts}.zip`
}

function buildReadme(meta: DiagnosticsMeta): string {
  return [
    'TabTin 客户端诊断包',
    '='.repeat(40),
    '',
    `导出时间：${meta.generatedAt}`,
    `触发来源：${meta.reason}`,
    `版本：${meta.appVersion}（${meta.profile}）`,
    `Git：${meta.gitCommit || '(unknown)'}${meta.gitBranch ? ` @ ${meta.gitBranch}` : ''}`,
    `系统：${meta.os.name} ${meta.os.version} ${meta.os.arch}`,
    meta.host
      ? `主机：${meta.host.cpuBrand ?? '(unknown CPU)'} · ${meta.host.runtimeLabel}${meta.host.macTranslated === 1 ? ' (Rosetta)' : ''}`
      : '',
    '',
    '文件说明：',
    '  meta.json          环境与运行上下文（版本/git/系统/主机CPU·架构/space/agent/登录用户，已脱敏）',
    '  renderer.log       界面层运行日志（内存环形缓冲，最近若干条）',
    '  breadcrumbs.json   出错前的操作时间线（点击/路由/HTTP）',
    '  recent-errors.json 最近捕获的前端错误',
    '  main.log           主进程日志（仅打包版本有内容）',
    '  main.1.log~main.5.log 主进程日志归档（若存在，新到旧）',
    '',
    '内容已脱敏（token / 手机号 / 邮箱 / 家目录用户名）。如仍发现敏感信息，反馈时请告知研发。',
    '',
  ].join('\n')
}

/**
 * 生成并导出诊断包。任何失败都以 toast 告知，不抛给调用方（三处 UI 都是
 * fire-and-forget 调用）。
 */
function collectRendererDiagnostics(reason: string, host: DiagnosticsHostEnv | null) {
  return {
    meta: collectDiagnosticsMeta(reason, host),
    rendererLog: formatLogEntries(getLogEntries()),
    breadcrumbs: getBreadcrumbsSnapshot(),
    errors: getRecentErrorsSnapshot(),
  }
}

async function buildDiagnosticsBundle(reason: string): Promise<DiagnosticsBundlePayload> {
  const host = await window.tabtin?.diagnostics?.getHostEnv?.().catch(() => null) ?? null
  const { meta, rendererLog, breadcrumbs, errors } = collectRendererDiagnostics(reason, host)
  const zip = new JSZip()
  zip.file('README.txt', buildReadme(meta))
  zip.file('meta.json', redactJson(meta))
  zip.file('renderer.log', redact(rendererLog) || '(界面层暂无日志)')
  zip.file('breadcrumbs.json', redactJson(breadcrumbs))
  zip.file('recent-errors.json', redactJson(errors))
  return {
    filename: buildFilename(meta),
    base64: await zip.generateAsync({ type: 'base64', compression: 'DEFLATE' }),
  }
}

export async function exportDiagnostics(options?: { reason?: string }): Promise<void> {
  if (diagnosticsActionInFlight) {
    toast({ title: '诊断日志正在处理中…' })
    return
  }
  diagnosticsActionInFlight = true
  const reason = options?.reason ?? 'manual'
  toast({ title: '正在生成诊断包…' })

  try {
    const result = await window.tabtin?.diagnostics?.saveBundle?.(await buildDiagnosticsBundle(reason))
    if (!result?.absolutePath) {
      throw new Error('诊断落盘未返回路径（API 不可用？）')
    }
    const desc = result.mainLogAttached
      ? result.absolutePath
      : `${result.absolutePath}${result.mainLogNote ? `（${result.mainLogNote}）` : ''}`
    toast({ title: '诊断包已导出', description: desc })
  } catch (err) {
    toast({
      title: '诊断包导出失败',
      description: err instanceof Error ? err.message : String(err),
      variant: 'destructive',
    })
  } finally {
    diagnosticsActionInFlight = false
  }
}

/** 仅在用户主动点击后上传；完整包会先经主进程注入 main.log 并进入可靠队列。 */
export async function uploadDiagnosticsToSupport(): Promise<void> {
  if (diagnosticsActionInFlight) {
    toast({ title: '诊断日志正在处理中…' })
    return
  }
  diagnosticsActionInFlight = true
  toast({ title: '正在准备上传诊断包…' })
  try {
    const result = await window.tabtin?.diagnostics?.queueSupportUpload?.(
      await buildDiagnosticsBundle('support_upload'),
    )
    if (!result?.queued) throw new Error('诊断包未进入上传队列')
    toast({ title: '诊断包已交给技术支持', description: '扫描通过后，运维可在 24 小时内下载查看。' })
  } catch (err) {
    toast({ title: '诊断包上传失败', description: err instanceof Error ? err.message : String(err), variant: 'destructive' })
  } finally {
    diagnosticsActionInFlight = false
  }
}

/**
 * 将诊断内容复制到系统剪贴板（开发时快速粘贴给 AI / 聊天工具）。
 * 包含 meta / 最近错误 / 面包屑 / renderer.log / main.log（经 IPC 读取，已脱敏）。
 */
export async function copyDiagnosticsToClipboard(options?: { reason?: string }): Promise<void> {
  if (diagnosticsActionInFlight) {
    toast({ title: '诊断日志正在处理中…' })
    return
  }
  diagnosticsActionInFlight = true
  const reason = options?.reason ?? 'manual'
  toast({ title: '正在复制诊断日志…' })

  try {
    const host = await window.tabtin?.diagnostics?.getHostEnv?.().catch(() => null) ?? null
    const meta = collectDiagnosticsMeta(reason, host)
    const mainSnap = await window.tabtin?.diagnostics?.readLogs?.()
    // 剪贴板只取最近 N 分钟现场，避免几天积累的 main.log/telemetry 撑爆 AI 上下文。
    // zip 导出仍走 collectRendererDiagnostics 全量路径。
    const prepared = prepareClipboardDiagnostics({
      meta,
      logEntries: getLogEntries(),
      breadcrumbs: getBreadcrumbsSnapshot(),
      errors: getRecentErrorsSnapshot(),
      mainLog: mainSnap?.mainLog ?? null,
      mainLogNote: mainSnap?.note,
      windowMs: CLIPBOARD_WINDOW_MS,
    })
    const text = buildDiagnosticsClipboardText(prepared)

    if (!navigator.clipboard?.writeText) {
      throw new Error('当前环境不支持剪贴板写入')
    }
    await navigator.clipboard.writeText(text)

    const kb = Math.round(text.length / 1024)
    const windowMin = Math.round(CLIPBOARD_WINDOW_MS / 60_000)
    toast({
      title: '诊断日志已复制到剪贴板',
      description: `最近 ${windowMin} 分钟 · 约 ${kb} KB，可直接粘贴给 AI`,
    })
  } catch (err) {
    toast({
      title: '复制诊断日志失败',
      description: err instanceof Error ? err.message : String(err),
      variant: 'destructive',
    })
  } finally {
    diagnosticsActionInFlight = false
  }
}

/**
 * 打开主进程日志所在目录（设置页「打开日志文件夹」按钮用）。
 */
export async function openDiagnosticsLogDir(): Promise<void> {
  try {
    await window.tabtin?.diagnostics?.openLogDir?.()
  } catch (err) {
    toast({
      title: '无法打开日志文件夹',
      description: err instanceof Error ? err.message : String(err),
      variant: 'destructive',
    })
  }
}

/**
 * 客户端诊断日志导出——主进程 IPC
 *
 * 职责边界（只做主进程能做、且必须做的事）：
 *   1. `diagnostics:read-logs` —— 读 electron-log 的 main.log / main.old.log
 *   2. `diagnostics:save-bundle` —— 渲染进程 zip base64 → 注入 main.log → 落盘
 *   3. `diagnostics:open-log-dir` —— 打开日志目录
 *
 * 三个 channel 一律返 wire envelope（`okResponse` / `errResponse`），由
 * preload `invokeIpc` unwrap；勿再塞进 LEGACY_HANDLERS。
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import { app, shell } from 'electron'
import { guardedHandle } from '../utils/guarded-handle'
import { createLogger } from '../logger'
import { sanitizeBundleFilename } from './bundle-filename'
import { readMainProcessLogSnapshot } from './read-main-logs'
import { mergeMainLogsIntoBundleBuffer } from './merge-main-logs-into-bundle'
import { queueSupportDiagnosticBundle } from './diagnostic-runtime'
import { flushPendingDiagnosticBundles } from './diagnostic-uploader'
import { getCLIOrganizationId } from '../cli/cli-context'
import { getDeviceFingerprint } from '../utils/deviceFingerprint'
import {
  wrapLogSnapshot,
  handleSaveBundle,
  handleOpenLogDir,
  handleQueueSupportUpload,
} from './diagnostics-handlers'
import { collectHostEnv } from './collect-host-env'
import { okResponse } from '@tabtin/agent-wire'

const log = createLogger('DiagnosticsIPC')

const CH_READ_LOGS = 'diagnostics:read-logs'
const CH_SAVE_BUNDLE = 'diagnostics:save-bundle'
const CH_OPEN_LOG_DIR = 'diagnostics:open-log-dir'
const CH_GET_HOST_ENV = 'diagnostics:get-host-env'
const CH_QUEUE_SUPPORT_UPLOAD = 'diagnostics:queue-support-upload'

const SUBDIR = path.join('TabTin', 'diagnostics')

function resolveDiagnosticsDir(): string {
  return path.join(app.getPath('downloads'), SUBDIR)
}

export function registerDiagnosticsIpc(): void {
  guardedHandle(CH_READ_LOGS, async () => {
    return wrapLogSnapshot(await readMainProcessLogSnapshot())
  })

  guardedHandle(CH_SAVE_BUNDLE, async (_event, payload: unknown) => {
    return handleSaveBundle(payload, {
      merge: mergeMainLogsIntoBundleBuffer,
      mkdir: fsp.mkdir,
      writeFile: fsp.writeFile,
      resolveDir: resolveDiagnosticsDir,
      reveal: (absolutePath) => {
        shell.showItemInFolder(absolutePath)
      },
      logError: (msg) => log.error(msg),
      logInfo: (msg) => log.info(msg),
    })
  })

  guardedHandle(CH_QUEUE_SUPPORT_UPLOAD, async (_event, payload: unknown) => {
    const organizationId = getCLIOrganizationId()
    if (!organizationId) throw new Error('当前未选择组织，无法上传诊断包')
    const result = await handleQueueSupportUpload(
      { ...(payload as object), organizationId, clientInstallId: getDeviceFingerprint() },
      { merge: mergeMainLogsIntoBundleBuffer, queue: queueSupportDiagnosticBundle },
    )
    void flushPendingDiagnosticBundles()
    return result
  })

  guardedHandle(CH_OPEN_LOG_DIR, async () => {
    return handleOpenLogDir({
      readSnapshot: readMainProcessLogSnapshot,
      mkdir: fsp.mkdir,
      openPath: (dir) => shell.openPath(dir),
    })
  })

  guardedHandle(CH_GET_HOST_ENV, async () => {
    return okResponse(collectHostEnv())
  })

  log.info('IPC handlers registered')
}

/** 仅供测试。 */
export const __internal = {
  sanitizeBundleFilename,
  resolveDiagnosticsDir,
  CH_READ_LOGS,
  CH_SAVE_BUNDLE,
  CH_OPEN_LOG_DIR,
  CH_GET_HOST_ENV,
  CH_QUEUE_SUPPORT_UPLOAD,
}

/**
 * Mobile → Electron control-device rewind contract.
 *
 * 手机本身没有工作区文件账本；它经后端把回退动作投递给绑定 Electron。本测试用
 * 真实 FileHistoryService 和真实临时工作区验证：device action 在回传“已应用”前，
 * 会把 tracked 文件恢复到锚点前，并把逐文件失败保留为 partial 状态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FileHistoryService } from '@tabtin/file-history-core'
import {
  previewControlDeviceFiles,
  rewindControlDeviceFiles,
} from '../../file-history/control-device-file-rewind'
import { executeDeviceSessionRewind } from '../device-session-rewind'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }
const sessionId = 'mobile-electron-session'
const anchorId = 'run-with-file-change'

let workspaceRoot: string
let historyRoot: string
let service: FileHistoryService

beforeEach(async () => {
  workspaceRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tabtin-mobile-rewind-ws-')))
  historyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tabtin-mobile-rewind-history-'))
  service = new FileHistoryService({
    threadId: sessionId,
    workspaceRoot,
    historyRoot,
    logger: silentLogger,
  })
})

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true })
  await fs.rm(historyRoot, { recursive: true, force: true })
})

function rewindFilesFromBoundElectron(anchor: string) {
  return rewindControlDeviceFiles(sessionId, anchor, {
    getFileHistory: async (requestedSessionId) => requestedSessionId === sessionId ? service : undefined,
    pathGuard: () => ({ allowed: true }),
  })
}

describe('mobile → Electron-hosted workspace file rewind', () => {
  it('当前设备没有文件账本时返回不可恢复，不把未知误说成无影响', async () => {
    const result = await executeDeviceSessionRewind({
      fileRewindAnchorId: anchorId,
      rewindTranscript: async () => ({ success: true, applied: true }),
      rewindFiles: (anchor) => rewindControlDeviceFiles(sessionId, anchor, {
        getFileHistory: async () => undefined,
        pathGuard: () => ({ allowed: true }),
      }),
    })

    expect(result).toMatchObject({
      success: true,
      data: {
        applied: true,
        file_restore_coordinated: true,
        file_restore_success: false,
        file_restore_status: 'unavailable',
        file_restore_reason: 'no_file_history',
      },
    })
  })

  it('预览找不到目标轮次时明确返回不可确认，不把空清单说成没有文件影响', async () => {
    const result = await previewControlDeviceFiles(sessionId, anchorId, {
      getFileHistory: async () => service,
      pathGuard: () => ({ allowed: true }),
    })

    expect(result).toMatchObject({
      success: false,
      status: 'unavailable',
      reason: 'file_snapshot_missing',
      paths: [],
      revision: expect.stringMatching(/^v2:[0-9a-f]{64}$/),
    })
  })

  it('本地文件预览修订会绑定确认时的当前内容', async () => {
    const trackedFile = path.join(workspaceRoot, 'src', 'revision.ts')
    await fs.mkdir(path.dirname(trackedFile), { recursive: true })
    await fs.writeFile(trackedFile, 'before\n')
    await service.beginSnapshot(anchorId)
    await service.trackEdit(anchorId, trackedFile)
    await fs.writeFile(trackedFile, 'after-confirmation-a\n')

    const first = await previewControlDeviceFiles(sessionId, anchorId, {
      getFileHistory: async () => service,
      pathGuard: () => ({ allowed: true }),
    })
    await fs.writeFile(trackedFile, 'after-confirmation-b\n')
    const second = await previewControlDeviceFiles(sessionId, anchorId, {
      getFileHistory: async () => service,
      pathGuard: () => ({ allowed: true }),
    })

    expect(first.revision).toMatch(/^v2:[0-9a-f]{64}$/)
    expect(second.revision).not.toBe(first.revision)
  })

  it('存在不可恢复账本项时预览为 unavailable，而不是空清单 not_applicable', async () => {
    const blocker = path.join(workspaceRoot, 'blocker')
    await fs.writeFile(blocker, 'file')
    await service.beginSnapshot(anchorId)
    await service.trackEdit(anchorId, path.join(blocker, 'child.ts'))

    const result = await previewControlDeviceFiles(sessionId, anchorId, {
      getFileHistory: async () => service,
      pathGuard: () => ({ allowed: true }),
    })

    expect(result).toMatchObject({
      success: false,
      status: 'unavailable',
      reason: 'unrestorable_files',
      paths: [],
      unrestorable: [expect.objectContaining({ reason: 'backup_failed' })],
    })
  })

  it('路径守卫拒绝时把具体受影响文件列入不可恢复清单', async () => {
    const trackedFile = path.join(workspaceRoot, 'protected', 'secret.bin')
    await fs.mkdir(path.dirname(trackedFile), { recursive: true })
    await fs.writeFile(trackedFile, Buffer.from([0x00, 0xff, 0x01]))
    await service.beginSnapshot(anchorId)
    await service.trackEdit(anchorId, trackedFile)
    await fs.writeFile(trackedFile, Buffer.from([0x02, 0xfe, 0x03]))

    const result = await previewControlDeviceFiles(sessionId, anchorId, {
      getFileHistory: async () => service,
      pathGuard: () => ({ allowed: false, reason: 'protected path' }),
      deviceFingerprint: 'device-path-guard',
    })

    expect(result).toMatchObject({
      success: false,
      status: 'unavailable',
      reason: 'path_guard_denied',
      paths: [trackedFile],
      unrestorable: [{ path: trackedFile, reason: 'path_guard_denied' }],
      revision: expect.stringMatching(/^v2:[0-9a-f]{64}$/),
    })
  })

  it('执行已确认的不可恢复结果时回传 revision 绑定的具体失败文件', async () => {
    const confirmedUnrestorableFiles = [
      { path: path.join(workspaceRoot, 'missing.bin'), reason: 'backup_missing' },
    ]
    const result = await executeDeviceSessionRewind({
      fileRewindAnchorId: anchorId,
      confirmedUnrestorableFiles,
      rewindTranscript: async () => ({ success: true, applied: true }),
      rewindFiles: async () => ({
        success: false,
        error: 'confirmed files have no restorable version',
        reason: 'unrestorable_files',
      }),
    })

    expect(result).toMatchObject({
      success: true,
      data: {
        applied: true,
        file_restore_success: false,
        file_restore_status: 'unavailable',
        file_restore_reason: 'unrestorable_files',
        failed_files: [confirmedUnrestorableFiles[0]!.path],
        unrestorable_files: confirmedUnrestorableFiles,
      },
    })
  })

  it('先回退有追踪改动的真实文件，再把成功结果交回后端投影', async () => {
    const trackedFile = path.join(workspaceRoot, 'src', 'app.ts')
    await fs.mkdir(path.dirname(trackedFile), { recursive: true })
    await fs.writeFile(trackedFile, 'export const version = 1\n')
    await service.beginSnapshot(anchorId)
    await service.trackEdit(anchorId, trackedFile)
    await fs.writeFile(trackedFile, 'export const version = 2\n')

    const rewindTranscript = vi.fn().mockResolvedValue({
      success: true,
      applied: true,
      keepMessageCount: 3,
    })
    const result = await executeDeviceSessionRewind({
      fileRewindAnchorId: anchorId,
      rewindTranscript,
      rewindFiles: rewindFilesFromBoundElectron,
    })

    expect(rewindTranscript).toHaveBeenCalledOnce()
    expect(await fs.readFile(trackedFile, 'utf8')).toBe('export const version = 1\n')
    expect(result).toMatchObject({
      success: true,
      data: {
        applied: true,
        keep_message_count: 3,
        file_restore_coordinated: true,
        file_restore_success: true,
        file_restore_status: 'success',
        failed_files: [],
      },
    })
  })

  it('文件账本损坏时保留对话回退，但明确返回 partial 而非假成功', async () => {
    const trackedFile = path.join(workspaceRoot, 'src', 'app.ts')
    await fs.mkdir(path.dirname(trackedFile), { recursive: true })
    await fs.writeFile(trackedFile, 'export const version = 1\n')
    await service.beginSnapshot(anchorId)
    await service.trackEdit(anchorId, trackedFile)
    await fs.writeFile(trackedFile, 'export const version = 2\n')
    await fs.rm(
      path.join(historyRoot, createHash('sha256').update(sessionId).digest('hex')),
      { recursive: true, force: true },
    )

    const result = await executeDeviceSessionRewind({
      fileRewindAnchorId: anchorId,
      rewindTranscript: async () => ({ success: true, applied: true }),
      rewindFiles: rewindFilesFromBoundElectron,
    })

    expect(await fs.readFile(trackedFile, 'utf8')).toBe('export const version = 2\n')
    expect(result).toMatchObject({
      success: true,
      data: {
        applied: true,
        file_restore_coordinated: true,
        file_restore_success: false,
        file_restore_status: 'failed',
        file_restore_reason: 'unrestorable_files',
        failed_files: [trackedFile],
      },
    })
  })

  it('transcript boundary 未命中时不触碰文件，也不给后端成功投影信号', async () => {
    const rewindFiles = vi.fn(rewindFilesFromBoundElectron)
    const result = await executeDeviceSessionRewind({
      fileRewindAnchorId: anchorId,
      rewindTranscript: async () => ({ success: true, applied: false }),
      rewindFiles,
    })

    expect(rewindFiles).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: true, data: { applied: false } })
  })
})

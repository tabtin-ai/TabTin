/**
 * 供给「当前用户在某 Project 下的伴生 Workspace」的客户端编排。
 *
 * 分层模型（principle/workspace-project.md）：Project 不执行，成员各自在伴生 Workspace
 * 里执行。供给动作必须在有 Electron 客户端时进行（要拿本机设备 + 本地目录）：
 *   1. 为该 Project 所属 Organization 注册/获取本机执行设备（拿 device_id）。
 *   2. 生成默认目录 ~/TabTin/<团队>/<Project名>（用户后续可改）。
 *   3. 调后端：创建者/存量成员走 ensureMyWorkspace；被邀请者走 acceptInvitation
 *      （同一事务里激活成员关系 + 供给 Workspace）。
 *
 * 两条链路共用本 helper，避免设备注册 + 目录生成的编排在多处重造。
 */
import { useDeviceStore } from '@stores/useDeviceStore'
import { ProjectApiService } from '@/services/projectApi'
import { createLogger } from '@/utils/logger'

const log = createLogger('provisionProjectWorkspace')

export interface ProvisionProjectWorkspaceOptions {
  organizationId: string
  organizationName: string
  projectId: string
  projectName: string
  /** accept：被邀请成员接受邀请；ensure：创建者 / 存量成员幂等补齐。 */
  mode: 'accept' | 'ensure'
  /** 可选：显式指定本地目录；不传则生成默认 ~/TabTin/<团队>/<Project名>。 */
  workingDir?: string
  workingDirType?: string
}

export interface CreateProjectWithWorkspaceOptions {
  organizationId: string
  organizationName: string
  projectName: string
  description?: string
  workingDir?: string
  workingDirType?: string
}

export type ProvisionResult =
  | { ok: true; workspace: { id: string; name: string; working_dir: string } }
  | { ok: false; error: string }

export type CreateProjectWithWorkspaceProvisionResult =
  | {
      ok: true
      project: Awaited<ReturnType<typeof ProjectApiService.createWithWorkspace>>['project']
      workspace: Awaited<ReturnType<typeof ProjectApiService.createWithWorkspace>>['workspace']
    }
  | { ok: false; error: string }

async function prepareProjectWorkspacePayload(opts: {
  organizationId: string
  organizationName: string
  projectName: string
  workingDir?: string
  workingDirType?: string
}): Promise<
  | {
      ok: true
      payload: {
        device_id: string
        working_dir: string
        working_dir_type: string
      }
    }
  | { ok: false; error: string }
> {
  const device = await useDeviceStore.getState().registerCurrentDevice(opts.organizationId)
  if (!device?.id) {
    return { ok: false, error: '正在识别本机执行设备，请稍后再试' }
  }

  let workingDir = opts.workingDir?.trim() || ''
  const workingDirType = opts.workingDirType || 'mixed'
  if (!workingDir) {
    const defaultDir = await window.tabtin?.fileSystem?.ensureDefaultAgentDir({
      organizationName: opts.organizationName,
      spaceName: opts.projectName,
    })
    if (!defaultDir?.success || !defaultDir.path) {
      return { ok: false, error: defaultDir?.error || '默认执行目录准备失败，请稍后再试' }
    }
    workingDir = defaultDir.path
  }

  return {
    ok: true,
    payload: {
      device_id: device.id,
      working_dir: workingDir,
      working_dir_type: workingDirType,
    },
  }
}

export async function createProjectWithCompanionWorkspace(
  opts: CreateProjectWithWorkspaceOptions,
): Promise<CreateProjectWithWorkspaceProvisionResult> {
  try {
    const prepared = await prepareProjectWorkspacePayload(opts)
    if (!prepared.ok) return prepared

    const result = await ProjectApiService.createWithWorkspace({
      organization_id: opts.organizationId,
      name: opts.projectName,
      description: opts.description ?? '',
      ...prepared.payload,
    })
    return { ok: true, project: result.project, workspace: result.workspace }
  } catch (error) {
    log.error('create project with workspace failed', {
      organizationId: opts.organizationId,
      message: error instanceof Error ? error.message : String(error),
    })
    return {
      ok: false,
      error: error instanceof Error ? error.message : '创建 Project 失败',
    }
  }
}

export async function provisionProjectCompanionWorkspace(
  opts: ProvisionProjectWorkspaceOptions,
): Promise<ProvisionResult> {
  const { organizationId, organizationName, projectId, projectName, mode } = opts
  try {
    const prepared = await prepareProjectWorkspacePayload({
      organizationId,
      organizationName,
      projectName,
      workingDir: opts.workingDir,
      workingDirType: opts.workingDirType,
    })
    if (!prepared.ok) return prepared

    if (mode === 'accept') {
      const result = await ProjectApiService.acceptInvitation(projectId, prepared.payload)
      return { ok: true, workspace: result.workspace }
    }
    const workspace = await ProjectApiService.ensureMyWorkspace(projectId, prepared.payload)
    return { ok: true, workspace }
  } catch (error) {
    log.error('provision companion workspace failed', {
      projectId,
      mode,
      message: error instanceof Error ? error.message : String(error),
    })
    return {
      ok: false,
      error: error instanceof Error ? error.message : '供给执行工作空间失败',
    }
  }
}

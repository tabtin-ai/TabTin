/**
 * 本机 Workspace 兜底判定（纯函数，无副作用、无 store/i18n 依赖，便于单测）。
 *
 * 判定当前 organization 是否缺「本机可用 / 未绑定」workspace。详见 ensureLocalWorkspace.ts。
 */

import {
  isCurrentDeviceControl,
  type DeviceControlView,
} from '@/services/deviceControlMatch'

/** 判定所需的最小 Space 视图，便于纯函数单测。 */
export interface WorkspaceDeviceView {
  organization_id: string;
  type?: string | null;
  project_id?: string | null;
  /** ：系统供给来源；优先于 project_id 判断是否算伴生内部现场 */
  provisioning_source?: string | null;
  is_companion?: boolean | null;
  control_device_id?: string | null;
  bound_device_id?: string | null;
  /** 工作空间适配行可能只投影这个字段（无 Space 壳）。 */
  owner_execution_device_id?: string | null;
}

/** 列出本机工作空间时额外需要的展示字段。 */
export interface LocalWorkspaceCandidate extends WorkspaceDeviceView {
  id: string;
  name: string;
  is_default?: boolean;
  last_activity_at?: string | null;
}

export interface LocalWorkspaceNeed {
  /** 当前 organization 是否缺「本机可用 / 未绑定」workspace，需要自动新建。 */
  needsCreate: boolean;
  /** 当前 organization 内 workspace（个人执行型，排除 team_space / 项目伴生）总数。 */
  workspaceCount: number;
  /** 存在 workspace 但全部绑在别的设备上（漂移信号）。 */
  allBoundToOthers: boolean;
}

const NO_NEED: LocalWorkspaceNeed = {
  needsCreate: false,
  workspaceCount: 0,
  allBoundToOthers: false,
};

function isSystemProvisionedWorkspace(space: WorkspaceDeviceView): boolean {
  const source = space.provisioning_source;
  if (source === 'system_project' || source === 'system_task') return true;
  return space.is_companion === true;
}

function isPersonalWorkspace(space: WorkspaceDeviceView): boolean {
  // ：用户工作空间改绑 Project 后仍有 project_id，但不能当伴生内部现场排除。
  return (
    (space.type == null || space.type === 'workspace') &&
    !isSystemProvisionedWorkspace(space)
  );
}

/**
 * 「本机可用 / 可自愈」：执行设备未绑定，或已等于当前设备。
 */
export function isLocalOrHealableWorkspace(
  space: WorkspaceDeviceView,
  currentDevice: DeviceControlView | null,
  devices: readonly DeviceControlView[] = [],
): boolean {
  // 工作空间适配行可能只带 owner_execution_device_id（无壳字段）。
  const controlDeviceId =
    space.control_device_id ??
    space.bound_device_id ??
    space.owner_execution_device_id ??
    null;
  if (controlDeviceId == null) return true;
  return isCurrentDeviceControl(controlDeviceId, currentDevice, devices);
}

/**
 * 列出当前 organization 内可切换的本机工作空间（排除 team_space / 项目伴生）。
 * 排序：默认优先 → 最近活动优先 → 名称。
 */
export function listLocalWorkspaces<T extends LocalWorkspaceCandidate>(
  spaces: readonly T[],
  currentOrganizationId: string | null,
  currentDevice: DeviceControlView | null,
  options?: { excludeSpaceId?: string | null; devices?: readonly DeviceControlView[] },
): T[] {
  if (!currentOrganizationId || !currentDevice?.id) return [];

  const excludeSpaceId = options?.excludeSpaceId ?? null;
  const devices = options?.devices ?? [];
  return spaces
    .filter(
      (space) =>
        space.organization_id === currentOrganizationId &&
        isPersonalWorkspace(space) &&
        space.id !== excludeSpaceId &&
        isLocalOrHealableWorkspace(space, currentDevice, devices),
    )
    .slice()
    .sort((a, b) => {
      if (Boolean(a.is_default) !== Boolean(b.is_default)) {
        return a.is_default ? -1 : 1;
      }
      const aActivity = a.last_activity_at ?? '';
      const bActivity = b.last_activity_at ?? '';
      if (aActivity !== bActivity) {
        return aActivity > bActivity ? -1 : 1;
      }
      return a.name.localeCompare(b.name, 'zh');
    });
}

/**
 * 判定当前 organization 是否缺「本机可用 / 未绑定」workspace。
 *
 * 「本机可用 / 可自愈」定义：执行设备（`control_device_id ?? bound_device_id`）
 *  - 未绑定（null）→ 交给 useEnsureAgentReady 自愈绑本机，或
 *  - 已等于当前设备 → 已是本机。
 *
 * 启动自动兜底只在「一个个人 workspace 都没有」时新建。
 * 「全部绑在他机」（设备指纹漂移）只标 allBoundToOthers，交给 RemoteAgentBanner
 * 显式「切回本机」；禁止启动期按组织连环 createSpace / ensureHome（会堆出
 * 默认 Workspace-N）。
 */
export function resolveLocalWorkspaceNeed(
  spaces: readonly WorkspaceDeviceView[],
  currentOrganizationId: string | null,
  currentDevice: DeviceControlView | null,
  devices: readonly DeviceControlView[] = [],
): LocalWorkspaceNeed {
  if (!currentOrganizationId || !currentDevice?.id) return NO_NEED;

  const workspaces = spaces.filter(
    (s) => s.organization_id === currentOrganizationId && isPersonalWorkspace(s),
  );

  const hasLocalOrHealable = workspaces.some((s) =>
    isLocalOrHealableWorkspace(s, currentDevice, devices),
  );

  const workspaceCount = workspaces.length;
  const allBoundToOthers = !hasLocalOrHealable && workspaceCount > 0;
  // 仅空组织自动建；他机占用由用户显式触发（force）。
  const needsCreate = !hasLocalOrHealable && workspaceCount === 0;
  return {
    needsCreate,
    workspaceCount,
    allBoundToOthers,
  };
}

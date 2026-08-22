/**
 * 本机 Workspace 自动兜底
 *
 * 设备身份 `fingerprint`（`electron-{uuid}`）代表一次安装。重装会产生新安装身份；
 * 若服务端因恢复证据不足而拒绝接管，存量工作空间仍钉在旧 Device.id 上，
 * 本机当前会话会被判为「远程 + 离线」。
 *
 * 本模块在客户端启动阶段做兜底：若当前选中 organization 内**一个个人 workspace 都没有**，
 * 则自动 ensureHome 并选中。若已有 workspace 但全钉在其它安装身份，启动期不建，
 * 由 RemoteAgentBanner 显式 force，避免多组织连环堆「默认工作空间-N」。
 * 远程离线 Space 保留展示，不改绑、不动后端绑定锁（改绑留待后续独立方案）。
 *
 * ：创建前必须确认该 organization 的 spaces 列表已成功加载；空列表 + 加载失败
 * 绝不能当成「缺本机工作空间」。创建前再强制 reload 一次并二次判定。
 */

import { useDeviceStore } from '@stores/useDeviceStore';
import { useSpaceListStore } from '@stores/useSpaceListStore';
import { useSpaceStore } from '@stores/useSpaceStore';
import { useOrganizationStore } from '@stores/useOrganizationStore';
import { registerResetAction } from '@stores/sessionResetRegistry';
import { createLogger } from '@utils/logger';
import { WorkspaceApiService } from '@tabtin/app-shell';
import { resolveLocalWorkspaceNeed } from './localWorkspaceNeed';

export {
  resolveLocalWorkspaceNeed,
  listLocalWorkspaces,
  isLocalOrHealableWorkspace,
  type WorkspaceDeviceView,
  type LocalWorkspaceCandidate,
  type LocalWorkspaceNeed,
} from './localWorkspaceNeed';

const log = createLogger('LocalWorkspace');

/** 与后端 onboarding_defaults.DEFAULT_ONBOARDING_SPACE_NAME 对齐；固定中文，不跟 UI 语言。 */
export const DEFAULT_LOCAL_WORKSPACE_NAME = '默认工作空间';

// 进程内去重：每个 organization 最多成功兜底一次；inflight 防并发风暴
// （对齐 useEnsureAgentReady 的 _bootstrappedAgents / _inflightAgents 写法）。
const bootstrappedOrganizations = new Set<string>();
const inflightOrganizations = new Set<string>();
const organizationBootstrapGenerations = new Map<string, number>();

function getBootstrapGeneration(organizationId: string): number {
  return organizationBootstrapGenerations.get(organizationId) ?? 0;
}

function isBootstrapGenerationCurrent(
  organizationId: string,
  generation: number,
): boolean {
  return getBootstrapGeneration(organizationId) === generation;
}

function bumpBootstrapGeneration(organizationId: string): void {
  organizationBootstrapGenerations.set(
    organizationId,
    getBootstrapGeneration(organizationId) + 1,
  );
}

function resolveOrganizationName(organizationId: string): string {
  const orgStore = useOrganizationStore.getState();
  if (orgStore.selectedOrganization?.id === organizationId) {
    return orgStore.selectedOrganization.name;
  }
  return (
    orgStore.organizations.find((o) => o.id === organizationId)?.name ?? ''
  );
}

function hasSpaceListLoadError(): boolean {
  const { error, lastLoadError } = useSpaceStore.getState();
  return Boolean(error || lastLoadError);
}

export type EnsureLocalWorkspaceOptions = {
  /**
   * 用户显式「切回本机」时允许在 allBoundToOthers 场景下建本机现场。
   * 启动自动兜底不得传 true（避免多组织连环堆默认工作空间）。
   */
  force?: boolean;
};

/**
 * 确保当前 organization 有一个本机可用 workspace；缺失则自动新建并选中。
 *
 * 调用方（useSpaceListLifecycle）需保证：已登录、设备已注册、该 organization spaces 已完成过
 * 一次**成功**加载。本函数内部自行读取最新 store 状态并二次判定，失败不标记完成、依赖上层重试。
 */
export async function ensureLocalWorkspaceForOrganization(
  organizationId: string,
  options?: EnsureLocalWorkspaceOptions,
): Promise<void> {
  if (!organizationId) return;
  const force = options?.force === true;
  if (
    (!force && bootstrappedOrganizations.has(organizationId)) ||
    inflightOrganizations.has(organizationId)
  ) {
    return;
  }

  const currentDevice = useDeviceStore.getState().currentDevice ?? null;
  if (!currentDevice?.id) return; // 设备未注册完，先等下一轮

  const devices = useDeviceStore.getState().devices ?? [];

  // 列表未成功加载时禁止创建（冷启动空数组 + 后端不可达的主增长路径）。
  if (hasSpaceListLoadError()) {
    log.warn(
      `skip auto-create for org=${organizationId}: space list still in error state`,
    );
    return;
  }

  const spaces = useSpaceStore.getState().spaces;
  const need = resolveLocalWorkspaceNeed(
    spaces,
    organizationId,
    currentDevice,
    devices,
  );
  const shouldCreate = need.needsCreate || (force && need.allBoundToOthers);
  if (!shouldCreate) {
    if (need.allBoundToOthers) {
      // 他机占用：启动期不建；标完成避免 effect(spaces) 反复空跑。
      bootstrappedOrganizations.add(organizationId);
      log.info(
        `skip auto-create for org=${organizationId}: allBoundToOthers ` +
          `(workspaceCount=${need.workspaceCount}); use RemoteAgentBanner to force`,
      );
    }
    return;
  }

  const bootstrapGeneration = getBootstrapGeneration(organizationId);
  inflightOrganizations.add(organizationId);
  log.info(
    `no local workspace in org=${organizationId}, auto-create ` +
      `(workspaceCount=${need.workspaceCount}, allBoundToOthers=${need.allBoundToOthers})`,
  );

  try {
    // 创建前强制刷新该组织列表，挡住「失败空列表 / 过期空列表」误建。
    await useSpaceStore.getState().loadSpaces(organizationId);
    if (!isBootstrapGenerationCurrent(organizationId, bootstrapGeneration)) {
      log.info(
        `skip auto-create for org=${organizationId}: bootstrap was invalidated`,
      );
      return;
    }
    if (hasSpaceListLoadError()) {
      log.warn(
        `skip auto-create for org=${organizationId}: refresh before create still failed`,
      );
      return;
    }

    const refreshedNeed = resolveLocalWorkspaceNeed(
      useSpaceStore.getState().spaces,
      organizationId,
      currentDevice,
      devices,
    );
    const stillNeedsCreate =
      refreshedNeed.needsCreate || (force && refreshedNeed.allBoundToOthers);
    if (!stillNeedsCreate) {
      if (isBootstrapGenerationCurrent(organizationId, bootstrapGeneration)) {
        bootstrappedOrganizations.add(organizationId);
      }
      log.info(
        `workspace already present after refresh for org=${organizationId}; skip create`,
      );
      return;
    }

    const organizationName = resolveOrganizationName(organizationId);
    const spaceName = DEFAULT_LOCAL_WORKSPACE_NAME;

    const dir = await window.tabtin?.fileSystem?.ensureDefaultAgentDir({
      organizationName,
      spaceName,
    });
    if (!dir?.success || !dir.path) {
      log.warn(
        `ensureDefaultAgentDir failed for org=${organizationId}: ${dir?.error ?? 'no path'}`,
      );
      return; // 不标记完成，下次重试
    }
    if (!isBootstrapGenerationCurrent(organizationId, bootstrapGeneration)) {
      log.info(
        `skip ensure-home for org=${organizationId}: bootstrap was invalidated`,
      );
      return;
    }

    const created = await WorkspaceApiService.ensureHome({
      organization_id: organizationId,
      name: spaceName,
      device_id: currentDevice.id,
      working_dir: dir.path,
      working_dir_type: 'mixed',
    });
    // ensure-home 的幂等结果必须属于请求的 Organization；否则不能把另一个
    // Organization 的主场当作当前组织已供给，避免空态被永久标记为已完成。
    if (created.organization_id !== organizationId) {
      throw new Error(
        `ensure-home returned workspace from another organization: ` +
          `expected=${organizationId} actual=${created.organization_id}`,
      );
    }
    if (!isBootstrapGenerationCurrent(organizationId, bootstrapGeneration)) {
      log.info(
        `skip post-create commit for org=${organizationId}: bootstrap was invalidated`,
      );
      return;
    }
    await useSpaceStore.getState().loadSpaces(organizationId);
    if (!isBootstrapGenerationCurrent(organizationId, bootstrapGeneration)) {
      log.info(
        `skip bootstrap commit for org=${organizationId}: bootstrap was invalidated`,
      );
      return;
    }
    bootstrappedOrganizations.add(organizationId);
    log.info(
      `local home workspace ensured: id=${created.id} org=${organizationId}`,
    );

    // 选中新建的本机工作空间，把用户从「远程离线」占位带到可用现场。
    try {
      useSpaceListStore.getState().selectSpaceBySpaceId(created.id);
    } catch (err) {
      log.warn(
        'select new local workspace failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  } catch (err) {
    log.warn(
      'ensureLocalWorkspace failed:',
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    inflightOrganizations.delete(organizationId);
  }
}

/** 成员退出组织后允许同一进程内的重新邀请再次恢复原 home Workspace。 */
export function invalidateLocalWorkspaceBootstrapForOrganization(
  organizationId: string,
): void {
  bumpBootstrapGeneration(organizationId);
  bootstrappedOrganizations.delete(organizationId);
}

// 登出 / token 失效时清空进程内兜底记录，避免下个账号复用上个账号的判定。
registerResetAction('local-workspace-bootstrap', 'reset', () => {
  bootstrappedOrganizations.clear();
  inflightOrganizations.clear();
  organizationBootstrapGenerations.clear();
});

/** 仅供单测重置模块级去重状态。 */
export function __resetLocalWorkspaceBootstrapForTests(): void {
  bootstrappedOrganizations.clear();
  inflightOrganizations.clear();
  organizationBootstrapGenerations.clear();
}

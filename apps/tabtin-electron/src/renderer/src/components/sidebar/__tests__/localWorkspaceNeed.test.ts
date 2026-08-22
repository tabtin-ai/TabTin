import { describe, expect, it } from 'vitest';
import {
  isLocalOrHealableWorkspace,
  listLocalWorkspaces,
  resolveLocalWorkspaceNeed,
  type LocalWorkspaceCandidate,
  type WorkspaceDeviceView,
} from '../localWorkspaceNeed';

const WT = 'wt-1';
const ME = 'electron-me';
const OTHER = 'electron-old-offline';

const meDevice = {
  id: ME,
  fingerprint: 'fp-me',
  name: 'Local Host (darwin)',
  status: 'online',
} as const;

const otherDevice = {
  id: OTHER,
  fingerprint: 'fp-other',
  name: 'Stale Host (win32)',
  status: 'offline',
} as const;

function ws(overrides: Partial<WorkspaceDeviceView> = {}): WorkspaceDeviceView {
  return {
    organization_id: WT,
    type: 'workspace',
    project_id: null,
    control_device_id: null,
    bound_device_id: null,
    ...overrides,
  };
}

function localWs(
  overrides: Partial<LocalWorkspaceCandidate> & Pick<LocalWorkspaceCandidate, 'id' | 'name'>,
): LocalWorkspaceCandidate {
  return {
    ...ws(),
    is_default: false,
    last_activity_at: null,
    ...overrides,
  };
}

describe('resolveLocalWorkspaceNeed', () => {
  it('本机已有：control_device_id 等于当前设备 → 不新建', () => {
    const res = resolveLocalWorkspaceNeed(
      [ws({ control_device_id: ME })],
      WT,
      meDevice,
    );
    expect(res.needsCreate).toBe(false);
    expect(res.workspaceCount).toBe(1);
    expect(res.allBoundToOthers).toBe(false);
  });

  it('仅远程：全部绑在别的设备上 → 不自动新建，只标 allBoundToOthers', () => {
    const res = resolveLocalWorkspaceNeed(
      [ws({ control_device_id: OTHER }), ws({ control_device_id: OTHER })],
      WT,
      meDevice,
      [otherDevice],
    );
    expect(res.needsCreate).toBe(false);
    expect(res.workspaceCount).toBe(2);
    expect(res.allBoundToOthers).toBe(true);
  });

  it('fingerprint 漂移：仅同名不算本机 → 不自动新建，标 allBoundToOthers', () => {
    const driftCurrent = {
      id: 'electron-new',
      fingerprint: 'fp-new',
      name: 'Stale Host (win32)',
      status: 'online',
    };
    const res = resolveLocalWorkspaceNeed(
      [ws({ control_device_id: OTHER })],
      WT,
      driftCurrent,
      [otherDevice, driftCurrent],
    );
    expect(res.needsCreate).toBe(false);
    expect(res.allBoundToOthers).toBe(true);
  });

  it('machine_key 相同仍不视为本机，避免同机多安装静默接管', () => {
    const driftCurrent = {
      id: 'electron-new',
      fingerprint: 'fp-new',
      machine_key: 'mk-same',
      name: 'Stale Host (win32)',
      status: 'online',
    };
    const stale = { ...otherDevice, machine_key: 'mk-same' };
    const res = resolveLocalWorkspaceNeed(
      [ws({ control_device_id: OTHER })],
      WT,
      driftCurrent,
      [stale, driftCurrent],
    );
    expect(res.needsCreate).toBe(false);
    expect(res.allBoundToOthers).toBe(true);
  });

  it('仅未绑定：control_device_id 为 null → 交给自愈，不新建', () => {
    const res = resolveLocalWorkspaceNeed([ws({ control_device_id: null })], WT, meDevice);
    expect(res.needsCreate).toBe(false);
    expect(res.allBoundToOthers).toBe(false);
  });

  it('空列表：workteam 内无任何 workspace → 需要新建，allBoundToOthers=false', () => {
    const res = resolveLocalWorkspaceNeed([], WT, meDevice);
    expect(res.needsCreate).toBe(true);
    expect(res.workspaceCount).toBe(0);
    expect(res.allBoundToOthers).toBe(false);
  });

  it('混合：有远程也有本机 → 存在本机可用，不新建', () => {
    const res = resolveLocalWorkspaceNeed(
      [ws({ control_device_id: OTHER }), ws({ control_device_id: ME })],
      WT,
      meDevice,
      [otherDevice, meDevice],
    );
    expect(res.needsCreate).toBe(false);
    expect(res.workspaceCount).toBe(2);
  });

  it('混合：有远程也有未绑定 → 未绑定可自愈，不新建', () => {
    const res = resolveLocalWorkspaceNeed(
      [ws({ control_device_id: OTHER }), ws({ control_device_id: null })],
      WT,
      meDevice,
      [otherDevice],
    );
    expect(res.needsCreate).toBe(false);
  });

  it('bound_device_id 兜底：control 为空但 bound 指向他机 → 标 allBoundToOthers，不自动新建', () => {
    const res = resolveLocalWorkspaceNeed(
      [ws({ control_device_id: null, bound_device_id: OTHER })],
      WT,
      meDevice,
      [otherDevice],
    );
    expect(res.needsCreate).toBe(false);
    expect(res.allBoundToOthers).toBe(true);
  });

  it('bound_device_id 兜底：bound 指向本机 → 视为本机', () => {
    const res = resolveLocalWorkspaceNeed(
      [ws({ control_device_id: null, bound_device_id: ME })],
      WT,
      meDevice,
    );
    expect(res.needsCreate).toBe(false);
  });

  it('只统计当前 organization：别的 organization 的本机 workspace 不算数', () => {
    const res = resolveLocalWorkspaceNeed(
      [ws({ organization_id: 'wt-other', control_device_id: ME })],
      WT,
      meDevice,
    );
    expect(res.needsCreate).toBe(true);
    expect(res.workspaceCount).toBe(0);
  });

  it('排除 team_space：团队 Space 不计入本机 workspace 判定', () => {
    const res = resolveLocalWorkspaceNeed(
      [ws({ type: 'team_space', control_device_id: ME })],
      WT,
      meDevice,
    );
    expect(res.needsCreate).toBe(true);
    expect(res.workspaceCount).toBe(0);
  });

  it('排除系统伴生 workspace：is_companion / system provisioning 不计入', () => {
    const res = resolveLocalWorkspaceNeed(
      [
        ws({
          project_id: 'proj-1',
          provisioning_source: 'system_project',
          is_companion: true,
          control_device_id: ME,
        }),
      ],
      WT,
      meDevice,
    );
    expect(res.needsCreate).toBe(true);
    expect(res.workspaceCount).toBe(0);
  });

  it('用户工作空间改绑后仍计入：仅有 project_id 不算伴生', () => {
    const res = resolveLocalWorkspaceNeed(
      [
        ws({
          project_id: 'proj-1',
          provisioning_source: 'user',
          is_companion: false,
          control_device_id: ME,
        }),
      ],
      WT,
      meDevice,
    );
    expect(res.needsCreate).toBe(false);
    expect(res.workspaceCount).toBe(1);
  });

  it('type 缺省（历史数据）：当作 workspace 处理', () => {
    const res = resolveLocalWorkspaceNeed(
      [ws({ type: undefined, control_device_id: ME })],
      WT,
      meDevice,
    );
    expect(res.needsCreate).toBe(false);
    expect(res.workspaceCount).toBe(1);
  });

  it('前置未就绪：currentDevice 为空 → 不判定需要新建', () => {
    const res = resolveLocalWorkspaceNeed([ws({ control_device_id: OTHER })], WT, null);
    expect(res.needsCreate).toBe(false);
  });

  it('前置未就绪：currentWorkteamId 为空 → 不判定需要新建', () => {
    const res = resolveLocalWorkspaceNeed([ws({ control_device_id: OTHER })], null, meDevice);
    expect(res.needsCreate).toBe(false);
  });
});

describe('isLocalOrHealableWorkspace / listLocalWorkspaces', () => {
  it('本机与未绑定视为可切换，他机不可', () => {
    expect(isLocalOrHealableWorkspace(ws({ control_device_id: ME }), meDevice)).toBe(true);
    expect(isLocalOrHealableWorkspace(ws({ control_device_id: null }), meDevice)).toBe(true);
    expect(
      isLocalOrHealableWorkspace(ws({ control_device_id: OTHER }), meDevice, [otherDevice]),
    ).toBe(false);
  });

  it('列出本机 Workspace：排除远程 / 当前 / team / 伴生，默认优先', () => {
    const listed = listLocalWorkspaces(
      [
        localWs({
          id: 'remote-1',
          name: '远程',
          control_device_id: OTHER,
          last_activity_at: '2026-07-10T12:00:00Z',
        }),
        localWs({
          id: 'local-old',
          name: '旧本机',
          control_device_id: ME,
          is_default: false,
          last_activity_at: '2026-07-01T00:00:00Z',
        }),
        localWs({
          id: 'local-default',
          name: '默认工作空间',
          control_device_id: ME,
          is_default: true,
          last_activity_at: '2026-06-01T00:00:00Z',
        }),
        localWs({
          id: 'current-remote',
          name: '当前远控',
          control_device_id: OTHER,
        }),
        localWs({
          id: 'team-1',
          name: '团队',
          type: 'team_space',
          control_device_id: ME,
        }),
        localWs({
          id: 'companion',
          name: '伴生',
          project_id: 'p1',
          provisioning_source: 'system_project',
          is_companion: true,
          control_device_id: ME,
        }),
      ],
      WT,
      meDevice,
      { excludeSpaceId: 'current-remote', devices: [otherDevice, meDevice] },
    );

    expect(listed.map((s) => s.id)).toEqual(['local-default', 'local-old']);
  });

  it('设备未就绪时列表为空', () => {
    expect(
      listLocalWorkspaces(
        [localWs({ id: 'local-1', name: '本机', control_device_id: ME })],
        WT,
        null,
      ),
    ).toEqual([]);
  });
});

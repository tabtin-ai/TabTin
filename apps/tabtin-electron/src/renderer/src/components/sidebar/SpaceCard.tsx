/**
 * Space 列表项组件
 *
 * 统一展示 workspace Space 与 IM 会话导航卡片。
 * 点击切换当前导航目标，右键菜单根据 navigationKind 差异化展示。
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useSpaceStore } from '@stores/useSpaceStore';
import { useDeviceStore } from '@stores/useDeviceStore';
import { useIMStore } from '@stores/useIMStore';
import { useSpaceListStore } from '@stores/useSpaceListStore';
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore';
import { openSpaceSettingsIntent } from '@components/space-settings/spaceSettingsNavigation';
import { AgentContextMenu } from './AgentContextMenu';
import { SpaceContextMenu } from './SpaceContextMenu';
import type { SpaceListItem } from '@tabtin/app-shell';
import {
  getSpaceNavigationIcon,
  getSpaceNavigationLabel,
  getSpaceVisibilityLabel,
} from '@tabtin/app-shell';
import { cn } from '@utils/cn';
import { useWorkbenchSceneStore } from '@/stores/useWorkbenchSceneStore';
import { usePendingReportStore } from '@/stores/usePendingReportStore';
import { alignChatPointerToWorkspace } from '@/stores/chat/session/reconcileSpacePointer';
import { formatOrganizationAffiliationTag } from '@/utils/organizationIdentity';

interface SpaceCardProps {
  space: SpaceListItem;
  isSelected: boolean;
}

export const SpaceCard: React.FC<SpaceCardProps> = React.memo(({ space, isSelected }) => {
  const { t } = useTranslation('sidebar');
  const selectSpace = useSpaceListStore((state) => state.selectSpace);
  const closeSettings = useSettingsSpaceStore((state) => state.closeSettings);
  const devices = useDeviceStore((state) => state.devices);
  const spaces = useSpaceStore((state) => state.spaces);
  const agentCache = useSpaceStore((state) => state.agentCache);
  const activateForegroundSpace = useWorkbenchSceneStore((state) => state.activateForegroundSpace);
  const pendingReportCount = usePendingReportStore((s) => s.pendingCountBySpaceId[space.source_id] ?? 0);

  const conversations = useIMStore((state) => state.conversations);

  const kind = space.navigationKind;
  const rawId = space.source_id;
  const fullSpace =
    kind === 'workspace' ? spaces.find((as) => as.id === rawId) : null;
  const conversation =
    kind === 'dm' || kind === 'im-group'
      ? conversations.find((c) => c.id === rawId)
      : null;

  const spaceAgentId = fullSpace?.execution_agent_id ?? fullSpace?.agent_id ?? null;
  const spaceAgent = spaceAgentId ? agentCache[spaceAgentId] : null;
  const controlDeviceId =
    fullSpace?.control_device_id
    ?? fullSpace?.bound_device_id
    ?? spaceAgent?.control_device_id
    ?? spaceAgent?.bound_device_id;
  const boundDevice = controlDeviceId
    ? devices.find((d) => d.id === controlDeviceId)
    : null;
  const deviceStatus = boundDevice?.status ?? null;
  const isDeviceOnline = deviceStatus === 'online';
  const isDeviceBusy = deviceStatus === 'busy';

  const handleClick = () => {
    closeSettings();
    selectSpace(space);
    if (kind === 'workspace') {
      activateForegroundSpace(rawId);
      // ：选中 Workspace 后立刻对齐 chat 指针，避免 UI 已切 Space 而发送仍绑旧会话
      alignChatPointerToWorkspace(rawId);
    }
  };

  const handleOpenSettings = () => {
    if (kind === 'workspace' && fullSpace) {
      openSpaceSettingsIntent(fullSpace.id, { activateWorkspaceSelection: true });
    }
  };

  const [avatarError, setAvatarError] = useState(false);
  // 工作空间是执行现场，不是可配置头像的社交身份；始终使用名称首字母。
  const customAvatar = kind === 'workspace' ? '' : space.avatar?.trim();
  const showAvatar = Boolean(customAvatar && !avatarError);
  const avatarSrc = customAvatar;
  const nameInitial = space.name?.charAt(0) || getSpaceNavigationIcon(kind, space.type);
  const cardTitle = buildTitle(space, boundDevice, deviceStatus, t);

  const card = (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        'group relative w-full h-10 rounded-xl flex items-center justify-center transition-all',
        isSelected ? '' : 'hover:bg-muted/30',
      )}
      title={cardTitle}
      aria-label={cardTitle}
    >
      {isSelected && (
        <span className="absolute -left-1 top-1/2 -translate-y-1/2 h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
      )}
      {showAvatar ? (
        <img
          src={avatarSrc}
          alt={space.name}
          className="h-8 w-8 rounded-lg object-cover select-none"
          draggable={false}
          onError={() => setAvatarError(true)}
        />
      ) : (
        <span className="h-8 w-8 rounded-lg bg-accent/10 text-accent text-body font-semibold flex items-center justify-center select-none">{nameInitial}</span>
      )}

      {/* workspace: 设备在线指示器 */}
      {kind === 'workspace' && controlDeviceId && (
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background',
            isDeviceOnline
              ? 'bg-success'
              : isDeviceBusy
                ? 'bg-warning'
                : 'bg-muted-foreground/40',
          )}
        />
      )}

      {/* IM 群聊会话：成员数或未读徽标 */}
      {kind === 'im-group' &&
        space.badge?.kind === 'members' &&
        space.badge.count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 rounded-full bg-muted text-caption font-medium text-muted-foreground flex items-center justify-center px-0.5">
            {space.badge.count}
          </span>
        )}

      {/* PRD 06 §5.6.3：后台任务完成 pending 汇报徽标 */}
      {kind === 'workspace' && pendingReportCount > 0 && space.unread_count === 0 && (
        <span
          className="absolute -top-1 -right-1 min-w-[16px] h-4 rounded-full bg-accent text-white text-caption font-medium flex items-center justify-center px-1 animate-in zoom-in-50 duration-200"
          title={t('pendingReport', { count: pendingReportCount, defaultValue: `${pendingReportCount} 个任务已完成` })}
        >
          {pendingReportCount > 99 ? '99+' : pendingReportCount}
        </span>
      )}

      {/* 未读消息徽标：当前正在查看的会话不展示 */}
      {space.unread_count > 0 && !isSelected && (
        <span className="absolute -top-1 -right-1 min-w-[16px] h-4 rounded-full bg-destructive text-white text-caption font-medium flex items-center justify-center px-1 animate-in zoom-in-50 duration-200">
          {space.unread_count > 99 ? '99+' : space.unread_count}
        </span>
      )}
    </button>
  );

  if (kind === 'workspace' && space) {
    return (
      <AgentContextMenu onSettings={handleOpenSettings} spaceId={rawId}>
        {card}
      </AgentContextMenu>
    );
  }

  if (kind === 'dm' || kind === 'im-group') {
    return (
      <SpaceContextMenu
        kind={kind}
        rawId={rawId}
        pinned={conversation?.pinned ?? false}
        muted={conversation?.is_muted ?? false}
      >
        {card}
      </SpaceContextMenu>
    );
  }

  return card;
});

SpaceCard.displayName = 'SpaceCard';

function buildTitle(
  space: SpaceListItem,
  boundDevice: { name: string; status: string } | null | undefined,
  deviceStatus: string | null,
  t: TFunction,
): string {
  const affiliationLabel = formatOrganizationAffiliationTag({
    organizationName: space.organization_name,
    organizationType: space.organization_type,
    personalLabel: t('personalIdentity', { defaultValue: '个人身份' }),
  });
  const organizationSuffix = affiliationLabel ? ` · ${affiliationLabel}` : '';
  const visibilitySuffix =
    space.navigationKind === 'workspace'
      ? ` · ${getSpaceVisibilityLabel(space.visibility, space.member_count)}`
      : '';
  const workingDir = getSpaceWorkingDir(space);
  const workingDirSuffix = workingDir
    ? ` · ${t('workingDirTitle', {
        defaultValue: '工作目录：{{dir}}',
        dir: workingDir,
      })}`
    : '';
  if (boundDevice) {
    const statusLabel =
      deviceStatus === 'online'
        ? t('deviceOnline')
        : deviceStatus === 'busy'
          ? t('deviceBusy')
          : t('deviceOffline');
    return `${space.name}${workingDirSuffix} · ${boundDevice.name} (${statusLabel})${visibilitySuffix}${organizationSuffix}`;
  }
  const navigationLabel = getSpaceNavigationLabel(space.navigationKind);
  return `${navigationLabel} · ${space.name}${workingDirSuffix}${visibilitySuffix}${organizationSuffix}`;
}

function getSpaceWorkingDir(space: SpaceListItem): string {
  return space.working_dir || space.normalized_working_dir || '';
}

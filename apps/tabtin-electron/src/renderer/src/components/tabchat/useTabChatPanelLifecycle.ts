import { useEffect } from 'react';
import { useAuthStore } from '@stores/useAuthStore';
import { useIMStore } from '@stores/useIMStore';
import { useOrganizationStore } from '@stores/useOrganizationStore';
import { startIMProvider } from '@/services/tabchatApi';

export function useTabChatPanelLifecycle(): void {
  const organizationId = useOrganizationStore((state) => state.selectedOrganization?.id);
  const userId = useAuthStore((state) => state.user?.id);
  const loadMembers = useOrganizationStore((state) => state.loadMembers);
  const loadConversations = useIMStore((state) => state.loadConversations);
  const loadLabels = useIMStore((state) => state.loadLabels);
  const connectionStatus = useIMStore((state) => state.connectionStatus);
  // TC-37：label 筛选变化时重新加载会话列表
  const activeLabelFilters = useIMStore((state) => state.activeLabelFilters);

  useEffect(() => {
    if (!organizationId || !userId || connectionStatus === 'connected') return;
    void startIMProvider({ organizationId, userId });
  }, [organizationId, userId, connectionStatus]);

  useEffect(() => {
    if (!organizationId) return;
    void loadConversations(organizationId);
    void loadLabels(organizationId);
    // ：进入消息域时始终保鲜成员快照；勿仅在 members 为空时拉取，
    // 否则已有缓存时新加入的组织成员会在通讯录里「过一阵才出现」。
    void loadMembers(organizationId);
  }, [organizationId, loadConversations, loadLabels, loadMembers]);

  // ：邀请被接受 / 重连后通知流会派发此事件；设置页刷 query，消息域刷 store。
  useEffect(() => {
    if (!organizationId) return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ organizationId?: string }>).detail;
      if (detail?.organizationId && detail.organizationId !== organizationId) return;
      void loadMembers(organizationId);
    };
    window.addEventListener('tabtin:organization-invitations-changed', handler);
    return () => {
      window.removeEventListener('tabtin:organization-invitations-changed', handler);
    };
  }, [organizationId, loadMembers]);

  // TC-37：筛选变化触发重新加载（organizationId 存在时）
  useEffect(() => {
    if (!organizationId) return;
    void loadConversations(organizationId);
  }, [activeLabelFilters, organizationId, loadConversations]);
}

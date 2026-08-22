/**
 * TabChatPanel — IM 主面板（双栏布局容器）
 *
 * 左栏：会话列表 | 右栏：聊天区
 * Centrifugo 连接和桌面通知跳转由 shell 级运行时统一管理。
 * organization 级会话加载由 lifecycle hook 承担，本组件只负责渲染 IM UI。
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useIMStore } from '@stores/useIMStore';
import { ConversationList } from './ConversationList';
import { ChatView } from './ChatView';
import { MessageSquare, WifiOff } from 'lucide-react';
import { useTabChatPanelLifecycle } from './useTabChatPanelLifecycle';
import { cn } from '@utils/cn';
import { MessageSearch } from './MessageSearch';
import { CreateConversationDialog } from './CreateConversationDialog';
import { IMContactsPanel } from '@components/layout/IMContactsPanel';
import { SidebarIMPrimaryNav } from '@components/layout/SidebarIMPrimaryNav';
import { useOrganizationStore } from '@stores/useOrganizationStore';
import { OrganizationProfileButton } from '@components/layout/OrganizationProfileButton';
import { SHELL_GLASS_FOOTER_CLASS } from '@components/layout/shellUi';
import { message, MESSAGE_ERROR_DURATION } from '@tabtin/smartsheet-ui/message';

const DETACHED_IM_SIDEBAR_SURFACE_CLASS = 'bg-transparent';
// 主内容卡片直接用主页卡片实际呈现的实底（bg-background），不再叠半透明
// surface-canvas-card 玻璃层——避免深色下比主窗口主页面更亮。
const DETACHED_IM_CONTENT_SURFACE_CLASS =
  'relative h-full min-h-0 min-w-0 overflow-hidden rounded-[12px] bg-background z-sticky';

interface TabChatPanelProps {
  /** full: 双栏全屏布局（会话列表+聊天区）; panel: 侧面板模式（仅当前会话） */
  mode?: 'full' | 'panel';
  /** embedded: 填满父容器；card: 独立窗口的大卡片布局 */
  surface?: 'embedded' | 'card';
  /** 左侧栏收起后，顶栏展开入口需要避让的宽度，单位 px */
  topBarLeftInset?: number;
  /** 右上角窗口控制 overlay 需要避让的宽度，单位 px */
  topBarRightInset?: number;
  /** IM 会话桌面态：隐藏聊天头部的内容筛选 tab（资产改由右侧收起栏 + 画布承载）。 */
  hideContentTabs?: boolean;
  /** 主窗口已有全局用户资料入口时关闭，独立消息窗口保留。 */
  showSidebarProfile?: boolean;
}

export const TabChatPanel: React.FC<TabChatPanelProps> = ({
  mode = 'full',
  surface = 'embedded',
  topBarLeftInset = 0,
  topBarRightInset = 0,
  hideContentTabs = false,
  showSidebarProfile = true,
}) => {
  const { t } = useTranslation('tabchat');
  const {
    conversations,
    currentConversationId,
    connectionStatus,
    sendError,
    dismissSendError,
    loadError,
    dismissLoadError,
    imSidebarView,
  } = useIMStore(
    useShallow((s) => ({
      conversations: s.conversations,
      currentConversationId: s.currentConversationId,
      connectionStatus: s.connectionStatus,
      sendError: s.sendError,
      dismissSendError: s.dismissSendError,
      loadError: s.loadError,
      dismissLoadError: s.dismissLoadError,
      imSidebarView: s.imSidebarView,
    })),
  );
  useTabChatPanelLifecycle();
  const isCardSurface = surface === 'card';
  const showContacts = imSidebarView === 'contacts';
  const organizationId = useOrganizationStore((state) => state.selectedOrganization?.id ?? '');
  const activeConversationId = conversations.some((conversation) => (
    conversation.id === currentConversationId
    && conversation.organization_id === organizationId
  ))
    ? currentConversationId
    : null;

  useEffect(() => {
    if (!sendError) return;

    message.error({ key: 'tabchat-send-error', content: t(sendError) });
    const timer = window.setTimeout(dismissSendError, MESSAGE_ERROR_DURATION);
    return () => window.clearTimeout(timer);
  }, [dismissSendError, sendError, t]);

  useEffect(() => {
    if (!loadError) return;

    message.error({ key: 'tabchat-load-error', content: t(loadError) });
    const timer = window.setTimeout(dismissLoadError, MESSAGE_ERROR_DURATION);
    return () => window.clearTimeout(timer);
  }, [dismissLoadError, loadError, t]);

  return (
    <div
      className={cn(
        'relative flex h-full min-w-0 w-full gap-2 bg-transparent @container',
      )}
    >
      {/* 连接状态提示条 */}
      {connectionStatus === 'connecting' && (
        <div className="absolute top-0 left-0 right-0 z-sticky bg-warning/10 border-b border-warning/20 px-4 py-1.5 flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-warning animate-pulse" />
          <span className="text-body text-warning">{t('connecting')}</span>
        </div>
      )}
      {connectionStatus === 'disconnected' && (
        <div className="absolute top-0 left-0 right-0 z-sticky bg-destructive/10 border-b border-destructive/20 px-4 py-1.5 flex items-center gap-2">
          <WifiOff className="h-3 w-3 text-destructive" />
          <span className="text-body text-destructive">
            {t('disconnected')}
          </span>
        </div>
      )}

      {/* 左栏：会话列表（panel 模式下隐藏） */}
      {mode === 'full' && (
        <div
          className={cn(
            'flex w-48 flex-shrink-0 flex-col @[640px]:w-60 @[900px]:w-72',
            isCardSurface
              ? DETACHED_IM_SIDEBAR_SURFACE_CLASS
              : 'bg-background',
          )}
        >
          {isCardSurface
            ? <DetachedIMSidebar showProfile={showSidebarProfile} />
            : <ConversationList />}
        </div>
      )}

      {/* 右栏：通讯录（select）或聊天区 */}
      <div
        className={cn(
          'flex min-h-0 min-w-0 flex-1 flex-col',
          isCardSurface && DETACHED_IM_CONTENT_SURFACE_CLASS,
        )}
      >
        {showContacts ? (
          <IMContactsPanel />
        ) : activeConversationId ? (
          <ChatView
            conversationId={activeConversationId}
            topBarLeftInset={topBarLeftInset}
            topBarRightInset={topBarRightInset}
            hideContentTabs={hideContentTabs}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center space-y-3">
              <div className="w-14 h-14 mx-auto rounded-full bg-muted/30 border border-border/40 flex items-center justify-center">
                <MessageSquare className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-body text-muted-foreground">
                {t('selectConversation')}
              </p>
            </div>
          </div>
        )}
      </div>

    </div>
  );
};

const DetachedIMSidebar: React.FC<{ showProfile: boolean }> = ({ showProfile }) => {
  const organizationId = useOrganizationStore((state) => state.selectedOrganization?.id ?? '');
  const imSidebarView = useIMStore((state) => state.imSidebarView);
  const setImSidebarView = useIMStore((state) => state.setImSidebarView);
  const isContactsActive = imSidebarView === 'contacts';
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  return (
    <div className="tabchat-skin flex h-full min-h-0 flex-col bg-transparent">
      <SidebarIMPrimaryNav
        isContactsActive={isContactsActive}
        createGroupDisabled={!organizationId}
        onToggleContacts={() => setImSidebarView(isContactsActive ? 'inbox' : 'contacts')}
        onCreateGroup={() => setIsCreateOpen(true)}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <MessageSearch organizationId={organizationId} embedded>
          <ConversationList embedded hideHeader showCreate={false} />
        </MessageSearch>
      </div>
      {/* 底部用户 profile：常规流式底栏（不浮动），与主窗口侧栏一致的同色卡片；
          团队切换经 useOrganizationSync 与主窗口双向同步；私信窗口不提供「新建团队」。 */}
      {showProfile ? (
        <div className={SHELL_GLASS_FOOTER_CLASS}>
          <OrganizationProfileButton className="w-full rounded-interactive" hideCreateOrganization />
        </div>
      ) : null}
      <CreateConversationDialog
        isOpen={isCreateOpen}
        initialTab="group"
        groupOnly
        onClose={() => setIsCreateOpen(false)}
      />
    </div>
  );
};

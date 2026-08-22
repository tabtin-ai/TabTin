import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, toast } from '@components/ui';
import { cn } from '@utils/cn';
import {
  SIDEBAR_META,
  SIDEBAR_SECTION_LABEL,
  SIDEBAR_TEXT_PRIMARY,
} from '@components/layout/sidebarUi';
import { provisionProjectCompanionWorkspace } from '@/services/provisionProjectWorkspace';
import { useSpaceStore } from '@stores/useSpaceStore';
import { usePendingProjectInvitationStore } from '@stores/usePendingProjectInvitationStore';
import type { PendingProjectInvitation } from '@/types/project';

/** 与 useNotificationEventStream 派发的 Project 邀请实时事件对齐。 */
export const PROJECT_INVITATION_RECEIVED_EVENT =
  'tabtin:project-invitation-received';

type ProjectInvitationReceivedDetail = {
  projectId?: string;
  organizationId?: string;
  isSync?: boolean;
};

interface PendingProjectInvitationsProps {
  organizationId: string | null;
  organizationName: string;
  onAccepted: (projectId: string) => void;
}

/** 在 Project 侧栏提供待接受邀请的明确入口。接受时才创建该成员自己的执行工作空间。 */
export const PendingProjectInvitations: React.FC<
  PendingProjectInvitationsProps
> = ({ organizationId, organizationName, onAccepted }) => {
  const { t } = useTranslation('project');
  const [acceptingProjectId, setAcceptingProjectId] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const invitationsAll = usePendingProjectInvitationStore(
    (state) => state.invitations,
  );
  const refresh = usePendingProjectInvitationStore((state) => state.refresh);
  const removeByProjectId = usePendingProjectInvitationStore(
    (state) => state.removeByProjectId,
  );

  const invitations = useMemo(
    () =>
      organizationId
        ? invitationsAll.filter(
            (invitation) => invitation.organization_id === organizationId,
          )
        : [],
    [invitationsAll, organizationId],
  );

  // ：挂载 / 切组织 / 收到 space.invitation* 后重拉，避免只在切组织时才出现。
  useEffect(() => {
    setAcceptingProjectId(null);
    setError(null);
    if (!organizationId) return;
    void refresh();
  }, [organizationId, refresh]);

  useEffect(() => {
    if (!organizationId) return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ProjectInvitationReceivedDetail>)
        .detail;
      if (
        detail?.organizationId &&
        detail.organizationId !== organizationId &&
        !detail.isSync
      ) {
        return;
      }
      void refresh();
    };

    window.addEventListener(PROJECT_INVITATION_RECEIVED_EVENT, handler);
    return () =>
      window.removeEventListener(PROJECT_INVITATION_RECEIVED_EVENT, handler);
  }, [organizationId, refresh]);

  const handleAccept = useCallback(
    async (invitation: PendingProjectInvitation) => {
      if (
        !organizationId ||
        invitation.organization_id !== organizationId ||
        acceptingProjectId
      )
        return;

      setAcceptingProjectId(invitation.project_id);
      setError(null);
      const result = await provisionProjectCompanionWorkspace({
        organizationId,
        organizationName,
        projectId: invitation.project_id,
        projectName: invitation.project_name,
        mode: 'accept',
      });
      setAcceptingProjectId(null);

      if (!result.ok) {
        setError(result.error);
        return;
      }

      removeByProjectId(invitation.project_id);
      await useSpaceStore.getState().loadSpaces(organizationId);
      toast({
        title: t('invitations.joined'),
        description: t('invitations.workspaceReady'),
      });
      onAccepted(invitation.project_id);
    },
    [
      acceptingProjectId,
      onAccepted,
      organizationId,
      organizationName,
      removeByProjectId,
      t,
    ],
  );

  if (invitations.length === 0 && !error) return null;

  return (
    <section
      className="mx-1.5 mb-2 rounded-md border border-border/40 bg-muted/10 p-2"
      aria-live="polite"
    >
      <p className={SIDEBAR_SECTION_LABEL}>{t('invitations.title')}</p>
      {invitations.map((invitation) => (
        <div
          key={invitation.project_id}
          className="mt-2 flex items-center justify-between gap-2"
        >
          <div className="min-w-0">
            <p
              className={cn(
                'truncate',
                SIDEBAR_TEXT_PRIMARY,
                'text-foreground',
              )}
            >
              {invitation.project_name}
            </p>
            <p className={cn('truncate', SIDEBAR_META)}>
              {t('invitations.invitedBy', {
                name: invitation.inviter_name || t('invitations.member'),
              })}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={acceptingProjectId !== null}
            onClick={() => void handleAccept(invitation)}
          >
            {acceptingProjectId === invitation.project_id
              ? t('invitations.preparing')
              : t('invitations.accept')}
          </Button>
        </div>
      ))}
      {error ? (
        <p className="mt-2 text-caption text-destructive">{error}</p>
      ) : null}
    </section>
  );
};

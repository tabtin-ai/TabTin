import React from 'react';
import { Users } from 'lucide-react';
import type {
  CollaborationAction,
  CollaborationPhase,
} from '@/services/im/cards/sharedTaskCardControl';
import {
  SharedTaskCardSurface,
  type SharedTaskCardAction,
  type SharedTaskCardTone,
} from './SharedTaskCardSurface';

export interface SessionCollaborationCardContent {
  kindLabel: string;
  statusLabel: string;
  secondaryStatusLabel?: string;
  relation: string;
  permissionLabel: string;
  permissionCopy: string;
  infoTitle: string;
  infoMeta?: string;
  infoDescription: string;
  infoSteps?: Array<{ id: string; label: string; status: 'running' | 'done' | 'error' }>;
  infoResources?: Array<{ label: string }>;
  footer: string;
}

interface Props {
  phase: CollaborationPhase;
  title: string;
  content: SessionCollaborationCardContent;
  action: SharedTaskCardAction<CollaborationAction> | null;
  onAction?: (action: CollaborationAction) => void;
}

const PRIMARY_TONE: Record<CollaborationPhase, SharedTaskCardTone> = {
  sending: 'warning',
  awaitingJoin: 'warning',
  joining: 'warning',
  activeView: 'success',
  activeCollaborate: 'success',
  ownerOffline: 'success',
  deliveryUnconfirmed: 'success',
  stopped: 'neutral',
  ineligible: 'danger',
  detailError: 'danger',
};

const INFO_TONE: Record<CollaborationPhase, SharedTaskCardTone> = {
  sending: 'warning',
  awaitingJoin: 'default',
  joining: 'default',
  activeView: 'default',
  activeCollaborate: 'default',
  ownerOffline: 'warning',
  deliveryUnconfirmed: 'warning',
  stopped: 'neutral',
  ineligible: 'danger',
  detailError: 'danger',
};

/** 新协作卡的纯渲染层：仅消费显式状态与文案，不读 Store/API/EventBus。 */
export function SessionCollaborationCard({
  phase,
  title,
  content,
  action,
  onAction,
}: Props) {
  const opensTask = action?.id === 'openOriginalTask'
    || action?.id === 'openCollaboration'
    || action?.id === 'openCollaborationHistory';

  return (
    <SharedTaskCardSurface
      onAction={onAction}
      view={{
        family: 'collaboration',
        phase,
        icon: <Users className="h-3.5 w-3.5" aria-hidden />,
        kindLabel: content.kindLabel,
        title,
        badges: [
          { label: content.statusLabel, tone: PRIMARY_TONE[phase] },
          ...(content.secondaryStatusLabel
            ? [
                {
                  label: content.secondaryStatusLabel,
                  tone: 'warning' as const,
                },
              ]
            : []),
        ],
        relation: content.relation,
        permissionLabel: content.permissionLabel,
        permissionCopy: content.permissionCopy,
        info: {
          tone: INFO_TONE[phase],
          title: content.infoTitle,
          meta: content.infoMeta,
          description: content.infoDescription,
          steps: content.infoSteps,
          resources: content.infoResources,
        },
        footer: content.footer,
        action,
        actionPlacement: opensTask ? 'card' : 'footer',
        muted: phase === 'stopped' || phase === 'ineligible',
      }}
    />
  );
}

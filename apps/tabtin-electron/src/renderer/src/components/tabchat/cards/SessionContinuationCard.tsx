import React from 'react';
import { GitBranchPlus } from 'lucide-react';
import type {
  ContinuationAction,
  ContinuationPhase,
} from '@/services/im/cards/sharedTaskCardControl';
import {
  SharedTaskCardSurface,
  type SharedTaskCardAction,
  type SharedTaskCardResource,
  type SharedTaskCardTone,
} from './SharedTaskCardSurface';

export interface SessionContinuationCardContent {
  kindLabel: string;
  statusLabel: string;
  secondaryStatusLabel?: string;
  relation: string;
  permissionLabel: string;
  permissionCopy: string;
  infoTitle: string;
  infoMeta?: string;
  infoDescription: string;
  resources?: SharedTaskCardResource[];
  footer: string;
}

interface Props {
  phase: ContinuationPhase;
  title: string;
  content: SessionContinuationCardContent;
  action: SharedTaskCardAction<ContinuationAction> | null;
  onAction?: (action: ContinuationAction) => void;
}

const PRIMARY_TONE: Record<ContinuationPhase, SharedTaskCardTone> = {
  sending: 'warning',
  pending: 'warning',
  truncated: 'warning',
  partial: 'warning',
  empty: 'danger',
  creating: 'warning',
  created: 'success',
  createFailed: 'danger',
  invalid: 'danger',
  detailError: 'danger',
};

const INFO_TONE: Record<ContinuationPhase, SharedTaskCardTone> = {
  sending: 'warning',
  pending: 'default',
  truncated: 'warning',
  partial: 'default',
  empty: 'danger',
  creating: 'default',
  created: 'default',
  createFailed: 'danger',
  invalid: 'danger',
  detailError: 'danger',
};

/** 新续接卡的纯渲染层：不持有冻结上下文，也不执行创建请求。 */
export function SessionContinuationCard({
  phase,
  title,
  content,
  action,
  onAction,
}: Props) {
  return (
    <SharedTaskCardSurface
      onAction={onAction}
      view={{
        family: 'continuation',
        phase,
        icon: <GitBranchPlus className="h-3.5 w-3.5" aria-hidden />,
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
          resources: content.resources,
        },
        footer: content.footer,
        action,
        muted: phase === 'invalid',
      }}
    />
  );
}

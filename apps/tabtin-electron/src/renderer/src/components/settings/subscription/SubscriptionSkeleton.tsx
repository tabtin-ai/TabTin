import React from 'react'
import { ManagementCardListSkeleton, DetailedRowListSkeleton } from '@components/common/ListSkeletons'

export const SubscriptionSkeleton: React.FC = () => (
  <div className="space-y-4 py-2" data-testid="subscription-skeleton">
    <ManagementCardListSkeleton count={2} />
    <DetailedRowListSkeleton count={6} compact showPreview={false} />
  </div>
)

SubscriptionSkeleton.displayName = 'SubscriptionSkeleton'

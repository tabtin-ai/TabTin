/**
 * LoadingPlaceholder — pulse-animated placeholder for tool cards in loading state.
 *
 * Shown when a tool is executing (phase='start') and no data is available yet.
 */

import React from 'react'
import { Skeleton } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'
import { CARD_HEADER_PADDING } from '../../registry/chatDesignTokens'

const LoadingPlaceholder: React.FC = React.memo(() => (
  <div className={cn(CARD_HEADER_PADDING.x, 'space-y-1.5 py-2')} aria-hidden="true">
    <Skeleton width="75%" height={12} rounded="md" />
    <Skeleton width="50%" height={12} rounded="md" className="opacity-80" />
  </div>
))

LoadingPlaceholder.displayName = 'LoadingPlaceholder'

export { LoadingPlaceholder }
export default LoadingPlaceholder

import type { GitBranchMeta } from '@shared/git-types'

export function canPushBranch(branchMeta: GitBranchMeta): boolean {
  if (branchMeta.isDetached) return false
  if (branchMeta.behind > 0) return false
  if (branchMeta.ahead > 0) return true
  return !branchMeta.upstream
}

export function getPushDisabledReasonKey(
  branchMeta: GitBranchMeta,
):
  | 'gitFlow.pushDisabledDetached'
  | 'gitFlow.pushDisabledBehind'
  | 'gitFlow.pushDisabledNoAhead'
  | null {
  if (branchMeta.isDetached) return 'gitFlow.pushDisabledDetached'
  if (branchMeta.behind > 0) return 'gitFlow.pushDisabledBehind'
  if (branchMeta.ahead <= 0 && branchMeta.upstream) {
    return 'gitFlow.pushDisabledNoAhead'
  }
  return null
}

export function resolvePushRemote(upstream: string | undefined | null): string {
  if (upstream && upstream.includes('/')) return upstream.split('/')[0] || 'origin'
  return 'origin'
}

export type CreateWorktreeValidationReason =
  | 'path_required'
  | 'branch_required'
  | 'branch_not_found'

export interface CreateWorktreeInput {
  path: string
  branch: string
  createBranch: boolean
  existingBranchNames: string[]
}

export function validateCreateWorktreeInput(
  input: CreateWorktreeInput,
): CreateWorktreeValidationReason | null {
  const pathValue = input.path.trim()
  if (!pathValue) return 'path_required'

  const branchValue = input.branch.trim()
  if (input.createBranch) {
    return branchValue ? null : 'branch_required'
  }

  if (branchValue && !input.existingBranchNames.includes(branchValue)) {
    return 'branch_not_found'
  }
  return null
}

export function resolveCreateWorktreeBranch(input: {
  branch: string
  createBranch: boolean
  baseBranch?: string
  currentBranch?: string
}): string {
  const branchValue = input.branch.trim()
  if (branchValue) return branchValue
  if (input.createBranch) return ''
  return (input.baseBranch || input.currentBranch || '').trim()
}

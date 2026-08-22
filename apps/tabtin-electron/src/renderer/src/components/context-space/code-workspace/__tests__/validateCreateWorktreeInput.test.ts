import { describe, expect, it } from 'vitest'
import {
  resolveCreateWorktreeBranch,
  validateCreateWorktreeInput,
} from '../validateCreateWorktreeInput'

describe('validateCreateWorktreeInput', () => {
  it('requires a path', () => {
    expect(validateCreateWorktreeInput({
      path: '  ',
      branch: 'feat/demo-wt',
      createBranch: true,
      existingBranchNames: ['main'],
    })).toBe('path_required')
  })

  it('requires a branch when creating one', () => {
    expect(validateCreateWorktreeInput({
      path: '/repo-wt',
      branch: '',
      createBranch: true,
      existingBranchNames: ['main'],
    })).toBe('branch_required')
  })

  it('rejects a missing existing branch', () => {
    expect(validateCreateWorktreeInput({
      path: '/repo-wt',
      branch: 'feat/missing',
      createBranch: false,
      existingBranchNames: ['main'],
    })).toBe('branch_not_found')
  })

  it('accepts a new branch and path', () => {
    expect(validateCreateWorktreeInput({
      path: '/repo-wt',
      branch: 'feat/demo-wt',
      createBranch: true,
      existingBranchNames: ['main'],
    })).toBeNull()
  })
})

describe('resolveCreateWorktreeBranch', () => {
  it('uses the typed branch first', () => {
    expect(resolveCreateWorktreeBranch({
      branch: 'feat/demo-wt',
      createBranch: false,
      baseBranch: 'main',
      currentBranch: 'feat/demo',
    })).toBe('feat/demo-wt')
  })

  it('falls back to base then current when not creating a branch', () => {
    expect(resolveCreateWorktreeBranch({
      branch: '',
      createBranch: false,
      baseBranch: 'main',
      currentBranch: 'feat/demo',
    })).toBe('main')
  })
})

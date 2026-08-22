import { describe, expect, it, vi } from 'vitest'
import type { AgentConfigV3, WorkspaceSources } from '@tabtin/security-policy'
import {
  applyAuthoritativeSecurityMutate,
  applyWorkspaceSnapshotMutate,
  type QuerySessionSecurityView,
  type QuerySessionWorkspaceSnapshotLike,
} from '../src/conversation/query-session-mutate.js'

function makeSession(): QuerySessionSecurityView {
  const agentConfigV3: AgentConfigV3 = {
    schema_version: 3,
    runtime_plane: 'local',
    security: { allow_yolo_mode: false, approval_grant: 'always_ask' },
  }
  return {
    agentConfigV3,
    policyContext: {
      currentAgentMode: 'agent',
      isGroupSpace: false,
      requestedApprovalMode: 'auto',
    },
  }
}

describe('applyAuthoritativeSecurityMutate', () => {
  it('writes authoritative allow_yolo / approval_grant into security in-place', () => {
    const session = makeSession()
    const originalAgentConfig = session.agentConfigV3
    applyAuthoritativeSecurityMutate(session, {
      allowYolo: true,
      approvalGrant: 'auto',
      agentMode: 'yolo',
    })
    expect(session.agentConfigV3).toBe(originalAgentConfig) // ref preserved (PD-13)
    expect(session.agentConfigV3?.security.allow_yolo_mode).toBe(true)
    expect(session.agentConfigV3?.security.approval_grant).toBe('auto')
    expect(session.policyContext.currentAgentMode).toBe('yolo')
  })

  it('drops illegal approval_grant to undefined (build-policy legacy fallback)', () => {
    const session = makeSession()
    applyAuthoritativeSecurityMutate(session, {
      allowYolo: false,
      approvalGrant: 'nonsense',
      agentMode: 'agent',
    })
    expect(session.agentConfigV3?.security.approval_grant).toBeUndefined()
  })

  it('writes undefined approvalGrant / requestedApprovalMode when missing (清粘滞)', () => {
    const session = makeSession()
    applyAuthoritativeSecurityMutate(session, {
      allowYolo: false,
      approvalGrant: null,
      agentMode: 'agent',
      requestedApprovalMode: undefined,
    })
    expect(session.agentConfigV3?.security.approval_grant).toBeUndefined()
    expect(session.policyContext.requestedApprovalMode).toBeUndefined()
  })

  it('drops illegal requestedApprovalMode to undefined', () => {
    const session = makeSession()
    applyAuthoritativeSecurityMutate(session, {
      allowYolo: false,
      agentMode: 'agent',
      requestedApprovalMode: 'nonsense',
    })
    expect(session.policyContext.requestedApprovalMode).toBeUndefined()
  })

  it('coerces isGroupSpace: only literal true sets true', () => {
    const session = makeSession()
    applyAuthoritativeSecurityMutate(session, {
      allowYolo: false,
      agentMode: 'agent',
      isGroupSpace: undefined,
    })
    expect(session.policyContext.isGroupSpace).toBe(false)

    applyAuthoritativeSecurityMutate(session, {
      allowYolo: false,
      agentMode: 'agent',
      isGroupSpace: true,
    })
    expect(session.policyContext.isGroupSpace).toBe(true)
  })

  it('leaves security untouched when agentConfigV3 is missing but still writes policyContext', () => {
    const session: QuerySessionSecurityView = {
      agentConfigV3: null,
      policyContext: { currentAgentMode: 'agent', isGroupSpace: false },
    }
    applyAuthoritativeSecurityMutate(session, {
      allowYolo: true,
      approvalGrant: 'auto',
      agentMode: 'plan',
      requestedApprovalMode: 'auto',
      isGroupSpace: true,
    })
    expect(session.agentConfigV3).toBeNull()
    expect(session.policyContext.currentAgentMode).toBe('plan')
    expect(session.policyContext.requestedApprovalMode).toBeUndefined()
    expect(session.policyContext.isGroupSpace).toBe(true)
  })
})

function makeWorkspace(): QuerySessionWorkspaceSnapshotLike {
  const sources: WorkspaceSources = {
    sandbox: '/tabtin/sandbox',
    workingDir: '/tabtin/wd-old',
    sessionApprovedPaths: ['/tabtin/approved-old'],
    attachedFiles: ['/tabtin/attach-old.txt'],
  }
  return {
    sources,
    allowedPaths: ['/tabtin/sandbox', '/tabtin/wd-old', '/tabtin/approved-old'],
    allowedFiles: ['/tabtin/attach-old.txt'],
    spaceSessionId: 'space-1',
  }
}

describe('applyWorkspaceSnapshotMutate', () => {
  it('overrides sources when incoming has content and re-derives allowedPaths', () => {
    const dst = makeWorkspace()
    const originalSources = dst.sources
    applyWorkspaceSnapshotMutate(dst, {
      sources: {
        sandbox: '/tabtin/sandbox-new',
        workingDir: '/tabtin/wd-new',
        attachedFiles: ['/tabtin/attach-new.txt'],
      },
      allowedFiles: ['/tabtin/attach-new.txt'],
    })
    expect(dst.sources).toBe(originalSources) // ref preserved (PD-13)
    expect(dst.sources.sandbox).toBe('/tabtin/sandbox-new')
    expect(dst.sources.workingDir).toBe('/tabtin/wd-new')
    expect(dst.sources.attachedFiles).toEqual(['/tabtin/attach-new.txt'])
    // Old sessionApprovedPaths is preserved (incoming.sources.sessionApprovedPaths untouched)
    expect(dst.sources.sessionApprovedPaths).toEqual(['/tabtin/approved-old'])
    // allowedPaths re-derived from sandbox + workingDir + sessionApprovedPaths
    expect(new Set(dst.allowedPaths)).toEqual(
      new Set(['/tabtin/sandbox-new', '/tabtin/wd-new', '/tabtin/approved-old']),
    )
    expect(dst.allowedFiles).toEqual(['/tabtin/attach-new.txt'])
  })

  it('treats empty strings / empty arrays as omit (W6 M3 空数组防御)', () => {
    const dst = makeWorkspace()
    applyWorkspaceSnapshotMutate(dst, {
      sources: {
        sandbox: '',
        workingDir: '',
        attachedFiles: [],
      },
      allowedFiles: [],
    })
    expect(dst.sources.sandbox).toBe('/tabtin/sandbox')
    expect(dst.sources.workingDir).toBe('/tabtin/wd-old')
    expect(dst.sources.attachedFiles).toEqual(['/tabtin/attach-old.txt'])
    expect(dst.allowedFiles).toEqual(['/tabtin/attach-old.txt'])
  })

  it('always re-derives allowedPaths (does not trust wire-side allowedPaths)', () => {
    const dst = makeWorkspace()
    applyWorkspaceSnapshotMutate(
      dst,
      {
        allowedPaths: ['/malicious/hijack'],
      } as unknown as { allowedPaths: string[] },
    )
    // allowedPaths must NOT contain '/malicious/hijack' — re-derived from sources
    expect(dst.allowedPaths).not.toContain('/malicious/hijack')
    expect(new Set(dst.allowedPaths)).toEqual(
      new Set(['/tabtin/sandbox', '/tabtin/wd-old', '/tabtin/approved-old']),
    )
  })

  it('uses injected reconcileAllowedPaths when Electron passes workspaceBoundary.reconcileSnapshot', () => {
    const dst = makeWorkspace()
    const reconcile = vi.fn((snapshot: QuerySessionWorkspaceSnapshotLike) => {
      snapshot.allowedPaths = ['/from/reconcile']
    })
    applyWorkspaceSnapshotMutate(
      dst,
      { sources: { workingDir: '/tabtin/wd-new' } },
      { reconcileAllowedPaths: reconcile },
    )
    expect(reconcile).toHaveBeenCalledWith(dst)
    expect(dst.allowedPaths).toEqual(['/from/reconcile'])
  })

  it('filters dangerously broad paths in default re-derive fallback', () => {
    const dst: QuerySessionWorkspaceSnapshotLike = {
      sources: {
        sandbox: '/',
        workingDir: '/tabtin/wd',
        sessionApprovedPaths: ['/', '/tabtin/approved'],
        attachedFiles: [],
      },
      allowedPaths: [],
      allowedFiles: [],
      spaceSessionId: 'space-x',
    }
    applyWorkspaceSnapshotMutate(dst, {})
    expect(dst.allowedPaths).not.toContain('/')
    expect(dst.allowedPaths).toContain('/tabtin/wd')
    expect(dst.allowedPaths).toContain('/tabtin/approved')
  })
})

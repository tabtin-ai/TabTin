import { vi } from 'vitest'

import type {
  ActionExecutionPorts,
  TranscriptRollbackPort,
} from '../../src/application/execution/action-bridge.js'

type ApprovalHandler = ActionExecutionPorts['requestApproval']
type ResultHandler = ActionExecutionPorts['sendResult']

export interface ActionExecutionTestPorts extends ActionExecutionPorts {
  approvalHandler: ApprovalHandler
  resultHandler: ResultHandler
  ptyAvailable: boolean
  browserAvailable: boolean
  transcriptRollbackPort: TranscriptRollbackPort | null
}

export function createActionExecutionTestPorts(): ActionExecutionTestPorts {
  const ports: ActionExecutionTestPorts = {
    approvalHandler: async () => false,
    resultHandler: async () => {},
    ptyAvailable: false,
    browserAvailable: false,
    transcriptRollbackPort: null,
    sendResult: (...args) => ports.resultHandler(...args),
    sendMonitorEvent: async () => {},
    requestApproval: (...args) => ports.approvalHandler(...args),
    isPtyAvailable: () => ports.ptyAvailable,
    isBrowserAvailable: () => ports.browserAvailable,
    resolveWorkspaceSnapshot: () => null,
    getTranscriptRollbackPort: () => ports.transcriptRollbackPort,
    gitStatusRegistry: {
      getOrCreate: vi.fn(),
      invalidateAndNotify: vi.fn(),
    } as any,
    workspaceHistory: {
      checkpoints: {
        init: vi.fn(),
        commit: vi.fn(),
        restore: vi.fn(),
        diff: vi.fn(),
        destroy: vi.fn(),
        initialCommit: vi.fn(),
        gc: vi.fn(),
        writeTree: vi.fn(),
        diffSummary: vi.fn(),
        affectedPaths: vi.fn(),
        dispose: vi.fn(),
      },
      files: {
        rewind: vi.fn(),
        affectedPaths: vi.fn(),
      },
    },
  }
  return ports
}

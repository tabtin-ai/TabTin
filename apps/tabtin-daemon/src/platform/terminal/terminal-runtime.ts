import {
  setPtyManagerAPI,
  setPtyManagerBridge,
  type PtyManagerAPI,
} from '@tabtin/action-tools/headless'

import type { DaemonConfig } from '../../base/types/daemon-config.js'
import type { Logger } from '../observability/logging/logger.js'
import {
  createDaemonPtyManagerBridge,
  type DaemonPtyManagerBridge,
} from './DaemonPtyManagerBridge.js'
import { DaemonPtyManager } from './daemon-pty-manager.js'

let publishedTerminalRuntime: TerminalRuntime | null = null

function claimTerminalAdapters(owner: TerminalRuntime): void {
  if (publishedTerminalRuntime && publishedTerminalRuntime !== owner) {
    throw new Error('A TerminalRuntime is already published')
  }
  publishedTerminalRuntime = owner
}

function releaseTerminalAdapters(owner: TerminalRuntime): boolean {
  if (publishedTerminalRuntime !== owner) return false
  publishedTerminalRuntime = null
  setPtyManagerBridge(null)
  setPtyManagerAPI(null)
  return true
}

/**
 * Owns the complete Daemon terminal lifecycle.
 *
 * The action-tools globals are compatibility adapters only. Their lifetime is
 * contained here and they never become a source of terminal state ownership.
 */
export class TerminalRuntime {
  private manager: DaemonPtyManager | null = null
  private agentBridge: DaemonPtyManagerBridge | null = null

  constructor(
    private readonly config: DaemonConfig,
    private readonly logger: Logger,
    private readonly envProvider: () => Record<string, string>,
    private readonly factories: {
      createManager?: () => DaemonPtyManager
      createAgentBridge?: (manager: DaemonPtyManager) => DaemonPtyManagerBridge
    } = {},
  ) {}

  async start(): Promise<boolean> {
    if (this.manager) return true

    const manager = this.factories.createManager?.() ?? new DaemonPtyManager(this.logger, {
      workspaceRoot: this.config.workspace_root,
      envProvider: this.envProvider,
    })
    let agentBridge: DaemonPtyManagerBridge | null = null
    try {
      if (!await manager.initialize()) {
        manager.cleanup()
        this.logger.warn('[TerminalRuntime] PTY unavailable; terminal actions will use spawn fallback')
        return false
      }

      agentBridge = this.factories.createAgentBridge?.(manager) ??
        createDaemonPtyManagerBridge(manager, this.logger, {
          ownerResolver: () => {
            const userId = this.config.user_id
            const organizationId = this.config.organization_id
            return userId && organizationId ? { userId, organizationId } : undefined
          },
        })

      this.manager = manager
      this.agentBridge = agentBridge
      claimTerminalAdapters(this)
      this.installCompatibilityAdapters(manager, agentBridge)
      this.logger.info('[TerminalRuntime] ready — human and Agent terminal interfaces installed')
      return true
    } catch (error) {
      this.manager = null
      this.agentBridge = null
      releaseTerminalAdapters(this)
      await agentBridge?.dispose().catch((disposeError) => {
        this.logger.warn(`[TerminalRuntime] rollback bridge dispose failed: ${disposeError}`)
      })
      manager.cleanup()
      throw error
    }
  }

  isAvailable(): boolean {
    return this.manager?.isAvailable() === true
  }

  getAgentBridge(): DaemonPtyManagerBridge | null {
    return this.agentBridge
  }

  async dispose(): Promise<void> {
    const bridge = this.agentBridge
    const manager = this.manager
    this.agentBridge = null
    this.manager = null

    releaseTerminalAdapters(this)

    if (bridge) {
      await bridge.dispose().catch((err) => {
        this.logger.warn(`[TerminalRuntime] agent bridge dispose failed: ${err}`)
      })
    }
    manager?.cleanup()
  }

  private installCompatibilityAdapters(
    manager: DaemonPtyManager,
    agentBridge: DaemonPtyManagerBridge,
  ): void {
    const humanApi: PtyManagerAPI = {
      readOutput: (sessionId, options) => manager.getSessionOutput(sessionId, options),
      listWithStatus: (spaceId) => manager.getAllSessionsWithStatus(spaceId),
      executeCommand: (sessionId, command, options) =>
        manager.executeCommand(
          sessionId,
          command,
          options as Parameters<DaemonPtyManager['executeCommand']>[2],
        ),
      spawnAgentSession: (spaceId, options) => manager.spawnAgentSession(spaceId, options),
      getOrSpawnAgentSession: (threadId, spaceId, options) =>
        manager.getOrSpawnAgentSession(threadId, spaceId, options),
      resolveThreadSession: (threadId) => manager.resolveThreadSession(threadId),
      write: (sessionId, data) => manager.write(sessionId, data),
    }

    setPtyManagerAPI(humanApi)
    setPtyManagerBridge(agentBridge)
  }
}

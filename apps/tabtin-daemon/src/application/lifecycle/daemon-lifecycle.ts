export type DaemonLifecycleState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'draining'
  | 'stopping'

export type DaemonResourcePhase = 'ingress' | 'workload' | 'infrastructure'

const STOP_PHASES: readonly DaemonResourcePhase[] = [
  'ingress',
  'workload',
  'infrastructure',
]

/** Single owner of Daemon process lifecycle transitions. */
export class DaemonLifecycle {
  private state: DaemonLifecycleState = 'stopped'
  private hasStarted = false
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private readonly ownedResources: Array<{
    name: string
    phase: DaemonResourcePhase
    dispose: () => void | Promise<void>
  }> = []

  getState(): DaemonLifecycleState {
    return this.state
  }

  runStart(start: () => Promise<void>, rollback: (error: unknown) => Promise<void>): Promise<void> {
    if (this.startPromise) return this.startPromise
    if (!this.beginStart()) return Promise.resolve()
    const operation = Promise.resolve().then(async () => {
      try {
        await start()
        this.markReady()
      } catch (error) {
        this.beginStop()
        try {
          await rollback(error)
        } finally {
          this.markStopped()
        }
        throw error
      } finally {
        this.startPromise = null
      }
    })
    this.startPromise = operation
    return operation
  }

  runStop(stop: () => Promise<void>): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    const operation = Promise.resolve().then(async () => {
      let ownsStop = false
      try {
        await this.startPromise?.catch(() => undefined)
        ownsStop = this.beginStop()
        if (!ownsStop) return
        await stop()
      } finally {
        if (ownsStop) this.markStopped()
        this.stopPromise = null
      }
    })
    this.stopPromise = operation
    return operation
  }

  beginStart(): boolean {
    if (this.state !== 'stopped' || this.hasStarted) return false
    this.hasStarted = true
    this.state = 'starting'
    return true
  }

  markReady(): void {
    if (this.state !== 'starting') {
      throw new Error(`Cannot mark daemon ready from '${this.state}'`)
    }
    this.state = 'running'
  }

  beginDrain(): boolean {
    if (this.state !== 'running') return false
    this.state = 'draining'
    return true
  }

  beginStop(): boolean {
    if (this.state === 'stopped' || this.state === 'stopping') return false
    this.state = 'stopping'
    return true
  }

  markStopped(): void {
    this.state = 'stopped'
  }

  isRunning(): boolean {
    return this.state === 'running'
  }

  own(
    name: string,
    phase: DaemonResourcePhase,
    dispose: () => void | Promise<void>,
  ): void {
    if (this.state !== 'starting' && this.state !== 'running') {
      throw new Error(`Cannot own resource '${name}' while daemon is '${this.state}'`)
    }
    if (this.ownedResources.some((resource) => resource.name === name)) {
      throw new Error(`Lifecycle resource '${name}' is already owned`)
    }
    this.ownedResources.push({ name, phase, dispose })
  }

  async disposeOwned(
    onError: (name: string, error: unknown) => void,
  ): Promise<void> {
    for (const phase of STOP_PHASES) {
      await this.disposePhase(phase, onError)
    }
  }

  async disposePhase(
    phase: DaemonResourcePhase,
    onError: (name: string, error: unknown) => void,
  ): Promise<void> {
    for (let index = this.ownedResources.length - 1; index >= 0; index -= 1) {
      const resource = this.ownedResources[index]
      if (resource.phase !== phase) continue
      this.ownedResources.splice(index, 1)
      try {
        await resource.dispose()
      } catch (error) {
        onError(resource.name, error)
      }
    }
  }

  acceptsNewTasks(): boolean {
    return this.state === 'running'
  }
}

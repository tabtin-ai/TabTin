import {
  FilePersistentQueue,
  buildSyncAccountDir,
  type PersistedEntryOwner,
} from '@tabtin/agent-runtime';
import type {
  ManagedTaskOwner,
  ManagedTaskPersistence,
  PersistedManagedTask,
} from '@tabtin/terminal-core';

interface PersistenceSupervisorPorts {
  isEnabled(): boolean;
  syncRoot(): string | null;
  ownerKey(owner: PersistedEntryOwner): string;
  warn(message: string): void;
}

/** Owns per-owner persistence queues and serializes destructive owner transitions. */
export class AgentPersistenceSupervisor {
  private readonly managedTaskQueues = new Map<string, FilePersistentQueue<PersistedManagedTask>>();
  private readonly resetLocks = new Map<string, Promise<void>>();
  private readonly clearedFilesByOwner = new Map<string, boolean>();
  private managedTaskReconcileStarted = false;
  private disposed = false;

  constructor(private readonly ports: PersistenceSupervisorPorts) {}

  getManagedTaskQueue(owner: PersistedEntryOwner): FilePersistentQueue<PersistedManagedTask> | undefined {
    if (this.disposed) return undefined;
    const syncRoot = this.ports.syncRoot();
    if (!this.ports.isEnabled() || !syncRoot) return undefined;
    const key = this.ports.ownerKey(owner);
    let queue = this.managedTaskQueues.get(key);
    if (!queue) {
      queue = new FilePersistentQueue<PersistedManagedTask>({
        dir: buildSyncAccountDir(syncRoot, owner),
        pendingFile: 'managed-tasks.jsonl',
        archiveFile: 'managed-tasks-archive.jsonl',
        onError: (error, context) => this.ports.warn(
          `[DaemonAgentHost] [ManagedTaskStore.file] owner=${owner.userId}/${owner.organizationId} phase=${context.phase} ${error.message}`,
        ),
      });
      this.managedTaskQueues.set(key, queue);
    }
    return queue;
  }

  buildManagedTaskPersistence(): ManagedTaskPersistence {
    return {
      upsert: record => this.persistManagedTask(record),
      delete: (sessionId, owner) => this.deleteManagedTask(sessionId, owner),
    };
  }

  claimStartupReconcile(): boolean {
    if (this.managedTaskReconcileStarted) return false;
    this.managedTaskReconcileStarted = true;
    return true;
  }

  recordClearedFiles(owner: PersistedEntryOwner, cleared: boolean): void {
    this.clearedFilesByOwner.set(this.ports.ownerKey(owner), cleared);
  }

  async runOwnerReset<T>(owner: PersistedEntryOwner, operation: () => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error('AgentPersistenceSupervisor is disposed');
    const key = this.ports.ownerKey(owner);
    const prior = this.resetLocks.get(key) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.resetLocks.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.resetLocks.get(key) === tail) this.resetLocks.delete(key);
    }
  }

  consumeClearedFiles(owner: PersistedEntryOwner): boolean {
    const key = this.ports.ownerKey(owner);
    const cleared = this.clearedFilesByOwner.get(key) ?? false;
    this.clearedFilesByOwner.delete(key);
    return cleared;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all([...this.resetLocks.values()]);
    this.resetLocks.clear();
    const queues = [...this.managedTaskQueues.values()];
    this.managedTaskQueues.clear();
    await Promise.all(queues.map(async queue => {
      try { await Promise.resolve(queue.dispose?.()); } catch { /* best effort */ }
    }));
  }

  private persistManagedTask(record: PersistedManagedTask): void {
    if (!record.owner) return;
    const queue = this.getManagedTaskQueue(record.owner);
    if (!queue) return;
    void queue.append({
      id: record.session_id,
      payload: record,
      createdAt: record.started_at,
      attempts: 0,
      lastAttemptAt: null,
      owner: { userId: record.owner.userId, organizationId: record.owner.organizationId },
    }).catch(error => this.ports.warn(
      `[DaemonAgentHost] [ManagedTaskStore] persist upsert failed session=${record.session_id.slice(0, 8)}…: ${error instanceof Error ? error.message : String(error)}`,
    ));
  }

  private deleteManagedTask(sessionId: string, owner: ManagedTaskOwner | undefined): void {
    if (!owner) return;
    const queue = this.getManagedTaskQueue(owner);
    if (!queue) return;
    void queue.remove(sessionId).catch(error => this.ports.warn(
      `[DaemonAgentHost] [ManagedTaskStore] persist delete failed session=${sessionId.slice(0, 8)}…: ${error instanceof Error ? error.message : String(error)}`,
    ));
  }
}

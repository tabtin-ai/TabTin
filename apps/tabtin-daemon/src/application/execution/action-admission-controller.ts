export interface ActionRequestLease {
  complete(): void;
}

export interface ActionTaskLease {
  readonly controller: AbortController;
  complete(): void;
}

/** Owns admission, cancellation and drain/dispose invariants for remote actions. */
export class ActionAdmissionController {
  private readonly tasks = new Map<string, AbortController>();
  private accepting = true;
  private disposed = false;
  private activeRequests = 0;

  admitRequest(): ActionRequestLease | null {
    if (!this.accepting || this.disposed) return null;
    this.activeRequests += 1;
    let completed = false;
    return {
      complete: () => {
        if (completed) return;
        completed = true;
        this.activeRequests -= 1;
      },
    };
  }

  claimTask(taskId: string): ActionTaskLease | null {
    if (!this.accepting || this.disposed || this.tasks.has(taskId)) return null;
    const controller = new AbortController();
    this.tasks.set(taskId, controller);
    let completed = false;
    return {
      controller,
      complete: () => {
        if (completed) return;
        completed = true;
        if (this.tasks.get(taskId) === controller) this.tasks.delete(taskId);
      },
    };
  }

  cancel(taskId: string): boolean {
    if (this.disposed) return false;
    const controller = this.tasks.get(taskId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  suspend(): void {
    this.accepting = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.accepting = false;
    for (const controller of this.tasks.values()) controller.abort();
    this.tasks.clear();
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  getActiveRequestCount(): number {
    return this.activeRequests;
  }
}

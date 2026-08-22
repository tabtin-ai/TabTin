import type { WorktreeSessionBindingRef } from '@shared/git-types';

export interface WorktreeRemoveRuntimeProbe {
  listBindingsForRoot(rootPath: string): Promise<WorktreeSessionBindingRef[]>;
  clearBindingsForRoot(rootPath: string): Promise<string[]>;
  reserveRootForRemoval(rootPath: string): Promise<(() => void) | null>;
}

let runtimeProbe: WorktreeRemoveRuntimeProbe | null = null;

export function registerWorktreeRemoveRuntimeProbe(
  probe: WorktreeRemoveRuntimeProbe,
): void {
  runtimeProbe = probe;
}

export function unregisterWorktreeRemoveRuntimeProbe(): void {
  runtimeProbe = null;
}

export function getWorktreeRemoveRuntimeProbe(): WorktreeRemoveRuntimeProbe | null {
  return runtimeProbe;
}

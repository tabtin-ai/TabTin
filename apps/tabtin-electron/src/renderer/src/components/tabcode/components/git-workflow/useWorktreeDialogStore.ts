import { create } from 'zustand';

interface WorktreeDialogState {
  openOwnerId: string | null;
  setOpen: (ownerId: string, open: boolean) => void;
}

/**
 * Worktree Dialog 是窗口级单例，而不是每个保活 TabCode 面板各自持有的局部状态。
 *
 * TabCode 面板使用 keepAlive 保留编辑器状态；若把 Dialog 的 open state 留在组件内，
 * 切回先前打开过 Dialog 的标签时会重新出现旧弹窗。
 */
export const useWorktreeDialogStore = create<WorktreeDialogState>((set) => ({
  openOwnerId: null,
  setOpen: (ownerId, open) => {
    set({ openOwnerId: open ? ownerId : null });
  },
}));

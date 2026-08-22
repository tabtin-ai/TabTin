import { beforeEach, describe, expect, it } from 'vitest';
import { useWorktreeDialogStore } from './useWorktreeDialogStore';

describe('useWorktreeDialogStore', () => {
  beforeEach(() => {
    useWorktreeDialogStore.setState({ openOwnerId: null });
  });

  it('keeps only one worktree dialog open across kept-alive TabCode panes', () => {
    const { setOpen } = useWorktreeDialogStore.getState();

    setOpen('tabcode:source', true);
    expect(useWorktreeDialogStore.getState().openOwnerId).toBe(
      'tabcode:source',
    );

    setOpen('tabcode:target', true);
    expect(useWorktreeDialogStore.getState().openOwnerId).toBe(
      'tabcode:target',
    );
  });

  it('clears the owner when the dialog is closed', () => {
    const { setOpen } = useWorktreeDialogStore.getState();

    setOpen('tabcode:source', true);
    setOpen('tabcode:source', false);

    expect(useWorktreeDialogStore.getState().openOwnerId).toBeNull();
  });
});

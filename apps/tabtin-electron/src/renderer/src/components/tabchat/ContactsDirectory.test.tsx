import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactsDirectory } from './ContactsDirectory';

const mocks = vi.hoisted(() => {
  const state = {
    tab: 'external',
    setTab: vi.fn(),
    listExternalContacts: vi.fn(),
    listContactInvitations: vi.fn(),
    discoverExternalContact: vi.fn(),
    issueContactInvitation: vi.fn(),
    updateContactInvitation: vi.fn(),
    updateExternalContact: vi.fn(),
    acceptExternalContact: vi.fn(),
    createConversationAndActivate: vi.fn(),
    setImSidebarView: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    translate: (key: string) => key,
    organizations: [
      { id: 'org-1', name: '当前组织' },
      { id: 'org-2', name: '另一个组织' },
    ],
  };
  return state;
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.translate }),
}));
vi.mock('@/services/tabchatApi', () => mocks);
vi.mock('@/utils/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));
vi.mock('@utils/cn', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
}));
vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (
    selector: (state: Record<string, unknown>) => unknown,
  ) =>
    selector({
      selectedOrganization: { id: 'org-1' },
      organizations: mocks.organizations,
    }),
}));
vi.mock('@stores/useIMStore', () => {
  const useIMStore = (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      imContactsTab: mocks.tab,
      setImContactsTab: mocks.setTab,
    });
  useIMStore.getState = () => ({
    createConversationAndActivate: mocks.createConversationAndActivate,
    setImSidebarView: mocks.setImSidebarView,
  });
  return { useIMStore };
});
vi.mock('./ContactsList', () => ({
  ContactsList: () => <div>internal-list</div>,
}));
vi.mock('./ColorAvatar', () => ({
  ColorAvatar: ({ name }: { name: string }) => <span>{name}</span>,
}));
vi.mock('@components/ui', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
  StatusNotice: ({ description }: { description: string }) => (
    <div>{description}</div>
  ),
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  ConfirmDialog: ({
    open,
    onConfirm,
  }: {
    open: boolean;
    onConfirm: () => void | Promise<void>;
  }) =>
    open ? (
      <button onClick={() => void onConfirm()}>confirm-remove</button>
    ) : null,
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button onClick={onClick}>{children}</button>
  ),
  Select: ({
    children,
    value,
    onValueChange,
    disabled,
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
  }) => (
    <select
      aria-label="externalContacts.acceptAs"
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) => onValueChange?.(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  SelectItem: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value: string;
  }) => <option value={value}>{children}</option>,
}));

const friend = {
  contact_id: 'contact-1',
  organization_id: 'org-1',
  peer_organization_id: 'peer-org',
  peer_user_id: 'friend-1',
  display_name: '外部好友',
  avatar_url: '',
  relationship: 'friend',
  is_restorable: false,
  updated_at: '2026-08-13T00:00:00Z',
  peer_organization_name: '合作组织',
};

const incomingInvitation = {
  invitation_id: 'invitation-1',
  direction: 'incoming',
  status: 'pending',
  peer_user_id: 'requester-1',
  peer_organization_id: 'requester-org',
  display_name: '申请人',
  avatar_url: '',
  created_at: '2026-08-14T00:00:00Z',
  expires_at: '2026-08-21T00:00:00Z',
};

const setInvitations = (incoming: unknown[] = [], outgoing: unknown[] = []) => {
  mocks.listContactInvitations.mockImplementation(
    (_organizationId: string, direction: string) =>
      Promise.resolve({ items: direction === 'incoming' ? incoming : outgoing }),
  );
};

describe('ContactsDirectory', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tab = 'external';
    mocks.updateExternalContact.mockReset();
    mocks.updateExternalContact.mockResolvedValue({});
    mocks.updateContactInvitation.mockReset();
    mocks.updateContactInvitation.mockResolvedValue({});
    mocks.acceptExternalContact.mockReset();
    mocks.acceptExternalContact.mockResolvedValue({});
    mocks.listExternalContacts.mockResolvedValue({ items: [] });
    setInvitations();
    mocks.organizations.splice(
      0,
      mocks.organizations.length,
      { id: 'org-1', name: '当前组织' },
      { id: 'org-2', name: '另一个组织' },
    );
    mocks.discoverExternalContact.mockResolvedValue({
      user_id: 'peer-1',
      display_name: '外部用户',
      avatar_url: '',
      relationship: 'none',
    });
    mocks.issueContactInvitation.mockResolvedValue({
      invitation_id: 'invite-1',
      status: 'pending',
    });
    mocks.createConversationAndActivate.mockResolvedValue('dm-1');
  });

  it('收到申请时排除申请方组织，并按选择的身份同意', async () => {
    mocks.tab = 'incoming';
    mocks.organizations.push({ id: 'requester-org', name: '申请方组织' });
    setInvitations([incomingInvitation]);
    render(<ContactsDirectory />);

    const select = await screen.findByRole('combobox', {
      name: 'externalContacts.acceptAs',
    });
    expect(screen.queryByRole('option', { name: '申请方组织' })).toBeNull();
    fireEvent.change(select, { target: { value: 'org-2' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'externalContacts.accept' }),
    );

    await waitFor(() => {
      expect(mocks.acceptExternalContact).toHaveBeenCalledWith(
        'org-2',
        'invitation-1',
      );
    });
  });

  it('没有可用组织身份时禁用同意操作', async () => {
    mocks.tab = 'incoming';
    mocks.organizations.splice(0, mocks.organizations.length, {
      id: 'requester-org',
      name: '申请方组织',
    });
    setInvitations([incomingInvitation]);
    render(<ContactsDirectory />);

    expect((await screen.findByRole('combobox')).hasAttribute('disabled')).toBe(
      true,
    );
    expect(
      screen
        .getByRole('button', { name: 'externalContacts.accept' })
        .hasAttribute('disabled'),
    ).toBe(true);
  });

  it('支持拒绝收到的申请和取消发出的申请', async () => {
    mocks.tab = 'incoming';
    setInvitations([incomingInvitation]);
    const { unmount } = render(<ContactsDirectory />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'externalContacts.reject' }),
    );
    await waitFor(() => {
      expect(mocks.updateContactInvitation).toHaveBeenCalledWith(
        'org-1',
        'invitation-1',
        'reject',
      );
    });
    unmount();

    vi.clearAllMocks();
    mocks.tab = 'outgoing';
    setInvitations([], [{ ...incomingInvitation, direction: 'outgoing' }]);
    render(<ContactsDirectory />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'externalContacts.cancel' }),
    );

    await waitFor(() => {
      expect(mocks.updateContactInvitation).toHaveBeenCalledWith(
        'org-1',
        'invitation-1',
        'cancel',
      );
    });
  });

  it('打开通讯录时定时同步对方处理后的申请状态', async () => {
    vi.useFakeTimers();
    mocks.tab = 'outgoing';
    let pending = true;
    mocks.listContactInvitations.mockImplementation(
      (_organizationId: string, direction: string) =>
        Promise.resolve({
          items:
            direction === 'outgoing' && pending
              ? [{ ...incomingInvitation, direction: 'outgoing' }]
              : [],
        }),
    );
    render(<ContactsDirectory />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(
      screen.getByRole('button', { name: 'externalContacts.cancel' }),
    ).toBeTruthy();

    pending = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(
      screen.queryByRole('button', { name: 'externalContacts.cancel' }),
    ).toBeNull();
  });

  it('取消已处理申请遇到冲突时重新同步并移除旧记录', async () => {
    mocks.tab = 'outgoing';
    let pending = true;
    mocks.listContactInvitations.mockImplementation(
      (_organizationId: string, direction: string) =>
        Promise.resolve({
          items:
            direction === 'outgoing' && pending
              ? [{ ...incomingInvitation, direction: 'outgoing' }]
              : [],
        }),
    );
    mocks.updateContactInvitation.mockImplementation(async () => {
      pending = false;
      throw Object.assign(new Error('contact invitation is not available'), {
        data: { code: 409 },
      });
    });
    render(<ContactsDirectory />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'externalContacts.cancel' }),
    );

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'externalContacts.cancel' }),
      ).toBeNull();
    });
    expect(
      screen.queryByText('contact invitation is not available'),
    ).toBeNull();
  });

  it('过期的静默刷新不能把已同步掉的申请写回来', async () => {
    vi.useFakeTimers();
    mocks.tab = 'outgoing';
    const outgoing = { ...incomingInvitation, direction: 'outgoing' };
    let pending = true;
    const delayed: Array<(items: unknown[]) => void> = [];
    mocks.listContactInvitations.mockImplementation(
      (_organizationId: string, direction: string) => {
        if (direction !== 'outgoing') return Promise.resolve({ items: [] });
        if (!pending) return Promise.resolve({ items: [] });
        return new Promise((resolve) => {
          delayed.push((items) => resolve({ items }));
        });
      },
    );
    render(<ContactsDirectory />);

    expect(delayed).toHaveLength(1);
    await act(async () => {
      delayed.shift()?.([outgoing]);
    });
    expect(
      screen.getByRole('button', { name: 'externalContacts.cancel' }),
    ).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(delayed).toHaveLength(1);
    vi.useRealTimers();

    mocks.updateContactInvitation.mockImplementation(async () => {
      pending = false;
      throw Object.assign(new Error('contact invitation is not available'), {
        data: { code: 409 },
      });
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'externalContacts.cancel' }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'externalContacts.cancel' }),
      ).toBeNull();
    });

    await act(async () => {
      delayed.shift()?.([outgoing]);
    });
    expect(
      screen.queryByRole('button', { name: 'externalContacts.cancel' }),
    ).toBeNull();
  });

  it('取消冲突后刷新失败时回退到处理失败提示', async () => {
    mocks.tab = 'outgoing';
    setInvitations([], [{ ...incomingInvitation, direction: 'outgoing' }]);
    mocks.updateContactInvitation.mockImplementation(async () => {
      mocks.listContactInvitations.mockRejectedValue(new Error('network down'));
      throw Object.assign(new Error('contact invitation is not available'), {
        data: { code: 409 },
      });
    });
    render(<ContactsDirectory />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'externalContacts.cancel' }),
    );

    expect(
      await screen.findByText('externalContacts.errors.resolveFailed'),
    ).toBeTruthy();
    expect(
      screen.queryByText('contact invitation is not available'),
    ).toBeNull();
  });

  it('取消冲突后申请仍待处理时提示失败并保留操作', async () => {
    mocks.tab = 'outgoing';
    setInvitations([], [{ ...incomingInvitation, direction: 'outgoing' }]);
    mocks.updateContactInvitation.mockRejectedValue(
      Object.assign(new Error('contact invitation is not available'), {
        data: { code: 409 },
      }),
    );
    render(<ContactsDirectory />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'externalContacts.cancel' }),
    );

    expect(
      await screen.findByText('externalContacts.errors.resolveFailed'),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'externalContacts.cancel' }),
    ).toBeTruthy();
  });

  it('支持私聊、拉黑、解除拉黑和解除关系', async () => {
    mocks.listExternalContacts.mockResolvedValue({ items: [friend] });
    const { unmount } = render(<ContactsDirectory />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'externalContacts.message' }),
    );
    await waitFor(() => {
      expect(mocks.createConversationAndActivate).toHaveBeenCalledWith({
        organizationId: 'org-1',
        kind: 'dm',
        memberIds: [],
        externalContactIds: ['contact-1'],
      });
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'externalContacts.more' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'externalContacts.block' }),
    );
    await waitFor(() => {
      expect(mocks.updateExternalContact).toHaveBeenCalledWith(
        'org-1',
        'contact-1',
        'block',
      );
    });
    unmount();

    vi.clearAllMocks();
    mocks.tab = 'blocked';
    mocks.listExternalContacts.mockResolvedValue({
      items: [{ ...friend, relationship: 'blocked' }],
    });
    setInvitations();
    const blockedView = render(<ContactsDirectory />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'externalContacts.unblock' }),
    );
    await waitFor(() => {
      expect(mocks.updateExternalContact).toHaveBeenCalledWith(
        'org-1',
        'contact-1',
        'unblock',
      );
    });
    blockedView.unmount();

    vi.clearAllMocks();
    mocks.tab = 'external';
    mocks.listExternalContacts.mockResolvedValue({ items: [friend] });
    setInvitations();
    render(<ContactsDirectory />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'externalContacts.more' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'externalContacts.remove' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'confirm-remove' }));
    await waitFor(() => {
      expect(mocks.updateExternalContact).toHaveBeenCalledWith(
        'org-1',
        'contact-1',
        'remove',
      );
    });
  });

  it('解除关系失败时保留联系人并展示错误', async () => {
    mocks.listExternalContacts.mockResolvedValue({ items: [friend] });
    mocks.updateExternalContact.mockRejectedValue(new Error('remove failed'));
    render(<ContactsDirectory />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'externalContacts.more' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'externalContacts.remove' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'confirm-remove' }));

    expect(await screen.findByText('remove failed')).toBeTruthy();
    expect(screen.getAllByText('外部好友').length).toBeGreaterThan(0);
  });

  it('通过 Django 外部联系人入口查找账号并发送申请', async () => {
    render(<ContactsDirectory />);

    expect(await screen.findByText('externalContacts.empty')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'externalContacts.addFriend' }),
    );
    expect(
      screen.getByRole('heading', { name: 'externalContacts.addDialogTitle' }),
    ).toBeTruthy();

    fireEvent.change(
      screen.getByRole('textbox', { name: 'externalContacts.phoneLabel' }),
      { target: { value: '13900001165' } },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'externalContacts.search' }),
    );
    expect((await screen.findAllByText('外部用户')).length).toBeGreaterThan(0);
    expect(mocks.discoverExternalContact).toHaveBeenCalledWith(
      'org-1',
      '13900001165',
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'externalContacts.sendRequest' }),
    );
    await waitFor(() => {
      expect(mocks.issueContactInvitation).toHaveBeenCalledWith(
        'org-1',
        'peer-1',
        undefined,
      );
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'externalContacts.requested',
    );
    expect(mocks.setTab).toHaveBeenCalledWith('outgoing');
  });

  it('外部联系人列表加载失败时按空列表处理，不转圈', async () => {
    mocks.listExternalContacts.mockRejectedValue(
      Object.assign(new Error('TabChat API transport is unavailable'), {
        name: 'IMRequestTransportError',
      }),
    );
    render(<ContactsDirectory />);

    expect(await screen.findByText('externalContacts.empty')).toBeTruthy();
    expect(
      screen.queryByText('externalContacts.errors.loadFailed'),
    ).toBeNull();
    expect(screen.queryByText('TabChat API transport is unavailable')).toBeNull();
    expect(document.querySelector('.animate-spin')).toBeNull();
  });
});

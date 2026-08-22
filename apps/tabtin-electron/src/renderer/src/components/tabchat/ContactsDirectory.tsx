import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Ban,
  Check,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Search,
  UserPlus,
  X,
} from 'lucide-react';
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusNotice,
  Textarea,
  toast,
} from '@components/ui';
import { useIMStore, type IMContactsTab } from '@stores/useIMStore';
import { useOrganizationStore } from '@stores/useOrganizationStore';
import * as tabchatApi from '@/services/tabchatApi';
import type {
  ContactInvitation,
  ExternalContact,
  ExternalContactCandidate,
} from '@/services/tabchatApi';
import { createLogger } from '@/utils/logger';
import { cn } from '@utils/cn';
import { ContactsList } from './ContactsList';
import { ColorAvatar } from './ColorAvatar';

const log = createLogger('ContactsDirectory');
const CONTACTS_REFRESH_INTERVAL_MS = 5_000;

type DirectorySnapshot = {
  contacts: ExternalContact[];
  incoming: ContactInvitation[];
  outgoing: ContactInvitation[];
};

type DirectoryLoadResult =
  | { status: 'applied'; snapshot: DirectorySnapshot }
  | { status: 'stale' }
  | { status: 'failed' }
  | { status: 'skipped' };

function readResponseCode(err: unknown): unknown {
  const responseData =
    err && typeof err === 'object' && 'data' in err
      ? (err as { data?: unknown }).data
      : undefined;
  if (
    !responseData ||
    typeof responseData !== 'object' ||
    !('code' in responseData)
  ) {
    return undefined;
  }
  return (responseData as { code?: unknown }).code;
}

function invitationStillOpen(
  snapshot: DirectorySnapshot,
  invitationId: string,
) {
  return [...snapshot.incoming, ...snapshot.outgoing].some(
    (item) => item.invitation_id === invitationId,
  );
}

const TABS: IMContactsTab[] = [
  'internal',
  'external',
  'incoming',
  'outgoing',
  'blocked',
];

export const ContactsDirectory: React.FC = () => {
  const { t } = useTranslation('tabchat');
  const organizationId = useOrganizationStore(
    (state) => state.selectedOrganization?.id ?? '',
  );
  const organizations = useOrganizationStore((state) => state.organizations);
  const activeTab = useIMStore((state) => state.imContactsTab);
  const setActiveTab = useIMStore((state) => state.setImContactsTab);
  const [contacts, setContacts] = useState<ExternalContact[]>([]);
  const [incoming, setIncoming] = useState<ContactInvitation[]>([]);
  const [outgoing, setOutgoing] = useState<ContactInvitation[]>([]);
  const [acceptAs, setAcceptAs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [candidate, setCandidate] = useState<ExternalContactCandidate | null>(
    null,
  );
  const [contactToRemove, setContactToRemove] =
    useState<ExternalContact | null>(null);
  const loadGenerationRef = useRef(0);
  const busyIdRef = useRef(busyId);
  busyIdRef.current = busyId;

  const load = useCallback(
    async (silent = false): Promise<DirectoryLoadResult> => {
      if (!organizationId) return { status: 'skipped' };
      const generation = ++loadGenerationRef.current;
      if (!silent) {
        setLoading(true);
        setError('');
      }
      try {
        const [contactResult, incomingResult, outgoingResult] =
          await Promise.all([
            tabchatApi.listExternalContacts(organizationId),
            tabchatApi.listContactInvitations(
              organizationId,
              'incoming',
              'pending',
            ),
            tabchatApi.listContactInvitations(
              organizationId,
              'outgoing',
              'pending',
            ),
          ]);
        if (generation !== loadGenerationRef.current) {
          return { status: 'stale' };
        }
        const snapshot: DirectorySnapshot = {
          contacts: contactResult.items,
          incoming: incomingResult.items,
          outgoing: outgoingResult.items,
        };
        setContacts(snapshot.contacts);
        setIncoming(snapshot.incoming);
        setOutgoing(snapshot.outgoing);
        return { status: 'applied', snapshot };
      } catch (err) {
        log.error('Failed to load contacts directory', { organizationId }, err);
        if (generation !== loadGenerationRef.current) {
          return { status: 'stale' };
        }
        const transportUnavailable =
          err instanceof Error && err.name === 'IMRequestTransportError';
        if (transportUnavailable) {
          const snapshot: DirectorySnapshot = {
            contacts: [],
            incoming: [],
            outgoing: [],
          };
          setContacts(snapshot.contacts);
          setIncoming(snapshot.incoming);
          setOutgoing(snapshot.outgoing);
          setError('');
          return { status: 'applied', snapshot };
        }
        if (!silent) {
          setError(
            err instanceof Error
              ? err.message
              : t('externalContacts.errors.loadFailed'),
          );
        }
        return { status: 'failed' };
      } finally {
        if (generation === loadGenerationRef.current) {
          setLoading(false);
        }
      }
    },
    [organizationId, t],
  );

  useEffect(() => {
    void load();

    const refreshWhenVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (busyIdRef.current) return;
      void load(true);
    };
    const timer = window.setInterval(
      refreshWhenVisible,
      CONTACTS_REFRESH_INTERVAL_MS,
    );

    return () => {
      loadGenerationRef.current += 1;
      window.clearInterval(timer);
    };
  }, [load]);

  const friends = useMemo(
    () => contacts.filter((contact) => contact.relationship === 'friend'),
    [contacts],
  );
  const blocked = useMemo(
    () => contacts.filter((contact) => contact.relationship === 'blocked'),
    [contacts],
  );

  const resetAdd = () => {
    setPhone('');
    setNote('');
    setCandidate(null);
    setError('');
  };

  const discover = async () => {
    if (!phone.trim() || busyId) return;
    setBusyId('discover');
    setError('');
    try {
      setCandidate(
        await tabchatApi.discoverExternalContact(organizationId, phone.trim()),
      );
    } catch (err) {
      log.error(
        'Failed to discover external contact',
        { organizationId, phoneLength: phone.trim().length },
        err,
      );
      setCandidate(null);
      const isSelfContact =
        readResponseCode(err) === 409 ||
        (err instanceof Error && err.message === 'cannot add yourself');
      const isMissingContact =
        err instanceof Error &&
        (err.message === 'account not found' ||
          err.message === 'failed to discover account');
      setError(
        isSelfContact
          ? t('externalContacts.errors.selfContact')
          : isMissingContact
          ? t('externalContacts.errors.notFound')
          : err instanceof Error
          ? err.message
          : t('externalContacts.errors.notFound'),
      );
    } finally {
      setBusyId('');
    }
  };

  const sendRequest = async () => {
    if (!candidate || busyId) return;
    setBusyId('request');
    setError('');
    try {
      await tabchatApi.issueContactInvitation(
        organizationId,
        candidate.user_id,
        note.trim() || undefined,
      );
      toast.success(t('externalContacts.requested'));
      setAddOpen(false);
      resetAdd();
      setActiveTab('outgoing');
      await load();
    } catch (err) {
      log.error(
        'Failed to issue external contact invitation',
        { organizationId, targetUserId: candidate.user_id },
        err,
      );
      setError(
        err instanceof Error
          ? err.message
          : t('externalContacts.errors.requestFailed'),
      );
    } finally {
      setBusyId('');
    }
  };

  const resolveInvitation = async (
    invitation: ContactInvitation,
    action: 'accept' | 'reject' | 'cancel',
  ) => {
    if (busyId) return;
    const eligibleOrganizations = organizations.filter(
      (organization) => organization.id !== invitation.peer_organization_id,
    );
    const selectedOrganizationId =
      acceptAs[invitation.invitation_id] ||
      eligibleOrganizations.find(
        (organization) => organization.id === organizationId,
      )?.id ||
      eligibleOrganizations[0]?.id;
    if (action === 'accept' && !selectedOrganizationId) {
      setError(t('externalContacts.errors.noEligibleOrganization'));
      return;
    }
    setBusyId(invitation.invitation_id);
    setError('');
    try {
      if (action === 'accept') {
        await tabchatApi.acceptExternalContact(
          selectedOrganizationId,
          invitation.invitation_id,
        );
        toast.success(
          t('externalContacts.acceptedAs', {
            organization: eligibleOrganizations.find(
              (organization) => organization.id === selectedOrganizationId,
            )?.name,
          }),
        );
      } else {
        await tabchatApi.updateContactInvitation(
          organizationId,
          invitation.invitation_id,
          action,
        );
      }
      await load();
    } catch (err) {
      log.error(
        'Failed to resolve contact invitation',
        { action, invitationId: invitation.invitation_id, organizationId },
        err,
      );
      if (readResponseCode(err) === 409) {
        const result = await load(true);
        if (
          result.status === 'failed' ||
          (result.status === 'applied' &&
            invitationStillOpen(result.snapshot, invitation.invitation_id))
        ) {
          setError(t('externalContacts.errors.resolveFailed'));
        }
      } else {
        setError(
          err instanceof Error
            ? err.message
            : t('externalContacts.errors.resolveFailed'),
        );
      }
    } finally {
      setBusyId('');
    }
  };

  const updateContact = async (
    contact: ExternalContact,
    action: 'block' | 'unblock' | 'remove',
  ) => {
    if (busyId) return;
    setBusyId(contact.contact_id);
    setError('');
    try {
      await tabchatApi.updateExternalContact(
        organizationId,
        contact.contact_id,
        action,
      );
      if (action === 'remove') toast.success(t('externalContacts.removed'));
      await load();
    } catch (err) {
      log.error(
        'Failed to update external contact',
        { organizationId, contactId: contact.contact_id, action },
        err,
      );
      setError(
        err instanceof Error
          ? err.message
          : t('externalContacts.errors.updateFailed'),
      );
    } finally {
      setBusyId('');
      setContactToRemove(null);
    }
  };

  const openDM = async (contact: ExternalContact) => {
    if (busyId) return;
    setBusyId(contact.contact_id);
    try {
      await useIMStore.getState().createConversationAndActivate({
        organizationId,
        kind: 'dm',
        memberIds: [],
        externalContactIds: [contact.contact_id],
      });
      useIMStore.getState().setImSidebarView('inbox');
    } catch (err) {
      log.error(
        'Failed to open external contact DM',
        { organizationId, contactId: contact.contact_id },
        err,
      );
      toast.error(t('contactCardDMFailed', { defaultValue: '无法打开私信' }));
    } finally {
      setBusyId('');
    }
  };

  const tabCount: Partial<Record<IMContactsTab, number>> = {
    external: friends.length,
    incoming: incoming.length,
    outgoing: outgoing.length,
    blocked: blocked.length,
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        className="flex shrink-0 gap-1 border-b border-border/50 px-1"
      >
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              'relative px-3 py-2.5 text-body text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
              activeTab === tab &&
                'font-medium text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary',
            )}
          >
            {t(`externalContacts.tabs.${tab}`)}
            {tabCount[tab] ? (
              <span className="ml-1 text-caption text-muted-foreground">
                {tabCount[tab]}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {activeTab === 'internal' ? (
        <ContactsList layout="module" />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto py-3">
          <div className="mb-3 flex items-center justify-between gap-3 px-1">
            <p className="text-body text-muted-foreground">
              {t(`externalContacts.hints.${activeTab}`)}
            </p>
            {activeTab === 'external' ? (
              <Button
                type="button"
                size="sm"
                onClick={() => setAddOpen(true)}
              >
                <UserPlus className="mr-1.5 h-4 w-4" aria-hidden />
                {t('externalContacts.addFriend')}
              </Button>
            ) : null}
          </div>
          {error ? (
            <StatusNotice tone="danger" size="sm" description={error} />
          ) : null}
          {loading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : activeTab === 'external' ? (
            <ContactRows
              contacts={friends}
              busyId={busyId}
              onOpenDM={openDM}
              onBlock={(contact) => void updateContact(contact, 'block')}
              onRemove={setContactToRemove}
            />
          ) : activeTab === 'blocked' ? (
            <ContactRows
              contacts={blocked}
              busyId={busyId}
              onUnblock={(contact) => void updateContact(contact, 'unblock')}
            />
          ) : activeTab === 'incoming' ? (
            <InvitationRows
              invitations={incoming}
              busyId={busyId}
              organizations={organizations}
              organizationId={organizationId}
              acceptAs={acceptAs}
              setAcceptAs={setAcceptAs}
              onAction={resolveInvitation}
            />
          ) : (
            <InvitationRows
              invitations={outgoing}
              busyId={busyId}
              onAction={resolveInvitation}
            />
          )}
        </div>
      )}

      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) resetAdd();
        }}
      >
        <DialogContent className="w-[460px] max-w-[calc(100vw-32px)]">
          <DialogTitle>{t('externalContacts.addDialogTitle')}</DialogTitle>
          <p className="text-body text-muted-foreground">
            {t('externalContacts.addDialogHint')}
          </p>
          <div className="flex gap-2">
            <Input
              type="tel"
              autoFocus
              value={phone}
              onChange={(event) => {
                setPhone(event.target.value);
                setCandidate(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing)
                  void discover();
              }}
              placeholder={t('externalContacts.phonePlaceholder')}
              aria-label={t('externalContacts.phoneLabel')}
            />
            <Button
              variant="outline"
              disabled={!phone.trim() || !!busyId}
              onClick={() => void discover()}
            >
              {busyId === 'discover' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              <span className="ml-1.5">{t('externalContacts.search')}</span>
            </Button>
          </div>
          {error ? (
            <StatusNotice tone="danger" size="sm" description={error} />
          ) : null}
          {candidate ? (
            <div className="space-y-3 rounded-xl border border-border/60 p-3">
              <div className="flex items-center gap-3">
                <ColorAvatar
                  name={candidate.display_name}
                  seed={candidate.user_id}
                  imageUrl={candidate.avatar_url}
                  className="h-9 w-9"
                />
                <div className="min-w-0 flex-1 truncate font-medium">
                  {candidate.display_name}
                </div>
                <span className="rounded bg-warning/10 px-1.5 py-0.5 text-caption text-warning">
                  {t('externalContacts.external')}
                </span>
              </div>
              {candidate.relationship === 'none' ||
              candidate.relationship === 'removed' ? (
                <>
                  <Textarea
                    value={note}
                    maxLength={100}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder={t('externalContacts.notePlaceholder')}
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-caption text-muted-foreground">
                      {note.length}/100
                    </span>
                    <Button
                      disabled={!!busyId}
                      onClick={() => void sendRequest()}
                    >
                      {t('externalContacts.sendRequest')}
                    </Button>
                  </div>
                </>
              ) : (
                <p className="text-body text-muted-foreground">
                  {candidate.relationship === 'pending'
                    ? t('externalContacts.requested')
                    : t('externalContacts.alreadyFriend')}
                </p>
              )}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!contactToRemove}
        onOpenChange={(open) => {
          if (!open) setContactToRemove(null);
        }}
        title={t('externalContacts.removeConfirmTitle')}
        description={t('externalContacts.removeConfirm', {
          name: contactToRemove?.display_name ?? '',
        })}
        variant="destructive"
        onConfirm={() =>
          contactToRemove
            ? updateContact(contactToRemove, 'remove')
            : Promise.resolve()
        }
      />
    </div>
  );
};

const Empty: React.FC = () => {
  const { t } = useTranslation('tabchat');
  return (
    <p className="py-10 text-center text-body text-muted-foreground">
      {t('externalContacts.empty')}
    </p>
  );
};

const ContactRows: React.FC<{
  contacts: ExternalContact[];
  busyId: string;
  onOpenDM?: (contact: ExternalContact) => void;
  onBlock?: (contact: ExternalContact) => void;
  onUnblock?: (contact: ExternalContact) => void;
  onRemove?: (contact: ExternalContact) => void;
}> = ({ contacts, busyId, onOpenDM, onBlock, onUnblock, onRemove }) => {
  const { t } = useTranslation('tabchat');
  if (contacts.length === 0) return <Empty />;
  return (
    <div>
      {contacts.map((contact) => (
        <div
          key={contact.contact_id}
          className="flex items-center gap-3 rounded-interactive px-1 py-2 hover:bg-foreground/[0.03]"
        >
          <ColorAvatar
            name={contact.display_name}
            seed={contact.peer_user_id}
            imageUrl={contact.avatar_url}
            className="h-9 w-9"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">
                {contact.display_name}
              </span>
              <span className="rounded bg-warning/10 px-1.5 py-0.5 text-caption text-warning">
                {t('externalContacts.external')}
              </span>
            </div>
            <div className="truncate text-caption text-muted-foreground">
              {contact.peer_organization_name}
            </div>
          </div>
          {busyId === contact.contact_id ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : null}
          {onOpenDM ? (
            <Button size="sm" variant="ghost" onClick={() => onOpenDM(contact)}>
              <MessageCircle className="mr-1 h-4 w-4" />
              {t('externalContacts.message')}
            </Button>
          ) : null}
          {onUnblock ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onUnblock(contact)}
            >
              {t('externalContacts.unblock')}
            </Button>
          ) : null}
          {onBlock || onRemove ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t('externalContacts.more')}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onBlock ? (
                  <DropdownMenuItem onClick={() => onBlock(contact)}>
                    <Ban className="mr-2 h-4 w-4" />
                    {t('externalContacts.block')}
                  </DropdownMenuItem>
                ) : null}
                {onRemove ? (
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={() => onRemove(contact)}
                  >
                    {t('externalContacts.remove')}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ))}
    </div>
  );
};

const InvitationRows: React.FC<{
  invitations: ContactInvitation[];
  busyId: string;
  organizations?: Array<{ id: string; name: string }>;
  organizationId?: string;
  acceptAs?: Record<string, string>;
  setAcceptAs?: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onAction: (
    invitation: ContactInvitation,
    action: 'accept' | 'reject' | 'cancel',
  ) => void;
}> = ({
  invitations,
  busyId,
  organizations = [],
  organizationId = '',
  acceptAs = {},
  setAcceptAs,
  onAction,
}) => {
  const { t } = useTranslation('tabchat');
  if (invitations.length === 0) return <Empty />;
  return (
    <div>
      {invitations.map((invitation) => {
        const eligible = organizations.filter(
          (organization) => organization.id !== invitation.peer_organization_id,
        );
        const selected =
          acceptAs[invitation.invitation_id] ||
          eligible.find((organization) => organization.id === organizationId)
            ?.id ||
          eligible[0]?.id;
        return (
          <div
            key={invitation.invitation_id}
            className="flex items-center gap-3 rounded-interactive px-1 py-2 hover:bg-foreground/[0.03]"
          >
            <ColorAvatar
              name={invitation.display_name}
              seed={invitation.peer_user_id}
              imageUrl={invitation.avatar_url}
              className="h-9 w-9"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">
                {invitation.display_name}
              </div>
              <div className="truncate text-caption text-muted-foreground">
                {invitation.note || invitation.peer_organization_name}
              </div>
            </div>
            {invitation.direction === 'incoming' ? (
              <>
                <Select
                  value={selected}
                  onValueChange={(value) =>
                    setAcceptAs?.((current) => ({
                      ...current,
                      [invitation.invitation_id]: value,
                    }))
                  }
                  disabled={!!busyId || eligible.length === 0}
                >
                  <SelectTrigger
                    className="w-40"
                    aria-label={t('externalContacts.acceptAs')}
                  >
                    <SelectValue placeholder={t('externalContacts.acceptAs')} />
                  </SelectTrigger>
                  <SelectContent>
                    {eligible.map((organization) => (
                      <SelectItem key={organization.id} value={organization.id}>
                        {organization.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!!busyId}
                  onClick={() => onAction(invitation, 'reject')}
                >
                  <X className="mr-1 h-4 w-4" />
                  {t('externalContacts.reject')}
                </Button>
                <Button
                  size="sm"
                  disabled={!!busyId || !selected}
                  onClick={() => onAction(invitation, 'accept')}
                >
                  <Check className="mr-1 h-4 w-4" />
                  {t('externalContacts.accept')}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={!!busyId}
                onClick={() => onAction(invitation, 'cancel')}
              >
                {t('externalContacts.cancel')}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
};

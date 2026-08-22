import type { Conversation } from '@/services/tabchatApi';
import {
  getConversationNavigationKind,
  type SpaceNavigationKind,
} from '@tabtin/app-shell';
import type { SpaceContext } from '@components/context-space/SpaceContextContainer';
import type { CrawlspaceConfig } from '@stores/useCrawlTabStore';
import { resolveSpaceCrawlspaceIdFromConfigs } from '@/crawlspace/registry';

export type ConversationWorkbenchKind = 'dm' | 'im-group' | null;
export type ActiveShellContextSource =
  | 'settings'
  | 'space'
  | 'conversation'
  | 'none';

interface ResolveActiveConversationInput {
  conversations: Conversation[];
  currentConversationId: string | null;
}

export function resolveActiveConversation(
  input: ResolveActiveConversationInput,
): Conversation | null {
  const { conversations, currentConversationId } = input;
  if (!currentConversationId) return null;
  return (
    conversations.find((item) => item.id === currentConversationId) ?? null
  );
}

interface ResolveConversationKindInput {
  activeConversation: Conversation | null;
  selectedSpaceKind: SpaceNavigationKind | null;
  isIMActive: boolean;
}

export function resolveConversationKind(
  input: ResolveConversationKindInput,
): ConversationWorkbenchKind {
  const { activeConversation, selectedSpaceKind, isIMActive } = input;

  if (!activeConversation) {
    if (selectedSpaceKind === 'im-group') return 'im-group';
    if (selectedSpaceKind === 'dm' || isIMActive) return 'dm';
    return null;
  }

  return getConversationNavigationKind(activeConversation) === 'im-group'
    ? 'im-group'
    : 'dm';
}

interface ResolveConversationBindingInput {
  conversations: Conversation[];
  currentConversationId: string | null;
  selectedSpaceKind: SpaceNavigationKind | null;
  isIMActive: boolean;
}

export interface ConversationBinding {
  activeConversation: Conversation | null;
  conversationId: string | null;
  conversationKind: ConversationWorkbenchKind;
}

export function resolveConversationBinding(
  input: ResolveConversationBindingInput,
): ConversationBinding {
  const activeConversation = resolveActiveConversation({
    conversations: input.conversations,
    currentConversationId: input.currentConversationId,
  });

  return {
    activeConversation,
    conversationId: input.currentConversationId,
    conversationKind: resolveConversationKind({
      activeConversation,
      selectedSpaceKind: input.selectedSpaceKind,
      isIMActive: input.isIMActive,
    }),
  };
}

interface ResolveConversationSpaceContextInput {
  activeConversation: Conversation | null;
  currentConversationId: string | null;
  isIMActive: boolean;
  selectedSpaceKind: SpaceNavigationKind | null;
  organizationId?: string | null;
}

export function resolveConversationSpaceContext(
  input: ResolveConversationSpaceContextInput,
): SpaceContext | null {
  const {
    activeConversation,
    currentConversationId,
    isIMActive,
    selectedSpaceKind,
    organizationId,
  } = input;

  const shouldResolveConversation =
    selectedSpaceKind === 'dm' ||
    selectedSpaceKind === 'im-group' ||
    (isIMActive && Boolean(currentConversationId));
  if (!shouldResolveConversation) return null;

  const conversationSpaceId = activeConversation?.space_id ?? null;
  if (!activeConversation || !conversationSpaceId) return null;

  return {
    id: conversationSpaceId,
    name: activeConversation.name || 'DM',
    organization_id: activeConversation.organization_id || organizationId || '',
  };
}

interface ResolveVisibleSpaceContextInput {
  selectedSpaceKind: SpaceNavigationKind | null;
  selectedSpace: SpaceContext | null;
  conversationSpaceContext: SpaceContext | null;
}

export function resolveVisibleSpaceContext(
  input: ResolveVisibleSpaceContextInput,
): SpaceContext | null {
  const {
    selectedSpaceKind,
    selectedSpace,
    conversationSpaceContext,
  } = input;

  if (selectedSpaceKind === 'dm' || selectedSpaceKind === 'im-group') {
    return conversationSpaceContext;
  }
  return selectedSpace;
}

interface ResolveActiveShellContextInput {
  isSettingsOpen: boolean;
  selectedSpaceKind: SpaceNavigationKind | null;
  selectedSpace: SpaceContext | null;
  conversations: Conversation[];
  currentConversationId: string | null;
  isIMActive: boolean;
  organizationId?: string | null;
}

export interface ActiveShellContext {
  source: ActiveShellContextSource;
  selectedSpaceKind: SpaceNavigationKind | null;
  selectedConversationId: string | null;
  selectedConversationKind: ConversationWorkbenchKind;
  activeConversation: Conversation | null;
  conversationSpaceContext: SpaceContext | null;
  visibleSpaceContext: SpaceContext | null;
}

export function resolveActiveShellContext(
  input: ResolveActiveShellContextInput,
): ActiveShellContext {
  const conversationBinding = resolveConversationBinding({
    conversations: input.conversations,
    currentConversationId: input.currentConversationId,
    selectedSpaceKind: input.selectedSpaceKind,
    isIMActive: input.isIMActive,
  });

  const conversationSpaceContext = resolveConversationSpaceContext({
    activeConversation: conversationBinding.activeConversation,
    currentConversationId: conversationBinding.conversationId,
    isIMActive: input.isIMActive,
    selectedSpaceKind: input.selectedSpaceKind,
    organizationId: input.organizationId,
  });

  const visibleSpaceContext = resolveVisibleSpaceContext({
    selectedSpaceKind: input.selectedSpaceKind,
    selectedSpace: input.selectedSpace,
    conversationSpaceContext,
  });

  const source: ActiveShellContextSource = input.isSettingsOpen
    ? 'settings'
    : conversationBinding.conversationKind
        ? 'conversation'
        : visibleSpaceContext
          ? 'space'
          : 'none';

  return {
    source,
    selectedSpaceKind: input.selectedSpaceKind,
    selectedConversationId: conversationBinding.conversationId,
    selectedConversationKind: conversationBinding.conversationKind,
    activeConversation: conversationBinding.activeConversation,
    conversationSpaceContext,
    visibleSpaceContext,
  };
}

interface ResolveSpaceCrawlspaceIdInput {
  activeSpaceId: string | null;
  crawlspaceConfigById: Record<string, CrawlspaceConfig>;
  fallbackCrawlspaceId?: string | null;
}

export function resolveSpaceCrawlspaceId(
  input: ResolveSpaceCrawlspaceIdInput,
): string | null {
  const {
    activeSpaceId,
    crawlspaceConfigById,
    fallbackCrawlspaceId = null,
  } = input;
  return resolveSpaceCrawlspaceIdFromConfigs(
    crawlspaceConfigById,
    activeSpaceId,
    fallbackCrawlspaceId,
  );
}

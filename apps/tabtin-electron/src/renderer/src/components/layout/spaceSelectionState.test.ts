import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_TYPE_DM,
  CONVERSATION_TYPE_GROUP,
} from '@/constants/tabchat';
import type { Conversation } from '@/services/tabchatApi';
import type { CrawlspaceConfig } from '@stores/useCrawlTabStore';
import {
  resolveActiveConversation,
  resolveActiveShellContext,
  resolveConversationBinding,
  resolveConversationKind,
  resolveConversationSpaceContext,
  resolveVisibleSpaceContext,
  resolveSpaceCrawlspaceId,
} from './spaceSelectionState';

const buildConversation = (
  overrides: Partial<Conversation> = {},
): Conversation => ({
  id: 'conv-1',
  organization_id: 'ws-1',
  space_id: 'space-conv-1',
  type: CONVERSATION_TYPE_DM,
  name: 'DM',
  avatar_url: '',
  member_count: 2,
  last_message_at: null,
  last_message_preview: '',
  unread_count: 0,
  created_at: '2026-03-09T00:00:00Z',
  ...overrides,
});

const buildConfig = (
  crawlspaceId: string,
  spaceId: string,
): CrawlspaceConfig => ({
  crawlspaceId,
  spaceId,
  profile: 'agent-workspace',
  partition: `tabtin:crawlspace:${crawlspaceId}`,
});

describe('spaceSelectionState', () => {
  it('优先根据当前会话真实类型解析 conversation kind', () => {
    const activeConversation = buildConversation({
      type: CONVERSATION_TYPE_GROUP,
    });

    expect(
      resolveConversationKind({
        activeConversation,
        selectedSpaceKind: 'dm',
        isIMActive: true,
      }),
    ).toBe('im-group');
  });

  it('在 IM 激活且存在当前会话时解析 conversation space context', () => {
    const activeConversation = buildConversation({
      id: 'conv-2',
      space_id: 'space-conv-2',
      name: 'Project DM',
    });

    expect(
      resolveConversationSpaceContext({
        activeConversation,
        currentConversationId: activeConversation.id,
        isIMActive: true,
        selectedSpaceKind: null,
        organizationId: 'ws-fallback',
      }),
    ).toEqual({
      id: 'space-conv-2',
      name: 'Project DM',
      organization_id: 'ws-1',
    });
  });

  it('统一解析 conversation binding，优先使用当前会话真实类型', () => {
    const activeConversation = buildConversation({
      id: 'conv-group-2',
      type: CONVERSATION_TYPE_GROUP,
    });

    expect(
      resolveConversationBinding({
        conversations: [activeConversation],
        currentConversationId: activeConversation.id,
        selectedSpaceKind: 'dm',
        isIMActive: true,
      }),
    ).toMatchObject({
      conversationId: 'conv-group-2',
      conversationKind: 'im-group',
      activeConversation,
    });
  });

  it('按当前选择类型解析可见的 space context', () => {
    const selectedSpace = {
      id: 'space-workspace-1',
      name: 'Bot',
      organization_id: 'ws-1',
    };
    const conversationSpaceContext = {
      id: 'space-conv-1',
      name: 'DM',
      organization_id: 'ws-1',
    };

    expect(
      resolveVisibleSpaceContext({
        selectedSpaceKind: 'dm',
        selectedSpace,
        conversationSpaceContext,
      })?.id,
    ).toBe('space-conv-1');

    expect(
      resolveVisibleSpaceContext({
        selectedSpaceKind: 'workspace',
        selectedSpace,
        conversationSpaceContext,
      })?.id,
    ).toBe('space-workspace-1');
  });

  it('设置态下仍保留底层选择上下文，避免关闭设置后回填漂移', () => {
    const selectedSpace = {
      id: 'space-workspace-1',
      name: 'Bot',
      organization_id: 'ws-1',
    };
    const activeConversation = buildConversation({
      id: 'conv-3',
      space_id: 'space-conv-3',
      name: 'Project DM',
    });

    expect(
      resolveActiveShellContext({
        isSettingsOpen: true,
        selectedSpaceKind: 'dm',
        selectedSpace,
        conversations: [activeConversation],
        currentConversationId: activeConversation.id,
        isIMActive: true,
        organizationId: 'ws-1',
      }),
    ).toMatchObject({
      source: 'settings',
      selectedSpaceKind: 'dm',
      selectedConversationId: 'conv-3',
      selectedConversationKind: 'dm',
      visibleSpaceContext: {
        id: 'space-conv-3',
        name: 'Project DM',
        organization_id: 'ws-1',
      },
    });
  });

  it('优先使用 config 映射，缺失时回退到 fallback crawlspace', () => {
    const configsById: Record<string, CrawlspaceConfig> = {
      'cs-workspace-1': buildConfig('cs-workspace-1', 'space-workspace-1'),
    };

    expect(
      resolveSpaceCrawlspaceId({
        activeSpaceId: 'space-workspace-1',
        crawlspaceConfigById: configsById,
        fallbackCrawlspaceId: 'cs-fallback',
      }),
    ).toBe('cs-workspace-1');

    expect(
      resolveSpaceCrawlspaceId({
        activeSpaceId: 'space-group-1',
        crawlspaceConfigById: configsById,
        fallbackCrawlspaceId: 'cs-group-fallback',
      }),
    ).toBe('cs-group-fallback');
  });

  it('在当前会话不存在时返回空 active conversation', () => {
    expect(
      resolveActiveConversation({
        conversations: [buildConversation()],
        currentConversationId: 'missing-conv',
      }),
    ).toBe(null);
  });
});

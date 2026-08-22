import { describe, expect, it } from 'vitest';
import { buildConversationReferenceSection } from '../sections.js';

describe('buildConversationReferenceSection', () => {
  it('returns empty string when threadId missing', () => {
    expect(buildConversationReferenceSection(undefined)).toBe('');
    expect(buildConversationReferenceSection({ threadId: '  ', organizationId: 'wt', spaceId: 'sp' })).toBe('');
  });

  it('renders summary, runtime labels, and archive paths', () => {
    const result = buildConversationReferenceSection({
      threadId: 'sess-xyz',
      title: '磁盘盘点',
      preview: '## 盘点完成',
      organizationId: 'wt-789',
      organizationName: 'TabTin',
      spaceId: 'space-abc',
      spaceName: '工作空间',
      workspaceRoot: '/sandbox/wt-789/space-abc',
      archiveDir: '/platform-data/wt-789/space-abc/conversations/sessions',
      toolLogsDir: '/platform-data/wt-789/space-abc/conversations/tool-logs',
      lastMessageAt: '2026-05-23T02:00:00Z',
      messageCount: 42,
    });

    expect(result).toContain('<conversation_reference>');
    expect(result).toContain('标题：       磁盘盘点');
    expect(result).toContain('消息数：     42');
    expect(result).toContain('组织：       "TabTin"   (id: wt-789)');
    expect(result).toContain('工作空间：  "工作空间"   (id: space-abc)');
    expect(result).toContain('会话：       sess-xyz');
    expect(result).toContain('messages.jsonl');
    expect(result).toContain('/platform-data/wt-789/space-abc/conversations/sessions/sess-xyz/');
    expect(result).toContain('/platform-data/wt-789/space-abc/conversations/tool-logs/sess-xyz/');
    expect(result).toContain('</conversation_reference>');
  });

  it('renders lastMessageAt in the user device timezone with explicit offset', () => {
    const result = buildConversationReferenceSection({
      threadId: 'sess-tz',
      organizationId: 'wt',
      spaceId: 'sp',
      lastMessageAt: '2026-05-30T23:33:24.748Z',
      timeZone: 'Asia/Shanghai',
    });
    // 本地+offset，而非裸 UTC ISO 串——消除"差一天"误判。
    expect(result).toContain('最后活动：   2026-05-31 07:33 (UTC+8)');
    expect(result).not.toContain('2026-05-30T23:33:24.748Z');
  });

  it('falls back to UTC for lastMessageAt when timezone is absent', () => {
    const result = buildConversationReferenceSection({
      threadId: 'sess-tz2',
      organizationId: 'wt',
      spaceId: 'sp',
      createdAt: '2026-05-30T23:33:24.748Z',
    });
    expect(result).toContain('创建时间：   2026-05-30 23:33 (UTC+0)');
  });

  it('omits archive paths when host cannot resolve them', () => {
    const result = buildConversationReferenceSection({
      threadId: 'sess-only',
      organizationId: 'wt',
      spaceId: 'sp',
    });

    expect(result).toContain('本地 archive 路径未能解析');
    expect(result).not.toContain('/conversations/sessions/sess-only/');
  });
});

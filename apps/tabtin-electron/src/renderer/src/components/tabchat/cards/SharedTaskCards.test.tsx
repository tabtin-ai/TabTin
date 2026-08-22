import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import enUS from '@/i18n/locales/en-US/tabchat.json';
import {
  SessionCollaborationCard,
  type SessionCollaborationCardContent,
} from './SessionCollaborationCard';
import {
  SessionContinuationCard,
  type SessionContinuationCardContent,
} from './SessionContinuationCard';

const COLLABORATION_CONTENT: SessionCollaborationCardContent = {
  kindLabel: '协作邀请',
  statusLabel: '参与中',
  relation: '对方邀请你参与原任务',
  permissionLabel: '协作',
  permissionCopy: '可查看进展并补充指令',
  infoTitle: '运行中',
  infoDescription: '指令在发起方的执行现场运行。',
  footer: '已加入协作任务',
};

const CONTINUATION_CONTENT: SessionContinuationCardContent = {
  kindLabel: '交给你继续',
  statusLabel: '待处理',
  relation: '对方请你基于当前内容独立继续',
  permissionLabel: '独立任务',
  permissionCopy: '不授予原任务访问权',
  infoTitle: '准备续接',
  infoDescription: '使用发送时冻结的上下文。',
  footer: '将在你的 Agent / Workspace 执行',
};

describe('new shared task card renderers', () => {
  it('keeps card content readable and exposes an English keyboard action', () => {
    const onAction = vi.fn();
    const { container } = render(
      <SessionCollaborationCard
        phase="activeCollaborate"
        title="调研任务"
        content={COLLABORATION_CONTENT}
        action={{
          id: 'openCollaboration',
          label: enUS.sharedTaskCard.openCollaboration,
        }}
        onAction={onAction}
      />,
    );

    expect(
      container.querySelector('[data-phase="activeCollaborate"]'),
    ).toBeTruthy();
    const article = screen.getByRole('article');
    expect(within(article).getByText('参与中')).toBeTruthy();
    expect(within(article).getByText('运行中')).toBeTruthy();
    const openButton = screen.getByRole('button', {
      name: enUS.sharedTaskCard.openCollaboration,
    });
    fireEvent.keyDown(openButton, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith('openCollaboration');
  });

  it('keeps owner access while stopped without opening the card for the recipient', () => {
    const ownerAction = vi.fn();
    const { unmount } = render(
      <SessionCollaborationCard
        phase="stopped"
        title="调研任务"
        content={{ ...COLLABORATION_CONTENT, statusLabel: '已停止' }}
        action={{
          id: 'openOriginalTask',
          label: '打开原任务',
          tone: 'neutral',
        }}
        onAction={ownerAction}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '打开原任务' }));
    expect(ownerAction).toHaveBeenCalledWith('openOriginalTask');
    unmount();

    const recipientAction = vi.fn();
    render(
      <SessionCollaborationCard
        phase="stopped"
        title="调研任务"
        content={{ ...COLLABORATION_CONTENT, statusLabel: '已停止' }}
        action={{ id: 'inspectStatus', label: '查看状态', tone: 'neutral' }}
        onAction={recipientAction}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '查看状态' }));
    expect(recipientAction).toHaveBeenCalledWith('inspectStatus');
    expect(recipientAction).not.toHaveBeenCalledWith('openCollaboration');
  });

  it('only exposes retry when collaboration detail loading fails', () => {
    const onAction = vi.fn();
    render(
      <SessionCollaborationCard
        phase="detailError"
        title="发送时标题"
        content={{ ...COLLABORATION_CONTENT, statusLabel: '加载失败' }}
        action={{ id: 'retryLoad', label: '重试加载', tone: 'danger' }}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '重试加载' }));
    expect(onAction).toHaveBeenCalledWith('retryLoad');
    expect(screen.queryByRole('button', { name: '参与任务' })).toBeNull();
  });

  it('keeps an unresolved collaboration contract non-interactive', () => {
    render(
      <SessionCollaborationCard
        phase="detailError"
        title="发送时标题"
        content={{ ...COLLABORATION_CONTENT, statusLabel: '详情暂不可用' }}
        action={null}
      />,
    );

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders only the continuation action projected by the control plane', () => {
    const onAction = vi.fn();
    const { unmount } = render(
      <SessionContinuationCard
        phase="pending"
        title="客户增长方案"
        content={CONTINUATION_CONTENT}
        action={{
          id: 'createContinuationTask',
          label: '创建独立任务',
        }}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '创建独立任务' }));
    expect(onAction).toHaveBeenCalledWith('createContinuationTask');
    unmount();

    render(
      <SessionContinuationCard
        phase="pending"
        title="客户增长方案"
        content={CONTINUATION_CONTENT}
        action={null}
        onAction={onAction}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('isolates unavailable resources and renders creating as a disabled loading CTA', () => {
    const { container, rerender } = render(
      <SessionContinuationCard
        phase="partial"
        title="客户增长方案"
        content={{
          ...CONTINUATION_CONTENT,
          secondaryStatusLabel: '部分材料不可用',
          resources: [
            { label: '访谈纪要.md' },
            {
              label: '客户名单',
              unavailable: true,
              unavailableLabel: '不可用',
            },
          ],
        }}
        action={{
          id: 'createContinuationTask',
          label: '创建独立任务',
        }}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText('客户名单', { exact: false }).className).toContain(
      'line-through',
    );
    expect(container.querySelector('.sr-only')?.textContent).toContain(
      '不可用',
    );

    rerender(
      <SessionContinuationCard
        phase="creating"
        title="客户增长方案"
        content={{ ...CONTINUATION_CONTENT, statusLabel: '创建中' }}
        action={{ label: '正在创建', disabled: true, loading: true }}
        onAction={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-phase="creating"]')).toBeTruthy();
    const creatingButton = screen.getByRole('button', { name: '正在创建' });
    expect((creatingButton as HTMLButtonElement).disabled).toBe(true);
    expect(creatingButton.getAttribute('aria-busy')).toBe('true');
  });

  it('renders an empty continuation as a disabled CTA', () => {
    render(
      <SessionContinuationCard
        phase="empty"
        title="客户增长方案"
        content={{ ...CONTINUATION_CONTENT, statusLabel: '需补充内容' }}
        action={{ label: '暂不可创建', disabled: true }}
        onAction={vi.fn()}
      />,
    );
    expect(
      (screen.getByRole('button', { name: '暂不可创建' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

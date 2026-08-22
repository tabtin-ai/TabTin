import { describe, expect, it } from 'vitest';
import {
  buildActiveTodosSection,
  buildTodoCompletionNudgeBody,
} from '../active-todos-section.js';

describe('buildActiveTodosSection', () => {
  it('列出全批状态与进度', () => {
    const body = buildActiveTodosSection({
      todos: [
        { id: '1', content: '采集', status: 'completed' },
        { id: '2', content: '汇报', status: 'in_progress' },
        { id: '3', content: '清理', status: 'pending' },
      ],
    });
    expect(body).toContain('当前待办进度：1/3');
    expect(body).toContain('- [completed] 采集');
    expect(body).toContain('- [进行中] 汇报');
    expect(body).toContain('- [待办] 清理');
    expect(body).toContain('todo(action="update")');
  });

  it('cancelled 不计入进度分母', () => {
    const body = buildActiveTodosSection({
      todos: [
        { id: '1', content: 'A', status: 'completed' },
        { id: '2', content: 'B', status: 'cancelled' },
      ],
    });
    expect(body).toContain('当前待办进度：1/1');
    expect(body).toContain('- [已取消] B');
  });

  it('paused 保留为未完成任务并提示解除阻塞后完成', () => {
    const body = buildActiveTodosSection({
      todos: [
        { id: '1', content: '等待用户授权', status: 'paused' },
      ],
    });
    expect(body).toContain('当前待办进度：0/1');
    expect(body).toContain('- [已暂停] 等待用户授权');
    expect(body).toContain('解除阻塞后再恢复推进到 completed');
  });
});

describe('buildTodoCompletionNudgeBody', () => {
  it('列出未完成 id 与硬提醒', () => {
    const body = buildTodoCompletionNudgeBody([
      { id: 'r1', content: '汇报结果', status: 'in_progress' },
    ]);
    expect(body).toContain('id="r1"');
    expect(body).toContain('[进行中] 汇报结果');
    expect(body).toContain('不要先写总结');
  });

  it('阻塞时允许 paused 结束本轮，但不把 paused 视为完成', () => {
    const body = buildTodoCompletionNudgeBody([
      { id: 'oauth', content: '等待用户授权', status: 'pending' },
    ]);
    expect(body).toContain('阻塞');
    expect(body).toContain('paused');
    expect(body).toContain('解除阻塞后仍必须恢复并完成');
  });
});

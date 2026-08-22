/**
 * skill-renderer 两区渲染单测（，合并 release 表格格式后）：
 * - renderSkillNames：静态段，全部 skill 名称（Markdown 表，key+source，无 desc）。
 * - renderRelevantTopK：动态段，Top-8 相关性表格，仅前 5 带描述；无信号返回 null。
 */

import { describe, it, expect } from 'vitest';
import {
  renderSkillNames,
  renderRelevantTopK,
  renderSkillsBlock,
} from '../skill-renderer.js';
import type { LocalSkill } from '../skill-types.js';
import { createLexicalSkillRecall } from '../skill-recall-port.js';

const testRecall = createLexicalSkillRecall();
const withRecall = (opts?: object) => ({ recall: testRecall, ...(opts ?? {}) });

function skill(
  slug: string,
  name: string,
  description: string,
  metaSource: LocalSkill['metaSource'] = 'user',
): LocalSkill {
  const canonicalKey = metaSource === 'platform' ? `platform:${slug}` : `user:${slug}`;
  return {
    canonicalKey,
    source: metaSource ?? 'user',
    slug,
    name,
    description,
    docPath: `/tmp/${slug}/SKILL.md`,
    realpath: `/tmp/${slug}/SKILL.md`,
    content: `# ${name}\n${description}`,
    rootKind: 'space',
    metaSource,
    indexedAt: 0,
  };
}

function appSkill(appId: string, slug: string, name: string, description: string): LocalSkill {
  return {
    ...skill(slug, name, description, 'app'),
    canonicalKey: `app:${appId}/${slug}`,
    source: 'app',
    metaSource: 'app',
    appId,
  };
}

function deviceSkill(slug: string, name: string, description: string): LocalSkill {
  return {
    ...skill(slug, name, description, 'device'),
    canonicalKey: `device:${slug}`,
    source: 'device',
    metaSource: 'device',
  };
}

function carryAll(skills: LocalSkill[]): Record<string, boolean> {
  return Object.fromEntries(skills.map((s) => [s.canonicalKey, true]));
}

const SKILLS: LocalSkill[] = [
  skill('mail', '邮箱', '飞书邮箱 起草邮件 发送邮件 回复邮件'),
  skill('sheets', '电子表格', '飞书电子表格 创建和操作表格 导出表格数据'),
  skill('calendar', '日历', '飞书日历 管理日程和会议室 预定会议室'),
];

/** 解析 Markdown 表格数据行为 {key, source, desc}[]（跳过表头 + 分隔行）。 */
function tableRows(rendered: string): Array<{ key: string; source: string; desc: string }> {
  return rendered
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| key ') && !l.startsWith('| ---'))
    .map((l) => {
      const cells = l.split('|').slice(1, -1).map((c) => c.trim());
      return { key: cells[0], source: cells[1], desc: cells[2] };
    });
}

describe('renderSkillNames（静态段：全部名称，列表 - key，无表格/无 desc）', () => {
  it('列出全部 skill 为 - key 列表、不含表格/描述、与输入顺序无关', async () => {
    const out = renderSkillNames(SKILLS, {
      budgetChars: 8000,
      enabledMap: carryAll(SKILLS),
    })!;
    expect(out).not.toContain('|'); // 不是表格
    expect(out).toContain('以下列表是你所携带的技能');
    expect(out).toContain('`<relevant_skills>`');
    expect(out).toContain('当任务符合 skill 描述的场景时使用');
    expect(out).not.toContain('不是 App 选型');
    expect(out).not.toContain('不要回显 canonical key');
    expect(out).not.toContain('在 Finder 中打开技能文件夹');
    const keys = out
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim());
    expect(keys.sort()).toEqual(['user:calendar', 'user:mail', 'user:sheets']);
    // 与输入顺序无关（组内字母序）
    const out2 = renderSkillNames([...SKILLS].reverse(), {
      budgetChars: 8000,
      enabledMap: carryAll(SKILLS),
    })!;
    expect(out).toBe(out2);
  });

  it('无 enabledMap / 零启用时只注入最小 skill header（封闭集无 key）', () => {
    const out = renderSkillNames(SKILLS, { budgetChars: 8000 });
    expect(out).toContain('以下列表是你所携带的技能');
    expect(out).not.toContain('不要回显 canonical key');
    expect(out).not.toContain('SKILL.md');
    expect(out).not.toContain('本地路径');
    expect(out).not.toContain('工作区目录');
    expect(out!.split('\n').filter((l) => l.startsWith('- '))).toEqual([]);
  });

  it('已启用的本机 Skill 出现在 Agent 自报能力使用的静态名录', () => {
    const localSkill = deviceSkill('local-cli', '本机命令流程', '执行本机命令流程');
    const out = renderSkillNames([localSkill], {
      budgetChars: 8000,
      enabledMap: { 'device:local-cli': true },
    });

    expect(out).toContain('- device:local-cli');
  });

  it('兼容 Skill 区块与静态名录使用同一来源集合', () => {
    const localSkill = deviceSkill('local-cli', '本机命令流程', '执行本机命令流程');
    const out = renderSkillsBlock([localSkill], {
      budgetChars: 8000,
      enabledMap: { 'device:local-cli': true },
    });

    expect(out).toContain('| device:local-cli | device |');
  });
});

describe('renderRelevantTopK（动态段：Top-8 表格，前 5 带描述）', () => {
  it('最相关的 skill 居首、带完整描述', async () => {
    const out = (await renderRelevantTopK(SKILLS, '帮我导出表格', 8000, withRecall()))!;
    const rows = tableRows(out);
    expect(rows[0].key).toBe('user:sheets');
    expect(rows[0].desc).not.toBe('—');
    expect(rows[0].desc.length).toBeGreaterThan(0);
  });

  it('query 命中邮件时 mail 居首', async () => {
    const out = (await renderRelevantTopK(SKILLS, '给他回复一封邮件', 8000, withRecall()))!;
    expect(tableRows(out)[0].key).toBe('user:mail');
  });

  it('最多展示 Top-8，其中仅 Top-5 带描述（其余 desc 为 —）', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      skill(`s${i}`, `技能${i}`, `描述 关键词${i} 表格导出`),
    );
    const rows = tableRows((await renderRelevantTopK(many, '表格导出', 8000, withRecall()))!);
    expect(rows.length).toBe(8);
    expect(rows.filter((r) => r.desc !== '—').length).toBe(5);
    expect(rows.slice(0, 5).every((r) => r.desc !== '—')).toBe(true);
    expect(rows.slice(5).every((r) => r.desc === '—')).toBe(true);
  });

  it('无词法信号返回 null（不注入动态段）', async () => {
    expect(await renderRelevantTopK(SKILLS, 'kubernetes docker 部署', 8000, withRecall())).toBeNull();
    expect(await renderRelevantTopK(SKILLS, '', 8000, withRecall())).toBeNull();
  });

  it('无词法命中但有 focused App 时，fallback 到该 App skill', async () => {
    const mixed: LocalSkill[] = [
      appSkill('tabdoc', 'tabdoc-operator', 'TabDoc Operator', '文档创建 编辑 检索'),
      appSkill('tabdata', 'table-operator', 'Table Operator', '表格字段 记录 视图'),
    ];
    const out = (await renderRelevantTopK(mixed, '继续整理一下', 8000, withRecall({
      focusedApp: 'tabdoc',
    })))!;
    const rows = tableRows(out);
    expect(rows.map((r) => r.key)).toEqual(['app:tabdoc/tabdoc-operator']);
  });

  it('明确跨 App query 仍由 BM25 覆盖 focused App 加权', async () => {
    const mixed: LocalSkill[] = [
      appSkill('tabdoc', 'tabdoc-operator', 'TabDoc Operator', '文档创建 编辑 检索'),
      appSkill('tabdata', 'table-operator', 'Table Operator', '表格结构 数据导出 视图'),
    ];
    const out = (await renderRelevantTopK(mixed, '导出表格数据', 8000, withRecall({
      focusedApp: 'tabdoc',
    })))!;
    expect(tableRows(out)[0].key).toBe('app:tabdata/table-operator');
  });

  it('跨来源：app skill 也能凭相关性居首', async () => {
    const mixed: LocalSkill[] = [
      skill('device', '设备', '设备状态 电量', 'platform'),
      appSkill('tabweb', 'browser', '浏览器', '在浏览器中打开网页 操作网页'),
    ];
    const out = (await renderRelevantTopK(mixed, '在浏览器中打开百度', 8000, withRecall()))!;
    expect(tableRows(out)[0].key).toBe('app:tabweb/browser');
  });

  it('前 5 带描述里保底 3 个 app/platform（把内置项从窗口外提到窗口内）', async () => {
    // 前排相关性更高的都是 user skill，app/platform 只有弱命中（排在后面）。
    const skills: LocalSkill[] = [
      skill('u0', 'U0', 'alpha beta gamma delta'),
      skill('u1', 'U1', 'alpha beta gamma'),
      skill('u2', 'U2', 'alpha beta'),
      skill('u3', 'U3', 'alpha'),
      appSkill('appx', 'ax', 'AX', 'alpha zzz'),
      skill('p0', 'P0', 'alpha yyy', 'platform'),
      appSkill('appy', 'ay', 'AY', 'alpha xxx'),
    ];
    const rows = tableRows((await renderRelevantTopK(skills, 'alpha', 8000, withRecall()))!);
    const top5 = rows.slice(0, 5);
    const builtinInTop5 = top5.filter(
      (r) => r.source === 'app' || r.source === 'platform',
    ).length;
    expect(builtinInTop5).toBeGreaterThanOrEqual(3);
    // 保底项必须带描述（落在前 5），不是被塞到只带名字的第 6-8 位
    expect(top5.every((r) => r.desc !== '—')).toBe(true);
  });

  it('保底只填到 3 个，剩余名额仍留给相关性最高的非内置项', async () => {
    // 6 个 user skill 相关性最高（含稀有词命中），3 个内置弱命中排在其后，
    // 需从窗口外提拔恰好 3 个内置进前 5，另 2 个名额仍是最相关的 user skill。
    const skills: LocalSkill[] = [
      skill('u0', 'U0', 'zeta alpha'),
      skill('u1', 'U1', 'zeta alpha'),
      skill('u2', 'U2', 'zeta alpha'),
      skill('u3', 'U3', 'zeta alpha'),
      appSkill('appx', 'ax', 'AX', 'zeta alpha pad pad pad pad pad'),
      skill('p0', 'P0', 'zeta alpha pad pad pad pad pad', 'platform'),
      appSkill('appy', 'ay', 'AY', 'zeta alpha pad pad pad pad pad'),
    ];
    const top5 = tableRows((await renderRelevantTopK(skills, 'zeta alpha', 8000, withRecall()))!).slice(0, 5);
    // 恰好 3 个内置（不多占），另 2 个名额是最相关的 user skill
    expect(top5.filter((r) => r.source === 'app' || r.source === 'platform').length).toBe(3);
    expect(top5.filter((r) => r.source === 'user').length).toBe(2);
    expect(top5.every((r) => r.desc !== '—')).toBe(true);
  });

  it('候选池 app/platform 不足 3 个时按实际数量保底、不硬凑', async () => {
    const skills: LocalSkill[] = [
      skill('u0', 'U0', 'alpha beta gamma delta'),
      skill('u1', 'U1', 'alpha beta gamma'),
      skill('u2', 'U2', 'alpha beta'),
      skill('u3', 'U3', 'alpha'),
      appSkill('appx', 'ax', 'AX', 'alpha zzz'),
    ];
    const rows = tableRows((await renderRelevantTopK(skills, 'alpha', 8000, withRecall()))!);
    const builtinInTop5 = rows
      .slice(0, 5)
      .filter((r) => r.source === 'app' || r.source === 'platform').length;
    expect(builtinInTop5).toBe(1); // 池里只有 1 个 app，保底不超过实际数量
  });

  it('相对阈值：仅泛词弱命中被过滤，只留强命中', async () => {
    const skills: LocalSkill[] = [
      skill('strong', 'Strong', 'unicorn common'),
      skill('weak1', 'W1', 'common'),
      skill('weak2', 'W2', 'common'),
      skill('weak3', 'W3', 'common'),
    ];
    const out = (await renderRelevantTopK(skills, 'unicorn common', 8000, withRecall()))!;
    const keys = tableRows(out).map((r) => r.key);
    expect(keys).toContain('user:strong'); // 强命中（含稀有词 unicorn）保留
    expect(keys).not.toContain('user:weak1'); // 仅泛词 common 的弱命中被阈值过滤
  });
});

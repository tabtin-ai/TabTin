/**
 * Browser CLI help ↔ agent prompt 轻量跨语言契约审计（Wave 1 / Task E）
 *
 * 范围刻意收窄：机器可读 fixture 继续校验 Browser CLI 契约，同时确保
 * `<apps>` 只承担 App 选型，不再内嵌具体子命令、参数与示例。
 *
 * 稳定跨语言桥：
 *   - Go live test 从真实 Cobra / CommandDef 树计算值，与小型 JSON fixture 比较；
 *   - 本测试只读该 fixture，并确认生产 `buildAppsSection` / `buildSystemPrompt`
 *     不复制这些 CLI 细节。
 *
 * 因此 TS 不解析 Go 源码，不受 CommandDef / FlagDef 合法多行布局、字段重排、
 * 嵌套 Enum 等源码排版变化影响。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { buildAppsSection } from '../sections.js';
import { buildSystemPrompt } from '../builder.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(TEST_DIR, 'fixtures/browser-cli-prompt-contract.json');

interface BrowserPromptFacingContract {
  schemaVersion: number;
  open: {
    use: string;
    requiredFlags: string[];
    argsMapping: string[];
  };
  print: {
    requiredFlags: string[];
  };
  capabilities: {
    exists: boolean;
  };
}

const TABWEB_APP = {
  key: 'tabweb',
  cliKey: 'browser',
  displayName: '浏览器',
  capability: '网页浏览与采集',
} as const;

function loadContractFixture(): BrowserPromptFacingContract {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8')) as BrowserPromptFacingContract;
}

describe('Browser CLI ↔ agent-prompt contract（Wave 1 / Task E）', () => {
  const contract = loadContractFixture();

  it('机器可读桥只包含 prompt-facing 小型契约', () => {
    expect(contract.schemaVersion).toBe(1);
    expect(Object.keys(contract).sort()).toEqual([
      'capabilities',
      'open',
      'print',
      'schemaVersion',
    ]);
  });

  it('fixture：open 必填 url、无 ArgsMapping、Use 无位置槽', () => {
    expect(contract.open.requiredFlags).toContain('url');
    expect(contract.open.argsMapping).toEqual([]);
    expect(contract.open.use).toBe('open');
  });

  it('fixture：print 必填 save 且 capabilities 存在', () => {
    expect(contract.print.requiredFlags).toContain('save');
    expect(contract.capabilities.exists).toBe(true);
  });

  it('生产 <apps> 段不内嵌 Browser 子命令、参数和示例', () => {
    const apps = buildAppsSection([TABWEB_APP]);
    for (const flag of contract.open.requiredFlags) {
      expect(apps).not.toContain(`tabtin browser ${contract.open.use} --${flag}`);
    }
    for (const flag of contract.print.requiredFlags) {
      expect(apps).not.toContain(`tabtin browser print --${flag}`);
    }
    expect(apps).not.toContain('tabtin browser capabilities');
    expect(apps).not.toContain('tabtin browser open https://');
    expect(apps).not.toContain('tabtin browser open <url>');
    expect(apps).not.toContain('示例：');
  });

  it('buildSystemPrompt 注入 apps 后仍不携带 Browser CLI 教程', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      agentMode: 'agent',
      enabledApps: [TABWEB_APP],
    });
    expect(prompt).toContain('<apps>');
    for (const flag of contract.open.requiredFlags) {
      expect(prompt).not.toContain(`tabtin browser ${contract.open.use} --${flag}`);
    }
    for (const flag of contract.print.requiredFlags) {
      expect(prompt).not.toContain(`tabtin browser print --${flag}`);
    }
    expect(prompt).not.toContain('tabtin browser capabilities');
    expect(prompt).not.toContain('tabtin browser open https://');
    expect(prompt).not.toContain('tabtin browser open <url>');
  });
});

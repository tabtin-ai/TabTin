/**
 * 路径权限治理 Wave 4 (L21 + P1-3) + W7 / B6 收口：
 * FrontendActionBridge 永远不信任 wire 上的 `_already_judged` 字段。
 *
 * 钉死契约（P1-3 安全裂缝跨端复刻防御 + W7 死参数清退）：
 *   - FrontendActionBridge 收到 wire envelope（来自 Daemon publish_action）
 *     时，即使 params._already_judged === true 也强制走完整 boundary
 *   - **W7 / B6 收口**：不再透传 alreadyJudged 字段（D3 反例死参数清退）；
 *     `validateProjectPath` 默认 alreadyJudged=false 走完整 boundary 检查；
 *     不再有 `const alreadyJudged = false` 这种"永远 false 的字段挂签名上"
 *   - 红线 + boundary 检查必须跑完
 *
 * 用源码字符串匹配兜底（与 daemon action-bridge 同模式）—— FrontendActionBridge
 * 端到端 mock 太重（依赖 ipcMain / Electron app / BrowserWindow / 共享
 * browser tool 等），用 source-level structural assertion 钉契约。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../FrontendActionBridge.ts'),
  'utf-8',
);

describe('FrontendActionBridge — Wave 4 P1-3 + W7 B6 死参数清退', () => {
  it('不再有 const alreadyJudged = false（D3 反例死参数已清退）', () => {
    // W4 阶段是 const alreadyJudged = false 锁死；W7 / B6 直接删——
    // validateProjectPath 默认 alreadyJudged=false 走完整 boundary 检查，
    // 不再透传"永远 false 的字段"。
    expect(SRC).not.toContain('const alreadyJudged = false');
    // 也不应该再有"读 _already_judged === true"的派生
    expect(SRC).not.toMatch(
      /alreadyJudged\s*=\s*\(params as any\)\?\._already_judged\s*===\s*true/,
    );
  });

  it('FILE_POLICY_ACTIONS 分支 validateProjectPath 调用不再传 alreadyJudged', () => {
    // W7 / B6：validateProjectPath 调用 simplify
    const fileBlock = SRC.match(
      /FILE_POLICY_ACTIONS\.has\(actionType\)[\s\S]{0,2500}?validateProjectPath\([\s\S]{0,400}?\}\)/,
    );
    expect(fileBlock).not.toBeNull();
    expect(fileBlock?.[0]).not.toMatch(/\balreadyJudged\b/);
  });

  it('注释明确说明 P1-3 + W7 / B6 死参数清退', () => {
    expect(SRC).toContain('P1-3');
    expect(SRC).toContain('wire envelope');
    expect(SRC).toMatch(/伪造|塞 wire|不信任/);
    // W7 收口提及
    expect(SRC).toContain('W7 / B6');
  });
});

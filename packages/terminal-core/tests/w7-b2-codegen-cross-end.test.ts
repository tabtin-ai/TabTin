/**
 * W7/B2 codegen 接入 · TS 端跨端契约
 *
 * 钉死跨端 4 条 basename pattern (.crt / .kdbx / id_dsa / id_ecdsa) 在
 * terminal-core/matchSensitivePath 命中 —— 与 Python `path_safety.matches_sensitive_path`
 * 同款 4 条断言对应（test_path_safety.py:TestSensitivePathBasenameCrossEndCoverage）。
 *
 * 两端共享同一份 SSoT（`packages/security-policy/src/hardline-v3-rules.json`
 * 的 `path_scan_rules`），由 `scripts/codegen-hardline.py` 输出
 * `terminal-core/sensitive-paths.generated.ts` + Python `generated_hardline.py`。
 *
 * 任何漂移（一端有 / 一端没有）都会被这两端各 4 条断言捕获。
 */
import { describe, it, expect } from 'vitest';
import { matchSensitivePath, SENSITIVE_PATH_RULES } from '../src/allowlist';

describe('W7/B2: codegen 接入 — 4 条 basename pattern 跨端覆盖', () => {
  describe('SENSITIVE_PATH_RULES 真从 codegen 输出派生', () => {
    it('载入了 path_scan_rules 全量规则（>= 33 条，含 W7/B2 漂移修复后的总数）', () => {
      // 32 (terminal-core 原有 30 + W7 加的 *.crt + *.kdbx) + 1 (W7/B2 加的 id_(rsa|ed25519|ecdsa|dsa) substring)
      expect(SENSITIVE_PATH_RULES.length).toBeGreaterThanOrEqual(33);
    });

    it('包含 *.crt 规则', () => {
      const labels = SENSITIVE_PATH_RULES.map((r) => r.label);
      expect(labels).toContain('*.crt');
    });

    it('包含 *.kdbx 规则', () => {
      const labels = SENSITIVE_PATH_RULES.map((r) => r.label);
      expect(labels).toContain('*.kdbx');
    });

    it('包含 ssh private key by name (substring) 规则', () => {
      const labels = SENSITIVE_PATH_RULES.map((r) => r.label);
      expect(labels).toContain('ssh private key by name (substring)');
    });
  });

  describe('matchSensitivePath: 4 条 basename pattern 命中（shell 命令扫描场景）', () => {
    it('cat ./server.crt（.crt 命中）', () => {
      expect(matchSensitivePath('cat ./server.crt')).toBe('*.crt');
    });

    it('vim my-cert.crt.bak（.crt 命中 substring）', () => {
      // .crt 后是 . 是 word boundary 所以 substring 命中
      expect(matchSensitivePath('vim my-cert.crt.bak')).toBe('*.crt');
    });

    it('cat ./db.kdbx（.kdbx 命中）', () => {
      expect(matchSensitivePath('cat ./db.kdbx')).toBe('*.kdbx');
    });

    it('cat ./id_dsa（.ssh/ 之外的 id_dsa 也命中 — W7/B2 修复漂移）', () => {
      // W7/B2 之前 terminal-core 没有 id_dsa substring 规则，靠 .ssh/ 兜底——
      // .ssh/ 之外的 id_dsa 漏过；codegen 接入后 id_(rsa|ed25519|ecdsa|dsa)
      // 规则补上这块
      expect(matchSensitivePath('cat ./id_dsa')).toBe(
        'ssh private key by name (substring)',
      );
    });

    it('cat ./id_ecdsa（.ssh/ 之外的 id_ecdsa 也命中 — W7/B2 修复漂移）', () => {
      expect(matchSensitivePath('cat ./id_ecdsa')).toBe(
        'ssh private key by name (substring)',
      );
    });

    it('cat ./id_rsa（命名 SSH 私钥）', () => {
      expect(matchSensitivePath('cat ./id_rsa')).toBe(
        'ssh private key by name (substring)',
      );
    });

    it('cat ./id_ed25519（命名 SSH 私钥）', () => {
      expect(matchSensitivePath('cat ./id_ed25519')).toBe(
        'ssh private key by name (substring)',
      );
    });

    it('误命中防御 — `my_id_rsa_helper.sh` 不命中（前置是 word char）', () => {
      // 前置是 `_`（word char）→ (^|[^a-zA-Z0-9_]) 不成立 → 不命中
      // .ssh/ 也不命中（命令里没有 `.ssh/`）
      expect(matchSensitivePath('vim my_id_rsa_helper.sh')).toBeNull();
    });
  });

  describe('回归 — 老 SENSITIVE_PATH_RULES 行为完全不变', () => {
    it('cat /etc/shadow 仍命中', () => {
      expect(matchSensitivePath('cat /etc/shadow')).toBe('/etc/shadow');
    });

    it('cat ~/.ssh/id_rsa 仍命中 .ssh/', () => {
      // 注意：matchSensitivePath 命中第一条 rule 即返回；.ssh/ 在 ssh-private-key
      // 之前所以这里返回 .ssh/（与 codegen 之前同行为）
      expect(matchSensitivePath('cat ~/.ssh/id_rsa')).toBe('.ssh/');
    });

    it('cat ~/.aws/credentials 仍命中', () => {
      expect(matchSensitivePath('cat ~/.aws/credentials')).toBe(
        '.aws/credentials',
      );
    });

    it('cat package.json 仍 null', () => {
      expect(matchSensitivePath('cat package.json')).toBeNull();
    });
  });
});

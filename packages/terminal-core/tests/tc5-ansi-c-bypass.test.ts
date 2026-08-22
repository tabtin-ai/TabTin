/**
 * TC-5 回归测试：ANSI-C 引号 / 十六进制编码绕过 denylist
 *
 * 攻击向量：
 * - $'\x72\x6d' -rf /  → bash 解释为 rm -rf /
 * - $'\162\155' -rf /   → 八进制编码的 rm
 * - $'\u0072\u006d'     → Unicode 编码的 rm
 * - $"localized string" → 本地化引号
 *
 * 修复方案：ENV_VAR_EXPANSION_RE 已覆盖 $' 和 $" 模式，
 * 检测到时跳过 allowlist 并返回 deny。
 */
import { describe, it, expect } from 'vitest';
import {
  CommandValidator,
  containsEnvVarExpansion,
  containsAnsiCQuoting,
} from '../src/commandValidator';

describe('TC-5: ANSI-C 引号检测', () => {
  describe('containsAnsiCQuoting 检测编码序列', () => {
    it('检测十六进制编码 $\'\\xNN\'', () => {
      expect(containsAnsiCQuoting("$'\\x72\\x6d' -rf /")).toBe(true);
    });

    it('检测八进制编码 $\'\\NNN\'', () => {
      expect(containsAnsiCQuoting("$'\\162\\155' -rf /")).toBe(true);
    });

    it('检测 Unicode 编码 $\'\\uNNNN\'', () => {
      expect(containsAnsiCQuoting("$'\\u0072\\u006d'")).toBe(true);
    });

    it('检测 Unicode 宽编码 $\'\\UNNNNNNNN\'', () => {
      expect(containsAnsiCQuoting("$'\\U00000072\\U0000006d'")).toBe(true);
    });

    it('不误报普通 $\' 不含编码的情况', () => {
      // $'hello' 不含 \x \NNN \u 编码，不应被 containsAnsiCQuoting 检测
      // 但 containsEnvVarExpansion 仍会检测到 $' 前缀
      expect(containsAnsiCQuoting("$'hello'")).toBe(false);
    });

    it('不误报普通字符串', () => {
      expect(containsAnsiCQuoting('echo hello')).toBe(false);
      expect(containsAnsiCQuoting('ls -la')).toBe(false);
    });
  });

  describe('containsEnvVarExpansion 覆盖 ANSI-C 引号', () => {
    it('检测 $\' 前缀', () => {
      expect(containsEnvVarExpansion("$'\\x72\\x6d' -rf /")).toBe(true);
    });

    it('检测 $" 前缀（本地化引号）', () => {
      expect(containsEnvVarExpansion('$"localized string"')).toBe(true);
    });
  });

  describe('CommandValidator 拒绝 ANSI-C 编码命令', () => {
    const validator = new CommandValidator();

    it("拒绝 $'\\x72\\x6d' -rf /（十六进制编码的 rm）", () => {
      const result = validator.validate("$'\\x72\\x6d' -rf /");
      expect(result.allowed).toBe(false);
      expect(result.decision).toBe('deny');
    });

    it("拒绝 $'\\162\\155' -rf /（八进制编码的 rm）", () => {
      const result = validator.validate("$'\\162\\155' -rf /");
      expect(result.allowed).toBe(false);
      expect(result.decision).toBe('deny');
    });

    it('拒绝 $"rm" -rf /（本地化引号）', () => {
      const result = validator.validate('$"rm" -rf /');
      expect(result.allowed).toBe(false);
      expect(result.decision).toBe('deny');
    });

    it("拒绝混合编码 echo $'\\x63\\x61\\x74' /etc/passwd", () => {
      const result = validator.validate("echo $'\\x63\\x61\\x74' /etc/passwd");
      expect(result.allowed).toBe(false);
      expect(result.decision).toBe('deny');
    });

    it("拒绝 allowlist 命令 + ANSI-C 注入：cat $'\\x2f\\x65\\x74\\x63\\x2f\\x70\\x61\\x73\\x73\\x77\\x64'", () => {
      const result = validator.validate("cat $'\\x2f\\x65\\x74\\x63\\x2f\\x70\\x61\\x73\\x73\\x77\\x64'");
      expect(result.allowed).toBe(false);
      expect(result.decision).toBe('deny');
    });
  });
});

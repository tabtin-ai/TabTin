/**
 * 回归测试：CMD-005 换行符作为命令分隔符
 *
 * splitCommandChain 应将 \n 视为命令分隔符，
 * 防止 shell 换行注入绕过安全检查。
 */
import { describe, it, expect } from 'vitest';
import { splitCommandChain, CommandValidator } from '../src/commandValidator';

describe('CMD-005: splitCommandChain 换行符拆分', () => {
  it('换行符拆分为两条独立命令', () => {
    expect(splitCommandChain('echo hello\nrm -rf /')).toEqual(['echo hello', 'rm -rf /']);
  });

  it('多个换行符拆分为多条命令', () => {
    expect(splitCommandChain('echo a\necho b\necho c')).toEqual(['echo a', 'echo b', 'echo c']);
  });

  it('换行符与其他分隔符混合', () => {
    expect(splitCommandChain('echo a\necho b; echo c && echo d')).toEqual([
      'echo a', 'echo b', 'echo c', 'echo d',
    ]);
  });

  it('双引号内的换行符不拆分', () => {
    expect(splitCommandChain('echo "hello\nworld"')).toEqual(['echo "hello\nworld"']);
  });

  it('单引号内的换行符不拆分', () => {
    expect(splitCommandChain("echo 'hello\nworld'")).toEqual(["echo 'hello\nworld'"]);
  });

  it('连续换行符过滤空段', () => {
    expect(splitCommandChain('echo hello\n\necho world')).toEqual(['echo hello', 'echo world']);
  });
});

describe('CMD-005: CommandValidator 拦截换行注入', () => {
  const validator = new CommandValidator();

  it('echo hello\\nrm -rf / 被拒绝', () => {
    const result = validator.validate('echo hello\nrm -rf /');
    expect(result.allowed).toBe(false);
    expect(result.decision).toBe('deny');
    expect(result.ruleName).toBe('rm -rf root or home');
  });

  it('tabtin foo\\nsudo su 被拒绝', () => {
    const result = validator.validate('tabtin foo\nsudo su');
    expect(result.allowed).toBe(false);
    expect(result.decision).toBe('deny');
  });

  it('正常多行 echo 命令全部允许', () => {
    const result = validator.validate('echo a\necho b\necho c');
    expect(result.allowed).toBe(true);
  });
});

/**
 * RT-6 命令输出解码单测：治中文 / 非 UTF-8 Windows 控制台输出乱码。
 *
 * `spawnAgentShellProcess` 走 child_process.spawn（非 ConPTY），Windows 子 shell
 * 内建消息 / 原生工具按控制台 OEM 代码页（中文=CP936/GBK）输出，旧实现一律
 * `toString('utf8')` → 乱码。修法：合法 UTF-8 优先、否则按检测到的 OEM 代码页解。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import {
  decodeWithFallback,
  mapCodePageToLabel,
  spawnAgentShellProcess,
} from '../src/agent-process-runner.js';

// "中文" 两种编码：UTF-8 = E4B8AD E69687；GBK = D6D0 CEC4
const ZHONGWEN_UTF8 = Buffer.from([0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87]);
const ZHONGWEN_GBK = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);

describe('mapCodePageToLabel', () => {
  it('映射常见 Windows 代码页', () => {
    expect(mapCodePageToLabel(936)).toBe('gbk');
    expect(mapCodePageToLabel(65001)).toBe('utf-8');
    expect(mapCodePageToLabel(932)).toBe('shift_jis');
    expect(mapCodePageToLabel(949)).toBe('euc-kr');
    expect(mapCodePageToLabel(950)).toBe('big5');
  });

  it('未知代码页返回 undefined', () => {
    expect(mapCodePageToLabel(99999)).toBeUndefined();
  });
});

describe('decodeWithFallback', () => {
  it('合法 UTF-8 字节按 UTF-8 解（即便给了 OEM label 也优先 UTF-8）', () => {
    expect(decodeWithFallback(ZHONGWEN_UTF8, 'gbk')).toBe('中文');
  });

  it('纯 ASCII 两边一致', () => {
    expect(decodeWithFallback(Buffer.from('hello world', 'ascii'), 'gbk')).toBe('hello world');
  });

  it('非法 UTF-8（GBK 字节）按检测到的 OEM 代码页解 → 正常中文', () => {
    expect(decodeWithFallback(ZHONGWEN_GBK, 'gbk')).toBe('中文');
  });

  it('GBK 字节但无 OEM label → 回退 lossy utf8（保留旧行为、不崩）', () => {
    const decoded = decodeWithFallback(ZHONGWEN_GBK, null);
    expect(decoded).not.toBe('中文');
    expect(decoded).toContain('\uFFFD');
  });

  it('cmd「不是内部或外部命令」GBK 错误消息 → 解出可读中文', () => {
    // '不是内部或外部命令' 的 GBK 字节
    const gbk = Buffer.from([
      0xb2, 0xbb, 0xca, 0xc7, 0xc4, 0xda, 0xb2, 0xbf, 0xbb, 0xf2, 0xcd, 0xe2, 0xb2, 0xbf, 0xc3,
      0xfc, 0xc1, 0xee,
    ]);
    expect(decodeWithFallback(gbk, 'gbk')).toBe('不是内部或外部命令');
  });
});

// 真实 spawn 端到端（仅 Windows 跑）：跑一个不存在的命令，shell 输出本地化错误，
// 验证 result.output 不含 U+FFFD 替换符（即没被错误解码成乱码）。英文/中文 Windows 均成立。
describe.skipIf(process.platform !== 'win32')('spawnAgentShellProcess 真实输出解码（Windows）', () => {
  it('不存在命令的本地化错误消息解码后不含替换符', async () => {
    const handle = spawnAgentShellProcess({ command: 'tabtin_nope_xyz_98765' });
    const result = await handle.result;
    expect(result.output).not.toContain('\uFFFD');
    if (result.outputFilePath) {
      try {
        fs.unlinkSync(result.outputFilePath);
      } catch {
        // ignore
      }
    }
  });
});

import { describe, expect, it } from 'vitest';
import { resolveCliToolPresentation } from '../src/capabilities/cli-presentation.js';

describe('resolveCliToolPresentation', () => {
  it('把真实生图 argv 解析成结构化展示语义', () => {
    expect(resolveCliToolPresentation({
      command: 'tabtin media image generate --prompt "a bright red apple" --format json',
    })).toEqual({
      kind: 'media_image_generation',
      data: {
        command: 'tabtin media image generate --prompt "a bright red apple" --format json',
        prompt: 'a bright red apple',
      },
    });
  });

  it('支持可执行文件绝对路径和 --prompt=value', () => {
    expect(resolveCliToolPresentation({
      command: '/Users/me/.local/bin/tabtin media image generate --prompt=闹钟',
    })?.kind).toBe('media_image_generation');
  });

  it('help、缺 prompt、其它子命令不认领专属 UI', () => {
    expect(resolveCliToolPresentation({
      command: 'tabtin media image generate --help',
    })).toBeUndefined();
    expect(resolveCliToolPresentation({
      command: 'tabtin media image generate --model seedream',
    })).toBeUndefined();
    expect(resolveCliToolPresentation({
      command: 'tabtin media image models --format json',
    })).toBeUndefined();
    expect(resolveCliToolPresentation({
      command: 'tabtin media image generate unexpected --prompt cat',
    })).toBeUndefined();
  });

  it('复合命令不认领，避免把一段 shell 脚本误装成单次业务操作', () => {
    expect(resolveCliToolPresentation({
      command: 'tabtin media image generate --prompt cat && echo done',
    })).toBeUndefined();
  });
});

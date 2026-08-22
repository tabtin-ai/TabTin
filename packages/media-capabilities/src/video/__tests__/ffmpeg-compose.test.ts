import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 1024 })),
}));

vi.mock('node:fs/promises', () => ({
  rm: vi.fn(async () => undefined),
}));

vi.mock('../../infra/ffmpeg-runner.js', () => ({
  runFFmpeg: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
}));

describe('composeVideo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('多 clip concat 使用 output.timeoutMs，而不是固定 120 秒', async () => {
    const { composeVideo } = await import('../ffmpeg-compose.js');
    const { runFFmpeg } = await import('../../infra/ffmpeg-runner.js');

    await composeVideo({
      videoClips: [
        { path: '/tmp/clip-1.mp4', durationSec: 3 },
        { path: '/tmp/clip-2.mp4', durationSec: 4 },
      ],
      narrations: [],
      output: {
        path: '/tmp/out.mp4',
        width: 1280,
        height: 720,
        fps: 30,
        quality: 'high',
        format: 'mp4',
        timeoutMs: 1_800_000,
      },
    });

    expect(runFFmpeg).toHaveBeenNthCalledWith(1, expect.objectContaining({
      args: expect.arrayContaining(['concat']),
      timeoutMs: 1_800_000,
    }));
  });

  it('无音频字幕转码的快速 copy 路径使用 output.timeoutMs，而不是固定 60 秒', async () => {
    const { composeVideo } = await import('../ffmpeg-compose.js');
    const { runFFmpeg } = await import('../../infra/ffmpeg-runner.js');

    await composeVideo({
      videoClips: [{ path: '/tmp/clip.mp4', durationSec: 3 }],
      narrations: [],
      output: {
        path: '/tmp/out.mp4',
        width: 1280,
        height: 720,
        fps: 30,
        timeoutMs: 1_800_000,
      },
    });

    expect(runFFmpeg).toHaveBeenCalledTimes(1);
    expect(runFFmpeg).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.arrayContaining(['copy', '/tmp/out.mp4']),
      timeoutMs: 1_800_000,
    }));
  });

  it('最终转码使用 output.timeoutMs', async () => {
    const { composeVideo } = await import('../ffmpeg-compose.js');
    const { runFFmpeg } = await import('../../infra/ffmpeg-runner.js');

    await composeVideo({
      videoClips: [{ path: '/tmp/clip.mp4', durationSec: 3 }],
      narrations: [],
      output: {
        path: '/tmp/out.mp4',
        width: 1280,
        height: 720,
        fps: 30,
        quality: 'high',
        format: 'mp4',
        timeoutMs: 1_800_000,
      },
    });

    expect(runFFmpeg).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: 1_800_000,
    }));
  });

  it.each([
    ['未传', undefined],
    ['为 0', 0],
    ['为 NaN', Number.NaN],
    ['为 Infinity', Number.POSITIVE_INFINITY],
  ])('timeoutMs %s 时使用默认 10 分钟预算', async (_label, timeoutMs) => {
    const { composeVideo } = await import('../ffmpeg-compose.js');
    const { runFFmpeg } = await import('../../infra/ffmpeg-runner.js');

    await composeVideo({
      videoClips: [{ path: '/tmp/clip.mp4', durationSec: 3 }],
      narrations: [],
      output: {
        path: '/tmp/out.mp4',
        width: 1280,
        height: 720,
        fps: 30,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      },
    });

    expect(runFFmpeg).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: 10 * 60 * 1000,
    }));
  });
});

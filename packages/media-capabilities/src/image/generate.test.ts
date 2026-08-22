import { describe, expect, it, vi } from 'vitest';

import {
  extractMediaSubmitDetail,
  resolveMediaModelFields,
  submitImage,
} from './generate.js';

describe('resolveMediaModelFields', () => {
  it('maps catalog UUID to model_id', () => {
    expect(resolveMediaModelFields('754a5153-6e4c-4d4c-94ba-d40e379132e8')).toEqual({
      model_id: '754a5153-6e4c-4d4c-94ba-d40e379132e8',
    });
  });

  it('maps model_name strings to model_name', () => {
    expect(resolveMediaModelFields('doubao-seedream-4-0-250828')).toEqual({
      model_name: 'doubao-seedream-4-0-250828',
    });
  });
});

describe('extractMediaSubmitDetail', () => {
  it('reads string detail', () => {
    expect(extractMediaSubmitDetail({ detail: 'model not found' })).toBe('model not found');
  });

  it('flattens pydantic validation list detail', () => {
    expect(
      extractMediaSubmitDetail({
        detail: [{ loc: ['body', 'organization_id'], msg: 'Field required', type: 'missing' }],
      }),
    ).toBe('Field required');
  });

  it('reads nested error.message', () => {
    expect(extractMediaSubmitDetail({ error: { message: 'quota exceeded' } })).toBe(
      'quota exceeded',
    );
  });
});

describe('submitImage', () => {
  it('uses Django image-generation field names and preserves organization scope', async () => {
    const djangoRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: { task_id: 'task-1', status: 'running' },
    });

    const result = await submitImage(
      {
        prompt: '一只红苹果',
        model: 'doubao-seedream-4-0-250828',
        organizationId: 'org-1',
        size: '1024*1024',
      },
      { djangoRequest, outputDir: '/tmp' },
    );

    expect(result).toEqual({ taskId: 'task-1', status: 'running' });
    expect(djangoRequest).toHaveBeenCalledWith(
      'POST',
      '/api/services/media/generate/image',
      expect.objectContaining({
        model_name: 'doubao-seedream-4-0-250828',
        organization_id: 'org-1',
      }),
      { timeout: 120_000 },
    );
    expect(djangoRequest.mock.calls[0][2]).not.toHaveProperty('model_id');
  });

  it('sends catalog UUID as model_id instead of model_name', async () => {
    const djangoRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: { task_id: 'task-uuid', status: 'pending' },
    });

    await submitImage(
      {
        prompt: '一只红苹果',
        model: '754a5153-6e4c-4d4c-94ba-d40e379132e8',
        organizationId: 'org-1',
      },
      { djangoRequest, outputDir: '/tmp' },
    );

    expect(djangoRequest).toHaveBeenCalledWith(
      'POST',
      '/api/services/media/generate/image',
      expect.objectContaining({
        model_id: '754a5153-6e4c-4d4c-94ba-d40e379132e8',
        organization_id: 'org-1',
      }),
      { timeout: 120_000 },
    );
    expect(djangoRequest.mock.calls[0][2]).not.toHaveProperty('model_name');
  });

  it('rejects an upstream failure before the CLI server reports task acceptance', async () => {
    await expect(
      submitImage(
        { prompt: '一只红苹果', organizationId: 'org-1' },
        {
          djangoRequest: vi.fn().mockResolvedValue({
            status: 400,
            data: { detail: 'organization_id is required' },
          }),
          outputDir: '/tmp',
        },
      ),
    ).rejects.toThrow('organization_id is required');
  });

  it('surfaces pydantic list detail instead of a generic missing-task-id message', async () => {
    await expect(
      submitImage(
        { prompt: '一只红苹果', organizationId: 'org-1' },
        {
          djangoRequest: vi.fn().mockResolvedValue({
            status: 422,
            data: {
              detail: [{ loc: ['body', 'prompt'], msg: 'Field required', type: 'missing' }],
            },
          }),
          outputDir: '/tmp',
        },
      ),
    ).rejects.toThrow('Field required');
  });
});

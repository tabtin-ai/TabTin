import { describe, expect, it, vi } from 'vitest';

import { createMediaHandler } from './media-handler.js';

describe('createMediaHandler image generation', () => {
  it('forwards the scene-scoped image catalog query to Django', async () => {
    const djangoRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: { success: true, models: [] },
    });
    const handler = createMediaHandler({ djangoRequest });
    const response = {};
    const sendJSON = vi.fn();

    await handler(
      '/media/catalog?task_type=text2image',
      'GET',
      undefined,
      response as any,
      sendJSON,
    );

    expect(djangoRequest).toHaveBeenCalledWith(
      'GET',
      '/api/services/media/catalog?task_type=text2image',
      undefined,
      expect.any(Object),
    );
  });

  it('returns the Django task ID only after upstream submission succeeds', async () => {
    const djangoRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: { task_id: 'django-task-1', status: 'running' },
    });
    const handler = createMediaHandler({ djangoRequest });
    const response = {};
    const sendJSON = vi.fn();

    await handler(
      '/media/generate/image',
      'POST',
      {
        prompt: '一只红苹果',
        model: 'doubao-seedream-4-0-250828',
        organization_id: 'org-1',
      },
      response as any,
      sendJSON,
    );

    expect(djangoRequest).toHaveBeenCalledWith(
      'POST',
      '/api/services/media/generate/image',
      expect.objectContaining({
        model_name: 'doubao-seedream-4-0-250828',
        organization_id: 'org-1',
      }),
      expect.objectContaining({ timeout: 120_000 }),
    );
    expect(sendJSON).toHaveBeenCalledWith(
      response,
      202,
      {
        success: true,
        data: { task_id: 'django-task-1', status: 'running' },
      },
    );
  });

  it('does not acknowledge a task and preserves upstream status when Django rejects it', async () => {
    const handler = createMediaHandler({
      djangoRequest: vi.fn().mockResolvedValue({
        status: 403,
        data: { detail: 'organization membership required' },
      }),
    });
    const response = {};
    const sendJSON = vi.fn();

    await handler(
      '/media/generate/image',
      'POST',
      { prompt: '一只红苹果' },
      response as any,
      sendJSON,
    );

    expect(sendJSON).toHaveBeenCalledWith(
      response,
      403,
      expect.objectContaining({ success: false }),
    );
  });

  it('matches task detail routes even when CLI appends organization query parameters', async () => {
    const taskId = '517c0005-cdbe-49ae-9d5b-91bba348858f';
    const djangoRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: { success: true, task_id: taskId, status: 'succeeded' },
    });
    const handler = createMediaHandler({ djangoRequest });
    const response = {};
    const sendJSON = vi.fn();

    await handler(
      `/media/tasks/${taskId}?organization_id=org-1&space_id=space-1`,
      'GET',
      undefined,
      response as any,
      sendJSON,
    );

    expect(djangoRequest).toHaveBeenCalledWith(
      'GET',
      `/api/services/media/tasks/${taskId}`,
      undefined,
      expect.any(Object),
    );
    expect(sendJSON).toHaveBeenCalledWith(
      response,
      200,
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ task_id: taskId, status: 'succeeded' }),
      }),
    );
  });
});

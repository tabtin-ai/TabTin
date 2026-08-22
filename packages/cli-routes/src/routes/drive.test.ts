import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { configureCLIRoutes } from '../host-bindings.js';
import { handleDriveRoute, setDriveUploadFileToOSSForTest } from './drive.js';

function captureSendJSON() {
  const calls: Array<{ status: number; data: any }> = [];
  return {
    calls,
    sendJSON: (_res: ServerResponse, status: number, data: any) => {
      calls.push({ status, data });
    },
  };
}

afterEach(() => {
  setDriveUploadFileToOSSForTest(null);
  delete process.env.TABTIN_ORGANIZATION_ID;
});

describe('drive route', () => {
  it('proxies attach to organization TabFiles upload endpoint', async () => {
    const requests: Array<{ method: string; path: string; body: any }> = [];
    configureCLIRoutes({
      djangoRequest: async (method, path, body) => {
        const requestBody = body as { file_record_id?: string };
        requests.push({ method, path, body });
        return {
          status: 201,
          data: { ok: true, data: { id: 'item-1', resource_id: requestBody.file_record_id } },
        };
      },
      getSpaceId: () => 'space-1',
    });
    const capture = captureSendJSON();

    await handleDriveRoute(
      '/drive/attach',
      'POST',
      { organization_id: 'org-1', file_record_id: 'file-1', title: '报告.pdf' },
      {} as ServerResponse,
      capture.sendJSON,
    );

    assert.deepEqual(requests, [{
      method: 'POST',
      path: '/context/organizations/org-1/files/upload',
      body: { file_record_id: 'file-1', title: '报告.pdf' },
    }]);
    assert.equal(capture.calls[0]?.status, 201);
  });

  it('returns validation error when organization id is missing', async () => {
    configureCLIRoutes({
      djangoRequest: async () => {
        throw new Error('djangoRequest should not be called');
      },
      getSpaceId: () => 'space-1',
    });
    const capture = captureSendJSON();

    await handleDriveRoute(
      '/drive/download-url',
      'POST',
      { item_id: 'item-1' },
      {} as ServerResponse,
      capture.sendJSON,
    );

    assert.equal(capture.calls[0]?.status, 400);
    assert.equal(capture.calls[0]?.data?.ok, false);
    assert.equal(capture.calls[0]?.data?.error?.code, 'VALIDATION_ERROR');
  });

  it('passes collection_id when listing TabFiles', async () => {
    const requests: Array<{ method: string; path: string }> = [];
    configureCLIRoutes({
      djangoRequest: async (method, path) => {
        requests.push({ method, path });
        return { status: 200, data: { ok: true, data: { items: [], total: 0 } } };
      },
      getSpaceId: () => 'space-1',
    });
    const capture = captureSendJSON();

    await handleDriveRoute(
      '/drive/list',
      'POST',
      { organization_id: 'org-1', collection_id: 'folder-1', page: 1, page_size: 20 },
      {} as ServerResponse,
      capture.sendJSON,
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.method, 'GET');
    assert.match(
      requests[0]?.path ?? '',
      /\/context\/organizations\/org-1\/context-items\?.*collection_id=folder-1/,
    );
    assert.match(requests[0]?.path ?? '', /item_type=tabfiles/);
  });

  it('proxies collection list/create/delete and move-items', async () => {
    const requests: Array<{ method: string; path: string; body?: any }> = [];
    configureCLIRoutes({
      djangoRequest: async (method, path, body) => {
        requests.push({ method, path, body });
        return { status: 200, data: { ok: true } };
      },
      getSpaceId: () => 'space-1',
    });
    const capture = captureSendJSON();

    await handleDriveRoute(
      '/drive/collection/list',
      'POST',
      { organization_id: 'org-1' },
      {} as ServerResponse,
      capture.sendJSON,
    );
    await handleDriveRoute(
      '/drive/collection/create',
      'POST',
      { organization_id: 'org-1', name: '周报', parent_id: 'parent-1' },
      {} as ServerResponse,
      capture.sendJSON,
    );
    await handleDriveRoute(
      '/drive/collection/delete',
      'POST',
      { collection_id: 'folder-1' },
      {} as ServerResponse,
      capture.sendJSON,
    );
    await handleDriveRoute(
      '/drive/collection/move-items',
      'POST',
      { organization_id: 'org-1', item_ids: ['item-1'], collection_id: 'root' },
      {} as ServerResponse,
      capture.sendJSON,
    );

    assert.deepEqual(requests, [
      { method: 'GET', path: '/context/organizations/org-1/collections', body: undefined },
      {
        method: 'POST',
        path: '/context/organizations/org-1/collections',
        body: { name: '周报', parent_id: 'parent-1' },
      },
      { method: 'DELETE', path: '/context/collections/folder-1', body: undefined },
      {
        method: 'POST',
        path: '/context/organizations/org-1/collections/move-items',
        body: { item_ids: ['item-1'], collection_id: null },
      },
    ]);
    assert.equal(capture.calls.length, 4);
  });

  it('proxies shared-with-me / trash-list / collaborator invite', async () => {
    const requests: Array<{ method: string; path: string; body?: any }> = [];
    configureCLIRoutes({
      djangoRequest: async (method, path, body) => {
        requests.push({ method, path, body });
        return { status: 200, data: { ok: true } };
      },
      getSpaceId: () => 'space-1',
    });
    const capture = captureSendJSON();

    await handleDriveRoute(
      '/drive/shared-with-me',
      'POST',
      { organization_id: 'org-1' },
      {} as ServerResponse,
      capture.sendJSON,
    );
    await handleDriveRoute(
      '/drive/trash-list',
      'POST',
      { organization_id: 'org-1', page: 1, page_size: 20 },
      {} as ServerResponse,
      capture.sendJSON,
    );
    await handleDriveRoute(
      '/drive/collaborator/invite',
      'POST',
      { file_record_id: 'file-1', user_ids: ['u1'], permission: 'editor' },
      {} as ServerResponse,
      capture.sendJSON,
    );

    assert.deepEqual(requests, [
      { method: 'GET', path: '/context/files/shared-with-me?organization_id=org-1', body: undefined },
      {
        method: 'GET',
        path: '/context/organizations/org-1/trash?item_type=tabfiles&page=1&page_size=20',
        body: undefined,
      },
      {
        method: 'POST',
        path: '/context/files/file-1/collaborators',
        body: { user_ids: ['u1'], permission: 'viewer' },
      },
    ]);
    assert.equal(capture.calls.length, 3);
  });

  it('proxies trash/restore/permanent-delete to organization TabFiles lifecycle', async () => {
    const requests: Array<{ method: string; path: string }> = [];
    configureCLIRoutes({
      djangoRequest: async (method, path) => {
        requests.push({ method, path });
        return { status: 200, data: { ok: true } };
      },
      getSpaceId: () => 'space-1',
    });
    const capture = captureSendJSON();

    await handleDriveRoute(
      '/drive/trash',
      'POST',
      { organization_id: 'org-1', file_record_id: 'file-1' },
      {} as ServerResponse,
      capture.sendJSON,
    );
    await handleDriveRoute(
      '/drive/restore',
      'POST',
      { organization_id: 'org-1', file_record_id: 'file-1' },
      {} as ServerResponse,
      capture.sendJSON,
    );
    await handleDriveRoute(
      '/drive/permanent-delete',
      'POST',
      { organization_id: 'org-1', file_record_id: 'file-1' },
      {} as ServerResponse,
      capture.sendJSON,
    );

    assert.deepEqual(requests, [
      { method: 'POST', path: '/context/organizations/org-1/files/file-1/trash' },
      { method: 'POST', path: '/context/organizations/org-1/files/file-1/restore' },
      { method: 'DELETE', path: '/context/organizations/org-1/files/file-1/permanent' },
    ]);
    assert.equal(capture.calls.length, 3);
  });

  it('proxies download-url to organization TabFiles download endpoint', async () => {
    const requests: Array<{ method: string; path: string; body: any }> = [];
    configureCLIRoutes({
      djangoRequest: async (method, path, body) => {
        requests.push({ method, path, body });
        return {
          status: 200,
          data: { ok: true, data: { url: 'https://example.test/file.pdf' } },
        };
      },
      getSpaceId: () => 'space-1',
    });
    const capture = captureSendJSON();

    await handleDriveRoute(
      '/drive/download-url',
      'POST',
      { organization_id: 'org-1', item_id: 'item-1' },
      {} as ServerResponse,
      capture.sendJSON,
    );

    assert.deepEqual(requests, [{
      method: 'GET',
      path: '/context/organizations/org-1/files/item-1/download-url',
      body: undefined,
    }]);
    assert.equal(capture.calls[0]?.status, 200);
  });

  it('returns validation error when file_record_id is missing', async () => {
    configureCLIRoutes({
      djangoRequest: async () => {
        throw new Error('djangoRequest should not be called');
      },
      getSpaceId: () => 'space-1',
    });
    const capture = captureSendJSON();

    await handleDriveRoute(
      '/drive/archive-from-chat',
      'POST',
      { organization_id: 'org-1' },
      {} as ServerResponse,
      capture.sendJSON,
    );

    assert.equal(capture.calls[0]?.status, 400);
    assert.equal(capture.calls[0]?.data?.error?.code, 'VALIDATION_ERROR');
  });

  it('uploads a local file then attaches to Organization', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drive-upload-'));
    const filePath = join(root, 'notes.md');
    writeFileSync(filePath, '# hello');

    const requests: Array<{ method: string; path: string; body: any }> = [];
    setDriveUploadFileToOSSForTest(async (path, opts) => {
      assert.equal(path, filePath);
      assert.equal(opts.module, 'tabfiles');
      assert.equal(opts.contextType, 'organization');
      assert.equal(opts.contextId, 'org-1');
      assert.equal(opts.folder, 'tabfiles/uploads');
      return {
        url: 'https://cdn.example/notes.md',
        fileId: 'file-rec-1',
        fileKey: 'tabfiles/uploads/notes.md',
      };
    });
    configureCLIRoutes({
      djangoRequest: async (method, path, body) => {
        requests.push({ method, path, body });
        return {
          status: 201,
          data: {
            ok: true,
            data: {
              id: 'item-1',
              title: '归档笔记.md',
              item_type: 'tabfiles',
              resource_id: 'file-rec-1',
              status: 'active',
            },
          },
        };
      },
      getSpaceId: () => 'space-1',
    });
    const capture = captureSendJSON();

    await handleDriveRoute(
      '/drive/upload',
      'POST',
      { organization_id: 'org-1', file_path: filePath, title: '归档笔记.md' },
      {} as ServerResponse,
      capture.sendJSON,
    );

    assert.deepEqual(requests, [{
      method: 'POST',
      path: '/context/organizations/org-1/files/upload',
      body: {
        file_record_id: 'file-rec-1',
        title: '归档笔记.md',
      },
    }]);
    assert.equal(capture.calls[0]?.status, 200);
    assert.equal(capture.calls[0]?.data?.ok, true);
    assert.equal(capture.calls[0]?.data?.data?.id, 'item-1');
    assert.equal(capture.calls[0]?.data?.data?.file_id, 'file-rec-1');
  });

  it('attaches to organization when upload includes collection_id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drive-upload-col-'));
    const filePath = join(root, 'notes.md');
    writeFileSync(filePath, '# hello');

    const requests: Array<{ method: string; path: string; body: any }> = [];
    setDriveUploadFileToOSSForTest(async (_path, opts) => {
      assert.equal(opts.contextType, 'organization');
      assert.equal(opts.contextId, 'org-1');
      return {
        url: 'https://cdn.example/notes.md',
        fileId: 'file-rec-1',
        fileKey: 'tabfiles/uploads/notes.md',
      };
    });
    configureCLIRoutes({
      djangoRequest: async (method, path, body) => {
        requests.push({ method, path, body });
        return {
          status: 201,
          data: { ok: true, data: { id: 'item-1', resource_id: 'file-rec-1' } },
        };
      },
      getSpaceId: () => 'space-1',
    });
    const capture = captureSendJSON();

    await handleDriveRoute(
      '/drive/upload',
      'POST',
      {
        organization_id: 'org-1',
        file_path: filePath,
        title: '归档笔记.md',
        collection_id: 'col-1',
      },
      {} as ServerResponse,
      capture.sendJSON,
    );

    assert.deepEqual(requests, [{
      method: 'POST',
      path: '/context/organizations/org-1/files/upload',
      body: {
        file_record_id: 'file-rec-1',
        collection_id: 'col-1',
        title: '归档笔记.md',
      },
    }]);
    assert.equal(capture.calls[0]?.status, 200);
  });

  it('creates collection, uploads first-level files, reports partial failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drive-folder-up-'));
    writeFileSync(join(root, 'ok.md'), 'ok');
    writeFileSync(join(root, 'bad.csv'), 'a,b');

    let uploadCount = 0;
    setDriveUploadFileToOSSForTest(async (path, opts) => {
      uploadCount += 1;
      assert.equal(opts.contextType, 'organization');
      assert.equal(opts.contextId, 'org-1');
      if (String(path).endsWith('bad.csv')) {
        return { url: null, error: 'quota', errorCode: 'quota-exceeded' };
      }
      return {
        url: 'https://cdn.example/ok.md',
        fileId: 'file-ok',
        fileKey: 'k',
      };
    });

    const requests: Array<{ method: string; path: string; body: any }> = [];
    configureCLIRoutes({
      djangoRequest: async (method, path, body) => {
        requests.push({ method, path, body });
        if (method === 'POST' && path.endsWith('/collections')) {
          return { status: 201, data: { ok: true, data: { id: 'col-new', name: 'folder' } } };
        }
        if (method === 'POST' && path.endsWith('/files/upload')) {
          return {
            status: 201,
            data: { ok: true, data: { id: 'item-ok', resource_id: 'file-ok', title: 'ok.md' } },
          };
        }
        return { status: 200, data: { ok: true } };
      },
      getSpaceId: () => 'space-1',
    });
    const capture = captureSendJSON();

    await handleDriveRoute(
      '/drive/upload-folder',
      'POST',
      { organization_id: 'org-1', directory: root },
      {} as ServerResponse,
      capture.sendJSON,
    );

    assert.equal(uploadCount, 2);
    assert.ok(requests.some((r) => r.method === 'POST' && r.path === '/context/organizations/org-1/collections'));
    assert.ok(requests.some((r) => (
      r.method === 'POST'
      && r.path === '/context/organizations/org-1/files/upload'
      && r.body?.collection_id === 'col-new'
    )));
    assert.equal(capture.calls[0]?.status, 200);
    assert.equal(capture.calls[0]?.data?.data?.partial_failure, true);
    assert.equal(capture.calls[0]?.data?.data?.summary?.success, 1);
    assert.equal(capture.calls[0]?.data?.data?.summary?.failed, 1);
    assert.equal(capture.calls[0]?.data?.data?.collection_id, 'col-new');
  });

  it('does not create collection when no uploadable files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drive-folder-empty-'));
    writeFileSync(join(root, 'skip.js'), 'x');

    let djangoCalled = false;
    configureCLIRoutes({
      djangoRequest: async () => {
        djangoCalled = true;
        throw new Error('should not create collection');
      },
      getSpaceId: () => 'space-1',
    });
    const capture = captureSendJSON();

    await handleDriveRoute(
      '/drive/upload-folder',
      'POST',
      { organization_id: 'org-1', directory: root },
      {} as ServerResponse,
      capture.sendJSON,
    );

    assert.equal(djangoCalled, false);
    assert.equal(capture.calls[0]?.status, 400);
    assert.equal(capture.calls[0]?.data?.error?.code, 'NO_UPLOADABLE_FILES');
  });

  it('cleans empty collection when all uploads fail', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drive-folder-fail-'));
    writeFileSync(join(root, 'a.md'), 'a');

    setDriveUploadFileToOSSForTest(async () => ({
      url: null,
      error: 'boom',
      errorCode: 'upload-failed',
    }));

    const requests: Array<{ method: string; path: string }> = [];
    configureCLIRoutes({
      djangoRequest: async (method, path) => {
        requests.push({ method, path });
        if (method === 'POST' && path.endsWith('/collections')) {
          return { status: 201, data: { ok: true, data: { id: 'col-empty' } } };
        }
        if (method === 'DELETE') {
          return { status: 200, data: { ok: true } };
        }
        return { status: 500, data: { ok: false } };
      },
      getSpaceId: () => 'space-1',
    });
    const capture = captureSendJSON();

    await handleDriveRoute(
      '/drive/upload-folder',
      'POST',
      { organization_id: 'org-1', directory: root },
      {} as ServerResponse,
      capture.sendJSON,
    );

    assert.ok(requests.some((r) => r.method === 'DELETE' && r.path === '/context/collections/col-empty'));
    assert.equal(capture.calls[0]?.status, 500);
    assert.equal(capture.calls[0]?.data?.error?.code, 'FOLDER_UPLOAD_ZERO_SUCCESS');
  });
});

import { describe, expect, it } from 'vitest';
import {
  analyzeBrowserNetworkToOpenApi,
  normalizeBrowserNetworkEntries,
} from '../browser-to-api';
import type { NetworkLogEntry } from '../runtime/NetworkLog';

function entry(
  partial: Partial<NetworkLogEntry> & Pick<NetworkLogEntry, 'url' | 'method'>,
): NetworkLogEntry {
  return {
    requestId: partial.requestId ?? `${partial.method}:${partial.url}`,
    timestamp: partial.timestamp ?? 1,
    ...partial,
  };
}

describe('browser-to-api', () => {
  it('把 tabtin browser network --format json 响应归一为 NetworkLogEntry[]', () => {
    const entries = normalizeBrowserNetworkEntries({
      success: true,
      data: [
        {
          requestId: 'r1',
          url: 'https://api.example.com/v1/users/123',
          method: 'GET',
          timestamp: 1,
        },
      ],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ requestId: 'r1', method: 'GET' });
  });

  it('模板化动态 URL segment 并生成 path/query 参数', () => {
    const spec = analyzeBrowserNetworkToOpenApi([
      entry({
        requestId: 'r1',
        url: 'https://api.example.com/v1/users/123/orders?page=2&include=items',
        method: 'GET',
        status: 200,
        resourceType: 'XHR',
        mimeType: 'application/json',
        responseBody: '{"items":[{"id":"o1","total":12.5}],"page":2}',
      }),
    ]);

    const operation = spec.paths['/v1/users/{userId}/orders'].get;
    expect(operation.operationId).toBe('getV1UsersUserIdOrders');
    expect(operation.parameters).toEqual([
      {
        name: 'userId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
      {
        name: 'include',
        in: 'query',
        required: true,
        schema: { type: 'string' },
      },
      {
        name: 'page',
        in: 'query',
        required: true,
        schema: { type: 'integer' },
      },
    ]);
    expect(
      operation.responses['200'].content?.['application/json'].schema,
    ).toMatchObject({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              total: { type: 'number' },
            },
          },
        },
        page: { type: 'integer' },
      },
    });
  });

  it('推断 JSON request body 和 response schema', () => {
    const spec = analyzeBrowserNetworkToOpenApi([
      entry({
        requestId: 'r1',
        url: 'https://api.example.com/v1/users',
        method: 'POST',
        status: 201,
        resourceType: 'XHR',
        mimeType: 'application/json',
        requestBody: '{"name":"Ada","age":37,"newsletter":true}',
        responseBody:
          '{"id":"usr_123","name":"Ada","createdAt":"2026-06-11T12:00:00.000Z"}',
      }),
    ]);

    const operation = spec.paths['/v1/users'].post;
    expect(
      operation.requestBody?.content['application/json'].schema,
    ).toMatchObject({
      type: 'object',
      properties: {
        age: { type: 'integer' },
        name: { type: 'string' },
        newsletter: { type: 'boolean' },
      },
      'x-tabtin-sample-derived': true,
      'x-tabtin-inferred': { source: 'network-samples', sampleCount: 1 },
    });
    expect(operation.requestBody?.required).toBe(false);
    expect(
      operation.requestBody?.content['application/json'].schema,
    ).not.toHaveProperty('required');
    expect(
      operation.responses['201'].content?.['application/json'].schema,
    ).toMatchObject({
      type: 'object',
      properties: {
        createdAt: { type: 'string', format: 'date-time' },
        id: { type: 'string' },
        name: { type: 'string' },
      },
    });
  });

  it('敏感 query/body 字段不进入 OpenAPI spec', () => {
    const spec = analyzeBrowserNetworkToOpenApi([
      entry({
        requestId: 'r1',
        url: 'https://api.example.com/v1/session?access_token=%5Bredacted%5D&page=1',
        method: 'POST',
        status: 200,
        resourceType: 'XHR',
        mimeType: 'application/json',
        requestHeaders: { Authorization: '[redacted]', 'X-Trace': 'ok' },
        requestBody:
          '{"username":"ada","password":"[redacted]","nested":{"api_key":"[redacted]","safe":"ok"}}',
        responseBody:
          '{"session":"[redacted]","user":{"id":"u1","email":"ada@example.com"},"csrf_token":"[redacted]"}',
      }),
    ]);

    const operationJson = JSON.stringify(spec.paths['/v1/session'].post);
    expect(operationJson).toContain('"page"');
    expect(operationJson).toContain('"username"');
    expect(operationJson).toContain('"safe"');
    expect(operationJson).toContain('"email"');
    expect(operationJson).not.toContain('access_token');
    expect(operationJson).not.toContain('password');
    expect(operationJson).not.toContain('api_key');
    expect(operationJson).not.toContain('csrf_token');
    expect(operationJson).not.toContain('Authorization');
    expect(operationJson).not.toContain('[redacted]');
  });

  it('camelCase 和连续命名敏感 key 不进入 OpenAPI spec', () => {
    const spec = analyzeBrowserNetworkToOpenApi([
      entry({
        requestId: 'r1',
        url: 'https://api.example.com/v1/profile?authToken=abc&sessionId=s1&safePage=1',
        method: 'POST',
        status: 200,
        resourceType: 'XHR',
        mimeType: 'application/json',
        requestBody:
          '{"authToken":"abc","csrfToken":"csrf","cookieValue":"c","clientSecret":"s","passwordHash":"h","credentialId":"cred","safeName":"Ada"}',
        responseBody:
          '{"sessionId":"s1","refreshToken":"r","safeResult":{"id":"u1","name":"Ada"}}',
      }),
    ]);

    const operationJson = JSON.stringify(spec.paths['/v1/profile'].post);
    expect(operationJson).toContain('"safePage"');
    expect(operationJson).toContain('"safeName"');
    expect(operationJson).toContain('"safeResult"');
    for (const sensitive of [
      'authToken',
      'sessionId',
      'csrfToken',
      'cookieValue',
      'clientSecret',
      'passwordHash',
      'credentialId',
      'refreshToken',
    ]) {
      expect(operationJson).not.toContain(sensitive);
    }
  });

  it('JWT/base64/dotted token path segment 会模板化且不泄漏原值', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const base64Token = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_';
    const spec = analyzeBrowserNetworkToOpenApi([
      entry({
        requestId: 'r1',
        url: `https://api.example.com/v1/download/${jwt}/chunks/${base64Token}`,
        method: 'GET',
        status: 200,
        resourceType: 'XHR',
        mimeType: 'application/json',
        responseBody: '{"ok":true}',
      }),
    ]);

    const pathKeys = Object.keys(spec.paths);
    expect(pathKeys).toEqual(['/v1/download/{token}/chunks/{token2}']);
    const serialized = JSON.stringify(spec);
    expect(serialized).not.toContain(jwt);
    expect(serialized).not.toContain(base64Token);
  });

  it('form body 使用表单 content type 且标记样本推断，不硬承诺 required', () => {
    const spec = analyzeBrowserNetworkToOpenApi([
      entry({
        requestId: 'r1',
        url: 'https://api.example.com/v1/search',
        method: 'POST',
        status: 200,
        resourceType: 'XHR',
        mimeType: 'application/json',
        requestBody: 'q=browser&page=2&csrfToken=secret',
        responseBody: '{"items":[]}',
        bodyTruncated: true,
      }),
      entry({
        requestId: 'r2',
        url: 'https://api.example.com/v1/search',
        method: 'POST',
        status: 204,
        resourceType: 'XHR',
        mimeType: 'application/json',
      }),
    ]);

    const requestBody = spec.paths['/v1/search'].post.requestBody;
    expect(requestBody?.required).toBe(false);
    expect(requestBody?.content).toHaveProperty(
      'application/x-www-form-urlencoded',
    );
    expect(requestBody?.content).not.toHaveProperty('application/json');
    expect(requestBody?.['x-tabtin-inferred']).toMatchObject({
      source: 'network-samples',
      sampleCount: 2,
      missingBodyCount: 1,
      truncatedBodyCount: 1,
    });
    const schema =
      requestBody?.content['application/x-www-form-urlencoded'].schema;
    expect(schema).toMatchObject({
      type: 'object',
      properties: {
        page: { type: 'integer' },
        q: { type: 'string' },
      },
      'x-tabtin-sample-derived': true,
    });
    expect(JSON.stringify(requestBody)).not.toContain('csrfToken');
  });

  it('声明未来只读取已投影为 NetworkLogEntry 的 trace network data', () => {
    const spec = analyzeBrowserNetworkToOpenApi([
      {
        type: 'network.response',
        data: entry({
          url: 'https://api.example.com/v1/items',
          method: 'GET',
          status: 200,
        }),
      },
    ]);

    expect(
      spec['x-tabtin-browser-to-api'].traceCompatibility
        .readsProjectedTraceNetworkData,
    ).toBe(true);
    expect(spec.paths['/v1/items'].get.responses['200'].description).toBe(
      'Observed HTTP 200 response',
    );
  });
});

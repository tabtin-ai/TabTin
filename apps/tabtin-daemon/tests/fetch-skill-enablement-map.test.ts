import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSkillEnablementMap } from '../src/application/agent/fetch-skill-enablement-map.js';

describe('fetchSkillEnablementMap', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('按 agentId 请求 AgentSkillLink 并解析 canonicalKey enabled map', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        data: {
          skills: [
            { skill_canonical_key: 'device:camera', enabled: true, config_json: {} },
            { skill_canonical_key: 'platform:docs', enabled: false, config_json: null },
          ],
        },
      }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSkillEnablementMap({
      apiBaseUrl: 'https://api.example.com/api',
      agentId: 'agent/id',
      getAccessToken: () => 'token',
    })).resolves.toEqual({
      'device:camera': true,
      'platform:docs': false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/agents/agent%2Fid/skills',
      {
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
        },
      },
    );
  });

  it('非 2xx 响应抛出可诊断错误，避免与空携带集混淆', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSkillEnablementMap({
      apiBaseUrl: 'https://api.example.com/api',
      agentId: 'agent-1',
      getAccessToken: () => 'token',
    })).rejects.toThrow('Agent Skill enablement request failed: HTTP 503');
  });

  it.each([
    {
      name: '非 JSON',
      body: 'not-json',
      expected: 'invalid JSON',
    },
    {
      name: '缺少 skills 数组',
      body: JSON.stringify({ data: {} }),
      expected: 'invalid payload',
    },
    {
      name: '携带项缺少 enabled 布尔值',
      body: JSON.stringify({
        data: { skills: [{ skill_canonical_key: 'device:camera' }] },
      }),
      expected: 'invalid skill entry at index 0',
    },
  ])('200 响应形态异常（$name）时拒绝覆盖旧快照', async ({ body, expected }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));

    await expect(fetchSkillEnablementMap({
      apiBaseUrl: 'https://api.example.com/api',
      agentId: 'agent-1',
      getAccessToken: () => 'token',
    })).rejects.toThrow(expected);
  });

  it('合法空 skills 数组返回空 map', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { skills: [] } }), { status: 200 }),
    ));

    await expect(fetchSkillEnablementMap({
      apiBaseUrl: 'https://api.example.com/api',
      agentId: 'agent-1',
      getAccessToken: () => 'token',
    })).resolves.toEqual({});
  });

  it('无 token 时抛出可诊断错误且不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSkillEnablementMap({
      apiBaseUrl: 'https://api.example.com/api',
      agentId: 'agent-1',
      getAccessToken: () => null,
    })).rejects.toThrow('Agent Skill enablement request failed: missing access token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('空 agentId 时抛出可诊断错误且不取 token', async () => {
    const fetchMock = vi.fn();
    const getAccessToken = vi.fn().mockReturnValue('token');
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSkillEnablementMap({
      apiBaseUrl: 'https://api.example.com/api',
      agentId: '',
      getAccessToken,
    })).rejects.toThrow('Agent Skill enablement request failed: missing agentId');
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

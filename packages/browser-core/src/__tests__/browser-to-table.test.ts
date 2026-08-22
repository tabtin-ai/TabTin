import { describe, expect, it } from 'vitest';
import { collectBrowserTableDataset } from '../browser-to-table';
import type { NetworkLogEntry } from '../runtime/NetworkLog';

function pitchHubProjects(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_unused, index) => {
    const n = index + 1;
    return {
      project_id: `900000000000${String(n).padStart(4, '0')}`,
      project_name: `PitchHub Project ${n}`,
      industry: n % 2 === 0 ? 'AI' : 'Robotics',
      latest_round: n % 3 === 0 ? 'A' : 'Seed',
      region: n % 2 === 0 ? 'Shanghai' : 'Beijing',
      founded_time: `202${n % 6}-01-01`,
      project_url: `https://pitchhub.36kr.com/project/${n}`,
    };
  });
}

function networkEntry(
  rows: Array<Record<string, unknown>>,
  page: number,
  params = 'sort=3',
): NetworkLogEntry {
  return {
    requestId: `pitchhub-${page}`,
    url: `https://pitchhub.36kr.com/api/projects?page=${page}&${params}`,
    method: 'GET',
    status: 200,
    resourceType: 'XHR',
    mimeType: 'application/json',
    responseBody: JSON.stringify({ data: { list: rows } }),
    timestamp: page,
  };
}

function pitchHubPage(page: number): Array<Record<string, unknown>> {
  return pitchHubProjects(20).map((row, index) => ({
    ...row,
    project_id: `90000000000${page}${String(index + 1).padStart(4, '0')}`,
  }));
}

describe('browser-to-table', () => {
  it('collects a bounded 36Kr PitchHub fixture into at least 100 TabData-ready rows', () => {
    const network = {
      ok: true,
      data: [
        networkEntry(pitchHubPage(1), 1),
        networkEntry(pitchHubPage(2), 2),
        networkEntry(pitchHubPage(3), 3),
        networkEntry(pitchHubPage(4), 4),
        networkEntry(pitchHubPage(5), 5),
        networkEntry(pitchHubPage(6), 6),
      ],
    };

    const dataset = collectBrowserTableDataset({
      url: 'https://pitchhub.36kr.com/projects?sort=3',
      network,
      rowLimit: 100,
      pageLimit: 5,
    });

    expect(dataset.row_count).toBe(100);
    expect(dataset.field_count).toBe(7);
    expect(dataset.capture_scope).toMatchObject({
      kind: 'bounded_initial_batch',
      rows: 100,
      row_limit: 100,
      pages: 5,
      page_limit: 5,
      is_partial: true,
      source_kind: 'network_api',
    });
    expect(dataset.preview_rows).toHaveLength(5);
    expect(dataset.records[0]).toMatchObject({
      'Project ID': '9000000000010001',
      'Project Name': 'PitchHub Project 1',
    });
  });

  it('infers https URL columns as url (including leading whitespace and name hints)', () => {
    const dataset = collectBrowserTableDataset({
      records: [
        { title: 'A', project_url: ' https://pitchhub.36kr.com/project/1', note: 'x' },
        { title: 'B', project_url: 'https://pitchhub.36kr.com/project/2', note: 'y' },
        { title: 'C', project_url: 'www.36kr.com/p/3', note: 'z' },
        { title: 'D', project_url: '暂无', note: 'w' },
      ],
    });

    expect(dataset.fields).toContainEqual(expect.objectContaining({
      name: 'Project URL',
      source_key: 'project_url',
      field_type: 'url',
    }));
  });

  it('infers 文章链接-style columns as url even with a minority of dirty cells', () => {
    const dataset = collectBrowserTableDataset({
      records: [
        { 标题: '逐际动力', 文章链接: 'https://www.36kr.com/p/1' },
        { 标题: '爱诗科技', 文章链接: 'https://www.36kr.com/p/2' },
        { 标题: '占位', 文章链接: '待补充' },
      ],
    });

    expect(dataset.fields).toContainEqual(expect.objectContaining({
      name: '文章链接',
      source_key: '文章链接',
      field_type: 'url',
    }));
  });

  it('infers long numeric identifiers as text instead of number', () => {
    const dataset = collectBrowserTableDataset({
      records: [
        { project_id: '9000000000000001', name: 'A', amount: 12.5 },
        { project_id: '9000000000000002', name: 'B', amount: 18 },
      ],
    });

    expect(dataset.fields).toContainEqual({
      name: 'Project ID',
      source_key: 'project_id',
      field_type: 'text',
      reason: 'identifier field',
    });
    expect(dataset.fields).toContainEqual({
      name: 'Amount',
      source_key: 'amount',
      field_type: 'number',
    });
  });

  it('warns when numeric identifier samples exceed JavaScript safe integer range', () => {
    const dataset = collectBrowserTableDataset({
      records: [
        { project_id: 9007199254740992, name: 'Unsafe numeric id' },
      ],
    });

    expect(dataset.fields).toContainEqual({
      name: 'Project ID',
      source_key: 'project_id',
      field_type: 'text',
      reason: 'identifier field',
    });
    expect(dataset.warnings).toContain('字段 Project ID 包含超过 JavaScript 安全整数范围的数字 ID；已按 text 导入，但源响应可能已发生精度损失');
    expect(dataset.records[0]).toMatchObject({
      'Project ID': '9007199254740992',
    });
  });

  it('does not merge different query variants that share the same API path', () => {
    const dataset = collectBrowserTableDataset({
      network: {
        data: [
          networkEntry(pitchHubPage(1), 1, 'sort=3'),
          networkEntry(pitchHubPage(2), 2, 'sort=3'),
          networkEntry([{ project_id: 'other-sort-id', project_name: 'Wrong sort' }], 1, 'sort=1'),
        ],
      },
      rowLimit: 100,
      pageLimit: 5,
    });

    expect(dataset.row_count).toBe(40);
    expect(dataset.records.some((row) => row['Project Name'] === 'Wrong sort')).toBe(false);
  });

  it('falls back to DOM table rows when network responses do not expose a JSON list', () => {
    const dataset = collectBrowserTableDataset({
      url: 'https://pitchhub.36kr.com/projects?sort=3',
      network: { data: [] },
      domRecords: [
        {
          project_name: '云工厂',
          description: '中小批量产品加工定制平台',
          industry: '企业服务 产业升级',
          latest_round: 'B+轮',
          region: '广东省',
          founded_time: '2016年',
        },
        {
          project_name: 'FunAI华彩未来全生态',
          description: '智能华彩FunAI，玩创音乐新未来',
          industry: '文化娱乐 体育游戏',
          latest_round: '天使轮',
          region: '海南省',
          founded_time: '2024年',
        },
      ],
    });

    expect(dataset.row_count).toBe(2);
    expect(dataset.capture_scope.source_kind).toBe('dom_table');
    expect(dataset.capture_scope.source_path).toBe('$.dom');
    expect(dataset.records[0]).toMatchObject({
      'Project Name': '云工厂',
      Description: '中小批量产品加工定制平台',
      Industry: '企业服务 产业升级',
      'Latest Round': 'B+轮',
      Region: '广东省',
      'Founded Time': '2016年',
    });
  });

  it('prefers richer content records over larger code/name dictionary arrays in the same network response', () => {
    const dictionaryOptions = [
      { code: 2, name: '福建省' },
      { code: 3, name: '广东省' },
      { code: 5, name: '北京市' },
      { code: 6, name: '香港特别行政区' },
      { code: 7, name: '吉林省' },
    ];
    const contentRecords = [
      {
        item_id: '9000000000000001',
        title: '云工厂',
        summary: '中小批量产品加工定制平台',
        category: '企业服务 产业升级',
        status: 'B+轮',
        location: '广东省',
        date: '2016年',
      },
      {
        item_id: '9000000000000002',
        title: 'FunAI华彩未来全生态',
        summary: '智能华彩FunAI，玩创音乐新未来',
        category: '文化娱乐 体育游戏',
        status: '天使轮',
        location: '海南省',
        date: '2024年',
      },
    ];

    const dataset = collectBrowserTableDataset({
      url: 'https://pitchhub.36kr.com/projects?sort=3',
      network: {
        data: [
          {
            ...networkEntry([], 1),
            url: 'https://gateway.36kr.com/api/pms/project/list',
            responseBody: JSON.stringify({
              data: {
                dictionaryOptions,
                contentRecords,
              },
            }),
          },
        ],
      },
    });

    expect(dataset.capture_scope.source_path).toBe('$.data.contentRecords');
    expect(dataset.row_count).toBe(2);
    expect(dataset.field_count).toBeGreaterThan(2);
    expect(dataset.records[0]).toMatchObject({
      'Item ID': '9000000000000001',
      Title: '云工厂',
      Category: '企业服务 产业升级',
      Location: '广东省',
    });
  });

  it('still imports a code/name list when it is the only discovered list', () => {
    const dataset = collectBrowserTableDataset({
      url: 'https://example.com/settings',
      network: {
        data: [
          {
            ...networkEntry([], 1),
            responseBody: JSON.stringify({
              data: {
                options: [
                  { code: 'enabled', name: 'Enabled' },
                  { code: 'disabled', name: 'Disabled' },
                ],
              },
            }),
          },
        ],
      },
    });

    expect(dataset.capture_scope.source_path).toBe('$.data.options');
    expect(dataset.row_count).toBe(2);
    expect(dataset.records[0]).toMatchObject({
      Code: 'enabled',
      Name: 'Enabled',
    });
  });
});

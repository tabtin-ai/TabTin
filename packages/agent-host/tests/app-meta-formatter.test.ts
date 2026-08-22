/**
 * App 详情行渲染器—— 从 agent-runtime context-injector 迁到宿主的
 * `details:` 段业务实现测试。
 *
 * 这些断言原属 `packages/agent-runtime/tests/context-injector-app-meta.test.ts` 的
 * 「详情块」用例（tabweb / tabdoc / tabwhiteboard / tabtracker）。core 去业务化后，
 * 详情段的字段口径、产品名与 CLI 配方随 formatter 迁到 `createAppMetaFormatter()`，
 * 断言随之迁到本文件（core 侧只再验中性框架 focused / open_tabs）。
 */
import { describe, expect, it } from 'vitest';
import { createAppMetaFormatter } from '../src/delivery/app-meta-formatter.js';

const formatAppMeta = createAppMetaFormatter();

function render(appType: string, meta: Record<string, unknown>): string {
  return formatAppMeta(appType, meta).join('\n');
}

describe('createAppMetaFormatter — tabweb 详情块', () => {
  it('current_browser_url / current_browser_title 渲染 details 块', () => {
    const text = render('tabweb', {
      current_browser_url: 'https://google.com',
      current_browser_title: 'Google',
    });
    expect(text).toContain('details:');
    expect(text).toContain('url: https://google.com');
    expect(text).toContain('page_title: Google');
  });

  it('historical fallback：仅含 current_url / page_title 时仍能渲染', () => {
    const text = render('tabweb', { current_url: 'https://old.example.com', page_title: 'Old' });
    expect(text).toContain('url: https://old.example.com');
    expect(text).toContain('page_title: Old');
  });

  it('current_browser_url 优先级高于 current_url', () => {
    const text = render('tabweb', {
      current_browser_url: 'https://new.example.com',
      current_url: 'https://old.example.com',
    });
    expect(text).toContain('url: https://new.example.com');
    expect(text).not.toContain('https://old.example.com');
  });
});

describe('createAppMetaFormatter — tabdoc 详情块', () => {
  it('当前文档只注入读取入口，不注入正文', () => {
    const text = render('tabdoc', {
      current_doc_id: 'doc_637',
      current_doc_title: '文献引用真实性检查报告',
    });
    expect(text).toContain('current_document: "文献引用真实性检查报告" (id: doc_637)');
    expect(text).toContain('read_current_document: tabtin doc read doc_637 --format json');
    expect(text).toContain('read_large_document: tabtin doc list-blocks doc_637 --format json; tabtin doc chunks doc_637 --format json');
    expect(text).toContain('create_cloud_document: write_file path=.agent-drafts/<slug>.md → tabtin doc create --title "<title>" --markdown @.agent-drafts/<slug>.md --format json');
    expect(text).toContain('update_document_metadata: tabtin doc update <document-id> --icon <emoji> --cover-image <url> --parent-id <parent-id> --tags <tag>');
    expect(text).toContain('long_doc_rule: Agent 新建长文临时草稿必须写 .agent-drafts/<slug>.md');
    expect(text).not.toContain('正文');
    expect(text).not.toContain('markdown:');
  });
});

describe('createAppMetaFormatter — tabwhiteboard 详情块', () => {
  it('current_canvas_id + current_canvas_title + current_page_id 全部渲染 details', () => {
    const text = render('tabwhiteboard', {
      current_canvas_id: 'cnv_x',
      current_canvas_title: 'My Canvas',
      current_page_id: 'page_y',
    });
    expect(text).toContain('details:');
    expect(text).toContain('current_whiteboard: "My Canvas" (id: cnv_x)');
    expect(text).toContain('current_page_id: page_y');
  });

  it('仅含 current_canvas_id（无 title）→ 标题兜底为 "Untitled"', () => {
    const text = render('tabwhiteboard', { current_canvas_id: 'cnv_only' });
    expect(text).toContain('current_whiteboard: "Untitled" (id: cnv_only)');
  });
});

describe('createAppMetaFormatter — tabtracker 详情块', () => {
  it('current_tracker_id + title 同时渲染', () => {
    const text = render('tabtracker', {
      current_tracker_id: 'tr_x',
      current_tracker_title: 'Daily Standup',
    });
    expect(text).toContain('details:');
    expect(text).toContain('current_tracker: "Daily Standup" (id: tr_x)');
  });

  it('仅含 current_tracker_id（无 title）→ 标题兜底为 "Untitled"', () => {
    const text = render('tabtracker', { current_tracker_id: 'tr_only' });
    expect(text).toContain('current_tracker: "Untitled" (id: tr_only)');
  });
});

describe('createAppMetaFormatter — tabfiles 详情块', () => {
  it('current_file_id + file_name 同时渲染', () => {
    const text = render('tabfiles', {
      current_file_id: 'file_1',
      current_file_name: 'brief.pdf',
    });
    expect(text).toContain('details:');
    expect(text).toContain('current_file: "brief.pdf" (id: file_1)');
  });

  it('仅含 current_file_id（无 name）→ 名称兜底为 "Untitled"', () => {
    const text = render('tabfiles', { current_file_id: 'file_only' });
    expect(text).toContain('current_file: "Untitled" (id: file_only)');
  });
});

describe('createAppMetaFormatter — tabdata 详情块', () => {
  it('current_table_name + current_table_id + current_view_id 渲染', () => {
    const text = render('tabdata', {
      current_table_name: '营销表',
      current_table_id: 'tbl_1',
      current_view_id: 'view_1',
    });
    expect(text).toContain('current_table: "营销表" (id: tbl_1)');
    expect(text).toContain('current_view_id: view_1');
  });
});

describe('createAppMetaFormatter — tabfolder 详情块', () => {
  it('同时渲染目录根和当前查看文件', () => {
    expect(formatAppMeta('tabfolder', {
      current_folder_path: '/workspace/project',
      current_file_path: '/workspace/project/src/index.ts',
    })).toEqual([
      'details:',
      '  folder_path: /workspace/project',
      '  current_file: /workspace/project/src/index.ts',
    ]);
  });

  it('沙箱目录沿用 sandbox_path 作为根路径', () => {
    expect(formatAppMeta('tabfolder', {
      sandbox_path: '/sandbox/agent',
    })).toEqual([
      'details:',
      '  folder_path: /sandbox/agent',
    ]);
  });
});

describe('createAppMetaFormatter — 白名单外 / 空 meta', () => {
  it('不认识的 App 类型返回空数组（不输出详情段）', () => {
    expect(formatAppMeta('chat', {})).toEqual([]);
    expect(formatAppMeta('apphome', {})).toEqual([]);
    expect(formatAppMeta('tabunknown', { foo: 'bar' })).toEqual([]);
  });

  it('白名单内但无可渲染字段 → 空数组', () => {
    expect(formatAppMeta('tabdata', {})).toEqual([]);
    expect(formatAppMeta('tabdoc', {})).toEqual([]);
  });
});

/**
 * ConsoleLog —— 常驻控制台历史缓冲（BR-8 WS-B）。
 *
 * 消费 CDP `Runtime.consoleAPICalled`（页面 console.* 调用）与 `Log.entryAdded`
 * （浏览器产生的日志：网络错误 / CSP / 弃用警告等），沉淀成历史日志（按 tabId
 * 分桶、环形容量上限）。于是 `console` 命令返回的是**历史日志**而非窗口快照。
 *
 * 形状对齐 Electron 经 action-tools 暴露的 `ConsoleLogEntry`，让双端 `console`
 * 输出结构一致。
 */

import type { CDPLogEvent, RuntimeLogContext } from './types';

export interface ConsoleLogEntry {
  level: string;
  text: string;
  timestamp: number;
  source?: string;
  runId?: string;
}

export interface ConsoleLogQuery {
  /** 精确匹配日志级别（如 error / warning / info / log / debug）。 */
  level?: string;
  runId?: string;
  /** 仅返回最近 N 条（保持时间序）。 */
  limit?: number;
}

const DEFAULT_CAPACITY = 1000;

/** 把 CDP RemoteObject 渲染成可读文本（与 devtools console 的呈现近似）。 */
function remoteObjectToString(arg: unknown): string {
  if (arg === null || arg === undefined) return String(arg);
  if (typeof arg !== 'object') return String(arg);
  const o = arg as Record<string, unknown>;
  if ('value' in o && o.value !== undefined) {
    return typeof o.value === 'string' ? o.value : safeJson(o.value);
  }
  if (typeof o.unserializableValue === 'string') return o.unserializableValue;
  if (typeof o.description === 'string') return o.description;
  if (o.type === 'undefined') return 'undefined';
  if (o.subtype === 'null') return 'null';
  if (typeof o.className === 'string') return o.className;
  if (typeof o.type === 'string') return o.type;
  return '';
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export class ConsoleLog {
  private readonly tabs = new Map<string, ConsoleLogEntry[]>();

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  record(tabId: string, event: CDPLogEvent, ctx?: RuntimeLogContext): void {
    if (!tabId || !event || typeof event.method !== 'string') return;
    const p = (event.params ?? {}) as Record<string, unknown>;
    if (event.method === 'Runtime.consoleAPICalled') {
      this.onConsoleApi(tabId, p, ctx?.runId);
    } else if (event.method === 'Log.entryAdded') {
      this.onLogEntry(tabId, p, ctx?.runId);
    }
  }

  query(tabId: string, q: ConsoleLogQuery = {}): ConsoleLogEntry[] {
    let arr = this.tabs.get(tabId) ?? [];
    if (q.runId) arr = arr.filter((e) => e.runId === q.runId);
    if (q.level) arr = arr.filter((e) => e.level === q.level);
    if (q.limit && q.limit > 0 && arr.length > q.limit) {
      arr = arr.slice(arr.length - q.limit);
    }
    // 返回拷贝，避免调用方意外改动缓冲。
    return arr.map((e) => ({ ...e }));
  }

  clear(tabId: string): void {
    this.tabs.delete(tabId);
  }

  clearAll(): void {
    this.tabs.clear();
  }

  size(tabId: string): number {
    return this.tabs.get(tabId)?.length ?? 0;
  }

  // ── 内部 ────────────────────────────────────────────────────────

  private onConsoleApi(tabId: string, p: Record<string, unknown>, runId?: string): void {
    const args = Array.isArray(p.args) ? p.args : [];
    const text = args.map(remoteObjectToString).join(' ');
    const stack = p.stackTrace as { callFrames?: Array<{ url?: string }> } | undefined;
    const source = stack?.callFrames?.[0]?.url || undefined;
    this.push(tabId, {
      level: typeof p.type === 'string' && p.type ? p.type : 'log',
      text,
      timestamp: this.toTimestamp(p.timestamp),
      ...(source ? { source } : {}),
      ...(runId ? { runId } : {}),
    });
  }

  private onLogEntry(tabId: string, p: Record<string, unknown>, runId?: string): void {
    const entry = p.entry as Record<string, unknown> | undefined;
    if (!entry) return;
    const source = typeof entry.url === 'string' ? entry.url : undefined;
    this.push(tabId, {
      level: typeof entry.level === 'string' ? entry.level : 'info',
      text: typeof entry.text === 'string' ? entry.text : '',
      timestamp: this.toTimestamp(entry.timestamp),
      ...(source ? { source } : {}),
      ...(runId ? { runId } : {}),
    });
  }

  /** CDP Runtime.Timestamp = 毫秒 epoch；非法/缺失时退回 Date.now()。 */
  private toTimestamp(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : Date.now();
  }

  private push(tabId: string, entry: ConsoleLogEntry): void {
    let arr = this.tabs.get(tabId);
    if (!arr) {
      arr = [];
      this.tabs.set(tabId, arr);
    }
    arr.push(entry);
    if (arr.length > this.capacity) arr.splice(0, arr.length - this.capacity);
  }
}

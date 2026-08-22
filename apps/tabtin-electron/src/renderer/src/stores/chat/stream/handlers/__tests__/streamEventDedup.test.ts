import { describe, it, expect, beforeEach } from 'vitest'
import {
  markStreamEventSeen,
  clearStreamEventDedup,
  __resetStreamEventDedupForTest,
} from '../streamEventDedup'

describe('streamEventDedup ( 跨源 arrival_seq 去重)', () => {
  beforeEach(() => {
    __resetStreamEventDedupForTest()
  })

  it('首次见到返回 true（应处理），重复返回 false（后到丢弃）', () => {
    expect(markStreamEventSeen('s1', 100)).toBe(true)
    expect(markStreamEventSeen('s1', 100)).toBe(false)
    expect(markStreamEventSeen('s1', 100)).toBe(false)
  })

  it('不同 arrival_seq 互不影响', () => {
    expect(markStreamEventSeen('s1', 100)).toBe(true)
    expect(markStreamEventSeen('s1', 101)).toBe(true)
    expect(markStreamEventSeen('s1', 100)).toBe(false)
  })

  it('per-session 隔离：同一 arrival_seq 在不同 session 各算首次', () => {
    expect(markStreamEventSeen('s1', 100)).toBe(true)
    expect(markStreamEventSeen('s2', 100)).toBe(true)
    expect(markStreamEventSeen('s1', 100)).toBe(false)
    expect(markStreamEventSeen('s2', 100)).toBe(false)
  })

  it('IPC 先到 / WS 后到：同一事件只处理一次（顺序无关）', () => {
    // 模拟 IPC 先到
    expect(markStreamEventSeen('s1', 5000)).toBe(true)
    // WS 镜像后到同一事件 → 丢弃
    expect(markStreamEventSeen('s1', 5000)).toBe(false)
  })

  it('WS 先到 / IPC 后到：同样只处理一次', () => {
    expect(markStreamEventSeen('s1', 6000)).toBe(true)
    expect(markStreamEventSeen('s1', 6000)).toBe(false)
  })

  it('clearStreamEventDedup 后同一 arrival_seq 重新算首次', () => {
    expect(markStreamEventSeen('s1', 100)).toBe(true)
    clearStreamEventDedup('s1')
    expect(markStreamEventSeen('s1', 100)).toBe(true)
  })

  it('LRU 淘汰：超过上限后最旧的 arrival_seq 被驱逐（再见到算首次）', () => {
    // 上限 8192；灌入 8193 条把第 1 条挤出
    const FIRST = 1
    expect(markStreamEventSeen('s1', FIRST)).toBe(true)
    for (let i = 2; i <= 8193; i++) {
      markStreamEventSeen('s1', i)
    }
    // FIRST 已被淘汰 → 再见到算首次（true），符合 LRU 容量边界预期
    expect(markStreamEventSeen('s1', FIRST)).toBe(true)
    // 仍在窗口内的最近事件依旧判重
    expect(markStreamEventSeen('s1', 8193)).toBe(false)
  })

  it('空 sessionId 一律放行（返回 true，不去重）', () => {
    expect(markStreamEventSeen('', 100)).toBe(true)
    expect(markStreamEventSeen('', 100)).toBe(true)
  })

  // ── ：event_id（string）身份键去重 ──────────────────────────────
  it('string event_id：首次 true，重复 false', () => {
    expect(markStreamEventSeen('s1', 'nonce-1a')).toBe(true)
    expect(markStreamEventSeen('s1', 'nonce-1a')).toBe(false)
  })

  it('子代理 transcript：IPC 包装副本与 WS 原始回声同 event_id → 只处理一次', () => {
    // 两路承载同一逻辑发射（forwardSubagentStreamToParent 把内层 id 提升到 wrapper 顶层，
    // WS 原始事件携带同一 id），无论谁先到都只处理一次
    expect(markStreamEventSeen('s1', 'child-emission-42')).toBe(true)
    expect(markStreamEventSeen('s1', 'child-emission-42')).toBe(false)
  })

  it('string 与 number key 不撞车（event_id vs 老 arrival_seq 回落并存）', () => {
    expect(markStreamEventSeen('s1', 'nonce-7')).toBe(true)
    expect(markStreamEventSeen('s1', 7)).toBe(true)
    expect(markStreamEventSeen('s1', 'nonce-7')).toBe(false)
    expect(markStreamEventSeen('s1', 7)).toBe(false)
  })
})

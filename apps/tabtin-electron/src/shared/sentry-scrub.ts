/**
 * Sentry 事件脱敏（主进程 / 渲染进程共享 beforeSend 钩子）——薄壳。
 *
 * 实现已提升到 @tabtin/shared：Daemon 的 @sentry/node
 * beforeSend 也复用同一份，保证多端脱敏口径同源。单测随实现搬到
 * packages/tabtin-shared/src/__tests__/sentry-scrub.test.ts。
 */

export { scrubSentryEvent } from '@tabtin/shared/sentry-scrub'

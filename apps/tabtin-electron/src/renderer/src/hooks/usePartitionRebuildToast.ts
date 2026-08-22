/**
 * usePartitionRebuildToast — 监听主进程"workspace view 因 env 绑定变更而被
 * 重建"事件，弹一条信息 toast 让用户知道刚才的"tab 闪一下"是合法切换。
 *
 * 触发链路：
 *   1. 用户在设置页改 Space → BrowserEnvironment 绑定
 *   2. 主进程 BrowserEnvironmentService 写入新 binding 并广播 onChanged
 *   3. renderer 端 browserEnvSnapshot listener 升级各 workspace 的 partition
 *      字段并触发 ChromeWebContentsView 重新调用 `crawl-view:show`
 *   4. 主进程 `crawl-view/ipc-handlers.ts` 检测到 partition 不一致 → 销毁旧
 *      view + 用新 partition 重建 + 广播 `crawl-view:partition-rebuilt`
 *   5. 本 hook 收到广播 → 弹 toast
 *
 * 没有这条 toast，用户感知就是"tab 突然刷新了一下"，无法把这件事和"我刚改
 * 了环境绑定"联系起来。这是一段 dogfood 期实测过的产品体验。
 */
import { useEffect } from 'react'
import { toast } from '@tabtin/smartsheet-ui/toast'
import { useTranslation } from 'react-i18next'
import { createLogger } from '@/utils/logger'

const log = createLogger('CrawlView')

export function usePartitionRebuildToast(enabled: boolean): void {
  const { t } = useTranslation('crawl')

  useEffect(() => {
    if (!enabled) return
    const onPartitionRebuilt = window.tabtin?.crawlView?.onPartitionRebuilt
    if (typeof onPartitionRebuilt !== 'function') return

    const unsub = onPartitionRebuilt(({ tabId, oldPartition, newPartition, reason }) => {
      // 调试场景下用得上：标识哪条 tab 被重建、partition 切换前后值
      log.info('partition 重建事件', { tabId, oldPartition, newPartition, reason })
      toast.info(
        t('toast.partitionRebuiltTitle', { defaultValue: '已切换到新登录环境' }),
        {
          description: t('toast.partitionRebuiltDesc', {
            defaultValue: '此标签的浏览器身份已根据工作空间绑定自动更新；如刚才在填写表单未提交，请重新输入。',
          }),
          duration: 6000,
        },
      )
    })

    return () => {
      try { unsub() } catch { /* ignore */ }
    }
  }, [enabled, t])
}

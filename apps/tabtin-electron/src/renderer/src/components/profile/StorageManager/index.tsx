/**
 * StorageManager — 「个人资料 → 存储管理」面板根组件（2026-05 重设 v5）。
 *
 * 设计聚焦：**只做存储管理一件事** ——"看占用 + 清条目"。
 *
 * 结构：
 *   1. StorageOverviewSection — 健康档位 + 三指标（已占用 / 最大一类 / 临时缓存）
 *   2. TopItemsSection — 按数据类型排序的 Top 列表，可下钻
 *
 * 不在本面板的（迁移历史）：
 *   - **备份/导出** — 删除。低频偶发动作，不占主屏（用户拍板）
 *   - **立即可清理** section — 删除。清理临时缓存动作并入顶部指标
 *   - **退出登录** — 删除。死按钮（Electron 没有 group=login 的 bucket
 *     注册），真正登出在「账户」面板的 useAuthStore.logout()
 *   - **重置设备身份** — 删除。死按钮（没有 system:fingerprint bucket 注册），
 *     未来需要时应到「开发者」面板独立实现
 *   - **清空所有 TabTin 数据** — 删除。这是"卸载重装"心智，不属于存储管理；
 *     macOS/iOS 的存储面板都没这个动作。需要时应建独立「重置应用」面板
 *
 * 跟性能面板的呼应：
 *   - 状态色点 + 拟人化文案（severity tagline）
 *   - 横向三指标（MetricCell）
 *   - 按"用户能识别的单位"展示 Top（不是按 bucket）
 */

import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HardDrive } from 'lucide-react'
import { useSpaceStore } from '@tabtin/app-shell'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { SettingsPanelHeader } from '../../settings/SettingsPanelHeader'
import { SettingsPanelLayout } from '../../settings/SettingsPanelLayout'
import { SettingsInlineAlert } from '../../settings/SettingsInlineAlert'
import { StorageOverviewSection } from './sections/StorageOverviewSection'
import { TopItemsSection } from './sections/TopItemsSection'
import { useStorageData } from './useStorageData'
import {
  buildStorageTopItems,
  type StorageTopItem,
} from './utils/buildTopItems'
import type {
  BucketSizeReport,
  StorageManagerData,
} from './components/types'

export const StorageManager: React.FC = () => {
  const { t } = useTranslation('storage-manager')
  const {
    views,
    isLoadingBuckets,
    isMeasuring,
    loadError,
    refresh,
    onClear,
    onListItems,
    onExport,
  } = useStorageData()

  // ── 整理传给 children 的数据契约 ──
  const data: StorageManagerData = useMemo(() => {
    const sizeMap: Record<string, BucketSizeReport | undefined> = {}
    const descriptors = views.map((v) => {
      sizeMap[v.id] = v.size
      const { size: _size, sizeError: _err, ...descriptor } = v
      void _size
      void _err
      return descriptor
    })
    return { descriptors, sizeMap, onClear, onListItems, onExport }
  }, [views, onClear, onListItems, onExport])

  // ── spaceId → spaceName join map（异步加载 spaces） ──
  // useSpaceStore.spaces 是当前 Organization 下的 Space 列表；BucketItem.metadata
  // 里的 spaceId 全局唯一，所以这个映射够用。
  const spaces = useSpaceStore((s) => s.spaces)
  const spaceNameMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of spaces) {
      m.set(s.id, s.name)
    }
    return m
  }, [spaces])

  const organizations = useOrganizationStore((s) => s.organizations)
  const organizationNameMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const organization of organizations) {
      map.set(organization.id, organization.name)
    }
    return map
  }, [organizations])

  // ── 计算 Top 列表（异步：调 listFn 拿 metadata 聚合） ──
  const [topResult, setTopResult] = useState<{
    topItems: StorageTopItem[]
    allItems: StorageTopItem[]
  }>({ topItems: [], allItems: [] })
  const [isBuildingTop, setIsBuildingTop] = useState(false)
  const [topBuildSeq, setTopBuildSeq] = useState(0)

  useEffect(() => {
    // 等 descriptors + sizes 都就绪后才算 Top（避免 listFn 跑两遍）
    if (isLoadingBuckets || isMeasuring) return
    if (data.descriptors.length === 0) {
      setTopResult({ topItems: [], allItems: [] })
      return
    }

    let cancelled = false
    setIsBuildingTop(true)
    void buildStorageTopItems({
      descriptors: data.descriptors,
      sizeMap: data.sizeMap,
      onListItems: data.onListItems,
      spaceNameMap,
      organizationNameMap,
      t,
      topN: 5,
    })
      .then((result) => {
        if (cancelled) return
        setTopResult(result)
      })
      .catch((err) => {
        if (cancelled) return
        console.warn('[StorageManager] buildStorageTopItems failed:', err)
        setTopResult({ topItems: [], allItems: [] })
      })
      .finally(() => {
        if (!cancelled) setIsBuildingTop(false)
      })

    return () => {
      cancelled = true
    }
    // topBuildSeq 让外部"刷新"也能重新算 Top
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    data.descriptors,
    data.sizeMap,
    data.onListItems,
    spaceNameMap,
    organizationNameMap,
    isLoadingBuckets,
    isMeasuring,
    topBuildSeq,
  ])

  // ── 临时缓存的合计（OverviewSection 的第三个指标用） ──
  const cacheStat = useMemo(() => {
    const cacheBuckets = data.descriptors.filter(
      (d) => d.category === 'cache' && d.capabilities.canClear,
    )
    const bytes = cacheBuckets.reduce(
      (sum, d) => sum + (data.sizeMap[d.id]?.bytes ?? 0),
      0,
    )
    return { bytes, count: cacheBuckets.length, buckets: cacheBuckets }
  }, [data.descriptors, data.sizeMap])

  // 摘要与下方明细必须来自同一份用户可见聚合，避免内部 bucket 被计入顶部、
  // 却无法在明细中解释。allItems 已完成去重、隐藏规则和分类聚合。
  const visibleSummary = useMemo(() => ({
    totalBytes: topResult.allItems.reduce((sum, item) => sum + item.bytes, 0),
    itemCount: topResult.allItems.length,
  }), [topResult.allItems])

  // ── 一键清缓存（OverviewSection 调） ──
  const handleCleanCache = async () => {
    if (cacheStat.buckets.length === 0) return
    await Promise.allSettled(
      cacheStat.buckets.map((d) => data.onClear(d.id)),
    )
    void refresh()
  }

  // ── 整体刷新 ──
  const handleRefresh = () => {
    void refresh().then(() => {
      setTopBuildSeq((n) => n + 1)
    })
  }

  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<HardDrive className="h-6 w-6" />}
        title={t('panel.title')}
        subtitle={t('panel.subtitle')}
      />

      {loadError && (
        <SettingsInlineAlert
          tone="danger"
          title={t('panel.loadErrorTitle')}
          description={loadError}
        />
      )}

      <StorageOverviewSection
        totalBytes={visibleSummary.totalBytes}
        totalItemCount={visibleSummary.itemCount}
        largestItem={topResult.topItems[0]}
        cacheBytes={cacheStat.bytes}
        cacheBucketCount={cacheStat.count}
        isLoading={isLoadingBuckets && views.length === 0}
        isMeasuring={isMeasuring || isBuildingTop}
        onCleanCache={handleCleanCache}
        onRefresh={handleRefresh}
        refreshDisabled={isLoadingBuckets || isMeasuring || isBuildingTop}
        isRefreshing={isLoadingBuckets || isMeasuring || isBuildingTop}
      />

      <TopItemsSection
        topItems={topResult.topItems}
        allItems={topResult.allItems}
        isLoading={isBuildingTop && topResult.topItems.length === 0}
        onClear={data.onClear}
        onListItems={data.onListItems}
        onExport={data.onExport}
        onChanged={handleRefresh}
      />
    </SettingsPanelLayout>
  )
}

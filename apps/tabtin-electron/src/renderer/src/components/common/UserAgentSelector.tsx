/**
 * User-Agent 选择器组件 v2.0
 *
 * ✨ 功能：
 * - 支持自动检测（保持原生指纹，最真实）
 * - 支持桌面UA池（20+桌面UA，可按平台/浏览器筛选）
 * - 支持移动设备模拟（42+设备库，完整指纹）
 * - 支持自定义UA
 * - 平台一致性检查
 * - 完整的Client Hints支持
 *
 * @example
 * ```tsx
 * <UserAgentSelector
 *   value={uaConfig}
 *   onChange={(config) => setUaConfig(config)}
 * />
 * ```
 */

import React, { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown, Smartphone, Edit3, Zap, Fingerprint, ShieldCheck,
  Monitor, Info, CheckCircle, AlertTriangle, RefreshCw
} from 'lucide-react'
import { cn } from '@utils/cn'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import type {
  UserAgentConfig,
  UserAgentMode,
  MobileDevicePreset,
  DesktopPlatform,
  DesktopBrowser
} from '@/types/userAgent'
import {
  DEFAULT_UA_CONFIG,
  MOBILE_UA_POOLS,
  DESKTOP_UA_POOLS
} from '@/types/userAgent'
import {
  getFingerprintPreview,
  getExtendedFingerprintPreview,
  getPlatformConsistencyStatus
} from '../../utils/fingerprintPreview'

interface UserAgentSelectorProps {
  /** 当前 UA 配置 */
  value?: UserAgentConfig
  /** 配置变化回调 */
  onChange: (config: UserAgentConfig) => void
  /** 是否禁用 */
  disabled?: boolean
  /** 自定义类名 */
  className?: string
  /** 是否显示在折叠区域内 */
  collapsible?: boolean
  /** 是否默认展开（collapsible=true 时有效） */
  defaultExpanded?: boolean
}

/**
 * 获取系统 User-Agent (简单模拟)
 */
function getSystemUserAgentString(): string {
  if (typeof navigator !== 'undefined') {
    return navigator.userAgent;
  }
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
}

/**
 * 获取系统信息描述
 */
function getSystemDescription(): string {
  if (typeof navigator === 'undefined') {
    return 'Chrome on Desktop'
  }

  const ua = navigator.userAgent
  let browser = 'Chrome'
  let os = 'Desktop'

  // 检测浏览器
  if (ua.includes('Edg/')) {
    browser = 'Edge'
  } else if (ua.includes('Chrome/')) {
    browser = 'Chrome'
  } else if (ua.includes('Safari/') && !ua.includes('Chrome')) {
    browser = 'Safari'
  } else if (ua.includes('Firefox/')) {
    browser = 'Firefox'
  }

  // 检测操作系统
  if (ua.includes('Mac OS X') || ua.includes('Macintosh')) {
    os = 'macOS'
  } else if (ua.includes('Windows')) {
    os = 'Windows'
  } else if (ua.includes('Linux')) {
    os = 'Linux'
  }

  return `${browser} on ${os}`
}

const MOBILE_PRESETS: MobileDevicePreset[] = ['iphone', 'android', 'ipad']
const DESKTOP_PLATFORMS: DesktopPlatform[] = ['current', 'windows', 'macos', 'linux']
const DESKTOP_BROWSERS: DesktopBrowser[] = ['chrome', 'edge', 'firefox', 'safari']

export const UserAgentSelector: React.FC<UserAgentSelectorProps> = ({
  value = DEFAULT_UA_CONFIG,
  onChange,
  disabled = false,
  className,
  collapsible = false,
  defaultExpanded = false
}) => {
  const { t } = useTranslation('userAgent')
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [systemDesc] = useState(getSystemDescription())
  const [randomSeed, setRandomSeed] = useState(0) // 用于强制刷新随机UA

  const platformLabels = useMemo(() => ({
    current: t('platforms.current'),
    windows: t('platforms.windows'),
    macos: t('platforms.macos'),
    linux: t('platforms.linux'),
  }), [t])

  const browserLabels = useMemo(() => ({
    chrome: t('browsers.chrome'),
    edge: t('browsers.edge'),
    firefox: t('browsers.firefox'),
    safari: t('browsers.safari'),
  }), [t])

  const mobileDeviceLabels = useMemo(() => ({
    iphone: t('mobileDevices.iphone'),
    android: t('mobileDevices.android'),
    ipad: t('mobileDevices.ipad'),
  }), [t])

  const mobileDeviceShortLabels = useMemo(() => ({
    iphone: t('mobileDevicesShort.iphone'),
    android: t('mobileDevicesShort.android'),
    ipad: t('mobileDevicesShort.ipad'),
  }), [t])

  const platformNameLabels = useMemo(() => ({
    macOS: t('platformNames.macOS'),
    Windows: t('platformNames.Windows'),
    Linux: t('platformNames.Linux'),
    iOS: t('platformNames.iOS'),
    iPadOS: t('platformNames.iPadOS'),
    Android: t('platformNames.Android'),
    Unknown: t('platformNames.Unknown'),
  }), [t])

  const resolvePlatformName = (platform: string) =>
    platformNameLabels[platform as keyof typeof platformNameLabels] ?? platform

  // ✅ 计算当前将会生效的 UA（根据配置动态生成预览）
  const effectiveUA = useMemo(() => {
    switch (value.mode) {
      case 'auto':
        return getSystemUserAgentString();

      case 'mobile': {
        // 移动设备：从UA池中随机选择
        const preset = value.preset || 'iphone';
        const pool = MOBILE_UA_POOLS[preset];
        if (pool && pool.length > 0) {
          // 使用 randomSeed 来确保每次 seed 变化时都会重新随机
          const index = Math.floor((Math.random() + randomSeed) * pool.length) % pool.length;
          return pool[index];
        }
        // Fallback（不应该走到这里）
        return 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
      }

      case 'desktop_pool': {
        // 桌面池：根据平台和浏览器从UA池中随机选择
        const platform = value.desktopPlatform || 'current';
        const browser = value.desktopBrowser || 'chrome';

        // 先确定平台
        let platformUA: 'windows' | 'macos' | 'linux' = 'windows';
        if (platform === 'current') {
          const sysUA = getSystemUserAgentString();
          if (sysUA.includes('Macintosh')) {
            platformUA = 'macos';
          } else if (sysUA.includes('Windows')) {
            platformUA = 'windows';
          } else if (sysUA.includes('Linux')) {
            platformUA = 'linux';
          }
        } else {
          platformUA = platform;
        }

        // 从对应的UA池中随机选择
        const pool = DESKTOP_UA_POOLS[platformUA][browser];
        if (pool && pool.length > 0) {
          // 使用 randomSeed 来确保每次 seed 变化时都会重新随机
          const index = Math.floor((Math.random() + randomSeed) * pool.length) % pool.length;
          return pool[index];
        }

        // Fallback
        return getSystemUserAgentString();
      }

      case 'custom':
        return value.custom || getSystemUserAgentString();

      default:
        return getSystemUserAgentString();
    }
  }, [value, randomSeed]); // 添加 randomSeed 作为依赖

  // ✅ 计算扩展指纹预览
  const extendedFingerprint = useMemo(() => {
    return getExtendedFingerprintPreview(effectiveUA);
  }, [effectiveUA]);

  // ✅ 计算平台一致性状态
  const platformStatus = useMemo(() => {
    return getPlatformConsistencyStatus(effectiveUA);
  }, [effectiveUA]);

  const handleModeChange = (mode: UserAgentMode) => {
    const newConfig: UserAgentConfig = {
      mode,
      desktopPlatform: 'current'
    }

    // 如果切换到 mobile，默认选择 iPhone
    if (mode === 'mobile') {
      newConfig.preset = 'iphone'
    }

    // 如果切换到 desktop_pool，设置默认平台为当前平台
    if (mode === 'desktop_pool') {
      newConfig.desktopPlatform = 'current'
    }

    onChange(newConfig)
  }

  const handlePresetChange = (preset: MobileDevicePreset) => {
    // 切换preset时，刷新随机种子以获取新的随机UA
    setRandomSeed(prev => prev + 1);
    onChange({
      ...value,
      mode: 'mobile',
      preset
    })
  }

  const handleDesktopPlatformChange = (platform: DesktopPlatform) => {
    onChange({
      ...value,
      desktopPlatform: platform
    })
  }

  const handleDesktopBrowserChange = (browser: DesktopBrowser) => {
    onChange({
      ...value,
      desktopBrowser: browser
    })
  }

  const handleCustomChange = (custom: string) => {
    onChange({
      ...value,
      mode: 'custom',
      custom
    })
  }

  // 渲染内容
  const renderContent = () => (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* 左侧：配置选择 */}
      <div className="space-y-3">
        <label className="text-body font-medium text-muted-foreground">
          {t('labels.strategy')}
        </label>

        {/* 1. 自动检测（原生） */}
        <div
          className={cn(
            'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
            value.mode === 'auto'
              ? 'border-success/40 bg-success/10'
              : 'border-border hover:border-success/30',
            disabled && 'opacity-50 cursor-not-allowed'
          )}
          onClick={() => !disabled && handleModeChange('auto')}
        >
          <div className="flex-shrink-0 mt-0.5">
            <input
              type="radio"
              checked={value.mode === 'auto'}
              onChange={() => handleModeChange('auto')}
              disabled={disabled}
              className="w-4 h-4 text-success"
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-success" />
              <span className="text-body font-medium text-foreground">
                {t('mode.auto.label')}
              </span>
              <span className="text-caption bg-success/20 text-success px-1.5 py-0.5 rounded">
                {t('labels.recommended')}
              </span>
            </div>
            <p className="text-body text-muted-foreground mt-1">
              {t('mode.auto.description')}
            </p>
            <p className="text-body text-success mt-1 font-medium">
              {t('labels.highestRealism', { system: systemDesc })}
            </p>
          </div>
        </div>

        {/* 2. 移动设备模拟 */}
        <div
          className={cn(
            'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
            value.mode === 'mobile'
              ? 'border-primary/40 bg-primary/10'
              : 'border-border hover:border-primary/30',
            disabled && 'opacity-50 cursor-not-allowed'
          )}
          onClick={() => !disabled && handleModeChange('mobile')}
        >
          <div className="flex-shrink-0 mt-0.5">
            <input
              type="radio"
              checked={value.mode === 'mobile'}
              onChange={() => handleModeChange('mobile')}
              disabled={disabled}
              className="w-4 h-4 text-primary"
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Smartphone className="w-4 h-4 text-primary" />
              <span className="text-body font-medium text-foreground">
                {t('mode.mobile.label')}
              </span>
            </div>
            <p className="text-body text-muted-foreground mt-1">
              {t('mode.mobile.description')}
            </p>

            {/* 移动设备下拉选择 */}
            {value.mode === 'mobile' && (
              <div className="mt-2 space-y-2">
                <select
                  value={value.preset || 'iphone'}
                  onChange={(e) => handlePresetChange(e.target.value as MobileDevicePreset)}
                  disabled={disabled}
                  className="w-full px-3 py-2 text-body border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40"
                  onClick={(e) => e.stopPropagation()}
                >
                  {MOBILE_PRESETS.map(preset => (
                    <option key={preset} value={preset}>
                      {mobileDeviceLabels[preset]}
                    </option>
                  ))}
                </select>
                <p className="text-body text-primary mt-1">
                  {t('labels.mobileDeviceHint')}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* 3. 桌面UA池 */}
        <div
          className={cn(
            'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
            value.mode === 'desktop_pool'
              ? 'border-brand-500/40 bg-brand-500/10'
              : 'border-border hover:border-brand-300/50',
            disabled && 'opacity-50 cursor-not-allowed'
          )}
          onClick={() => !disabled && handleModeChange('desktop_pool')}
        >
          <div className="flex-shrink-0 mt-0.5">
            <input
              type="radio"
              checked={value.mode === 'desktop_pool'}
              onChange={() => handleModeChange('desktop_pool')}
              disabled={disabled}
              className="w-4 h-4 text-brand-600"
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Monitor className="w-4 h-4 text-brand-600" />
              <span className="text-body font-medium text-foreground">
                {t('mode.desktop_pool.label')}
              </span>
            </div>
            <p className="text-body text-muted-foreground mt-1">
              {t('mode.desktop_pool.description')}
            </p>

            {/* 桌面UA池配置 */}
            {value.mode === 'desktop_pool' && (
              <div className="mt-2 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-body font-medium text-muted-foreground">{t('labels.platform')}</label>
                    <select
                      value={value.desktopPlatform || 'current'}
                      onChange={(e) => handleDesktopPlatformChange(e.target.value as DesktopPlatform)}
                      disabled={disabled}
                      className="w-full px-2 py-1.5 text-body border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500/40"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {DESKTOP_PLATFORMS.map(platform => (
                        <option key={platform} value={platform}>
                          {platformLabels[platform]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-body font-medium text-muted-foreground">{t('labels.browser')}</label>
                    <select
                      value={value.desktopBrowser || 'chrome'}
                      onChange={(e) => handleDesktopBrowserChange(e.target.value as DesktopBrowser)}
                      disabled={disabled}
                      className="w-full px-2 py-1.5 text-body border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500/40"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {DESKTOP_BROWSERS.map(browser => (
                        <option key={browser} value={browser}>
                          {browserLabels[browser]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <p className="text-body text-brand-600 mt-2">
                  {t('labels.desktopPoolHint')}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* 4. 自定义 */}
        <div
          className={cn(
            'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
            value.mode === 'custom'
              ? 'border-warning/40 bg-warning/10'
              : 'border-border hover:border-warning/30',
            disabled && 'opacity-50 cursor-not-allowed'
          )}
          onClick={() => !disabled && handleModeChange('custom')}
        >
          <div className="flex-shrink-0 mt-0.5">
            <input
              type="radio"
              checked={value.mode === 'custom'}
              onChange={() => handleModeChange('custom')}
              disabled={disabled}
              className="w-4 h-4 text-warning"
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Edit3 className="w-4 h-4 text-warning" />
              <span className="text-body font-medium text-foreground">
                {t('mode.custom.label')}
              </span>
            </div>
            <p className="text-body text-muted-foreground mt-1">
              {t('mode.custom.description')}
            </p>

            {/* 自定义 UA 输入框 */}
            {value.mode === 'custom' && (
              <textarea
                value={value.custom || ''}
                onChange={(e) => handleCustomChange(e.target.value)}
                disabled={disabled}
                placeholder={t('labels.customPlaceholder')}
                className="mt-2 w-full px-3 py-2 text-body font-mono border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-warning/40 focus:border-warning/40 min-h-[60px]"
                onClick={(e) => e.stopPropagation()}
              />
            )}
          </div>
        </div>
      </div>

      {/* 右侧：实时预览 */}
      <div className="space-y-3">
        <label className="text-body font-medium text-muted-foreground">
          {t('labels.preview')}
        </label>

        {/* UA字符串预览 */}
        <div className="bg-card border border-border rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Info className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-body font-medium text-muted-foreground">
                {t('labels.uaPreview')}
              </span>
            </div>
            {/* 刷新按钮（移动设备模式或桌面池模式显示） */}
            {(value.mode === 'mobile' || value.mode === 'desktop_pool') && (
              <button
                onClick={() => setRandomSeed(prev => prev + 1)}
                disabled={disabled}
                className="flex items-center gap-1 px-2 py-1 text-caption text-brand-600 hover:text-brand-700 hover:bg-brand-500/10 rounded transition-colors disabled:opacity-50"
                title={t('labels.refreshRandom')}
              >
                <RefreshCw className="w-3 h-3" />
                <span>{t('labels.refreshOne')}</span>
              </button>
            )}
          </div>
          <ScrollArea className="max-h-24 rounded border border-border bg-muted/40">
            <div className="text-body font-mono text-foreground px-3 py-2 break-all leading-relaxed">
              {effectiveUA}
            </div>
          </ScrollArea>
          <div className="mt-2 flex items-start gap-1.5">
            {value.mode === 'desktop_pool' && (
              <p className="text-caption text-brand-600 bg-brand-500/10 px-2 py-1 rounded border border-brand-500/20 flex-1">
                {t('labels.previewDesktopPool', {
                  platform: platformLabels[value.desktopPlatform || 'current'],
                  browser: browserLabels[value.desktopBrowser || 'chrome'],
                })}
              </p>
            )}
            {value.mode === 'mobile' && (
              <p className="text-caption text-primary bg-primary/10 px-2 py-1 rounded border border-primary/20 flex-1">
                {t('labels.previewMobile', {
                  device: mobileDeviceShortLabels[value.preset || 'iphone'],
                })}
              </p>
            )}
            {value.mode === 'auto' && (
              <p className="text-caption text-success bg-success/10 px-2 py-1 rounded border border-success/20 flex-1">
                {t('labels.previewAuto')}
              </p>
            )}
          </div>
        </div>

        {/* 平台一致性提示 */}
        {value.mode !== 'auto' && (
          <div className={cn(
            'rounded-lg p-3 border',
            platformStatus.isConsistent
              ? 'bg-success/10 border-success/20'
              : 'bg-warning/10 border-warning/20'
          )}>
            <div className="flex items-start gap-2">
              {platformStatus.isConsistent ? (
                <CheckCircle className="w-4 h-4 text-success flex-shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-body font-medium text-foreground mb-1">
                  {t('labels.consistencyTitle')}
                </p>
                <p className="text-body text-muted-foreground">
                  {t('labels.consistencyLine', {
                    current: resolvePlatformName(platformStatus.currentPlatform),
                    target: resolvePlatformName(platformStatus.targetPlatform),
                  })}
                </p>
                <p className={cn(
                  'text-body mt-1',
                  platformStatus.isConsistent ? 'text-success' : 'text-warning'
                )}>
                  {platformStatus.recommendation}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* 指纹预览卡片 */}
        <div className="bg-muted/30 border border-border rounded-lg p-3">
          <div className="flex items-center gap-2 mb-2">
            <Fingerprint className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-body font-medium text-muted-foreground">
              {t('labels.fingerprintTitle')}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-2 text-body">
            <div className="flex flex-col gap-0.5">
              <span className="text-muted-foreground/80">{t('labels.gpuVendor')}</span>
              <span className="font-mono text-foreground bg-background px-2 py-1 rounded border border-border truncate">
                {extendedFingerprint.webgl.vendor}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-muted-foreground/80">{t('labels.renderer')}</span>
              <span className="font-mono text-foreground bg-background px-2 py-1 rounded border border-border truncate" title={extendedFingerprint.webgl.renderer}>
                {extendedFingerprint.webgl.renderer}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-muted-foreground/80">{t('labels.platformInfo')}</span>
              <span className="font-mono text-foreground bg-background px-2 py-1 rounded border border-border truncate">
                {extendedFingerprint.platform} {extendedFingerprint.platformVersion} ({extendedFingerprint.arch})
              </span>
            </div>
          </div>
          <div className="mt-2 space-y-1">
            <div className={cn(
              'flex items-center gap-1.5 text-caption px-2 py-1 rounded border',
              extendedFingerprint.keepNativeGPU
                ? 'text-success bg-success/10 border-success/20'
                : 'text-brand-600 bg-brand-500/10 border-brand-500/20'
            )}>
              <div className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
              <span>{extendedFingerprint.description}</span>
            </div>
            <div className="flex items-center gap-1.5 text-caption text-brand-600 bg-brand-500/10 px-2 py-1 rounded border border-brand-500/20">
              <ShieldCheck className="w-3 h-3 text-brand-500" />
              <span>{t('labels.clientHints')}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )

  // 如果是折叠模式
  if (collapsible) {
    return (
      <details
        className={cn('bg-muted/30 border border-border rounded-lg', className)}
        open={expanded}
        onToggle={(e) => setExpanded((e.target as HTMLDetailsElement).open)}
      >
        <summary className="px-4 py-3 cursor-pointer hover:bg-muted/40 transition-colors flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Smartphone className="w-4 h-4 text-muted-foreground" />
            <span className="text-body font-medium text-foreground">{t('labels.advancedSettings')}</span>
          </div>
          <ChevronDown className={cn(
            'w-4 h-4 text-muted-foreground transition-transform',
            expanded && 'rotate-180'
          )} />
        </summary>
        <div className="px-4 pb-4 pt-2 border-t border-border">
          {renderContent()}
        </div>
      </details>
    )
  }

  // 直接渲染模式
  return (
    <div className={className}>
      {renderContent()}
    </div>
  )
}

/**
 * 根据 UA 配置生成实际的 User-Agent 字符串
 *
 * ⚠️ 注意：这个函数在前端只用于预览，实际的 UA 生成在主进程中完成
 */
export function resolveUserAgent(config: UserAgentConfig | undefined): string | undefined {
  if (!config) {
    return undefined
  }

  switch (config.mode) {
    case 'auto':
      // 返回 undefined，让引擎使用系统 UA
      return undefined

    case 'mobile': {
      // 移动设备：从池中随机选择一个
      const preset = config.preset || 'iphone';
      const pool = MOBILE_UA_POOLS[preset];
      if (pool && pool.length > 0) {
        return pool[Math.floor(Math.random() * pool.length)];
      }
      return undefined;
    }

    case 'desktop_pool':
      // 桌面池：返回 undefined，由主进程从池中选择
      return undefined

    case 'custom':
      return config.custom || undefined

    default:
      return undefined
  }
}

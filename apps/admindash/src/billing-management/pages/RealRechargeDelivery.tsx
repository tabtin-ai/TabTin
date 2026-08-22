import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Loader2, MessageSquareShare, Save, Send, TestTube2 } from 'lucide-react'
import { useCallback, useState } from 'react'
import {
  type RealRechargeDeliveryConfig,
  type RealRechargeDeliveryConfigInput,
  getRealRechargeDeliveryConfig,
  sendRealRechargeReport,
  testRealRechargeDelivery,
  updateRealRechargeDeliveryConfig,
} from '../api/billing-admin'
import { RealRechargeDeliveryFields } from './RealRechargeDeliveryFields'
import { RealRechargeDeliveryStatus } from './RealRechargeDeliveryStatus'
import type { RechargePeriod } from './payment-order-recharge-stats'

const EMPTY_CONFIG: RealRechargeDeliveryConfigInput = {
  enabled: true,
  name: '真实充值报表',
  webhook_url: '',
  provider: 'feishu',
  delivery_mode: 'manual',
  daily_time: '09:00',
  schedule_timezone: 'Asia/Shanghai',
}

type Operation = 'load' | 'save' | 'test' | 'send' | null

interface RealRechargeDeliveryProps {
  period: RechargePeriod
}

export function RealRechargeDelivery({ period }: RealRechargeDeliveryProps) {
  const [open, setOpen] = useState(false)
  const [operation, setOperation] = useState<Operation>(null)
  const [config, setConfig] = useState<RealRechargeDeliveryConfigInput>(EMPTY_CONFIG)
  const [savedConfig, setSavedConfig] = useState<RealRechargeDeliveryConfig | null>(null)
  const [hasWebhookUrl, setHasWebhookUrl] = useState(false)
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(
    null
  )

  const applyRemoteConfig = useCallback((remote: RealRechargeDeliveryConfig) => {
    setConfig({
      enabled: true,
      name: remote.name || '真实充值报表',
      webhook_url: '',
      provider: remote.provider,
      delivery_mode: remote.delivery_mode,
      daily_time: remote.daily_time,
      schedule_timezone: remote.schedule_timezone,
    })
    setHasWebhookUrl(remote.has_webhook_url)
    setSavedConfig(remote)
  }, [])

  const load = useCallback(async () => {
    setOperation('load')
    setFeedback(null)
    try {
      applyRemoteConfig(await getRealRechargeDeliveryConfig())
    } catch (error) {
      setFeedback({
        tone: 'error',
        message: error instanceof Error ? error.message : '读取 IM 投递配置失败',
      })
    } finally {
      setOperation(null)
    }
  }, [applyRemoteConfig])

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (nextOpen) void load()
  }

  const save = async (): Promise<boolean> => {
    setOperation('save')
    setFeedback(null)
    try {
      const remote = await updateRealRechargeDeliveryConfig({ ...config, enabled: true })
      applyRemoteConfig(remote)
      setFeedback({ tone: 'success', message: '配置已保存并启用，密钥不会回传到浏览器。' })
      return true
    } catch (error) {
      setFeedback({
        tone: 'error',
        message: error instanceof Error ? error.message : '保存投递配置失败',
      })
      return false
    } finally {
      setOperation(null)
    }
  }

  const saveAndTest = async () => {
    if (!(await save())) return
    setOperation('test')
    setFeedback(null)
    try {
      await testRealRechargeDelivery()
      setFeedback({ tone: 'success', message: '测试消息已送达所选投递渠道。' })
    } catch (error) {
      setFeedback({
        tone: 'error',
        message: error instanceof Error ? error.message : '测试发送失败',
      })
    } finally {
      setOperation(null)
    }
  }

  const sendReport = async () => {
    if (!(await save())) return
    setOperation('send')
    setFeedback(null)
    try {
      await sendRealRechargeReport({
        period_key: period.key,
        start_date: period.key === 'custom' ? period.startDate || undefined : undefined,
        end_date: period.key === 'custom' ? period.endDate || undefined : undefined,
      })
      setFeedback({ tone: 'success', message: '当前时间范围的充值报表已进入发送队列。' })
    } catch (error) {
      setFeedback({
        tone: 'error',
        message: error instanceof Error ? error.message : '发送充值报表失败',
      })
    } finally {
      setOperation(null)
    }
  }

  const busy = operation !== null
  const hasUnsavedChanges = savedConfig
    ? Boolean(config.webhook_url.trim()) ||
      config.name !== (savedConfig.name || '真实充值报表') ||
      config.provider !== savedConfig.provider ||
      config.delivery_mode !== savedConfig.delivery_mode ||
      config.daily_time !== savedConfig.daily_time ||
      config.schedule_timezone !== savedConfig.schedule_timezone
    : false
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => handleOpenChange(true)}>
        <MessageSquareShare className="mr-2 h-[1em] w-[1em]" />
        发送到 IM
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              真实充值报表投递
              <Badge variant="outline">Webhook</Badge>
            </DialogTitle>
            <DialogDescription>
              配置接收消息的 Webhook 地址和发送方式。接收端可以是外部群聊，也可以是后续接入的 TabTin
              IM。
            </DialogDescription>
          </DialogHeader>

          {operation === 'load' ? (
            <div className="flex items-center justify-center gap-2 py-10 text-body text-muted-foreground">
              <Loader2 className="h-[1em] w-[1em] animate-spin" />
              正在读取配置…
            </div>
          ) : (
            <div className="space-y-4">
              {savedConfig ? (
                <RealRechargeDeliveryStatus
                  savedConfig={savedConfig}
                  hasUnsavedChanges={hasUnsavedChanges}
                />
              ) : null}

              <RealRechargeDeliveryFields
                config={config}
                hasWebhookUrl={hasWebhookUrl}
                onChange={setConfig}
              />

              {feedback ? (
                <div
                  role={feedback.tone === 'error' ? 'alert' : 'status'}
                  className={
                    feedback.tone === 'error'
                      ? 'bg-destructive/10 p-3 text-body text-destructive'
                      : 'bg-success/10 p-3 text-body text-success'
                  }
                >
                  {feedback.message}
                </div>
              ) : null}
            </div>
          )}

          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button variant="outline" onClick={() => void save()} disabled={busy}>
              <Save className="mr-2 h-[1em] w-[1em]" />
              保存配置
            </Button>
            <Button variant="secondary" onClick={() => void saveAndTest()} disabled={busy}>
              <TestTube2 className="mr-2 h-[1em] w-[1em]" />
              保存并测试
            </Button>
            <Button onClick={() => void sendReport()} disabled={busy}>
              {operation === 'send' ? (
                <Loader2 className="mr-2 h-[1em] w-[1em] animate-spin" />
              ) : (
                <Send className="mr-2 h-[1em] w-[1em]" />
              )}
              保存并发送
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

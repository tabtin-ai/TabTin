import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, LoaderCircle, Wifi, WifiOff } from 'lucide-react'
import QRCode from 'qrcode'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import type { LocalNetworkAddress } from '@shared/types/local-network'
import {
  buildMobileEnvironmentQrValue,
  isLoopbackMobileEnvironment,
  replaceLoopbackHosts,
  type MobileEnvironmentQrConfig,
} from '@/utils/mobileEnvironmentQr'

interface MobileEnvironmentQrDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  config: MobileEnvironmentQrConfig
}

export function MobileEnvironmentQrDialog({
  open,
  onOpenChange,
  config,
}: MobileEnvironmentQrDialogProps) {
  const { t } = useTranslation('settings')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [qrError, setQrError] = useState(false)
  const [localAddresses, setLocalAddresses] = useState<LocalNetworkAddress[]>(
    [],
  )
  const [selectedAddress, setSelectedAddress] = useState('')
  const hasLoopbackAddress = useMemo(
    () => isLoopbackMobileEnvironment(config),
    [config],
  )
  const effectiveConfig = useMemo(
    () =>
      hasLoopbackAddress && selectedAddress
        ? replaceLoopbackHosts(config, selectedAddress)
        : config,
    [config, hasLoopbackAddress, selectedAddress],
  )
  const canGenerateQrCode = !hasLoopbackAddress || Boolean(selectedAddress)
  const payload = useMemo(
    () =>
      canGenerateQrCode ? buildMobileEnvironmentQrValue(effectiveConfig) : '',
    [canGenerateQrCode, effectiveConfig],
  )

  useEffect(() => {
    if (!open || !hasLoopbackAddress) return

    let cancelled = false
    void (async () => {
      let addresses: LocalNetworkAddress[] = []
      try {
        addresses = (await window.tabtin?.getLocalNetworkAddresses?.()) ?? []
      } catch {
        addresses = []
      }
      if (cancelled) return
      setLocalAddresses(addresses)
      setSelectedAddress((current) =>
        addresses.some((entry) => entry.address === current)
          ? current
          : (addresses[0]?.address ?? ''),
      )
    })()
    return () => {
      cancelled = true
    }
  }, [hasLoopbackAddress, open])

  useEffect(() => {
    if (!open || !payload) {
      setQrDataUrl('')
      setQrError(false)
      return
    }

    let cancelled = false
    setQrDataUrl('')
    setQrError(false)
    QRCode.toDataURL(payload, {
      width: 320,
      margin: 2,
      errorCorrectionLevel: 'M',
    })
      .then((value) => {
        if (!cancelled) setQrDataUrl(value)
      })
      .catch(() => {
        if (!cancelled) setQrError(true)
      })

    return () => {
      cancelled = true
    }
  }, [open, payload])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('update.mobileEnvironmentTitle')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-body text-muted-foreground">
            {t('update.mobileEnvironmentDescription')}
          </p>

          <div className="flex items-start gap-2 rounded-md bg-muted/40 px-3 py-2 text-body text-foreground/80">
            <Wifi className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p>{t('update.mobileEnvironmentNetworkNotice')}</p>
          </div>

          {hasLoopbackAddress ? (
            <div className="space-y-3 rounded-md border border-warning/30 bg-warning/10 p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <div className="space-y-1">
                  <p className="text-body font-medium text-foreground">
                    {t('update.mobileEnvironmentAddressTitle')}
                  </p>
                  <p className="text-caption text-muted-foreground">
                    {t('update.mobileEnvironmentAddressDescription')}
                  </p>
                </div>
              </div>

              {localAddresses.length > 0 ? (
                <div className="space-y-2">
                  <label className="text-caption font-medium text-foreground">
                    {t('update.mobileEnvironmentAddressLabel')}
                  </label>
                  <Select
                    value={selectedAddress}
                    onValueChange={setSelectedAddress}
                  >
                    <SelectTrigger
                      className="h-9 w-full bg-background text-body"
                      aria-label={t('update.mobileEnvironmentAddressLabel')}
                    >
                      <SelectValue
                        placeholder={t(
                          'update.mobileEnvironmentAddressPlaceholder',
                        )}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {localAddresses.map((entry) => (
                        <SelectItem
                          key={`${entry.interfaceName}:${entry.address}`}
                          value={entry.address}
                        >
                          {entry.interfaceName} · {entry.address}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p
                    className="text-caption text-muted-foreground"
                    aria-live="polite"
                  >
                    {t('update.mobileEnvironmentAddressSelected', {
                      address: selectedAddress,
                    })}
                  </p>
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-md bg-background/70 px-3 py-2 text-body text-destructive">
                  <WifiOff className="mt-0.5 h-4 w-4 shrink-0" />
                  <p>{t('update.mobileEnvironmentNoAddress')}</p>
                </div>
              )}
            </div>
          ) : null}

          <div className="mx-auto flex min-h-72 w-72 items-center justify-center rounded-xl border border-border bg-white p-3">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt={t('update.mobileEnvironmentQrAlt')}
                className="h-full w-full"
              />
            ) : qrError ? (
              <p className="px-4 text-center text-body text-destructive">
                {t('update.mobileEnvironmentQrFailed')}
              </p>
            ) : !canGenerateQrCode ? (
              <p className="px-4 text-center text-body text-muted-foreground">
                {t('update.mobileEnvironmentQrUnavailable')}
              </p>
            ) : (
              <LoaderCircle className="h-6 w-6 animate-spin text-muted-foreground" />
            )}
          </div>

          <dl className="space-y-2 rounded-md bg-muted/30 p-3 text-caption">
            {Object.entries(effectiveConfig).map(([key, value]) => (
              <div
                key={key}
                className="grid grid-cols-[92px_minmax(0,1fr)] gap-2"
              >
                <dt className="text-muted-foreground">
                  {t(`update.mobileEnvironmentField.${key}`)}
                </dt>
                <dd className="break-all font-mono text-foreground/80">
                  {value}
                </dd>
              </div>
            ))}
          </dl>

          <p className="text-caption text-muted-foreground">
            {t('update.mobileEnvironmentReviewHint')}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

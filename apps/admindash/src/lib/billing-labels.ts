/** AdminDash 计费枚举中文展示（与 Electron settings.wallet.txType / 扣费状态对齐）。 */

export const WALLET_TX_TYPE_LABELS: Record<string, string> = {
  recharge: '充值',
  consume: '消费',
  grant: '赠送',
  expire: '过期',
  refund: '退款',
  freeze: '冻结',
  unfreeze: '解冻',
}

export const CASH_TX_TYPE_LABELS: Record<string, string> = {
  recharge: '充值',
  purchase_credit_package: '购买点券包',
  purchase_addon_package: '购买权益扩容包',
  llm_auto_topup: 'LLM 点券自动补充',
  membership_payment: '套餐订阅',
  membership_upgrade_payment: '套餐升级',
  membership_lifecycle_payment: '套餐续费/切换',
  refund: '退款',
  freeze: '冻结',
  unfreeze: '解冻',
  manual_adjust: '人工调整',
}

export const CHARGE_STATUS_LABELS: Record<string, string> = {
  pending: '待聚合',
  charged: '已扣费',
  aggregated: '已聚合扣款',
  failed: '扣费失败',
  released: '已释放',
  reversed: '已冲正',
  refunded: '已退款',
}

export const BIZ_TYPE_LABELS: Record<string, string> = {
  llm: 'LLM 调用',
  llm_call: 'LLM 调用',
  llm_chat: 'LLM 对话',
  charge_failed: '计费失败',
  charge_skipped: '跳过计费',
  membership_quota: '会员配额',
  embedding: '向量嵌入',
  tabmail: 'TabMail',
  tabdata: 'TabData',
  docparse: '文档解析',
  summarization: '摘要',
  memory_flush: '记忆刷新',
  structured_output: '结构化输出',
  storage: '存储',
  seed: '验收数据',
  'orchestration.web_search': '编排联网搜索',
  oss_upload: '对象存储上传',
  oss_async_upload: '对象存储异步上传',
  oss_staged_upload: '对象存储暂存上传',
  oss_url_upload: '对象存储 URL 上传',
  oss_batch_upload: '对象存储批量上传',
  oss_batch_url_upload: '对象存储批量 URL 上传',
  oss_instant_upload: '对象存储秒传',
  oss_instant_upload_batch: '对象存储批量秒传',
  oss_file_delete: '对象存储删除',
  oss_billing_compensation: '对象存储计费补偿',
  permanent_delete: '永久删除',
  trash: '移入回收站',
  restore: '从回收站恢复',
}

/** MeterPricing / 用量仪表盘计量键 */
export const METER_KEY_LABELS: Record<string, string> = {
  'llm.tokens': 'LLM Token',
  'llm.token': 'LLM Token',
  'storage.gb': '对象存储',
  'storage.gb_day': '对象存储（GB·天）',
  'storage.bytes': '对象存储（字节）',
  'storage.oss.bytes': '对象存储',
  'speech.asr.seconds': '语音识别',
  'speech.tts.characters': '语音合成',
  'media.image.count': '图片生成',
  'media.video.seconds': '视频生成',
  'media.bgm.seconds': '背景音乐生成',
  'rag.embedding.tokens': 'RAG 向量嵌入',
  'search.web.request': '联网搜索',
  'channel.message.count': '渠道消息',
  'notification.email.count': '邮件通知',
  'notification.sms.count': '短信通知',
}

export const BILLING_UNIT_LABELS: Record<string, string> = {
  request: '次',
  count: '次',
  token: 'token',
  tokens: 'token',
  second: '秒',
  seconds: '秒',
  character: '字符',
  characters: '字符',
  byte: '字节',
  bytes: '字节',
  gb: 'GB',
  gb_day: 'GB·天',
  'gb-day': 'GB·天',
  unit: '单位',
}

export const BILLING_CURRENCY_LABELS: Record<string, string> = {
  CREDITS: '点券',
  credits: '点券',
  CNY: '元',
  cny: '元',
  USD: '美元',
  usd: '美元',
}

export const BILLING_SCOPE_LABELS: Record<string, string> = {
  global: '全局',
  organization: '组织',
  workteam: '组织',
  user: '用户',
}

/** 与 OrganizationBillingPolicy.STORAGE_BILLING_MODE_CHOICES 对齐 */
export const STORAGE_BILLING_MODE_LABELS: Record<string, string> = {
  package_only: '仅套餐',
  paygo_only: '仅按量',
  package_plus_paygo: '套餐+按量',
}

/** PaymentOrder.order_type */
export const PAYMENT_ORDER_TYPE_LABELS: Record<string, string> = {
  membership: '套餐订阅',
  credits: '点券充值',
  storage_package: '存储包',
  billing_addon: '权益扩容包',
  cash_wallet: '现金钱包充值',
}

/** PaymentOrder.status */
export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: '待支付',
  paying: '支付中',
  paid: '已支付',
  cancelled: '已取消',
  expired: '已过期',
  failed: '支付失败',
  payment_failed: '支付失败',
  refunding: '退款中',
  refunded: '已退款',
  partially_refunded: '部分退款',
  closed: '已关闭',
  completed: '已完成',
}

/** PaymentOrder.payment_method */
export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  organization_wallet: '组织余额',
  alipay: '支付宝',
  wechat: '微信支付',
}

export function labelWalletTxType(value?: string | null): string {
  const key = (value || '').trim()
  if (!key) return '未知'
  return WALLET_TX_TYPE_LABELS[key] || key
}

export function labelCashTxType(value?: string | null): string {
  const key = (value || '').trim()
  if (!key) return '未知'
  return CASH_TX_TYPE_LABELS[key] || key
}

export function labelChargeStatus(value?: string | null): string {
  const key = (value || '').trim().toLowerCase()
  if (!key) return '未知'
  return CHARGE_STATUS_LABELS[key] || value || '未知'
}

export function labelBizType(value?: string | null): string {
  const key = (value || '').trim()
  if (!key) return '—'
  if (BIZ_TYPE_LABELS[key]) return BIZ_TYPE_LABELS[key]
  // 已是中文业务名（如「LLM 常用」）则原样展示；英文 key 做可读兜底。
  if (/[\u4e00-\u9fff]/.test(key)) return key
  const tail = key.split(/[._]/).filter(Boolean).pop() || key
  return `业务（${tail}）`
}

export function labelMeterKey(value?: string | null): string {
  const key = (value || '').trim()
  if (!key) return '—'
  if (METER_KEY_LABELS[key]) return METER_KEY_LABELS[key]
  const tail = key.split('.').filter(Boolean).pop() || key
  return `计量项（${tail}）`
}

export function labelBillingUnit(value?: string | null): string {
  const key = (value || '').trim()
  if (!key) return '—'
  return BILLING_UNIT_LABELS[key] || BILLING_UNIT_LABELS[key.toLowerCase()] || key
}

export function labelBillingCurrency(value?: string | null): string {
  const key = (value || '').trim()
  if (!key) return '点券'
  return BILLING_CURRENCY_LABELS[key] || BILLING_CURRENCY_LABELS[key.toUpperCase()] || key
}

export function labelBillingScope(value?: string | null): string {
  const key = (value || '').trim().toLowerCase()
  if (!key) return '—'
  return BILLING_SCOPE_LABELS[key] || value || '—'
}

export function labelStorageBillingMode(value?: string | null): string {
  const key = (value || '').trim()
  if (!key) return '—'
  return STORAGE_BILLING_MODE_LABELS[key] || key
}

function labelFromMap(
  map: Record<string, string>,
  value?: string | null,
  empty = '—'
): string {
  const key = (value || '').trim()
  if (!key) return empty
  return map[key] || key
}

export function labelPaymentOrderType(value?: string | null, empty = '—'): string {
  return labelFromMap(PAYMENT_ORDER_TYPE_LABELS, value, empty)
}

export function labelPaymentStatus(value?: string | null, empty = '—'): string {
  return labelFromMap(PAYMENT_STATUS_LABELS, value, empty)
}

export function labelPaymentMethod(value?: string | null, empty = '—'): string {
  return labelFromMap(PAYMENT_METHOD_LABELS, value, empty)
}

/** 单价展示：避免 0E-8，并中文化币种/单位 */
export function formatMeterUnitPrice(opts: {
  unitPrice?: string | number | null
  currency?: string | null
  unit?: string | null
}): string {
  const raw = opts.unitPrice
  let priceText = '—'
  if (raw != null && raw !== '') {
    const n = Number(raw)
    if (Number.isFinite(n)) {
      priceText = n.toLocaleString(undefined, {
        maximumFractionDigits: 8,
        minimumFractionDigits: 0,
      })
    } else {
      priceText = String(raw)
    }
  }
  return `${priceText} ${labelBillingCurrency(opts.currency)} / ${labelBillingUnit(opts.unit)}`
}

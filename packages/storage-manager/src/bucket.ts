/**
 * StorageBucket — TabTin 本地存储统一注册中心的核心类型。
 *
 * 设计意图：
 *   - 各业务模块（TabVideo / Conversation / Checkpoint / Browser / Skills 等）
 *     用统一的"桶"模型描述自己的本地存储资产，不必 UI 每个模块单独写适配器；
 *   - D-4 四档 Affordance（L1 一键清 / L2 半缓存提示 / L3 输入名字 / L4 高级警告）
 *     由 `category` + `requiresConfirmation` 决定 UI 走哪一档，**注册时由
 *     `assertValidBucket` 运行时强制校验**（cache→none / semi-cache→soft /
 *     data→soft|hard 且 warnings 必填非空），不允许 UI 端"按经验判断"。
 *     注：当前是运行时强制（register 阶段抛错），不是 TS 类型层强制——
 *     未来可考虑 discriminated union 改造，但会牺牲业务接入体验，
 *     v1 选择"运行时强制 + 充分单测覆盖"的折中方案；
 *   - 所有 IO 由调用方实现，本包只是注册中心 + 度量聚合 + UI 协议。
 *
 */

// ── 三色分类（D-4 的语义骨架） ──────────────────────────────────

/**
 * 存储类别——决定 UI 走哪一档清理 Affordance：
 *   - `cache`      → L1 一键清，无确认（绿色）
 *   - `semi-cache` → L2 弹"会变慢"提示（黄色）
 *   - `data`       → L3/L4 输入 bucket 名二次确认（红色）
 */
export type BucketCategory = 'cache' | 'semi-cache' | 'data'

/**
 * 用户视角分组——UI 在「我的资产」/「缓存」/「高级」tab 内按 group 聚合卡片。
 *
 * 8 类覆盖 RFC §4.3 信息架构枚举的全部分组：登录/对话/Checkpoint/业务 App/
 * 浏览器/媒体/缓存/系统。新增 group 必须先在 RFC 立项再加。
 */
export type BucketGroup =
  | 'login' // 登录与账号（高级 tab）
  | 'conversation' // 对话历史
  | 'checkpoint' // Agent 撤销快照
  | 'business-app' // 业务 App 数据（TabVideo / TabDoc / TabSlide / TabWhiteboard / Skills 等）
  | 'browser' // 浏览器内嵌环境（partition / cookies / bookmarks / history）
  | 'media' // 媒体与下载（screenshots / recordings / downloads）
  | 'cache' // 纯缓存（HTTP / GPU / Code / 临时中转）
  | 'system' // 系统服务（device-fingerprint / audit / keychain，高级 tab）

/**
 * 二次确认强度——对应 D-4 的四档 Affordance：
 *   - `none` → L1，cache 一键清，不弹任何对话框
 *   - `soft` → L2，semi-cache 弹"会变慢"提示
 *   - `hard` → L3/L4，data 必须输入 bucket 的 displayName 才能确认
 *
 * 强约束（assertValidBucket 校验）：
 *   - `category === 'data'` 时 `requiresConfirmation` 必须为 `'hard'` 或 `'soft'`
 *   - `category === 'cache'` 时 `requiresConfirmation` 必须为 `'none'`
 *   - `category === 'semi-cache'` 时 `requiresConfirmation` 必须为 `'soft'`
 */
export type ConfirmationLevel = 'none' | 'soft' | 'hard'

// ── 数据结构 ─────────────────────────────────────────────────────

/**
 * Bucket 子项——`listFn` 返回的元素，UI 用来展示"这个桶里有哪些条目"
 * 并支持部分清理（`clearFn({ itemIds: [...] })`）。
 */
export interface BucketItem {
  /** 子项稳定 id，clearFn 通过 `itemIds` 引用 */
  id: string
  /** 用户可读标签（通常是项目名 / session 名 / 文件名） */
  label: string
  /** 单条容量；某些列表（如对话条数）可不报 bytes 只报 count */
  bytes?: number
  /** 任意附加元信息，UI 自行决定是否展示（如 lastActiveAt / itemCount） */
  metadata?: Record<string, unknown>
}

/** `clearFn` 选项 */
export interface ClearOptions {
  /**
   * 部分清理时指定的子项 id 列表。
   * `undefined` → 全清；空数组 `[]` → no-op（用于 dryRun 边界）。
   */
  itemIds?: string[]
  /**
   * 只算不删，让 UI 在"输入名字确认"对话框预览将释放多少空间。
   * 实现端拿到 `dryRun: true` 必须返回真实预估，不可改变磁盘状态。
   */
  dryRun?: boolean
}

/** `clearFn` 结果 */
export interface ClearResult {
  /** 实际清掉/将清掉（dryRun 时）的条目数 */
  clearedItemCount: number
  /** 实际释放/将释放（dryRun 时）的字节数 */
  freedBytes: number
  /** 部分失败时的错误说明，UI 把这些拼接展示给用户 */
  errors?: string[]
}

/** `sizeFn` 结果 */
export interface BucketSize {
  bytes: number
  /** 子项个数；某些桶（如单文件 audit log）只有 bytes 没 itemCount */
  itemCount?: number
}

/** `exportFn` 结果——导出原始负载（IPC 跨界时由 ipc-bridge 转 base64） */
export interface ExportResult {
  /** 建议的下载文件名（含扩展名） */
  filename: string
  /** 数据负载：渲染进程产物可能是 Blob，主进程通常是 string/Buffer */
  data: Blob | string | Uint8Array
  /** MIME 类型，UI 触发下载时用 */
  mimeType: string
}

/**
 * 存储桶——一个业务模块向注册中心暴露其本地存储资产的描述符。
 *
 * 完整语义：
 *   - **必填**：`id` / `category` / `group` / `displayName` / `description` / `sizeFn`
 *   - **推荐**：`listFn`（子项展示）、`clearFn`（清理）
 *   - **可选**：`exportFn`（仅 5 个核心资产 v1 必须实现 — voice/bookmarks/草稿/Checkpoint 摘要/对话摘要）
 *   - **UI 控制**：`warnings`（data 类必填）/ `requiresConfirmation` / `hideFromList`
 */
export interface StorageBucket {
  /** 全局唯一 id，建议 `'<domain>:<name>'`，如 `'tabvideo:projects'` / `'browser:bookmarks'` */
  id: string

  category: BucketCategory
  group: BucketGroup

  /** 用户看的中文名（如「TabVideo 项目」） */
  displayName: string
  /** 一句话用户级说明，UI 在卡片副标题展示（不超过 80 字） */
  description: string

  // ── 必填能力 ────────────────────────────────────────────────────
  /** 容量与子项数量。UI 进入 tab 时批量调用，必须实现。 */
  sizeFn: () => Promise<BucketSize>

  // ── 可选能力 ────────────────────────────────────────────────────
  /** 列出子项详情（用于"展开看看里面有什么"） */
  listFn?: () => Promise<BucketItem[]>
  /** 清理（全量或部分） */
  clearFn?: (options?: ClearOptions) => Promise<ClearResult>
  /** 导出为 JSON / 文件（v1 仅 5 个核心资产实现） */
  exportFn?: () => Promise<ExportResult>

  // ── UI 控制 ────────────────────────────────────────────────────
  /**
   * 清理前向用户展示的警告文案数组（UI 按列表渲染）。
   * **强约束**：`category === 'data'` 时必须非空，描述清后会丢什么。
   */
  warnings?: string[]
  /**
   * 二次确认强度。不指定时按 category 推导默认值（cache→none / semi-cache→soft / data→hard）。
   * 显式指定的值如违反类别约束会被 `assertValidBucket` 拒绝。
   */
  requiresConfirmation?: ConfirmationLevel
  /**
   * 默认 `false`。`true` 时仅在「高级」tab 可见——用于
   * 重置设备身份 / 系统级敏感桶。
   */
  hideFromList?: boolean
}

// ── 校验 ────────────────────────────────────────────────────────

/**
 * 注册阶段抛出的校验错误，包含 bucket id + field 便于定位。
 */
export class InvalidBucketError extends Error {
  public readonly bucketId: string
  public readonly field: string
  constructor(bucketId: string, field: string, reason: string) {
    super(
      `[storage-manager] invalid bucket "${bucketId}": field "${field}" — ${reason}`,
    )
    this.name = 'InvalidBucketError'
    this.bucketId = bucketId
    this.field = field
  }
}

const VALID_CATEGORIES: ReadonlySet<BucketCategory> = new Set([
  'cache',
  'semi-cache',
  'data',
])

const VALID_GROUPS: ReadonlySet<BucketGroup> = new Set([
  'login',
  'conversation',
  'checkpoint',
  'business-app',
  'browser',
  'media',
  'cache',
  'system',
])

const VALID_CONFIRMATIONS: ReadonlySet<ConfirmationLevel> = new Set([
  'none',
  'soft',
  'hard',
])

/**
 * 推导 `requiresConfirmation` 的默认值——按 category 强映射。
 * registerStorageBucket 内部会用此函数补全用户未指定的字段，
 * 与 `assertValidBucket` 约束保持一致。
 */
export function defaultConfirmationFor(
  category: BucketCategory,
): ConfirmationLevel {
  switch (category) {
    case 'cache':
      return 'none'
    case 'semi-cache':
      return 'soft'
    case 'data':
      return 'hard'
  }
}

/**
 * 校验 bucket 必填字段 + 业务约束。校验失败抛 `InvalidBucketError`。
 *
 * 业务约束（D-4 四档 Affordance 在类型层的强制表达）：
 *   1. id / displayName / description 非空字符串
 *   2. category / group / requiresConfirmation 取值在合法集
 *   3. sizeFn 必须是函数
 *   4. category === 'data' 时 warnings 必须非空数组
 *   5. requiresConfirmation 与 category 必须匹配（除非未指定，未指定按默认推导）
 */
export function assertValidBucket(
  bucket: StorageBucket,
): asserts bucket is StorageBucket {
  if (!bucket || typeof bucket !== 'object') {
    throw new InvalidBucketError('<unknown>', '<root>', 'bucket 必须是对象')
  }

  // id
  if (typeof bucket.id !== 'string' || bucket.id.trim() === '') {
    throw new InvalidBucketError(
      String(bucket.id ?? '<missing>'),
      'id',
      'id 必须是非空字符串',
    )
  }

  // category / group
  if (!VALID_CATEGORIES.has(bucket.category)) {
    throw new InvalidBucketError(
      bucket.id,
      'category',
      `category 必须是 'cache' | 'semi-cache' | 'data'，收到 ${JSON.stringify(bucket.category)}`,
    )
  }
  if (!VALID_GROUPS.has(bucket.group)) {
    throw new InvalidBucketError(
      bucket.id,
      'group',
      `group 必须是 8 个预定义分组之一，收到 ${JSON.stringify(bucket.group)}`,
    )
  }

  // displayName / description
  if (
    typeof bucket.displayName !== 'string' ||
    bucket.displayName.trim() === ''
  ) {
    throw new InvalidBucketError(
      bucket.id,
      'displayName',
      'displayName 必须是非空字符串（用户看的中文名）',
    )
  }
  if (
    typeof bucket.description !== 'string' ||
    bucket.description.trim() === ''
  ) {
    throw new InvalidBucketError(
      bucket.id,
      'description',
      'description 必须是非空字符串（一句话用户级说明）',
    )
  }

  // sizeFn 必填
  if (typeof bucket.sizeFn !== 'function') {
    throw new InvalidBucketError(
      bucket.id,
      'sizeFn',
      'sizeFn 必填，签名 () => Promise<{ bytes; itemCount? }>',
    )
  }

  // 可选能力的类型校验（提供时必须是函数，避免传错对象）
  if (bucket.listFn !== undefined && typeof bucket.listFn !== 'function') {
    throw new InvalidBucketError(bucket.id, 'listFn', 'listFn 必须是函数或 undefined')
  }
  if (bucket.clearFn !== undefined && typeof bucket.clearFn !== 'function') {
    throw new InvalidBucketError(bucket.id, 'clearFn', 'clearFn 必须是函数或 undefined')
  }
  if (bucket.exportFn !== undefined && typeof bucket.exportFn !== 'function') {
    throw new InvalidBucketError(bucket.id, 'exportFn', 'exportFn 必须是函数或 undefined')
  }

  // requiresConfirmation 取值
  if (
    bucket.requiresConfirmation !== undefined &&
    !VALID_CONFIRMATIONS.has(bucket.requiresConfirmation)
  ) {
    throw new InvalidBucketError(
      bucket.id,
      'requiresConfirmation',
      `requiresConfirmation 必须是 'none' | 'soft' | 'hard'，收到 ${JSON.stringify(
        bucket.requiresConfirmation,
      )}`,
    )
  }

  // data 类强约束：warnings 必填非空
  if (bucket.category === 'data') {
    if (
      !Array.isArray(bucket.warnings) ||
      bucket.warnings.length === 0 ||
      bucket.warnings.some((w) => typeof w !== 'string' || w.trim() === '')
    ) {
      throw new InvalidBucketError(
        bucket.id,
        'warnings',
        'data 类 bucket 必须提供非空 warnings 数组（描述清后会丢什么）',
      )
    }
  } else if (bucket.warnings !== undefined) {
    if (
      !Array.isArray(bucket.warnings) ||
      bucket.warnings.some((w) => typeof w !== 'string')
    ) {
      throw new InvalidBucketError(
        bucket.id,
        'warnings',
        'warnings 必须是字符串数组',
      )
    }
  }

  // category 与 requiresConfirmation 一致性：
  //   - cache 必须 'none'
  //   - semi-cache 必须 'soft'
  //   - data 必须 'soft' | 'hard'（不允许 'none'）
  const effective =
    bucket.requiresConfirmation ?? defaultConfirmationFor(bucket.category)
  if (bucket.category === 'cache' && effective !== 'none') {
    throw new InvalidBucketError(
      bucket.id,
      'requiresConfirmation',
      `cache 类必须 requiresConfirmation === 'none'（一键清，无确认），收到 '${effective}'`,
    )
  }
  if (bucket.category === 'semi-cache' && effective !== 'soft') {
    throw new InvalidBucketError(
      bucket.id,
      'requiresConfirmation',
      `semi-cache 类必须 requiresConfirmation === 'soft'，收到 '${effective}'`,
    )
  }
  if (bucket.category === 'data' && effective === 'none') {
    throw new InvalidBucketError(
      bucket.id,
      'requiresConfirmation',
      `data 类不允许 requiresConfirmation === 'none'，必须 'soft' 或 'hard'`,
    )
  }
}

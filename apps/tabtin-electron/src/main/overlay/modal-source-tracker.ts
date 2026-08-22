export type ModalSource =
  | 'global-search'
  | 'confirm'
  | 'update-prompt'
  | 'notification'
  | 'save-password'
  | 'autofill-suggest'

/**
 * 非阻塞「提示」型 source：浮层只覆盖卡片本身那一小块（贴角小窗），卡片以外的
 * 屏幕不被覆盖，底层网页照常可点/可输入；窗口本身始终捕获点击（走确认框那条
 * 验证过的可靠路径），不做鼠标穿透。目前仅自动填充建议。
 *
 * 其余 source（confirm / global-search / save-password / update-prompt /
 * notification）都是阻塞型 modal —— 全屏铺满 + 抢焦点，符合「必须先处理」语义。
 */
const HINT_SOURCES = new Set<ModalSource>(['autofill-suggest'])

type ModalVisibilityDriver = {
  /** compact=true 提示型贴角小窗（不抢焦点）；false 阻塞型全屏（抢焦点）。 */
  show: (compact: boolean) => void
  hide: () => void
}

export function createModalSourceTracker(driver: ModalVisibilityDriver) {
  const openSources = new Set<ModalSource>()

  // 当前打开的 source 是否「全是提示型」（没有任何阻塞型 modal 在开）。
  const isHintOnly = () =>
    openSources.size > 0 && [...openSources].every((s) => HINT_SOURCES.has(s))

  // 记录当前 driver 已呈现的形态：null=隐藏，true=贴角小窗，false=全屏。
  // 只在形态真正变化时才驱动 show/hide，避免同形态下重复升起（抢焦点/闪烁）。
  let shownCompact: boolean | null = null

  const syncVisibility = () => {
    if (openSources.size === 0) {
      if (shownCompact !== null) {
        driver.hide()
        shownCompact = null
      }
      return
    }
    // 只有提示型 → 贴角小窗；一旦有阻塞型 modal → 全屏。
    const compact = isHintOnly()
    if (shownCompact !== compact) {
      driver.show(compact)
      shownCompact = compact
    }
  }

  return {
    setOpen(source: ModalSource, open: boolean): void {
      if (open) openSources.add(source)
      else openSources.delete(source)
      syncVisibility()
    },

    isOpen(source: ModalSource): boolean {
      return openSources.has(source)
    },
  }
}

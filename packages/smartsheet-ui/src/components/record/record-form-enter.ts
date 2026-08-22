/**
 * 记录表单 Enter 快捷提交白名单：
 * 若焦点在会自行处理 Enter 的控件（含 cmdk 可搜索选项），则勿 requestSubmit。
 */

const CMDK_ENTER_SELECTOR = [
  '[cmdk-input-wrapper]',
  '[cmdk-item]',
  '[cmdk-input]',
].join(', ')

export function shouldRecordFormDeferEnter(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false

  const tagName = target.tagName.toLowerCase()
  const role = target.getAttribute('role')
  const inputType = target instanceof HTMLInputElement ? target.type : ''

  return (
    tagName === 'textarea' ||
    target.isContentEditable ||
    tagName === 'button' ||
    tagName === 'select' ||
    inputType === 'submit' ||
    inputType === 'button' ||
    role === 'button' ||
    role === 'option' ||
    role === 'listbox' ||
    role === 'menuitem' ||
    Boolean(target.closest(CMDK_ENTER_SELECTOR)) ||
    target.hasAttribute('cmdk-input')
  )
}

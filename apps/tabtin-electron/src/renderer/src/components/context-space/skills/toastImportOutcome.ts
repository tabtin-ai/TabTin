/**
 * 导入结果 toast：同源复用 vs 新导入。
 * 后端 already_exists 时必须提示「已存在」，不能再报「导入成功」。
 */

export type ImportOutcomeKind = 'already_exists' | 'success'

export function resolveImportOutcomeKind(alreadyExists: boolean): ImportOutcomeKind {
  return alreadyExists ? 'already_exists' : 'success'
}

/** 任一项带 already_exists 即视为幂等复用（npm 多 skill 包同口径）。 */
export function anyImportedAlreadyExists(
  items: Array<{ already_exists?: boolean } | null | undefined>,
): boolean {
  return items.some((item) => Boolean(item?.already_exists))
}

type ToastLike = {
  info: (message: string) => void
  success: (message: string) => void
}

type Translate = (key: string) => string

export function toastImportOutcome(
  toastApi: ToastLike,
  t: Translate,
  alreadyExists: boolean,
): void {
  if (resolveImportOutcomeKind(alreadyExists) === 'already_exists') {
    toastApi.info(t('skills.importAlreadyExists'))
    return
  }
  toastApi.success(t('skills.importSuccess'))
}

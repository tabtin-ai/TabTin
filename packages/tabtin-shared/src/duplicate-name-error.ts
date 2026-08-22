export const DUPLICATE_NAME_ERROR_TITLE = '已有同名文件存在，请重新命名'

export function isDuplicateNameErrorMessage(message: string | undefined): boolean {
  return /已存在名为|同名|duplicate|already exists/i.test(message ?? '')
}

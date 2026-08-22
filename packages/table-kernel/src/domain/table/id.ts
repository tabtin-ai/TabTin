import { generateUuid } from '../shared/id.js'

export function generateTableId(): string {
  return `tbl_${generateUuid()}`
}

import { generateUuid } from '../shared/id.js'

export function generateFieldId(): string {
  return `fld_${generateUuid()}`
}

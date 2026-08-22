import { generateUuid } from '../shared/id.js'

export function generateViewId(): string {
  return `viw_${generateUuid()}`
}

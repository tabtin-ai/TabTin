import { generateUuid } from '../shared/id.js'

export { generateEventId, generateChangeId } from '../shared/id.js'

export function generateRecordId(): string {
  return generateUuid()
}

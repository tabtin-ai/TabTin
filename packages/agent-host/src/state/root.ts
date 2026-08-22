import { AttributionStore } from './attribution/attribution-store.js'
import { CatalogStore } from './catalog/catalog-store.js'
import { ConversationStore } from './conversation/conversation-store.js'
import { DeliveryStore } from './delivery/delivery-store.js'
import { DeviceIdentityStore } from './device-identity/device-identity-store.js'
import { HitlStore } from './hitl/hitl-store.js'
import { LeaseStore } from './lease/lease-store.js'
import { ModelPrefsStore } from './model/model-prefs-store.js'
import { OwnerStore } from './owner/owner-store.js'
import { PrewarmScheduler } from './prewarm/prewarm-scheduler.js'
import { SessionStore } from './session/session-store.js'
import { SkillsStore } from './skills/skills-store.js'
import { HostTurnStore } from './turn/host-turn-store.js'

export type StateRootOptions = {
  owner?: OwnerStore
  turn?: HostTurnStore
  conversation?: ConversationStore
  session?: SessionStore
  delivery?: DeliveryStore
  deviceIdentity?: DeviceIdentityStore
  hitl?: HitlStore
  skills?: SkillsStore
  catalog?: CatalogStore
  prewarm?: PrewarmScheduler
  attribution?: AttributionStore
  model?: ModelPrefsStore
  lease?: LeaseStore
}

/**
 * 可实例化的宿主权威状态根。
 */
export class StateRoot {
  readonly owner: OwnerStore
  readonly turn: HostTurnStore
  readonly conversation: ConversationStore
  readonly session: SessionStore
  readonly delivery: DeliveryStore
  readonly deviceIdentity: DeviceIdentityStore
  readonly hitl: HitlStore
  readonly skills: SkillsStore | undefined
  readonly catalog: CatalogStore
  readonly prewarm: PrewarmScheduler
  readonly attribution: AttributionStore
  readonly model: ModelPrefsStore
  readonly lease: LeaseStore

  constructor(options: StateRootOptions = {}) {
    this.owner = options.owner ?? new OwnerStore()
    this.turn = options.turn ?? new HostTurnStore()
    this.conversation = options.conversation ?? new ConversationStore()
    this.session = options.session ?? new SessionStore()
    this.delivery = options.delivery ?? new DeliveryStore()
    this.deviceIdentity = options.deviceIdentity ?? new DeviceIdentityStore()
    this.hitl = options.hitl ?? new HitlStore()
    this.skills = options.skills
    this.catalog = options.catalog ?? new CatalogStore()
    this.prewarm = options.prewarm ?? new PrewarmScheduler()
    this.attribution = options.attribution ?? new AttributionStore()
    this.model = options.model ?? new ModelPrefsStore()
    this.lease = options.lease ?? new LeaseStore()
  }
}

export function createStateRoot(options?: StateRootOptions): StateRoot {
  return new StateRoot(options)
}

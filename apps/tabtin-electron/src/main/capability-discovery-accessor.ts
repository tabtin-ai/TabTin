import type { CapabilityDiscoveryService } from './services/CapabilityDiscoveryService'
import { createLazyAccessor } from './utils/lazy'

const accessor = createLazyAccessor<CapabilityDiscoveryService>('CapabilityDiscoveryService')

export const getCapabilityDiscoveryService = accessor.get
export const setCapabilityDiscoveryService = accessor.set

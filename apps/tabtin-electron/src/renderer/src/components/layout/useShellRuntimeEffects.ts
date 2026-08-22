import { useConnectionRecovery } from '@/hooks/useConnectionRecovery'
import { useSystemSleepRecovery } from '@/hooks/useSystemSleepRecovery'
import { useCentrifugoClient } from '@/hooks/useCentrifugoClient'
import { useAgentTerminalSync } from '@/hooks/useAgentTerminalSync'
import { useTinsAgentHandler } from '@/hooks/useTinsAgentHandler'
import { useIMProviderClient } from '@/hooks/useIMProviderClient'

export function useShellRuntimeEffects(): void {
  useConnectionRecovery()
  useSystemSleepRecovery()
  useCentrifugoClient()
  useIMProviderClient()
  useAgentTerminalSync()
  useTinsAgentHandler()
}

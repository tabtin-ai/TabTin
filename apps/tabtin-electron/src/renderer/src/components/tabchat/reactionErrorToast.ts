import i18n from '@/i18n'
import { toast } from '@components/ui'

export function showReactionErrorToast(_error: unknown): void {
  toast({ title: i18n.t('tabchat:reactionFailed'), variant: 'destructive' })
}

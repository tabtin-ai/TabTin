import React from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@components/ui'
import type { PendingInvitation } from '@/services/invitationApi'
import { Building2, Users, Shield, Clock, User, ChevronRight } from 'lucide-react'

interface Props {
  invitations: PendingInvitation[]
  onSelect: (invitation: PendingInvitation) => void
  onClose: () => void
}

export const InvitationListDialog: React.FC<Props> = ({ invitations, onSelect, onClose }) => {
  const { t } = useTranslation(['workspace', 'common'])

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="w-[440px] max-w-[440px]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Users className="h-5 w-5 text-primary" />
            </div>
            <div>
              <DialogTitle className="text-subtitle font-semibold text-foreground">
                {t('invitationList.title')}
              </DialogTitle>
              <DialogDescription className="text-caption text-muted-foreground/60">
                {t('invitationList.description', { count: invitations.length })}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto -mx-6 px-6 space-y-2">
          {invitations.map((invitation) => (
            <button
              key={invitation.id}
              type="button"
              onClick={() => onSelect(invitation)}
              className="w-full text-left rounded-lg border border-border/60 hover:border-primary/30 hover:bg-muted/30 p-3 transition-all group"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
                    <span className="text-body font-medium text-foreground truncate">
                      {invitation.organization_name}
                    </span>
                  </div>

                  <div className="flex items-center gap-3 text-caption text-muted-foreground/80">
                    {invitation.invited_by_name && (
                      <span className="flex items-center gap-1">
                        <User className="h-3 w-3" />
                        {t('invitationList.from', { name: invitation.invited_by_name })}
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Shield className="h-3 w-3" />
                      {t(`members.roles.${invitation.role}`)}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 text-caption text-muted-foreground/60">
                    <Clock className="h-3 w-3" />
                    <span>{new Date(invitation.expires_at).toLocaleString()}</span>
                  </div>
                </div>

                <ChevronRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-primary mt-1 transition-colors" />
              </div>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

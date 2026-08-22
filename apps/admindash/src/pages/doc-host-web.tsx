import { DocHostWebModule } from '@/doc-host/DocHostWebModule'
import { buildDocHostRoutePath } from '@/doc-host/constants'
import { useLocation, useNavigate, useParams } from 'react-router-dom'

export function DocHostWebPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { organizationId, spaceId } = useParams<{
    organizationId?: string
    spaceId?: string
  }>()

  const handleNavigateToContext = (nextOrganizationId: string, nextSpaceId: string) => {
    const nextPath = buildDocHostRoutePath(nextOrganizationId, nextSpaceId)
    if (location.pathname !== nextPath) {
      navigate(nextPath)
    }
  }

  const handleNavigateToLogin = (fromPathname: string) => {
    navigate('/login', {
      state: { from: { pathname: fromPathname || location.pathname } },
    })
  }

  return (
    <DocHostWebModule
      organizationId={organizationId}
      spaceId={spaceId}
      currentPathname={location.pathname}
      onNavigateToContext={handleNavigateToContext}
      onNavigateToLogin={handleNavigateToLogin}
    />
  )
}

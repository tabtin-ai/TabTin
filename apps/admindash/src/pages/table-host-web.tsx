import { TableHostWebModule } from '@/table-host/TableHostWebModule'
import { buildTableHostRoutePath } from '@/table-host/constants'
import { useLocation, useNavigate, useParams } from 'react-router-dom'

export function TableHostWebPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { organizationId, spaceId } = useParams<{
    organizationId?: string
    spaceId?: string
  }>()

  const handleNavigateToContext = (nextOrganizationId: string, nextSpaceId: string) => {
    const nextPath = buildTableHostRoutePath(nextOrganizationId, nextSpaceId)
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
    <TableHostWebModule
      organizationId={organizationId}
      spaceId={spaceId}
      currentPathname={location.pathname}
      onNavigateToContext={handleNavigateToContext}
      onNavigateToLogin={handleNavigateToLogin}
    />
  )
}

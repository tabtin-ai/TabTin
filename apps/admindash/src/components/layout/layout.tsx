import { Outlet } from 'react-router-dom'
import { Sidebar } from './sidebar'

export function Layout() {
  return (
    <div className="flex h-screen w-full overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}

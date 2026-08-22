import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useAuthStore } from '@/stores/auth-store'
import '@/stores/ui-store'
import './i18n'
import './styles/globals.css'
import '@tabtin/smartsheet-ui/styles'
import { ensureWebTableRuntimeConfigured } from '@/features/table/bootstrap'
import { initAppShellForWeb } from '@/adapters/app-shell-init'

initAppShellForWeb()
ensureWebTableRuntimeConfigured()
useAuthStore.getState().initAuth()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

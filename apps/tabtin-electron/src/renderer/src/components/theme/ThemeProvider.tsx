import * as React from 'react'

interface ThemeProviderProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode
}

export function ThemeProvider({
  children,
  ...props
}: ThemeProviderProps) {
  return (
    <div {...props}>
      {children}
    </div>
  )
}

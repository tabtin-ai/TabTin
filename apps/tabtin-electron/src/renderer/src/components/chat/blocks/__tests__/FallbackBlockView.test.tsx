import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { FallbackBlockView } from '../FallbackBlockView'

describe('FallbackBlockView', () => {
  it('renders unsupported message for unknown type', () => {
    render(<FallbackBlockView blockType="code_artifact_v3" />)
    expect(screen.getByTestId('block-fallback')).toBeTruthy()
    expect(screen.getByText('blockTimeline.fallback.unsupported')).toBeTruthy()
    expect(screen.getByText(/code_artifact_v3/)).toBeTruthy()
  })

  it('renders summary text when provided', () => {
    render(<FallbackBlockView blockType="future_block" summary="This is a future feature" />)
    expect(screen.getByText('This is a future feature')).toBeTruthy()
  })

  it('renders error message from ErrorBoundary', () => {
    render(<FallbackBlockView error="render-error" />)
    expect(screen.getByText(/render-error/)).toBeTruthy()
  })

  it('extracts blockType from entry prop (dispatcher compatibility)', () => {
    render(<FallbackBlockView entry={{ block: { type: 'holographic_v4', summary: 'Holo content' } }} />)
    expect(screen.getByText(/holographic_v4/)).toBeTruthy()
    expect(screen.getByText('Holo content')).toBeTruthy()
  })

  it('renders gracefully with no props at all', () => {
    render(<FallbackBlockView />)
    expect(screen.getByTestId('block-fallback')).toBeTruthy()
  })
})

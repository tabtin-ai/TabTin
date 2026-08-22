import { describe, expect, it, vi } from 'vitest'
import { createOAuthAuthorizeUrlParser } from '../mcp-oauth-url'

describe('createOAuthAuthorizeUrlParser', () => {
  it('emits the authorize URL after the visiting prompt line', () => {
    const onUrl = vi.fn()
    const parse = createOAuthAuthorizeUrlParser(onUrl)
    parse('[123] Discovering OAuth server configuration...')
    parse('Please authorize this client by visiting:')
    parse('https://access.stripe.com/mcp/oauth2/authorize?response_type=code&scope=mcp')
    parse('Browser opened automatically.')
    expect(onUrl).toHaveBeenCalledTimes(1)
    expect(onUrl).toHaveBeenCalledWith(
      'https://access.stripe.com/mcp/oauth2/authorize?response_type=code&scope=mcp',
    )
  })

  it('ignores later urls after the first authorize url', () => {
    const onUrl = vi.fn()
    const parse = createOAuthAuthorizeUrlParser(onUrl)
    parse('Please authorize this client by visiting:')
    parse('https://example.com/first')
    parse('https://example.com/second')
    expect(onUrl).toHaveBeenCalledTimes(1)
    expect(onUrl).toHaveBeenCalledWith('https://example.com/first')
  })

  it('opens when authorize URL shares the prompt line', () => {
    const onUrl = vi.fn()
    const parse = createOAuthAuthorizeUrlParser(onUrl)
    parse(
      'Please authorize this client by visiting: https://access.stripe.com/mcp/oauth2/authorize?scope=mcp',
    )
    expect(onUrl).toHaveBeenCalledTimes(1)
    expect(onUrl).toHaveBeenCalledWith(
      'https://access.stripe.com/mcp/oauth2/authorize?scope=mcp',
    )
  })

  it('opens on a lone oauth2/authorize URL without the prompt line', () => {
    const onUrl = vi.fn()
    const parse = createOAuthAuthorizeUrlParser(onUrl)
    parse(
      '[6065] https://access.stripe.com/mcp/oauth2/authorize?response_type=code&scope=mcp',
    )
    expect(onUrl).toHaveBeenCalledWith(
      'https://access.stripe.com/mcp/oauth2/authorize?response_type=code&scope=mcp',
    )
  })
})

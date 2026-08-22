import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchDeviceActionRequest } from './action-request-dispatch'

const payload = { action: 'login_relay.import' }
const envelope = { thread_id: 'thread-1' }

describe('dispatchDeviceActionRequest', () => {
  const handleRollback = vi.fn()
  const handleLoginRelayImport = vi.fn()
  const handleMcp = vi.fn()
  const handleFile = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    handleRollback.mockResolvedValue(false)
    handleLoginRelayImport.mockResolvedValue(false)
    handleMcp.mockResolvedValue(false)
    handleFile.mockResolvedValue(false)
  })

  it('stops after rollback handles the action', async () => {
    handleRollback.mockResolvedValueOnce(true)

    await dispatchDeviceActionRequest(payload, envelope, {
      handleRollback,
      handleLoginRelayImport,
      handleMcp,
      handleFile,
    })

    expect(handleLoginRelayImport).not.toHaveBeenCalled()
    expect(handleFile).not.toHaveBeenCalled()
  })

  it('stops after login relay handles the action', async () => {
    handleLoginRelayImport.mockResolvedValueOnce(true)

    await dispatchDeviceActionRequest(payload, envelope, {
      handleRollback,
      handleLoginRelayImport,
      handleMcp,
      handleFile,
    })

    expect(handleRollback).toHaveBeenCalledWith(payload, envelope)
    expect(handleLoginRelayImport).toHaveBeenCalledWith(payload, envelope)
    expect(handleFile).not.toHaveBeenCalled()
  })

  it('falls back to file only when rollback, relay, and MCP all decline', async () => {
    await dispatchDeviceActionRequest(payload, envelope, {
      handleRollback,
      handleLoginRelayImport,
      handleMcp,
      handleFile,
    })

    expect(handleFile).toHaveBeenCalledWith(payload, envelope)
  })

  it('keeps the target branch MCP action handler in the dispatch chain', async () => {
    handleMcp.mockResolvedValueOnce(true)

    await dispatchDeviceActionRequest(payload, envelope, {
      handleRollback,
      handleLoginRelayImport,
      handleMcp,
      handleFile,
    })

    expect(handleFile).not.toHaveBeenCalled()
  })

  it.each([
    ['rollback', handleRollback],
    ['relay', handleLoginRelayImport],
  ])('propagates a %s handler error without falling back', async (_name, failingHandler) => {
    failingHandler.mockRejectedValueOnce(new Error('handler failed'))

    await expect(dispatchDeviceActionRequest(payload, envelope, {
      handleRollback,
      handleLoginRelayImport,
      handleMcp,
      handleFile,
    })).rejects.toThrow('handler failed')
    expect(handleFile).not.toHaveBeenCalled()
  })
})

import type { EditorState } from '@tiptap/pm/state'
import * as Y from 'yjs'

/**
 * 可选 Yjs 相对位置编解码。
 * 协作宿主在 Y.Doc 就绪后用 createYjsCodecFromModule(import('y-prosemirror')) 注入；
 * 缺省为 null（跳过 Yjs 策略，回退 blockId/上下文）。
 */
export interface CommentYjsCodec {
  encode(pmPos: number, state: EditorState): string | null
  decode(encoded: string, state: EditorState): number | null
}

export type YProsemirrorModule = {
  ySyncPluginKey: { getState: (state: EditorState) => any }
  absolutePositionToRelativePosition: (
    pos: number,
    type: any,
    mapping: any,
  ) => Y.RelativePosition
  relativePositionToAbsolutePosition: (
    ydoc: Y.Doc,
    type: any,
    relPos: Y.RelativePosition,
    mapping: any,
  ) => number | null
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!)
  if (typeof btoa === 'function') return btoa(binary)
  return Buffer.from(bytes).toString('base64')
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  }
  return new Uint8Array(Buffer.from(value, 'base64'))
}

function getYSyncBinding(state: EditorState, mod: YProsemirrorModule) {
  const ystate = mod.ySyncPluginKey.getState(state)
  if (!ystate?.type || !ystate?.binding?.mapping || !ystate?.doc) return null
  return ystate as { type: any; binding: { mapping: any }; doc: Y.Doc }
}

/** 用已解析的 y-prosemirror 模块构造 codec（推荐：协作扩展挂载后调用一次并缓存）。 */
export function createYjsCodecFromModule(mod: YProsemirrorModule): CommentYjsCodec {
  return {
    encode(pmPos, state) {
      const ystate = getYSyncBinding(state, mod)
      if (!ystate) return null
      try {
        const rel = mod.absolutePositionToRelativePosition(
          pmPos,
          ystate.type,
          ystate.binding.mapping,
        )
        return bytesToBase64(Y.encodeRelativePosition(rel))
      } catch {
        return null
      }
    },
    decode(encoded, state) {
      if (!encoded) return null
      const ystate = getYSyncBinding(state, mod)
      if (!ystate) return null
      try {
        const rel = Y.decodeRelativePosition(base64ToBytes(encoded))
        const abs = mod.relativePositionToAbsolutePosition(
          ystate.doc,
          ystate.type,
          rel,
          ystate.binding.mapping,
        )
        return typeof abs === 'number' ? abs : null
      } catch {
        return null
      }
    },
  }
}

/** 无协作绑定时的默认值：跳过 Yjs 策略。 */
export function createDefaultYjsCodec(): CommentYjsCodec | null {
  return null
}

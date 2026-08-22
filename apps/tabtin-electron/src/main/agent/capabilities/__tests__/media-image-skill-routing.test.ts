import { describe, expect, it } from 'vitest'
import {
  isExplicitLibTvRequest,
  isLibTvSkill,
  shouldInjectMediaSkill,
} from '../media-image-skill-routing.js'

const libTv = {
  canonicalKey: 'user:libtv-skill',
  slug: 'libtv-skill',
  name: 'LibTV',
  displayName: 'LibTV 生图',
  primaryEnv: 'LIBTV_ACCESS_KEY',
}

const ordinary = {
  canonicalKey: 'app:cowart-image-gen',
  slug: 'cowart-image-gen',
  name: 'Cowart image',
  displayName: '图片生成',
  primaryEnv: undefined,
}

describe('media image skill routing', () => {
  it('通用生图请求不自动召回无密钥 LibTV', () => {
    expect(shouldInjectMediaSkill(libTv, {
      query: '帮我生成一张五角星图片',
      libTvCredentialAvailable: false,
    })).toBe(false)
  })

  it('用户明确指定 LibTV 时允许召回，即使尚未配置密钥', () => {
    expect(isExplicitLibTvRequest('请用 LibTV 生成一张图')).toBe(true)
    expect(shouldInjectMediaSkill(libTv, {
      query: '请用 LibTV 生成一张图',
      libTvCredentialAvailable: false,
    })).toBe(true)
  })

  it('密钥可用时允许 LibTV 参与召回；其它 Skill 不受影响', () => {
    expect(isLibTvSkill(libTv)).toBe(true)
    expect(shouldInjectMediaSkill(libTv, {
      query: '生成图片',
      libTvCredentialAvailable: true,
    })).toBe(true)
    expect(shouldInjectMediaSkill(ordinary, {
      query: '生成图片',
      libTvCredentialAvailable: false,
    })).toBe(true)
  })
})

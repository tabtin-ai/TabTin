import { describe, expect, it } from 'vitest'
import { looksLikeRealSkillContent } from '../skillSkeletonDetect'
import { generateSkillSkeleton } from '../skillMdUtils'

describe('looksLikeRealSkillContent', () => {
  it('rejects empty / whitespace', () => {
    expect(looksLikeRealSkillContent(null)).toBe(false)
    expect(looksLikeRealSkillContent('')).toBe(false)
    expect(looksLikeRealSkillContent('   ')).toBe(false)
  })

  it('rejects Electron generateSkillSkeleton output', () => {
    const skeleton = generateSkillSkeleton('algorithmic art', 'Creating algorithmic art using p5.js')
    expect(looksLikeRealSkillContent(skeleton)).toBe(false)
  })

  it('accepts real imported algorithmic-art style body', () => {
    const real = `---
name: algorithmic-art
description: Creating algorithmic art using p5.js
---

# Algorithmic Art

Use p5.js with seeded randomness. Create original work.

## Particle systems

1. Set up a canvas
2. Seed the RNG
`
    expect(looksLikeRealSkillContent(real)).toBe(true)
  })
})

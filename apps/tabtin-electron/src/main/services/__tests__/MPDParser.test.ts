import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => '/tmp') },
  net: { request: vi.fn() }
}))

vi.mock('../resourceRequestContext', () => ({
  buildNetRequestOptions: vi.fn((url: string) => ({ url }))
}))

const BASE = 'https://cdn.example.com/dash/manifest.mpd'

// ── 1. SegmentTemplate + $Number$ (static) ─────────────────────

describe('MPDParser — SegmentTemplate ($Number$)', () => {
  it('解析 static MPD：variants、segments、initSegmentUrl、duration', async () => {
    const { MPDParser } = await import('../MPDParser')
    const parser = new MPDParser()

    const mpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD type="static" mediaPresentationDuration="PT20S"
     xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <Representation id="720p" bandwidth="1200000" width="1280" height="720" codecs="avc1.64001f">
        <SegmentTemplate media="seg_$Number$.m4s" initialization="init.mp4"
                         startNumber="1" duration="4000" timescale="1000"/>
      </Representation>
      <Representation id="1080p" bandwidth="2400000" width="1920" height="1080" codecs="avc1.640028">
        <SegmentTemplate media="hd_$Number$.m4s" initialization="hd_init.mp4"
                         startNumber="1" duration="4000" timescale="1000"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`

    const result = parser.parse(mpd, BASE)

    expect(result.isMasterPlaylist).toBe(true)
    expect(result.duration).toBe(20)
    expect(result.isLive).toBe(false)
    expect(result.isEncrypted).toBe(false)

    // variants 按 bandwidth 降序
    expect(result.variants).toHaveLength(2)
    expect(result.variants[0].bandwidth).toBe(2400000)
    expect(result.variants[0].resolution).toBe('1920x1080')
    expect(result.variants[0].codecs).toBe('avc1.640028')
    expect(result.variants[1].bandwidth).toBe(1200000)

    // segments 来自最高带宽 (2400000) 的 Representation
    expect(result.segments).toHaveLength(5) // 20s / 4s = 5
    expect(result.segments[0]).toEqual({
      url: 'https://cdn.example.com/dash/hd_1.m4s',
      duration: 4,
      sequence: 1
    })
    expect(result.segments[4].sequence).toBe(5)

    expect(result.initSegmentUrl).toBe('https://cdn.example.com/dash/hd_init.mp4')
  })

  it('会解码属性中的 XML entities，避免把 &amp; 写进分片 URL', async () => {
    const { MPDParser } = await import('../MPDParser')
    const parser = new MPDParser()

    const mpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD type="static" mediaPresentationDuration="PT8S"
     xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <Representation id="1080p" bandwidth="2400000" width="1920" height="1080">
        <SegmentTemplate
          media="seg_$Number$.m4s?p=token&amp;s=sig"
          initialization="init.mp4?p=token&amp;s=sig"
          startNumber="1"
          duration="4000"
          timescale="1000"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`

    const result = parser.parse(mpd, BASE)

    expect(result.initSegmentUrl).toBe('https://cdn.example.com/dash/init.mp4?p=token&s=sig')
    expect(result.segments).toHaveLength(2)
    expect(result.segments[0].url).toBe('https://cdn.example.com/dash/seg_1.m4s?p=token&s=sig')
    expect(result.segments[1].url).toBe('https://cdn.example.com/dash/seg_2.m4s?p=token&s=sig')
  })
})

// ── 2. SegmentList ──────────────────────────────────────────────

describe('MPDParser — SegmentList', () => {
  it('解析 SegmentList 的 Initialization + SegmentURL 列表', async () => {
    const { MPDParser } = await import('../MPDParser')
    const parser = new MPDParser()

    const mpd = `<MPD type="static" mediaPresentationDuration="PT12S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="1" bandwidth="500000" width="640" height="360">
        <SegmentList duration="4000" timescale="1000">
          <Initialization sourceURL="init.mp4"/>
          <SegmentURL media="seg1.m4s"/>
          <SegmentURL media="seg2.m4s"/>
          <SegmentURL media="seg3.m4s"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`

    const result = parser.parse(mpd, BASE)

    expect(result.initSegmentUrl).toBe('https://cdn.example.com/dash/init.mp4')
    expect(result.segments).toHaveLength(3)
    expect(result.segments[0]).toEqual({
      url: 'https://cdn.example.com/dash/seg1.m4s',
      duration: 4,
      sequence: 0
    })
    expect(result.segments[2].url).toBe('https://cdn.example.com/dash/seg3.m4s')
    expect(result.duration).toBe(12)
  })
})

// ── 3. 多 AdaptationSet（视频 + 音频） ─────────────────────────

describe('MPDParser — 视频 + 独立音频轨', () => {
  it('分别解析视频 segments 和 audioSegments', async () => {
    const { MPDParser } = await import('../MPDParser')
    const parser = new MPDParser()

    const mpd = `<MPD type="static" mediaPresentationDuration="PT8S">
  <Period>
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <Representation id="v1" bandwidth="2400000" width="1920" height="1080" codecs="avc1.640028">
        <SegmentTemplate media="video_$Number$.m4s" initialization="video_init.mp4"
                         startNumber="1" duration="4000" timescale="1000"/>
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" contentType="audio">
      <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2">
        <SegmentTemplate media="audio_$Number$.m4s" initialization="audio_init.mp4"
                         startNumber="1" duration="4000" timescale="1000"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`

    const result = parser.parse(mpd, BASE)

    expect(result.segments).toHaveLength(2) // 8s / 4s
    expect(result.initSegmentUrl).toBe('https://cdn.example.com/dash/video_init.mp4')

    expect(result.audioSegments).toBeDefined()
    expect(result.audioSegments!.initUrl).toBe('https://cdn.example.com/dash/audio_init.mp4')
    expect(result.audioSegments!.segments).toHaveLength(2)
    expect(result.audioSegments!.segments[0]).toEqual({
      url: 'https://cdn.example.com/dash/audio_1.m4s',
      duration: 4,
      sequence: 1
    })
  })
})

// ── 4. DRM 检测 ─────────────────────────────────────────────────

describe('MPDParser — DRM (ContentProtection)', () => {
  it('检测到 ContentProtection 时标记 isEncrypted', async () => {
    const { MPDParser } = await import('../MPDParser')
    const parser = new MPDParser()

    const mpd = `<MPD type="static" mediaPresentationDuration="PT10S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <Representation id="1" bandwidth="1000000" width="1280" height="720">
        <SegmentTemplate media="seg_$Number$.m4s" initialization="init.mp4"
                         duration="5000" timescale="1000" startNumber="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`

    const result = parser.parse(mpd, BASE)

    expect(result.isEncrypted).toBe(true)
    expect(result.segments).toHaveLength(2)
  })
})

// ── 5. 直播流 (type="dynamic") ──────────────────────────────────

describe('MPDParser — 直播流', () => {
  it('type="dynamic" 时标记 isLive，SegmentTimeline 正确展开', async () => {
    const { MPDParser } = await import('../MPDParser')
    const parser = new MPDParser()

    const mpd = `<MPD type="dynamic" xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="1" bandwidth="1000000" width="1280" height="720">
        <SegmentTemplate media="seg_$Number$.m4s" initialization="init.mp4"
                         startNumber="100" timescale="1000">
          <SegmentTimeline>
            <S t="0" d="4000" r="2"/>
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`

    const result = parser.parse(mpd, BASE)

    expect(result.isLive).toBe(true)
    // r=2 → 原始 1 次 + 重复 2 次 = 3 段
    expect(result.segments).toHaveLength(3)
    expect(result.segments[0]).toEqual({
      url: 'https://cdn.example.com/dash/seg_100.m4s',
      duration: 4,
      sequence: 100
    })
    expect(result.segments[2].sequence).toBe(102)
  })
})

// ── 6. ISO 8601 Duration ────────────────────────────────────────

describe('parseISO8601Duration', () => {
  it('PT1H2M3.4S → 3723.4 秒', async () => {
    const { parseISO8601Duration } = await import('../MPDParser')
    expect(parseISO8601Duration('PT1H2M3.4S')).toBeCloseTo(3723.4)
  })

  it('PT30S → 30', async () => {
    const { parseISO8601Duration } = await import('../MPDParser')
    expect(parseISO8601Duration('PT30S')).toBe(30)
  })

  it('P1DT12H → 129600', async () => {
    const { parseISO8601Duration } = await import('../MPDParser')
    expect(parseISO8601Duration('P1DT12H')).toBe(129600)
  })

  it('PT0S → 0', async () => {
    const { parseISO8601Duration } = await import('../MPDParser')
    expect(parseISO8601Duration('PT0S')).toBe(0)
  })

  it('undefined / 空字符串 → 0', async () => {
    const { parseISO8601Duration } = await import('../MPDParser')
    expect(parseISO8601Duration(undefined)).toBe(0)
    expect(parseISO8601Duration('')).toBe(0)
  })

  it('非法格式 → 0', async () => {
    const { parseISO8601Duration } = await import('../MPDParser')
    expect(parseISO8601Duration('INVALID')).toBe(0)
  })
})

// ── 7. 多层 BaseURL 拼接 ────────────────────────────────────────

describe('MPDParser — 多层 BaseURL', () => {
  it('MPD → Period → AdaptationSet → Representation 层层拼接', async () => {
    const { MPDParser } = await import('../MPDParser')
    const parser = new MPDParser()

    const mpd = `<MPD type="static" mediaPresentationDuration="PT8S">
  <BaseURL>https://cdn.example.com/</BaseURL>
  <Period>
    <BaseURL>content/</BaseURL>
    <AdaptationSet mimeType="video/mp4">
      <BaseURL>video/</BaseURL>
      <Representation id="1" bandwidth="1000000" width="1280" height="720">
        <BaseURL>hd/</BaseURL>
        <SegmentTemplate media="seg_$Number$.m4s" initialization="init.mp4"
                         duration="4000" timescale="1000" startNumber="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`

    const result = parser.parse(mpd, 'https://origin.example.com/fallback.mpd')

    expect(result.initSegmentUrl).toBe('https://cdn.example.com/content/video/hd/init.mp4')
    expect(result.segments[0].url).toBe('https://cdn.example.com/content/video/hd/seg_1.m4s')
    expect(result.segments[1].url).toBe('https://cdn.example.com/content/video/hd/seg_2.m4s')
  })
})

// ── 8. 无效 XML ─────────────────────────────────────────────────

describe('MPDParser — 错误处理', () => {
  it('完全无效的内容抛出 MPDParseError', async () => {
    const { MPDParser, MPDParseError } = await import('../MPDParser')
    const parser = new MPDParser()

    expect(() => parser.parse('this is not XML at all', BASE)).toThrow(MPDParseError)
  })

  it('有效 XML 但根元素不是 MPD 时抛出 MPDParseError', async () => {
    const { MPDParser, MPDParseError } = await import('../MPDParser')
    const parser = new MPDParser()

    expect(() => parser.parse('<html><body>hello</body></html>', BASE)).toThrow(
      'Invalid MPD: root element is <html>, expected <MPD>'
    )
  })

  it('MPD 无 Period 时抛出 MPDParseError', async () => {
    const { MPDParser, MPDParseError } = await import('../MPDParser')
    const parser = new MPDParser()

    expect(() => parser.parse('<MPD type="static"></MPD>', BASE)).toThrow(
      'Invalid MPD: no <Period> element found'
    )
  })
})

// ── 9. toStreamInfo ─────────────────────────────────────────────

describe('MPDParser — toStreamInfo', () => {
  it('将 MPDParseResult 转为 StreamInfo', async () => {
    const { MPDParser } = await import('../MPDParser')
    const parser = new MPDParser()

    const mpd = `<MPD type="static" mediaPresentationDuration="PT20S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="1" bandwidth="1200000" width="1280" height="720">
        <SegmentTemplate media="seg_$Number$.m4s" initialization="init.mp4"
                         startNumber="1" duration="4000" timescale="1000"/>
      </Representation>
      <Representation id="2" bandwidth="2400000" width="1920" height="1080">
        <SegmentTemplate media="seg_$Number$.m4s" initialization="init.mp4"
                         startNumber="1" duration="4000" timescale="1000"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`

    const result = parser.parse(mpd, BASE)
    const info = parser.toStreamInfo(result)

    expect(info.isMasterPlaylist).toBe(true)
    expect(info.variants).toHaveLength(2)
    expect(info.duration).toBe(20)
    expect(info.segmentCount).toBe(5)
    expect(info.isLive).toBe(false)
  })
})

// ── 10. getMPDParser 单例 ────────────────────────────────────────

describe('getMPDParser', () => {
  it('返回同一实例', async () => {
    const { getMPDParser } = await import('../MPDParser')
    const a = getMPDParser()
    const b = getMPDParser()
    expect(a).toBe(b)
  })
})

// ── 11. SegmentTimeline + $Time$ 模板 ───────────────────────────

describe('MPDParser — SegmentTimeline + $Time$', () => {
  it('使用 $Time$ 模板变量生成分片 URL', async () => {
    const { MPDParser } = await import('../MPDParser')
    const parser = new MPDParser()

    const mpd = `<MPD type="static" mediaPresentationDuration="PT12S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v1" bandwidth="1500000" width="1280" height="720">
        <SegmentTemplate media="seg_$Time$.m4s" initialization="init_$RepresentationID$.mp4"
                         timescale="1000" startNumber="1">
          <SegmentTimeline>
            <S t="0" d="4000"/>
            <S d="4000"/>
            <S d="4000"/>
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`

    const result = parser.parse(mpd, BASE)

    expect(result.initSegmentUrl).toBe('https://cdn.example.com/dash/init_v1.mp4')
    expect(result.segments).toHaveLength(3)
    expect(result.segments[0].url).toBe('https://cdn.example.com/dash/seg_0.m4s')
    expect(result.segments[1].url).toBe('https://cdn.example.com/dash/seg_4000.m4s')
    expect(result.segments[2].url).toBe('https://cdn.example.com/dash/seg_8000.m4s')
    expect(result.segments.every(s => s.duration === 4)).toBe(true)
  })
})

// ── 12. AdaptationSet 上没有 mimeType，通过子 Representation 推断 ──

describe('MPDParser — 无 mimeType/contentType 的 AdaptationSet', () => {
  it('根据子 Representation 的 mimeType 推断媒体类型', async () => {
    const { MPDParser } = await import('../MPDParser')
    const parser = new MPDParser()

    const mpd = `<MPD type="static" mediaPresentationDuration="PT4S">
  <Period>
    <AdaptationSet>
      <Representation id="1" bandwidth="800000" width="640" height="360" mimeType="video/mp4">
        <SegmentTemplate media="seg_$Number$.m4s" initialization="init.mp4"
                         duration="4000" timescale="1000" startNumber="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`

    const result = parser.parse(mpd, BASE)

    expect(result.variants).toHaveLength(1)
    expect(result.variants[0].bandwidth).toBe(800000)
    expect(result.segments).toHaveLength(1)
  })
})

// ── 13. variantSegmentMap — 多 Representation 各自的 segments ──

describe('MPDParser — variantSegmentMap', () => {
  it('多 Representation 时 map 包含每个 variant 的独立 segments', async () => {
    const { MPDParser } = await import('../MPDParser')
    const parser = new MPDParser()

    const mpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD type="static" mediaPresentationDuration="PT20S">
  <Period>
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <Representation id="360p" bandwidth="400000" width="640" height="360" codecs="avc1.42c01e">
        <SegmentTemplate media="low_$Number$.m4s" initialization="low_init.mp4"
                         startNumber="1" duration="4000" timescale="1000"/>
      </Representation>
      <Representation id="720p" bandwidth="1200000" width="1280" height="720" codecs="avc1.64001f">
        <SegmentTemplate media="mid_$Number$.m4s" initialization="mid_init.mp4"
                         startNumber="1" duration="4000" timescale="1000"/>
      </Representation>
      <Representation id="1080p" bandwidth="2400000" width="1920" height="1080" codecs="avc1.640028">
        <SegmentTemplate media="hd_$Number$.m4s" initialization="hd_init.mp4"
                         startNumber="1" duration="4000" timescale="1000"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`

    const result = parser.parse(mpd, BASE)

    expect(result.variantSegmentMap).toBeDefined()
    const map = result.variantSegmentMap!

    // variants 按 bandwidth 降序：index 0=1080p, 1=720p, 2=360p
    expect(map.size).toBe(3)
    expect(result.variants).toHaveLength(3)

    // index 0 → 1080p (最高画质)，与 segments/initSegmentUrl 一致
    const v0 = map.get(0)!
    expect(v0.initUrl).toBe('https://cdn.example.com/dash/hd_init.mp4')
    expect(v0.segments).toHaveLength(5)
    expect(v0.segments[0].url).toBe('https://cdn.example.com/dash/hd_1.m4s')
    expect(v0.segments).toEqual(result.segments)
    expect(v0.initUrl).toBe(result.initSegmentUrl)

    // index 1 → 720p
    const v1 = map.get(1)!
    expect(v1.initUrl).toBe('https://cdn.example.com/dash/mid_init.mp4')
    expect(v1.segments).toHaveLength(5)
    expect(v1.segments[0].url).toBe('https://cdn.example.com/dash/mid_1.m4s')
    expect(v1.segments[4].url).toBe('https://cdn.example.com/dash/mid_5.m4s')

    // index 2 → 360p
    const v2 = map.get(2)!
    expect(v2.initUrl).toBe('https://cdn.example.com/dash/low_init.mp4')
    expect(v2.segments).toHaveLength(5)
    expect(v2.segments[0].url).toBe('https://cdn.example.com/dash/low_1.m4s')
  })

  it('key 与 variants 数组索引严格对应', async () => {
    const { MPDParser } = await import('../MPDParser')
    const parser = new MPDParser()

    const mpd = `<MPD type="static" mediaPresentationDuration="PT8S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="low" bandwidth="300000" width="426" height="240">
        <SegmentTemplate media="240p_$Number$.m4s" initialization="240p_init.mp4"
                         startNumber="1" duration="4000" timescale="1000"/>
      </Representation>
      <Representation id="high" bandwidth="5000000" width="2560" height="1440">
        <SegmentTemplate media="1440p_$Number$.m4s" initialization="1440p_init.mp4"
                         startNumber="1" duration="4000" timescale="1000"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`

    const result = parser.parse(mpd, BASE)
    const map = result.variantSegmentMap!

    for (let i = 0; i < result.variants.length; i++) {
      const entry = map.get(i)
      expect(entry).toBeDefined()
      expect(entry!.segments.length).toBeGreaterThan(0)
    }

    // index 0 → bandwidth 5000000 (降序排列后)
    expect(result.variants[0].bandwidth).toBe(5000000)
    expect(map.get(0)!.segments[0].url).toContain('1440p_')

    // index 1 → bandwidth 300000
    expect(result.variants[1].bandwidth).toBe(300000)
    expect(map.get(1)!.segments[0].url).toContain('240p_')
  })

  it('单 Representation 时 map 仍有一个条目', async () => {
    const { MPDParser } = await import('../MPDParser')
    const parser = new MPDParser()

    const mpd = `<MPD type="static" mediaPresentationDuration="PT4S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="only" bandwidth="1000000" width="1280" height="720">
        <SegmentTemplate media="seg_$Number$.m4s" initialization="init.mp4"
                         duration="4000" timescale="1000" startNumber="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`

    const result = parser.parse(mpd, BASE)

    expect(result.variantSegmentMap).toBeDefined()
    expect(result.variantSegmentMap!.size).toBe(1)
    expect(result.variantSegmentMap!.get(0)!.segments).toEqual(result.segments)
  })

  it('SegmentList 类型的 Representation 也进入 map', async () => {
    const { MPDParser } = await import('../MPDParser')
    const parser = new MPDParser()

    const mpd = `<MPD type="static" mediaPresentationDuration="PT8S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="sd" bandwidth="500000" width="640" height="360">
        <SegmentList duration="4000" timescale="1000">
          <Initialization sourceURL="sd_init.mp4"/>
          <SegmentURL media="sd_1.m4s"/>
          <SegmentURL media="sd_2.m4s"/>
        </SegmentList>
      </Representation>
      <Representation id="hd" bandwidth="2000000" width="1920" height="1080">
        <SegmentList duration="4000" timescale="1000">
          <Initialization sourceURL="hd_init.mp4"/>
          <SegmentURL media="hd_1.m4s"/>
          <SegmentURL media="hd_2.m4s"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`

    const result = parser.parse(mpd, BASE)
    const map = result.variantSegmentMap!

    expect(map.size).toBe(2)

    // index 0 → hd (2000000)
    expect(map.get(0)!.initUrl).toBe('https://cdn.example.com/dash/hd_init.mp4')
    expect(map.get(0)!.segments[0].url).toBe('https://cdn.example.com/dash/hd_1.m4s')

    // index 1 → sd (500000)
    expect(map.get(1)!.initUrl).toBe('https://cdn.example.com/dash/sd_init.mp4')
    expect(map.get(1)!.segments[0].url).toBe('https://cdn.example.com/dash/sd_1.m4s')
  })
})

// ── 14. 多 Period ────────────────────────────────────────────────

describe('MPDParser — 多 Period', () => {
  it('应正确解析多 Period MPD', async () => {
    const { MPDParser } = await import('../MPDParser')
    const parser = new MPDParser()

    const mpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT60S">
    <Period duration="PT30S">
        <AdaptationSet mimeType="video/mp4">
            <Representation id="1" bandwidth="1000000" width="1280" height="720">
                <SegmentTemplate media="p1_seg_$Number$.m4s" initialization="p1_init.mp4" startNumber="1" duration="4000" timescale="1000"/>
            </Representation>
        </AdaptationSet>
    </Period>
    <Period duration="PT30S">
        <AdaptationSet mimeType="video/mp4">
            <Representation id="1" bandwidth="1000000" width="1280" height="720">
                <SegmentTemplate media="p2_seg_$Number$.m4s" initialization="p2_init.mp4" startNumber="1" duration="4000" timescale="1000"/>
            </Representation>
        </AdaptationSet>
    </Period>
</MPD>`

    const result = parser.parse(mpd, 'https://cdn.example.com/')

    expect(result.segments.length).toBeGreaterThan(8)
    expect(result.duration).toBeCloseTo(60, 0)
    expect(result.segments[0].url).toContain('p1_seg_')
    expect(result.segments[result.segments.length - 1].url).toContain('p2_seg_')
  })

  it('通过 Period start 属性推断 duration', async () => {
    const { MPDParser } = await import('../MPDParser')
    const parser = new MPDParser()

    const mpd = `<MPD type="static" mediaPresentationDuration="PT40S">
    <Period start="PT0S">
        <AdaptationSet mimeType="video/mp4">
            <Representation id="1" bandwidth="1000000" width="1280" height="720">
                <SegmentTemplate media="a_$Number$.m4s" initialization="a_init.mp4" startNumber="1" duration="5000" timescale="1000"/>
            </Representation>
        </AdaptationSet>
    </Period>
    <Period start="PT10S">
        <AdaptationSet mimeType="video/mp4">
            <Representation id="1" bandwidth="1000000" width="1280" height="720">
                <SegmentTemplate media="b_$Number$.m4s" initialization="b_init.mp4" startNumber="1" duration="5000" timescale="1000"/>
            </Representation>
        </AdaptationSet>
    </Period>
</MPD>`

    const result = parser.parse(mpd, 'https://cdn.example.com/')

    expect(result.duration).toBeCloseTo(40, 0)
    // Period 1: start=0, next start=10 → duration=10 → 10/5=2 segments
    expect(result.segments.filter(s => s.url.includes('a_')).length).toBe(2)
    // Period 2: start=10, mpdDuration=40 → duration=30 → 30/5=6 segments
    expect(result.segments.filter(s => s.url.includes('b_')).length).toBe(6)
  })

  it('variantSegmentMap 跨 Period 拼接', async () => {
    const { MPDParser } = await import('../MPDParser')
    const parser = new MPDParser()

    const mpd = `<MPD type="static" mediaPresentationDuration="PT20S">
    <Period duration="PT10S">
        <AdaptationSet mimeType="video/mp4">
            <Representation id="hd" bandwidth="2000000" width="1920" height="1080">
                <SegmentTemplate media="p1_hd_$Number$.m4s" initialization="hd_init.mp4" startNumber="1" duration="5000" timescale="1000"/>
            </Representation>
            <Representation id="sd" bandwidth="500000" width="640" height="360">
                <SegmentTemplate media="p1_sd_$Number$.m4s" initialization="sd_init.mp4" startNumber="1" duration="5000" timescale="1000"/>
            </Representation>
        </AdaptationSet>
    </Period>
    <Period duration="PT10S">
        <AdaptationSet mimeType="video/mp4">
            <Representation id="hd" bandwidth="2000000" width="1920" height="1080">
                <SegmentTemplate media="p2_hd_$Number$.m4s" initialization="hd_init.mp4" startNumber="1" duration="5000" timescale="1000"/>
            </Representation>
            <Representation id="sd" bandwidth="500000" width="640" height="360">
                <SegmentTemplate media="p2_sd_$Number$.m4s" initialization="sd_init.mp4" startNumber="1" duration="5000" timescale="1000"/>
            </Representation>
        </AdaptationSet>
    </Period>
</MPD>`

    const result = parser.parse(mpd, 'https://cdn.example.com/')
    const map = result.variantSegmentMap!

    expect(map.size).toBe(2)
    // index 0 → hd (2000000), 两个 Period 各 2 segments = 4
    const hdSegs = map.get(0)!.segments
    expect(hdSegs.length).toBe(4)
    expect(hdSegs[0].url).toContain('p1_hd_')
    expect(hdSegs[hdSegs.length - 1].url).toContain('p2_hd_')

    // index 1 → sd (500000), 同样 4 segments
    const sdSegs = map.get(1)!.segments
    expect(sdSegs.length).toBe(4)
    expect(sdSegs[0].url).toContain('p1_sd_')
    expect(sdSegs[sdSegs.length - 1].url).toContain('p2_sd_')

    // initUrl 来自第一个 Period
    expect(map.get(0)!.initUrl).toContain('hd_init.mp4')
  })
})

// ── 15. SegmentBase ──────────────────────────────────────────────

describe('MPDParser — SegmentBase', () => {
  it('应正确解析 SegmentBase 模式', async () => {
    const { MPDParser } = await import('../MPDParser')
    const parser = new MPDParser()

    const mpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT120S">
    <Period>
        <AdaptationSet mimeType="video/mp4">
            <Representation id="1" bandwidth="2000000" width="1920" height="1080">
                <BaseURL>video.mp4</BaseURL>
                <SegmentBase indexRange="674-1149">
                    <Initialization range="0-673"/>
                </SegmentBase>
            </Representation>
        </AdaptationSet>
    </Period>
</MPD>`

    const result = parser.parse(mpd, 'https://cdn.example.com/')

    expect(result.segments.length).toBe(1)
    expect(result.segments[0].url).toBe('https://cdn.example.com/video.mp4')
    expect(result.duration).toBeCloseTo(120, 0)
    expect(result.initSegmentUrl).toBeUndefined()
  })

  it('SegmentBase 多 Representation 时按 bandwidth 选最高', async () => {
    const { MPDParser } = await import('../MPDParser')
    const parser = new MPDParser()

    const mpd = `<MPD type="static" mediaPresentationDuration="PT60S">
    <Period>
        <AdaptationSet mimeType="video/mp4">
            <Representation id="sd" bandwidth="500000" width="640" height="360">
                <BaseURL>video_sd.mp4</BaseURL>
                <SegmentBase indexRange="0-999">
                    <Initialization range="0-499"/>
                </SegmentBase>
            </Representation>
            <Representation id="hd" bandwidth="2000000" width="1920" height="1080">
                <BaseURL>video_hd.mp4</BaseURL>
                <SegmentBase indexRange="0-999">
                    <Initialization range="0-499"/>
                </SegmentBase>
            </Representation>
        </AdaptationSet>
    </Period>
</MPD>`

    const result = parser.parse(mpd, 'https://cdn.example.com/')

    expect(result.variants.length).toBe(2)
    expect(result.variants[0].bandwidth).toBe(2000000)
    expect(result.segments.length).toBe(1)
    expect(result.segments[0].url).toBe('https://cdn.example.com/video_hd.mp4')
    expect(result.segments[0].duration).toBeCloseTo(60, 0)

    const map = result.variantSegmentMap!
    expect(map.get(0)!.segments[0].url).toBe('https://cdn.example.com/video_hd.mp4')
    expect(map.get(1)!.segments[0].url).toBe('https://cdn.example.com/video_sd.mp4')
  })
})

// ── 16. 带命名空间前缀的 ContentProtection ──────────────────────

describe('MPDParser — 带命名空间前缀的标签', () => {
  it('cenc:ContentProtection 等带前缀的标签正确识别', async () => {
    const { MPDParser } = await import('../MPDParser')
    const parser = new MPDParser()

    const mpd = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     xmlns:cenc="urn:mpeg:cenc:2013"
     type="static" mediaPresentationDuration="PT4S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <cenc:ContentProtection schemeIdUri="urn:mpeg:cenc:2013"/>
      <Representation id="1" bandwidth="1000000" width="1280" height="720">
        <SegmentTemplate media="seg_$Number$.m4s" initialization="init.mp4"
                         duration="4000" timescale="1000" startNumber="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`

    const result = parser.parse(mpd, BASE)
    expect(result.isEncrypted).toBe(true)
  })
})

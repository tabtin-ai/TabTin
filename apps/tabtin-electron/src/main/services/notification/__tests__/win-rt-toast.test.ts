import { describe, expect, it } from 'vitest'
import { __testing } from '../win-rt-toast'

describe('win-rt-toast helpers', () => {
  it('escapeToastXml 转义 XML 特殊字符', () => {
    expect(__testing.escapeToastXml(`a<b>&"'`)).toBe('a&lt;b&gt;&amp;&quot;&apos;')
  })

  it('buildToastXml 生成短横幅 ToastGeneric（对齐 Mac 停留与图标）', () => {
    const xml = __testing.buildToastXml({
      title: '张三',
      body: 'hello <world>',
      aumid: 'com.tabtin.app.preprod',
      silent: true,
      iconFileUrl: 'file:///C:/app/static/icon.png',
      launchUrl: 'tabtin://notify?d=abc&x=1',
    })
    expect(xml).toContain('duration="short"')
    expect(xml).toContain('activationType="protocol"')
    expect(xml).toContain('launch="tabtin://notify?d=abc&amp;x=1"')
    expect(xml).toContain('<audio silent="true"/>')
    expect(xml).toContain('placement="appLogoOverride"')
    expect(xml).toContain('hint-crop="circle"')
    expect(xml).toContain('src="file:///C:/app/static/icon.png"')
    expect(xml).toContain('hint-style="title"')
    expect(xml).toContain('>张三</text>')
    expect(xml).toContain('hint-style="body"')
    expect(xml).toContain('>hello &lt;world&gt;</text>')
  })

  it('buildPowerShellScript 写入 ExpirationTime', () => {
    const script = __testing.buildPowerShellScript(
      'com.tabtin.app.preprod',
      '<toast/>',
      5,
    )
    expect(script).toContain('ExpirationTime')
    expect(script).toContain('AddSeconds(5)')
  })
})

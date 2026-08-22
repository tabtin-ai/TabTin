/**
 * 主进程右键菜单国际化
 *
 * 主进程没有 react-i18next，使用轻量级翻译字典。
 * 通过 app.getLocale() 检测系统语言，支持渲染进程同步语言偏好。
 */

import { guardedOn } from '../utils/guarded-handle'
import { resolveStartupUiLocale } from '../startup-ui-locale'

type TranslationKey =
  | 'back' | 'forward' | 'reload'
  | 'selectAll'
  | 'undo' | 'redo' | 'cut' | 'copy' | 'paste'
  | 'openLinkInNewTab' | 'openLinkInNewWindow' | 'saveLinkAs' | 'copyLinkAddress'
  | 'openImageInNewTab' | 'saveImageAs' | 'copyImage' | 'copyImageAddress' | 'searchImageOnGoogle'
  | 'play' | 'pause' | 'mute' | 'unmute' | 'copyMediaAddress'
  | 'searchFor'
  | 'addToContext' | 'print' | 'savePageAs' | 'captureScreenshot'
  | 'viewPageSource' | 'inspect'

const translations: Record<string, Record<TranslationKey, string>> = {
  'zh-CN': {
    back: '后退',
    forward: '前进',
    reload: '重新加载',
    selectAll: '全选',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    openLinkInNewTab: '在新标签页中打开链接',
    openLinkInNewWindow: '在新窗口中打开链接',
    saveLinkAs: '链接另存为…',
    copyLinkAddress: '复制链接地址',
    openImageInNewTab: '在新标签页中打开图片',
    saveImageAs: '图片另存为…',
    copyImage: '复制图片',
    copyImageAddress: '复制图片地址',
    searchImageOnGoogle: '使用 Google 搜索图片',
    play: '播放',
    pause: '暂停',
    mute: '静音',
    unmute: '取消静音',
    copyMediaAddress: '复制媒体地址',
    searchFor: '搜索"{{text}}"',
    addToContext: '引用到对话',
    print: '打印…',
    savePageAs: '页面另存为…',
    captureScreenshot: '截取可见区域截图',
    viewPageSource: '查看页面源代码',
    inspect: '检查',
  },
  'zh-TW': {
    back: '返回',
    forward: '前進',
    reload: '重新載入',
    selectAll: '全選',
    undo: '復原',
    redo: '重做',
    cut: '剪下',
    copy: '複製',
    paste: '貼上',
    openLinkInNewTab: '在新分頁中開啟連結',
    openLinkInNewWindow: '在新視窗中開啟連結',
    saveLinkAs: '另存連結為…',
    copyLinkAddress: '複製連結網址',
    openImageInNewTab: '在新分頁中開啟圖片',
    saveImageAs: '另存圖片為…',
    copyImage: '複製圖片',
    copyImageAddress: '複製圖片網址',
    searchImageOnGoogle: '使用 Google 搜尋圖片',
    play: '播放',
    pause: '暫停',
    mute: '靜音',
    unmute: '取消靜音',
    copyMediaAddress: '複製媒體網址',
    searchFor: '搜尋「{{text}}」',
    addToContext: '引用到對話',
    print: '列印…',
    savePageAs: '另存頁面為…',
    captureScreenshot: '擷取可見區域截圖',
    viewPageSource: '檢視網頁原始碼',
    inspect: '檢查',
  },
  'en-US': {
    back: 'Back',
    forward: 'Forward',
    reload: 'Reload',
    selectAll: 'Select All',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    openLinkInNewTab: 'Open Link in New Tab',
    openLinkInNewWindow: 'Open Link in New Window',
    saveLinkAs: 'Save Link As…',
    copyLinkAddress: 'Copy Link Address',
    openImageInNewTab: 'Open Image in New Tab',
    saveImageAs: 'Save Image As…',
    copyImage: 'Copy Image',
    copyImageAddress: 'Copy Image Address',
    searchImageOnGoogle: 'Search Image with Google',
    play: 'Play',
    pause: 'Pause',
    mute: 'Mute',
    unmute: 'Unmute',
    copyMediaAddress: 'Copy Media Address',
    searchFor: 'Search for "{{text}}"',
    addToContext: 'Quote to Chat',
    print: 'Print…',
    savePageAs: 'Save Page As…',
    captureScreenshot: 'Capture Visible Area Screenshot',
    viewPageSource: 'View Page Source',
    inspect: 'Inspect',
  },
  'ja-JP': {
    back: '戻る', forward: '進む', reload: '再読み込み', selectAll: 'すべて選択',
    undo: '元に戻す', redo: 'やり直す', cut: '切り取り', copy: 'コピー', paste: '貼り付け',
    openLinkInNewTab: 'リンクを新しいタブで開く', openLinkInNewWindow: 'リンクを新しいウィンドウで開く',
    saveLinkAs: 'リンクを別名で保存…', copyLinkAddress: 'リンクのアドレスをコピー',
    openImageInNewTab: '画像を新しいタブで開く', saveImageAs: '画像を別名で保存…',
    copyImage: '画像をコピー', copyImageAddress: '画像のアドレスをコピー', searchImageOnGoogle: 'Google で画像を検索',
    play: '再生', pause: '一時停止', mute: 'ミュート', unmute: 'ミュートを解除', copyMediaAddress: 'メディアのアドレスをコピー',
    searchFor: '「{{text}}」を検索', addToContext: 'チャットに引用', print: '印刷…', savePageAs: 'ページを別名で保存…',
    captureScreenshot: '表示領域のスクリーンショットを撮る', viewPageSource: 'ページのソースを表示', inspect: '検証',
  },
  'ko-KR': {
    back: '뒤로', forward: '앞으로', reload: '새로고침', selectAll: '모두 선택',
    undo: '실행 취소', redo: '다시 실행', cut: '잘라내기', copy: '복사', paste: '붙여넣기',
    openLinkInNewTab: '새 탭에서 링크 열기', openLinkInNewWindow: '새 창에서 링크 열기',
    saveLinkAs: '링크를 다른 이름으로 저장…', copyLinkAddress: '링크 주소 복사',
    openImageInNewTab: '새 탭에서 이미지 열기', saveImageAs: '이미지를 다른 이름으로 저장…',
    copyImage: '이미지 복사', copyImageAddress: '이미지 주소 복사', searchImageOnGoogle: 'Google에서 이미지 검색',
    play: '재생', pause: '일시 정지', mute: '음소거', unmute: '음소거 해제', copyMediaAddress: '미디어 주소 복사',
    searchFor: '“{{text}}” 검색', addToContext: '채팅에 인용', print: '인쇄…', savePageAs: '페이지를 다른 이름으로 저장…',
    captureScreenshot: '표시 영역 스크린샷 캡처', viewPageSource: '페이지 소스 보기', inspect: '검사',
  },
  'de-DE': {
    back: 'Zurück', forward: 'Vorwärts', reload: 'Neu laden', selectAll: 'Alles auswählen',
    undo: 'Rückgängig', redo: 'Wiederholen', cut: 'Ausschneiden', copy: 'Kopieren', paste: 'Einfügen',
    openLinkInNewTab: 'Link in neuem Tab öffnen', openLinkInNewWindow: 'Link in neuem Fenster öffnen',
    saveLinkAs: 'Link speichern unter…', copyLinkAddress: 'Linkadresse kopieren',
    openImageInNewTab: 'Bild in neuem Tab öffnen', saveImageAs: 'Bild speichern unter…',
    copyImage: 'Bild kopieren', copyImageAddress: 'Bildadresse kopieren', searchImageOnGoogle: 'Bild mit Google suchen',
    play: 'Wiedergabe', pause: 'Pause', mute: 'Stummschalten', unmute: 'Stummschaltung aufheben', copyMediaAddress: 'Medienadresse kopieren',
    searchFor: 'Nach „{{text}}“ suchen', addToContext: 'Im Chat zitieren', print: 'Drucken…', savePageAs: 'Seite speichern unter…',
    captureScreenshot: 'Screenshot des sichtbaren Bereichs aufnehmen', viewPageSource: 'Seitenquelltext anzeigen', inspect: 'Untersuchen',
  },
  'fr-FR': {
    back: 'Précédent', forward: 'Suivant', reload: 'Actualiser', selectAll: 'Tout sélectionner',
    undo: 'Annuler', redo: 'Rétablir', cut: 'Couper', copy: 'Copier', paste: 'Coller',
    openLinkInNewTab: 'Ouvrir le lien dans un nouvel onglet', openLinkInNewWindow: 'Ouvrir le lien dans une nouvelle fenêtre',
    saveLinkAs: 'Enregistrer le lien sous…', copyLinkAddress: 'Copier l’adresse du lien',
    openImageInNewTab: 'Ouvrir l’image dans un nouvel onglet', saveImageAs: 'Enregistrer l’image sous…',
    copyImage: 'Copier l’image', copyImageAddress: 'Copier l’adresse de l’image', searchImageOnGoogle: 'Rechercher l’image avec Google',
    play: 'Lire', pause: 'Pause', mute: 'Couper le son', unmute: 'Réactiver le son', copyMediaAddress: 'Copier l’adresse du média',
    searchFor: 'Rechercher « {{text}} »', addToContext: 'Citer dans le chat', print: 'Imprimer…', savePageAs: 'Enregistrer la page sous…',
    captureScreenshot: 'Capturer la zone visible', viewPageSource: 'Afficher le code source de la page', inspect: 'Inspecter',
  },
  'es-ES': {
    back: 'Atrás', forward: 'Adelante', reload: 'Volver a cargar', selectAll: 'Seleccionar todo',
    undo: 'Deshacer', redo: 'Rehacer', cut: 'Cortar', copy: 'Copiar', paste: 'Pegar',
    openLinkInNewTab: 'Abrir enlace en una pestaña nueva', openLinkInNewWindow: 'Abrir enlace en una ventana nueva',
    saveLinkAs: 'Guardar enlace como…', copyLinkAddress: 'Copiar dirección del enlace',
    openImageInNewTab: 'Abrir imagen en una pestaña nueva', saveImageAs: 'Guardar imagen como…',
    copyImage: 'Copiar imagen', copyImageAddress: 'Copiar dirección de la imagen', searchImageOnGoogle: 'Buscar imagen con Google',
    play: 'Reproducir', pause: 'Pausar', mute: 'Silenciar', unmute: 'Activar sonido', copyMediaAddress: 'Copiar dirección del contenido multimedia',
    searchFor: 'Buscar “{{text}}”', addToContext: 'Citar en el chat', print: 'Imprimir…', savePageAs: 'Guardar página como…',
    captureScreenshot: 'Capturar el área visible', viewPageSource: 'Ver código fuente de la página', inspect: 'Inspeccionar',
  },
}

let currentLocale = 'zh-CN'

function resolveLocale(raw: string): string {
  const lower = raw.toLowerCase()
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-mo' || lower === 'zh-hant' || lower.startsWith('zh-hant')) {
    return 'zh-TW'
  }
  if (lower.startsWith('zh')) return 'zh-CN'
  if (lower.startsWith('ja')) return 'ja-JP'
  if (lower.startsWith('ko')) return 'ko-KR'
  if (lower.startsWith('de')) return 'de-DE'
  if (lower.startsWith('fr')) return 'fr-FR'
  if (lower.startsWith('es')) return 'es-ES'
  return 'en-US'
}

/**
 * 初始化主进程菜单语言（在 app.ready 后调用）
 */
export function initContextMenuI18n(): void {
  try {
    currentLocale = resolveLocale(resolveStartupUiLocale())
  } catch {
    currentLocale = 'zh-CN'
  }

  guardedOn('context-menu:set-locale', (_event, locale: string) => {
    if (typeof locale === 'string' && locale) {
      currentLocale = resolveLocale(locale)
    }
  })
}

/**
 * 翻译函数
 */
export function t(key: TranslationKey, interpolations?: Record<string, string>): string {
  const dict = translations[currentLocale] || translations['en-US']
  let text = dict[key] || translations['en-US'][key] || key

  if (interpolations) {
    for (const [k, v] of Object.entries(interpolations)) {
      text = text.replace(`{{${k}}}`, v)
    }
  }

  return text
}

import http from 'http';
import WebSocket from 'ws';
import fs from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

/*
 * 把正在运行的 TabTin 客户端「当前这一屏」冻成自包含单文件 HTML，供 html.to.design 灌进 Figma。
 *
 * 前置：客户端需以调试端口启动（CDP 9222）。dev 下 pnpm dev 已带；若没有，用
 *   ELECTRON_EXTRA_ARGS 或启动参数加 --remote-debugging-port=9222。
 *
 * 用法：
 *   node snapshot-to-figma.mjs                 # 抓主窗口→自动用 Arc 打开快照，产物落 ~/Downloads/TabTin/figma-snapshots/
 *   node snapshot-to-figma.mjs <名字>          # 自定义产物名
 *   node snapshot-to-figma.mjs <名字> <页面URL> # 指定抓哪个页面(默认主窗口 http://127.0.0.1:5175/)
 *   附加开关：--no-open 抓完不自动开浏览器；--verify 额外出无头复验图(慢 ~3s)
 *   换浏览器：SNAPSHOT_BROWSER="Google Chrome" node snapshot-to-figma.mjs（默认 Arc，扩展装哪用哪）
 *
 * 产物（都在输出目录）：
 *   <名字>.html         ← 交给设计师：Chrome 打开 → html.to.design 扩展「导入当前页」→ Figma
 *   <名字>.png          ← 客户端里的真实截图（核对抓对了没）
 *   <名字>.verify.png   ← 仅 --verify 时产出：快照在纯 Chrome 的渲染（核对还原度）
 */

const CDP_HOST = '127.0.0.1:9222';
const argv = process.argv.slice(2);
const NO_OPEN = argv.includes('--no-open');
const WANT_VERIFY = argv.includes('--verify');
const positional = argv.filter(a => !a.startsWith('--'));
const NAME = positional[0] || 'tabtin-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const TARGET_URL = positional[1] || 'http://127.0.0.1:5175/';
const OUT_DIR = path.join(os.homedir(), 'Downloads', 'TabTin', 'figma-snapshots');
fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT = path.join(OUT_DIR, NAME);

function getJSON(u) {
  return new Promise((res, rej) => {
    http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}

let targets;
try {
  targets = await getJSON(`http://${CDP_HOST}/json`);
} catch (e) {
  console.error(`✗ 连不上 CDP (${CDP_HOST})。客户端是否以 --remote-debugging-port=9222 启动？`);
  process.exit(1);
}
const main = targets.find(t => t.type === 'page' && t.url === TARGET_URL);
if (!main) {
  console.error('✗ 找不到目标页面:', TARGET_URL);
  console.error('  当前可选页面:\n   ', targets.filter(t => t.type === 'page').map(t => t.url).join('\n    '));
  process.exit(1);
}

const ws = new WebSocket(main.webSocketDebuggerUrl);
let id = 0; const pending = {};
const send = (m, p = {}) => new Promise(r => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.on('message', m => { const o = JSON.parse(m); if (o.id && pending[o.id]) { pending[o.id](o.result); delete pending[o.id]; } });
await new Promise(r => ws.on('open', r));
await send('Page.enable');
await send('Runtime.enable');

// 1) 客户端真实截图
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT + '.png', Buffer.from(shot.data, 'base64'));

// 2) 页面内序列化成单文件 HTML（合并样式表 + 内联 url() 资源 + 内联 <img>，去掉脚本）
const serializer = `(async () => {
  const abs = (u, base) => { try { return new URL(u, base || location.href).href; } catch { return u; } };
  const cache = new Map();
  async function toDataURI(url) {
    if (!url || url.startsWith('data:')) return url;
    if (cache.has(url)) return cache.get(url);
    try {
      const res = await fetch(url); const blob = await res.blob();
      const d = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
      cache.set(url, d); return d;
    } catch { return url; }
  }
  let css = '';
  for (const sheet of Array.from(document.styleSheets)) {
    try { for (const rule of Array.from(sheet.cssRules)) css += rule.cssText + '\\n'; }
    catch { if (sheet.href) { try { css += await (await fetch(sheet.href)).text() + '\\n'; } catch {} } }
  }
  const urlRe = /url\\((['\"]?)([^'\")]+)\\1\\)/g; const found = new Set(); let m;
  while ((m = urlRe.exec(css))) { if (!m[2].startsWith('data:')) found.add(m[2]); }
  for (const u of found) {
    const d = await toDataURI(abs(u));
    if (d.startsWith('data:')) css = css.split('url(' + u + ')').join('url(' + d + ')').split("url('" + u + "')").join('url(' + d + ')').split('url(\"' + u + '\")').join('url(' + d + ')');
  }
  const doc = document.documentElement.cloneNode(true);
  doc.querySelectorAll('link[rel="stylesheet"], style').forEach(n => n.remove());
  const style = document.createElement('style'); style.textContent = css;
  (doc.querySelector('head') || doc).appendChild(style);
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src');
    if (src && !src.startsWith('data:')) { const d = await toDataURI(abs(src)); if (d.startsWith('data:')) img.setAttribute('src', d); }
    img.removeAttribute('srcset');
  }
  doc.querySelectorAll('script').forEach(n => n.remove());
  // 用 outerHTML 保留 <html> 标签自身属性（暗色主题 class="dark"/data-theme 挂在这里，丢了就变亮色）
  return '<!DOCTYPE html>\\n' + doc.outerHTML;
})()`;
const r = await send('Runtime.evaluate', { expression: serializer, returnByValue: true, awaitPromise: true });
if (r.exceptionDetails) { console.error('✗ 序列化异常:', JSON.stringify(r.exceptionDetails).slice(0, 600)); process.exit(1); }
fs.writeFileSync(OUT + '.html', r.result.value);
ws.close();

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// 3) 可选：Chrome 无头复验图（--verify 时才出，默认跳过省 ~3s）
let verified = false;
if (WANT_VERIFY && fs.existsSync(chrome)) {
  try {
    execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900', `--screenshot=${OUT}.verify.png`, `file://${OUT}.html`], { stdio: 'ignore' });
    verified = true;
  } catch {}
}

// 4) 默认用浏览器打开快照 → 设计师只需再点一下 html.to.design 扩展
//    默认 Arc（html.to.design 扩展装在这里）；可用 SNAPSHOT_BROWSER 覆盖，如 "Google Chrome"
//    用 macOS `open -a`（立即返回；直接调浏览器二进制会阻塞到其退出）
const OPEN_BROWSER = process.env.SNAPSHOT_BROWSER || 'Arc';
let opened = false;
if (!NO_OPEN) {
  try { execFileSync('open', ['-a', OPEN_BROWSER, OUT + '.html'], { stdio: 'ignore' }); opened = true; } catch {}
}

console.log('✓ 快照完成');
console.log('  交付 HTML :', OUT + '.html');
console.log('  客户端原图:', OUT + '.png');
if (verified) console.log('  快照复验图:', OUT + '.verify.png');
if (opened) console.log(`\n✅ 已在 ${OPEN_BROWSER} 打开 → 现在点一下 html.to.design 扩展「导入当前页」即进 Figma。`);
else console.log('\n下一步：用装了 html.to.design 的浏览器打开该 .html → 点扩展「导入当前页」→ 进 Figma。');

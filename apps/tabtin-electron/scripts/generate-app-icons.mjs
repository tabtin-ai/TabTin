#!/usr/bin/env node
/**
 * 从仓库根目录 TabTin-icon.png 一键生成全平台 app 图标资源
 *
 * 输出：
 *   build/icon-source/icon-master.png   完整 1024 PNG（规范化源图）
 *   build/icons/icon.png                1024 PNG（linux + win 走它，electron-builder 自动转 ico）
 *   build/icons/icon.icns               macOS .icns（iconutil 打包）
 *   build/icons/icon-{16..1024}.png     多尺寸 PNG（参考、文档、网页用）
 *   static/icon.png                     1024 PNG（main-app import.meta.url；builder 打进 asar）
 *   ../tabtin-web/public/favicon.png    Web favicon
 *   ../tabtin-www/favicon.png           静态官网 favicon
 *   ../tabtin-ios/.../AppIcon-1024.png  iOS AppIcon
 *   ../tabtin-android/...               Android launcher foreground
 *
 * 调整图标只需替换仓库根目录 TabTin-icon.png 后重跑：
 *   node scripts/generate-app-icons.mjs
 *
 * 设计规范见 docs/app-icon.md
 */

import sharp from 'sharp';
import { execSync } from 'node:child_process';
import {
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(ROOT, '../..');

// ---------- 配置 ----------
const CONFIG = {
  // 完整 app 图标源图。优先使用本地设计交付图，缺失时回退到已入库源图。
  localSourcePng: resolve(REPO_ROOT, 'TabTin-icon.png'),
  trackedSourcePng: resolve(ROOT, 'build/icon-source/icon-master.png'),

  // 输出根目录
  iconSourceDir: resolve(ROOT, 'build/icon-source'),
  iconsDir: resolve(ROOT, 'build/icons'),
  preprodIconPng: resolve(ROOT, 'build/icons/icon-preprod.png'),
  preprodIconIcns: resolve(ROOT, 'build/icons/icon-preprod.icns'),
  preprodStaticIcon: resolve(ROOT, 'static/icon-preprod.png'),
  staticIcon: resolve(ROOT, 'static/icon.png'),
  webFavicon: resolve(REPO_ROOT, 'apps/tabtin-web/public/favicon.png'),
  wwwFavicon: resolve(REPO_ROOT, 'apps/tabtin-www/favicon.png'),
  wwwFaviconIco: resolve(REPO_ROOT, 'apps/tabtin-www/favicon.ico'),
  iosAppIcon: resolve(REPO_ROOT, 'apps/tabtin-ios/Tabtin/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png'),
  iosOddAppIcon: resolve(REPO_ROOT, 'apps/tabtin-ios/tabtin-ios-odd/TabTin/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png'),
  androidForeground: resolve(REPO_ROOT, 'apps/tabtin-android/app/src/main/res/drawable/ic_launcher_foreground.png'),

  // 画布尺寸
  size: 1024,

  // 桌面/Web 图标安全区：图形内缩到画布的 82%，四周留透明外缘。
  // macOS/Windows/Linux Dock/任务栏并排时才与其他 app 图标视觉等大
  // （Apple HIG 安全区 824/1024≈0.805，取 0.82 略留呼吸）。
  // 注意：iOS 走满幅铺白底（系统自动圆角 mask），不套用此安全区。
  safeAreaScale: 0.82,

  // 多尺寸切片（macOS .icns 必需 + Windows .ico 推荐 + 通用）
  sizes: [16, 32, 64, 128, 256, 512, 1024],
};

function resolveSourcePng() {
  if (existsSync(CONFIG.localSourcePng)) {
    return CONFIG.localSourcePng;
  }
  return CONFIG.trackedSourcePng;
}

async function sourceToPng(size, options = {}) {
  const { flattenBackground, contentScale = 1 } = options;

  // 图形先缩放到 size*contentScale，再居中放到 size 透明画布，四周形成安全区外缘。
  const inner = Math.max(1, Math.round(size * contentScale));
  const innerBuffer = await sharp(resolveSourcePng())
    .resize(inner, inner, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      withoutEnlargement: false,
    })
    .png()
    .toBuffer();

  const pad = Math.round((size - inner) / 2);
  let pipeline = sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite([{ input: innerBuffer, top: pad, left: pad }]);

  if (flattenBackground) {
    pipeline = pipeline.flatten({ background: flattenBackground });
  }

  return pipeline.png({ compressionLevel: 9 }).toBuffer();
}

function buildIco(entries) {
  const headerSize = 6;
  const entrySize = 16;
  const directorySize = headerSize + entries.length * entrySize;
  const header = Buffer.alloc(directorySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  let imageOffset = directorySize;
  entries.forEach(({ size, buffer }, index) => {
    const offset = headerSize + index * entrySize;
    header.writeUInt8(size >= 256 ? 0 : size, offset);
    header.writeUInt8(size >= 256 ? 0 : size, offset + 1);
    header.writeUInt8(0, offset + 2);
    header.writeUInt8(0, offset + 3);
    header.writeUInt16LE(1, offset + 4);
    header.writeUInt16LE(32, offset + 6);
    header.writeUInt32LE(buffer.length, offset + 8);
    header.writeUInt32LE(imageOffset, offset + 12);
    imageOffset += buffer.length;
  });

  return Buffer.concat([header, ...entries.map((entry) => entry.buffer)]);
}

/**
 * 将常规桌面图标映射为预发专属的粉色主题；保留原图透明度与明暗层级。
 * 生产图标保持不变，只有 preprod 打包配置会引用该派生产物。
 */
async function tintPreprodPink(pngBuffer) {
  const { data, info } = await sharp(pngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const dark = [157, 23, 77]; // #9D174D，深莓色线稿
  const light = [252, 231, 243]; // #FCE7F3，浅樱粉面板

  for (let index = 0; index < data.length; index += 4) {
    const luminance = (
      data[index] * 0.2126
      + data[index + 1] * 0.7152
      + data[index + 2] * 0.0722
    ) / 255;
    data[index] = Math.round(dark[0] + (light[0] - dark[0]) * luminance);
    data[index + 1] = Math.round(dark[1] + (light[1] - dark[1]) * luminance);
    data[index + 2] = Math.round(dark[2] + (light[2] - dark[2]) * luminance);
  }

  return sharp(data, { raw: info }).png({ compressionLevel: 9 }).toBuffer();
}

function writeIcns(pngBuffers, iconsetDir, icnsPath) {
  rmSync(iconsetDir, { recursive: true, force: true });
  mkdirSync(iconsetDir, { recursive: true });

  const iconsetMap = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ];
  for (const [size, fname] of iconsetMap) {
    writeFileSync(resolve(iconsetDir, fname), pngBuffers[size]);
  }
  execSync(`iconutil -c icns -o "${icnsPath}" "${iconsetDir}"`);
  rmSync(iconsetDir, { recursive: true, force: true });
}

async function main() {
  console.log('→ 检查依赖');
  const sourcePng = resolveSourcePng();
  if (!existsSync(sourcePng)) {
    throw new Error(`找不到源 PNG: ${CONFIG.localSourcePng} 或 ${CONFIG.trackedSourcePng}`);
  }
  console.log(`  ✓ 源图: ${sourcePng}`);
  try {
    execSync('which iconutil', { stdio: 'pipe' });
  } catch {
    throw new Error('未找到 iconutil（macOS 自带），请在 macOS 上运行此脚本');
  }

  mkdirSync(CONFIG.iconSourceDir, { recursive: true });
  mkdirSync(CONFIG.iconsDir, { recursive: true });

  console.log('→ 生成 master PNG (1024)');
  // master 保持满幅规范源（不套安全区），作为缺失本地源图时的回退，避免重复内缩。
  const masterPng = await sourceToPng(CONFIG.size);
  const masterPngPath = resolve(CONFIG.iconSourceDir, 'icon-master.png');
  writeFileSync(masterPngPath, masterPng);
  console.log(`  ✓ ${masterPngPath}`);

  console.log('→ 生成多尺寸 PNG（桌面/Web 套安全区外缘）');
  const pngBuffers = {};
  for (const s of CONFIG.sizes) {
    const buf = await sourceToPng(s, { contentScale: CONFIG.safeAreaScale });
    pngBuffers[s] = buf;
    const file = resolve(CONFIG.iconsDir, `icon-${s}.png`);
    writeFileSync(file, buf);
    console.log(`  ✓ ${file}`);
  }

  console.log('→ 写入主图标 PNG');
  // build/icons/icon.png — Linux 直接用 + Windows electron-builder 会从它生成 .ico
  const iconPng = resolve(CONFIG.iconsDir, 'icon.png');
  writeFileSync(iconPng, pngBuffers[1024]);
  console.log(`  ✓ ${iconPng}`);

  // static/icon.png — main-app.ts 经 import.meta.url 引用；package.json build.files 打进 asar
  writeFileSync(CONFIG.staticIcon, pngBuffers[1024]);
  console.log(`  ✓ ${CONFIG.staticIcon}`);

  console.log('→ 同步 Web / 移动端图标');
  writeFileSync(CONFIG.webFavicon, pngBuffers[64]);
  console.log(`  ✓ ${CONFIG.webFavicon}`);
  writeFileSync(CONFIG.wwwFavicon, pngBuffers[64]);
  console.log(`  ✓ ${CONFIG.wwwFavicon}`);
  writeFileSync(CONFIG.wwwFaviconIco, buildIco([
    { size: 16, buffer: pngBuffers[16] },
    { size: 32, buffer: pngBuffers[32] },
    { size: 64, buffer: pngBuffers[64] },
  ]));
  console.log(`  ✓ ${CONFIG.wwwFaviconIco}`);
  const iosAppIcon = await sourceToPng(1024, { flattenBackground: '#FFFFFF' });
  writeFileSync(CONFIG.iosAppIcon, iosAppIcon);
  console.log(`  ✓ ${CONFIG.iosAppIcon}`);
  writeFileSync(CONFIG.iosOddAppIcon, iosAppIcon);
  console.log(`  ✓ ${CONFIG.iosOddAppIcon}`);
  writeFileSync(CONFIG.androidForeground, await sourceToPng(432));
  console.log(`  ✓ ${CONFIG.androidForeground}`);

  console.log('→ 生成 macOS .icns');
  // iconset 是一个特定命名规范的文件夹：iconutil 会把它转成 .icns。
  const iconsetDir = resolve(CONFIG.iconsDir, 'icon.iconset');
  const icnsPath = resolve(CONFIG.iconsDir, 'icon.icns');
  writeIcns(pngBuffers, iconsetDir, icnsPath);
  console.log(`  ✓ ${icnsPath}`);

  console.log('→ 生成预发专属粉色图标');
  const preprodPngBuffers = {};
  for (const size of CONFIG.sizes) {
    preprodPngBuffers[size] = await tintPreprodPink(pngBuffers[size]);
  }
  writeFileSync(CONFIG.preprodIconPng, preprodPngBuffers[1024]);
  writeFileSync(CONFIG.preprodStaticIcon, preprodPngBuffers[1024]);
  writeIcns(
    preprodPngBuffers,
    resolve(CONFIG.iconsDir, 'icon-preprod.iconset'),
    CONFIG.preprodIconIcns,
  );
  console.log(`  ✓ ${CONFIG.preprodIconPng}`);
  console.log(`  ✓ ${CONFIG.preprodIconIcns}`);
  console.log(`  ✓ ${CONFIG.preprodStaticIcon}`);

  console.log('\n✅ 全部完成。');
  console.log('   - mac:   build/icons/icon.icns');
  console.log('   - win:   build/icons/icon.png  (electron-builder 自动转 .ico)');
  console.log('   - linux: build/icons/icon.png');
  console.log('   - preprod: build/icons/icon-preprod.{png,icns}');
  console.log('   - pack:  static/icon.png      (main-app import.meta.url + build.files)');
  console.log('   - web:   apps/tabtin-web/public/favicon.png');
  console.log('   - www:   apps/tabtin-www/favicon.png + favicon.ico');
  console.log('   - ios:   apps/tabtin-ios/**/AppIcon-1024.png');
  console.log('   - android: apps/tabtin-android/**/ic_launcher_foreground.png');
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});

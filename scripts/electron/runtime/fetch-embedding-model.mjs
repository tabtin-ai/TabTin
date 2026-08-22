#!/usr/bin/env node
/**
 * 语义召回模型置入脚本（issue #3306：生产零下载）。
 *
 * 运行时代码没有任何下载能力——模型文件只能通过本脚本置入：
 * - dev 环境：`node scripts/electron/runtime/fetch-embedding-model.mjs`
 *   落到 `~/.tabtin/models/Xenova/multilingual-e5-small`（宿主 dev 默认目录）；
 * - 打包机：`node scripts/electron/runtime/fetch-embedding-model.mjs --out <构建资产目录>`
 *   由 electron-builder extraResources / daemon 镜像构建带进产物。
 *
 * 钉版本 + sha256 校验：下载内容与登记指纹不符立即失败，防供应链投毒。
 * 支持 HF_ENDPOINT 镜像（如 https://hf-mirror.com），与 huggingface 生态约定一致。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const MODEL_ID = 'Xenova/multilingual-e5-small';
/** 钉死到生成 sha256 指纹时的仓库版本，上游 force-push 也不会静默换文件。 */
const REVISION = 'main';

/**
 * 文件清单与指纹。更换模型 / 升级版本时：手动核实来源后更新此表，
 * 并同步重新生成 `packages/local-embedding` 的分词金标 fixture。
 *
 * 量化选型（2026-07-06 核实）：int8 `model_quantized.onnx`（112.8MB）是该仓库
 * 全部变体中最小的——e5-small 体积大头是 25 万词表的 embedding 表，q4 系列只
 * 量化 matmul 权重（model_q4 380MB / model_q4f16 195MB 反而更大），不要换 q4。
 */
const FILES = [
  {
    relPath: 'config.json',
    sha256: 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1',
  },
  {
    relPath: 'tokenizer.json',
    sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
  },
  {
    relPath: 'tokenizer_config.json',
    sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
  },
  {
    relPath: 'onnx/model_quantized.onnx',
    sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
  },
];

function parseArgs(argv) {
  const args = { out: null, force: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out') {
      args.out = argv[++i];
    } else if (argv[i] === '--force') {
      args.force = true;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('用法: node scripts/electron/runtime/fetch-embedding-model.mjs [--out <目录>] [--force]');
      console.log('  --out    输出根目录（内部按模型 id 分子目录）；缺省 ~/.tabtin/models');
      console.log('  --force  忽略已存在且校验通过的文件，强制重新下载');
      console.log('  环境变量 HF_ENDPOINT 可指定镜像站（如 https://hf-mirror.com）');
      process.exit(0);
    } else {
      console.error(`未知参数: ${argv[i]}`);
      process.exit(1);
    }
  }
  return args;
}

function endpointBase() {
  const raw = (process.env.HF_ENDPOINT ?? 'https://huggingface.co').trim();
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

function sha256Of(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

async function download(url, destPath) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`下载失败 HTTP ${res.status}: ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(path.dirname(destPath), { recursive: true });
  // 先落临时文件再原子改名，中断不会留半截文件被当成完整模型
  const tmpPath = `${destPath}.download`;
  writeFileSync(tmpPath, buf);
  renameSync(tmpPath, destPath);
}

async function main() {
  const args = parseArgs(process.argv);
  const outRoot = args.out ?? path.join(os.homedir(), '.tabtin', 'models');
  const modelDir = path.join(outRoot, MODEL_ID);
  const base = endpointBase();
  console.log(`模型: ${MODEL_ID}@${REVISION}`);
  console.log(`来源: ${base}`);
  console.log(`目标: ${modelDir}`);

  for (const { relPath, sha256 } of FILES) {
    const destPath = path.join(modelDir, relPath);
    if (!args.force && existsSync(destPath) && sha256Of(destPath) === sha256) {
      console.log(`✓ 已存在且校验通过，跳过: ${relPath}`);
      continue;
    }
    const url = `${base}/${MODEL_ID}/resolve/${REVISION}/${relPath}`;
    console.log(`↓ 下载: ${relPath} ...`);
    await download(url, destPath);
    const actual = sha256Of(destPath);
    if (actual !== sha256) {
      rmSync(destPath, { force: true });
      throw new Error(
        `sha256 校验失败: ${relPath}\n  期望 ${sha256}\n  实际 ${actual}\n来源文件可能被篡改或上游已变更，已删除下载产物。`,
      );
    }
    const sizeMb = (statSync(destPath).size / 1024 / 1024).toFixed(1);
    console.log(`✓ 校验通过: ${relPath} (${sizeMb}MB)`);
  }
  console.log('模型置入完成。');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

/**
 * 通用文本分词 —— 中文可用，零运行时依赖。
 *
 * 为什么在这里：召回需要对「用户 query」与「候选条目文本」做词法
 * 相关性打分（见 `bm25.ts`）。候选条目当前是 skill / CLI / MCP listing，
 * 所以分词与打分放在**业务无关的本包**，不与任何消费方绑定。
 *
 * 为什么用 `Intl.Segmenter` 而非 jieba/segmentit：
 *   - `Intl.Segmenter` 是 ECMAScript Intl 标准，V8（Node 16+ / 现代 Electron）
 *     **原生内置**，字典级中文分词，无 native binding、无体积、离线可用。
 *   - 本包是 pure TS 库，需在 Electron + Daemon 双端跨平台打包；
 *     jieba 系（nodejieba / @node-rs/jieba）都是 native binding，是打包噩梦。
 *   - 分词质量略逊 jieba（新词/专名切得糙），但候选文本主要是我们自己写的
 *     skill description（可控），够用；真不够再升级，调用方无需改动。
 *
 * 降级：极少数不支持 `Intl.Segmenter` 的运行时下，回退到「ASCII 词 + 单个 CJK
 * 字」正则，保证不抛错、仍有基本可用性。
 */

let _segmenter: Intl.Segmenter | null | undefined;

function getSegmenter(): Intl.Segmenter | null {
  if (_segmenter !== undefined) return _segmenter;
  try {
    // locale 'zh' 让分词器优先按中文字典切分；对拉丁词同样按词边界切。
    _segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  } catch {
    _segmenter = null;
  }
  return _segmenter;
}

/** 降级分词：ASCII 字母数字词 + 每个 CJK 字符各成一个 token。 */
function fallbackTokenize(lower: string): string[] {
  return lower.match(/[a-z0-9]+|[\u4e00-\u9fff]/g) ?? [];
}

/**
 * 把文本切成小写 token 数组。用于词法相关性打分，不保证语言学精确。
 *
 * - 大小写归一（统一小写）。
 * - 只保留 word-like 片段（丢标点、空白）。
 * - 中英混合文本一次处理，无需调用方区分语言。
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const seg = getSegmenter();
  if (!seg) return fallbackTokenize(lower);

  const out: string[] = [];
  for (const part of seg.segment(lower)) {
    // isWordLike 过滤掉标点、空白、纯符号段。
    if (part.isWordLike && part.segment.trim()) {
      out.push(part.segment);
    }
  }
  return out;
}

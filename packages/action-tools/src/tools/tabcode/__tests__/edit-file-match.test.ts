/**
 * Regression for Wave 1（2026-05-09）：edit_file 协议矫正
 *
 * 业务目标：让 LLM（特别是 Kimi/GLM 这类非原生训练分布模型）调 `edit_file` 时不再
 * 因为"首尾锚定中间不校验"的三级匹配返回假阳性 success 而进入 hallucination
 * 循环；撞 `OLD_STRING_NOT_FOUND` 时拿到能直接自纠错的反馈（回显自己写的 old_string）。
 *
 * 关键不变量：
 *   1. Tier 1 (exact) 整体 indexOf —— hit 后返 strategy='exact'
 *   2. Tier 2 (line_trimmed) 整体逐行 trim 比对 —— 必须**所有行**都对得上
 *   3. **没有** Tier 3 (block-anchor) —— 首末锚定 + 中间不校验是 hallucination 假阳性的元凶
 *   4. 失败错误文案须符合标准错误反馈，**回显 LLM 给的 old_string**
 *   5. 写入前最后保险栓 `if (newContent === content) fail` —— 内容未变则失败（写入前保险栓）
 *
 * 触发起源：dogfood session（让 Kimi 2.5 把 305 行 calculator.html 改黑白配色）
 * 撞到 hallucination case：Kimi 给的 old_string 首末两行命中 `.operator { … }`
 * 边界，中间是 hallucinated 的 `.clear` `.delete` 类不存在的 CSS。block-anchor
 * 返回假阳性 success 让 LLM 持续走错路径。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// standardizeLegacyResult 默认会把失败 result.error 包装成 ToolError 对象（含 code/message/...）。
// 本测试关心的是工具产出的"原始错误字符串"——LLM 在 envelope 里拿到的最终文本。
// identity mock 让 result.error 保持字符串形态，便于直接 contain 断言。
vi.mock('../../../utils/tool-output', () => ({
  standardizeLegacyResult: (r: any) => r,
}));

import { fileEditTool } from '../index';

let tmpDir: string;

beforeEach(async () => {
  // macOS realpath 让 /var/folders 与 /private/var/folders 一致，避免 boundary 误判
  const raw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'edit-match-'));
  tmpDir = await fsPromises.realpath(raw);
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

async function writeFile(name: string, content: string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fsPromises.writeFile(p, content, 'utf8');
  return p;
}

describe('edit_file 两级匹配（exact / line_trimmed）协议', () => {
  describe('Tier 1 — exact match', () => {
    it('整段精确匹配 → success + match_strategy=exact', async () => {
      const file = await writeFile('a.css', '.button { color: red; }\n');
      const res = await fileEditTool.execute({
        path: file,
        old_string: '.button { color: red; }',
        new_string: '.button { color: blue; }',
      });
      expect(res.success).toBe(true);
      expect(res.data?.match_strategy).toBe('exact');
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe('.button { color: blue; }\n');
    });

    it('多行精确匹配 → success', async () => {
      const file = await writeFile(
        'multiline.ts',
        'function add(a: number, b: number) {\n  return a + b;\n}\n',
      );
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'function add(a: number, b: number) {\n  return a + b;\n}',
        new_string: 'function add(a: number, b: number) {\n  return a - b;\n}',
      });
      expect(res.success).toBe(true);
      expect(res.data?.match_strategy).toBe('exact');
      // P0-2: 全文件内容断言（不只是 toContain）—— 防同款 P0-1 拼接错乱回归
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe('function add(a: number, b: number) {\n  return a - b;\n}\n');
    });
  });

  describe('Tier 2 — line_trimmed match (空白漂移容忍)', () => {
    it('每行去掉首尾空白后逐行精确对应 → success + match_strategy=line_trimmed', async () => {
      const file = await writeFile(
        'b.ts',
        '  function foo() {\n    return 1;\n  }\n',
      );
      const res = await fileEditTool.execute({
        path: file,
        // LLM 复制时丢失缩进——line_trimmed 仍能命中
        old_string: 'function foo() {\nreturn 1;\n}',
        new_string: 'function foo() {\n    return 2;\n  }',
      });
      expect(res.success).toBe(true);
      expect(res.data?.match_strategy).toBe('line_trimmed');
      // P0-2: 全文件内容断言。注意 line_trimmed 命中替换后**外层缩进 + 末尾 \n 都会被
      // matchedText 吞掉** —— 这是 line_trimmed 协议的已知行为：matchedText 含原缩进
      // `  function foo() {\n    return 1;\n  }\n`（包括 trailing \n），整段被
      // `new_string=function foo() {\n    return 2;\n  }`（无 trailing \n）替换。
      // 这里钉死实际产出，让 LLM / 调用方对此行为有明确预期。
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe('function foo() {\n    return 2;\n  }');
    });

    it('行尾空格漂移 → 仍能 line_trimmed 命中', async () => {
      const file = await writeFile('trail.txt', 'hello   \nworld   \n');
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'hello\nworld',
        new_string: 'goodbye\nuniverse',
      });
      expect(res.success).toBe(true);
      expect(res.data?.match_strategy).toBe('line_trimmed');
      // P0-2: 完整内容断言。同理 line_trimmed 替换会吞 matchedText 的 trailing \n。
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe('goodbye\nuniverse');
    });
  });

  describe('hallucinated middle content 必须 fail（calculator regression）', () => {
    it('首末两行命中真实 .operator block，中间塞不存在的 .fake_class → OLD_STRING_NOT_FOUND', async () => {
      // 重现 Kimi calculator case：原文件有真实的 `.operator { background: ...#fa709a... }`，
      // 但 LLM 凭虚构记忆给了一个 old_string —— 首行 `.operator {`、末行 `}` 都命中，
      // 中间却塞了一个原文件根本不存在的 CSS 规则。
      const original = `.button {
  background: linear-gradient(135deg, #f093fb 0%, #fa709a 100%);
  color: white;
}
.operator {
  background: linear-gradient(135deg, #fa709a 0%, #fee140 100%);
  color: white;
  font-weight: bold;
}
.equals {
  background: #4caf50;
}
`;
      const file = await writeFile('calc.css', original);

      const hallucinatedOldString = `.operator {
  background: linear-gradient(135deg, #f093fb 0%, #fa709a 100%);
  color: white;
  font-weight: bold;
}`;

      const res = await fileEditTool.execute({
        path: file,
        old_string: hallucinatedOldString,
        new_string: '.operator { background: black; color: white; }',
      });

      expect(res.success).toBe(false);
      const errStr = String(res.error);
      // 标准错误反馈文案
      expect(errStr).toContain('String to replace not found in file');
      // 回显 LLM 给的 old_string —— LLM 看到自己写的字符串就能比对原文自纠错
      expect(errStr).toContain('#f093fb'); // hallucinate 出来的颜色码

      // 文件未被改动
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe(original);
    });

    it('多行 block 首末行匹配但中间行有 hallucinated 标识符 → fail', async () => {
      const original = `function abc() {
  const a = 1;
  const b = 2;
  const c = 3;
  return a + b + c;
}
`;
      const file = await writeFile('block.ts', original);
      // LLM 给的 old_string：首行 `function abc() {` 末行 `}` 都对，中间却是虚构的标识符
      const hallucinated = `function abc() {
  const HALLUCINATED_THING = 999;
  const ANOTHER_FAKE = 'oops';
  return a + b + c;
}`;
      const res = await fileEditTool.execute({
        path: file,
        old_string: hallucinated,
        new_string: 'function abc() { return 0; }',
      });
      expect(res.success).toBe(false);
      const errStr = String(res.error);
      expect(errStr).toContain('not found in file');
      expect(errStr).toContain('HALLUCINATED_THING'); // 回显
      // P0-2: 完整文件内容断言（文件必须**字节级**未变）
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe(original);
    });

    it('单行边界看似一致但内嵌字符不同 → fail（regression for #fa709a vs #f093fb）', async () => {
      const original = `.operator {
  background: linear-gradient(135deg, #fa709a 0%, #fee140 100%);
}
`;
      const file = await writeFile('single.css', original);
      // LLM 把颜色码 hallucinate 错了
      const res = await fileEditTool.execute({
        path: file,
        old_string: `.operator {
  background: linear-gradient(135deg, #f093fb 0%, #fee140 100%);
}`,
        new_string: '.operator { background: black; }',
      });
      expect(res.success).toBe(false);
      const errStr = String(res.error);
      expect(errStr).toContain('not found in file');
      // P0-2: 完整文件内容断言
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe(original);
    });
  });

  describe('错误反馈对 LLM 自纠错友好（标准错误反馈文案）', () => {
    it('OLD_STRING_NOT_FOUND 错误必须回显 old_string', async () => {
      const file = await writeFile('d.txt', 'hello world\n');
      const oldStr = 'NONEXISTENT_TOKEN_THAT_DOES_NOT_APPEAR';
      const res = await fileEditTool.execute({
        path: file,
        old_string: oldStr,
        new_string: 'replacement',
      });
      expect(res.success).toBe(false);
      const errStr = String(res.error);
      expect(errStr).toContain('String to replace not found in file');
      expect(errStr).toContain(oldStr); // 回显
    });

    it('多匹配 + replace_all=false 错误必须含标准错误反馈文案 + 回显 + 双解决方案', async () => {
      const file = await writeFile('e.txt', 'foo\nfoo\nfoo\n');
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'foo',
        new_string: 'bar',
      });
      expect(res.success).toBe(false);
      const errStr = String(res.error);
      expect(errStr).toContain('Found 3 matches');
      expect(errStr).toContain('replace_all is false');
      expect(errStr).toContain('set replace_all to true'); // 解决方案 1
      expect(errStr).toContain('more context to uniquely identify'); // 解决方案 2
      expect(errStr).toContain('foo'); // 回显 old_string
    });

    it('多匹配错误**不**含旧版 "is not unique" 字眼', async () => {
      const file = await writeFile('e2.txt', 'foo\nfoo\n');
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'foo',
        new_string: 'bar',
      });
      expect(res.success).toBe(false);
      const errStr = String(res.error);
      // 旧文案残留 sentinel —— 防止有人手抖恢复回去
      expect(errStr).not.toContain('is not unique');
    });

    it('not_found 错误**不**含旧版"tried exact, line-trimmed, and block-anchor matching"字眼', async () => {
      const file = await writeFile('e3.txt', 'hello world\n');
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'NONEXISTENT',
        new_string: 'x',
      });
      expect(res.success).toBe(false);
      const errStr = String(res.error);
      // 旧文案残留 sentinel —— 防止 block-anchor 描述被偷偷写回来
      expect(errStr).not.toContain('block-anchor');
      expect(errStr).not.toContain('tried exact');
    });
  });

  // 2026-05-10 R1 复核新增（W1-LL-8/9 维度 6）：
  // action-tools 5 处 set error_code 直接断言。
  // 旧测试只断 message phrase，没断 envelope 的 error_code 字段——如果有人
  // 未来手抖把 ToolErrorCode 写错（比如复制粘贴 bug 写成 INVALID_PARAMETER），
  // 现有测试都会通过（因为它们走的是 phrase 路径在 adapter 层兜底）。
  // 这组测试钉死"action-tools 这层就 set 了 error_code"的契约——code 优先
  // 路径在产品 dogfood 时才能真正生效。
  describe('R1 — error_code 显式设置（W1-LL-8/9 dogfood 契约）', () => {
    it('单次替换 not found → error_code = "old_string_not_found"', async () => {
      const file = await writeFile('ec1.txt', 'hello world\n');
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'NONEXISTENT',
        new_string: 'x',
      });
      expect(res.success).toBe(false);
      expect((res as { error_code?: string }).error_code).toBe('old_string_not_found');
    });

    it('单次替换 exact 多匹配 → error_code = "old_string_not_unique"', async () => {
      const file = await writeFile('ec2.txt', 'foo\nfoo\n');
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'foo',
        new_string: 'bar',
      });
      expect(res.success).toBe(false);
      expect((res as { error_code?: string }).error_code).toBe('old_string_not_unique');
    });

    it('单次替换 line_trimmed 多匹配 → error_code = "old_string_not_unique"', async () => {
      // 文件多处同样行结构（缩进不同）+ LLM 给无缩进 old_string → line_trimmed 多匹配
      const file = await writeFile(
        'ec3.txt',
        'function a() {\n  let x = 1;\n}\nfunction b() {\n  let x = 1;\n}\n',
      );
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'let x = 1;',
        new_string: 'let x = 2;',
      });
      expect(res.success).toBe(false);
      expect((res as { error_code?: string }).error_code).toBe('old_string_not_unique');
    });

    it('replace_all=true not found → error_code = "old_string_not_found"', async () => {
      const file = await writeFile('ec4.txt', 'hello world\n');
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'NONEXISTENT_IN_REPLACE_ALL',
        new_string: 'x',
        replace_all: true,
      });
      expect(res.success).toBe(false);
      expect((res as { error_code?: string }).error_code).toBe('old_string_not_found');
    });

    it('单次替换 newContent === content (line_trimmed 命中后 LLM 复制原文) → error_code = "old_string_not_found"（与 replace_all 同款保险栓对称）', async () => {
      // 触发 line_trimmed + newContent === content 必须满足：
      //   1. old_string 不 exact 命中（避免单行 substring 匹配 + OLD_NEW_IDENTICAL 短路绕开）
      //   2. line_trimmed 命中 → matchedText 是含原始缩进的真实行
      //   3. new_string 等于 matchedText 字面（含缩进）→ 替换后 newContent === content
      // 构造：多行 + 不同缩进，old_string 给无缩进版让 exact miss → 走 line_trimmed。
      const file = await writeFile(
        'ec5.txt',
        '  function foo() {\n    return 1;\n  }\n',
      );
      // findMatch 的 line_trimmed 算法把每行 length+1（含 \n）累加到 endChar，
      // 所以 matchedText 末尾**含 \n**（不仅是行内容）。new_string 必须同样含末尾 \n
      // 才能 newContent === content。
      const matchedText = '  function foo() {\n    return 1;\n  }\n';
      const res = await fileEditTool.execute({
        path: file,
        // 全无缩进（每行 trim 后逐行等于文件中的 trimmed 行）→ exact miss → line_trimmed 命中
        old_string: 'function foo() {\nreturn 1;\n}',
        new_string: matchedText, // 复制 matchedText（含原始缩进 + 末尾 \n）—— 替换后 noop
      });
      expect(res.success).toBe(false);
      expect(String(res.error)).toContain('Original and edited file match exactly');
      expect((res as { error_code?: string }).error_code).toBe('old_string_not_found');
    });
  });

  describe('行为短路 / 输入校验', () => {
    it('old_string === new_string → 提前拒绝', async () => {
      const file = await writeFile('g.txt', 'foo bar\n');
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'foo',
        new_string: 'foo',
      });
      expect(res.success).toBe(false);
      const errStr = String(res.error).toLowerCase();
      expect(errStr).toContain('different');
    });

    it('path 缺失 → INVALID_PARAMETER', async () => {
      const res = await fileEditTool.execute({
        path: '',
        old_string: 'x',
        new_string: 'y',
      });
      expect(res.success).toBe(false);
      expect(String(res.error)).toContain('path');
    });

    it('文件不存在 → 错误（不抛 panic）', async () => {
      const nonExistent = path.join(tmpDir, 'does-not-exist-anywhere.txt');
      const res = await fileEditTool.execute({
        path: nonExistent,
        old_string: 'x',
        new_string: 'y',
      });
      expect(res.success).toBe(false);
      // ENOENT 文案因 OS 不同小有差异，但一定不是 success / 一定不会抛异常
    });
  });

  describe('保险栓（newContent === content fallback）', () => {
    it('正常 line_trimmed 替换写入实际改动 → success（保险栓不误伤）', async () => {
      const file = await writeFile('h.txt', '  hello\n');
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'hello',
        new_string: 'world',
      });
      expect(res.success).toBe(true);
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe('  world\n');
    });

    it('replace_all=true 路径下成功改动 → 不被保险栓拦截', async () => {
      const file = await writeFile('h2.txt', 'foo\nfoo\nfoo\n');
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'foo',
        new_string: 'bar',
        replace_all: true,
      });
      expect(res.success).toBe(true);
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe('bar\nbar\nbar\n');
    });

    it('line_trimmed 命中后 new_string 等于实际 matchedText（含原缩进）→ 保险栓真触发', async () => {
      // 这是保险栓**真实可触发**的 case，不是 edge case：
      // LLM 重读 file 后把整段 paste 当 new_string，又给了无缩进的 old_string，
      // line_trimmed 命中 matchedText="  hello\n  world\n"（含原缩进），
      // 拼出的 newContent === content → 保险栓拦下，不写入空 diff。
      const file = await writeFile('noop.ts', '  hello\n  world\n');
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'hello\nworld', // LLM 简化版，无缩进
        new_string: '  hello\n  world\n', // LLM 给的"复读"——恰好等于 matchedText
      });
      expect(res.success).toBe(false);
      const errStr = String(res.error);
      expect(errStr).toContain('Original and edited file match exactly');
      expect(errStr).toContain('Failed to apply edit');
      // 文件保持原状
      expect(await fsPromises.readFile(file, 'utf8')).toBe('  hello\n  world\n');
    });
  });

  describe('P0-1 regression: replace_all=true 只接受 exact 命中，line_trimmed 不参与', () => {
    // 2026-05-09 Wave 1 复核（独立验证 Agent + harness）发现：
    // 让 replace_all=true 享受 line_trimmed 容错（前一轮 F4）会引入"matchedText 跟
    // input.old_string 长度/边界不一致 + split-join 在两段拼接处粘连"的输出错乱 bug。
    // 复现：file `'  hello\n  world\n  hello\n  world\n'` + old `'hello\nworld'` +
    // new `'hi\nthere'` + replace_all=true → 旧实现产出 `'hi\ntherehi\nthere'`（行
    // 结构破坏，单词意外粘连）。
    //
    // 修法 C（保守策略）：replace_all=true 只接受 Tier 1 exact 命中，
    // 找不到时直接 fail with `String to replace not found in file`，让 LLM 重写
    // 带正确缩进的 old_string 走 exact 路径。

    it('文件多行同缩进 + LLM 给无缩进多行 old_string + replace_all=true → fail with 标准错误文案（不输出错乱）', async () => {
      // 这是 harness 给的具体复现 case，必须钉死
      const original = '  hello\n  world\n  hello\n  world\n';
      const file = await writeFile('p0_1_main_regression.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'hello\nworld', // LLM 给的多行无缩进
        new_string: 'hi\nthere',
        replace_all: true,
      });
      // 关键断言：必须 fail，不能 success（success 等于错乱输出 'hi\ntherehi\nthere'）
      expect(res.success).toBe(false);
      const errStr = String(res.error);
      expect(errStr).toContain('String to replace not found in file');
      expect(errStr).toContain('hello\nworld'); // 回显 old_string
      // 文件必须**字节级**未变（不能是 'hi\ntherehi\nthere' 错乱输出）
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe(original);
    });

    it('文件单处缩进 + LLM 给无缩进 old_string + replace_all=true → fail（同款防御）', async () => {
      // line_trimmed 命中单处也不能让 replace_all=true 走通——因为这条路径有产出错乱风险
      const original = '  hello world\n';
      const file = await writeFile('p0_1_single.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'hello world',
        new_string: 'goodbye world',
        replace_all: true,
      });
      // exact: '  hello world\n'.includes('hello world') 是 true（因为 'hello world' 是子串）
      // → 这条 case 实际走 exact 路径成功，不撞 P0-1
      // 这里钉死的是 exact substring 命中行为：
      expect(res.success).toBe(true);
      expect(res.data?.match_strategy).toBe('exact');
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe('  goodbye world\n');
    });

    it('替换前后内容字节级一致（防 line_trimmed 协议被静默"恢复"回去）', async () => {
      // 反向 sentinel：如果有人未来把 P0-1 修订改回去（让 replace_all=true 走 line_trimmed），
      // 那么本测试组其他 case 不一定 catch（因为多匹配数 + 输出形态测试已经在上面）。
      // 这条额外加：通过断言"replace_all=true + 多行无缩进"始终 fail，作为
      // **协议层面 sentinel**——即使有人把 findMatch 签名改了，这个不变量不能被破坏。
      const original = `function add(a, b) {
  return a + b;
}
function add(a, b) {
  return a + b;
}
`;
      const file = await writeFile('p0_1_protocol_sentinel.ts', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'function add(a, b) {\nreturn a + b;\n}', // 无缩进版
        new_string: 'function add(a, b) {\n  return a - b;\n}',
        replace_all: true,
      });
      expect(res.success).toBe(false);
      expect(String(res.error)).toContain('not found in file');
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe(original);
    });
  });

  describe('P1 regression: line_trimmed 多匹配 uniqueness 检查', () => {
    // 2026-05-09 Wave 1 复核：findMatch 命中 line_trimmed 后只返第一处，跟 exact
    // 路径"多匹配 → 报错"待遇不一致。LLM 给无缩进 old_string、文件多处同行结构 →
    // 静默替换第一处，跟"首尾锚定中间不校验"假阳性 success 是同款 hallucination 路径。
    //
    // 修法：findMatch 扫完整文件统计 lineTrimmedMatchCount；execute 在 line_trimmed
    // 命中时若 count > 1 且 replace_all=false → 报错（多匹配文案）。

    it('line_trimmed 命中 ≥ 2 处 + replace_all=false → fail with 多匹配文案 + 回显', async () => {
      const original = `function foo() {
  let x = 1;
  return x;
}
function bar() {
  let x = 1;
  return x;
}
`;
      const file = await writeFile('p1_line_trimmed_multi.ts', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'let x = 1;\nreturn x;', // LLM 无缩进，line_trimmed 在 foo / bar 内各命中一处
        new_string: 'let y = 2;\nreturn y;',
      });
      expect(res.success).toBe(false);
      const errStr = String(res.error);
      // **W5 收尾轮 reviewer 修订（2026-05-12）**：line_trimmed 多匹配错误文案
      // 不再让 Agent "set replace_all=true"（replace_all 路径只接受 exact，会让
      // Agent 陷入死循环）；改成"提供更多上下文 + 提示 replace_all 要 byte-exact"。
      expect(errStr).toContain('Found 2 matches');
      expect(errStr).toContain('whitespace normalization'); // 明示是 fuzzy 路径
      expect(errStr).toContain('more surrounding context'); // 解决路径
      expect(errStr).toContain("requires byte-exact"); // 防 Agent 误用 replace_all
      expect(errStr).toContain('let x = 1;'); // 回显 old_string
      // 旧 misleading 文案残留 sentinel —— 防止有人手抖恢复
      expect(errStr).not.toContain('set replace_all to true');
      // 文件未被改动
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe(original);
    });

    it('line_trimmed 多匹配 + 用户 set replace_all=true → 仍 fail（exact 找不到）', async () => {
      // 这是 P0-1 + P1 的预期联动：line_trimmed 多匹配 → LLM 看到多匹配文案
      // → 试图 set replace_all=true → 撞 P0-1 only-exact 路径 → 因 line_trimmed
      // 命中的根因就是 LLM 给的 old_string 字面不在文件 → fail with 'not found in file'。
      // 这条 double-fail 引导 LLM 重写带正确缩进的 old_string，是预期行为。
      const original = `function foo() {
  let x = 1;
  return x;
}
function bar() {
  let x = 1;
  return x;
}
`;
      const file = await writeFile('p1_double_fail.ts', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'let x = 1;\nreturn x;',
        new_string: 'let y = 2;\nreturn y;',
        replace_all: true,
      });
      expect(res.success).toBe(false);
      expect(String(res.error)).toContain('not found in file');
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe(original);
    });

    it('line_trimmed 命中**单处** + replace_all=false → 仍能 success（uniqueness 不误伤）', async () => {
      // 防御性：P1 多匹配检查不能误伤合法的 line_trimmed 单匹配路径
      const original = '  hello\n  world\n';
      const file = await writeFile('p1_single_line_trimmed.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'hello\nworld',
        new_string: 'hi\nthere',
      });
      expect(res.success).toBe(true);
      expect(res.data?.match_strategy).toBe('line_trimmed');
      expect(res.data?.replacements).toBe(1);
      const after = await fsPromises.readFile(file, 'utf8');
      // 注：line_trimmed 命中替换会丢外层缩进（matchedText='  hello\n  world\n' 整段被
      // new_string 覆盖）—— 这是已知协议行为，钉死边界
      expect(after).toBe('hi\nthere');
    });
  });

  describe('replace_all 基础行为', () => {
    it('replace_all=true exact 多次替换正确 + match_strategy=exact + 完整文件内容', async () => {
      const file = await writeFile('r.txt', 'a\na\na\n');
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'a',
        new_string: 'b',
        replace_all: true,
      });
      expect(res.success).toBe(true);
      expect(res.data?.replacements).toBe(3);
      expect(res.data?.match_strategy).toBe('exact');
      // P0-2: 完整内容断言
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe('b\nb\nb\n');
    });

    it('replace_all=true 但 old_string 找不到 → 文案须回显 old_string', async () => {
      const original = 'hello\n';
      const file = await writeFile('r2.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'NONEXISTENT_IN_REPLACE_ALL',
        new_string: 'x',
        replace_all: true,
      });
      expect(res.success).toBe(false);
      const errStr = String(res.error);
      expect(errStr).toContain('String to replace not found in file');
      expect(errStr).toContain('NONEXISTENT_IN_REPLACE_ALL');
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe(original);
    });

    it('replace_all=true exact 命中含原缩进的多处 → 全部成功替换', async () => {
      // 这条 case：LLM 给带正确缩进的 old_string + replace_all=true → exact 命中 N 处
      // 是 P0-1 修后的"正确路径"——LLM 必须自己保证 old_string 字面在文件里
      const original = '  color: white;\n  color: white;\n  color: white;\n';
      const file = await writeFile('r3.css', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: '  color: white;', // 带缩进
        new_string: '  color: black;',
        replace_all: true,
      });
      expect(res.success).toBe(true);
      expect(res.data?.replacements).toBe(3);
      expect(res.data?.match_strategy).toBe('exact');
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe('  color: black;\n  color: black;\n  color: black;\n');
    });
  });

  // ─── W5 (2026-05-12) 4 级 fuzzy 端到端 ─────────────────────────────────
  //
  // findActualString 模块单测覆盖了 normalize / 反向映射的字节级正确性
  // (`edit-fuzzy.test.ts`)。本块覆盖 fileEditTool 的 e2e 行为：fuzzy 命中后
  // 文件真的被改、match_strategy 字段返新值、原文件字符规范保持。
  describe('W5 4 级精准 fuzzy 命中（e2e）', () => {
    it('Level 2 curly quote：文件 curly + LLM ASCII → 命中且文件保持 curly', async () => {
      const original = `say \u201Chello\u201D and goodbye\n`;
      const file = await writeFile('w5_curly.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'say "hello"',
        new_string: 'say "world"',
      });
      expect(res.success).toBe(true);
      expect(res.data?.match_strategy).toBe('curly_quote');
      const after = await fsPromises.readFile(file, 'utf8');
      // new_string ASCII → 写入后该位置变成 ASCII（保留文件其他位置 curly 不变）
      expect(after).toBe(`say "world" and goodbye\n`);
    });

    it('Level 3 whitespace：文件 tab + LLM 4 spaces → 命中且文件保持 tab', async () => {
      const original = '\tfoo();\n\treturn 1;\n';
      const file = await writeFile('w5_tab.py', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: '    foo();', // 4 spaces 版
        new_string: '    bar();',
      });
      expect(res.success).toBe(true);
      expect(res.data?.match_strategy).toBe('whitespace');
      const after = await fsPromises.readFile(file, 'utf8');
      // new_string 是 4 spaces 形态，写入后该行变成 4 spaces；原文件其他 tab 行不变
      expect(after).toBe('    bar();\n\treturn 1;\n');
    });

    it('Level 4 组合：文件 tab + curly，LLM 给 spaces + ASCII → 命中', async () => {
      const original = `\t${`\u201Chello\u201D`}\n`;
      const file = await writeFile('w5_combo.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: '    "hello"',
        new_string: '    "world"',
      });
      expect(res.success).toBe(true);
      expect(res.data?.match_strategy).toBe('curly_quote_whitespace');
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe('    "world"\n');
    });

    it('fuzzy 命中**多处**（curly_quote）+ replace_all=false → 显式拒绝（uniqueness）', async () => {
      // 文件两处都是 curly 双引号 + LLM 给单一 ASCII 形态 → fuzzy 命中两次必须报多匹配
      const original = `\u201Chello\u201D\nbar\n\u201Chello\u201D\n`;
      const file = await writeFile('w5_dup_curly.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: '"hello"',
        new_string: '"world"',
      });
      expect(res.success).toBe(false);
      const errStr = String(res.error);
      // **W5 收尾轮 reviewer 修订（2026-05-12）**：fuzzy 多匹配错误文案明示
      // strategy（curly_quote）+ 警告 replace_all 不接受 fuzzy。
      expect(errStr).toContain('Found 2 matches');
      expect(errStr).toContain('curly_quote normalization'); // 明示路径
      expect(errStr).toContain("requires byte-exact"); // 防误用 replace_all
      // 旧 misleading 文案残留 sentinel
      expect(errStr).not.toContain('set replace_all to true');
    });

    it('fuzzy 全 miss（虚构内容）→ OLD_STRING_NOT_FOUND（calculator regression）', async () => {
      const original = `.button {\n  background: #fa709a;\n}\n`;
      const file = await writeFile('w5_hallu.css', original);
      // LLM 凭幻觉给一个文件里完全不存在的 selector：fuzzy 各级都不能命中
      const res = await fileEditTool.execute({
        path: file,
        old_string: '.fake_class {\n  background: NEVER_HERE;\n}',
        new_string: '.fake_class {}',
      });
      expect(res.success).toBe(false);
      const errStr = String(res.error);
      expect(errStr).toContain('not found in file');
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe(original);
    });

    it('exact 命中优先于 fuzzy（顺序敏感）', async () => {
      // 文件同时有 ASCII 直引号（exact 命中）和 curly 引号（fuzzy 备选），
      // LLM 给 ASCII → 必须走 exact，不应该走 fuzzy。
      const original = `say "hello"\n.then \u201Chello\u201D\n`;
      const file = await writeFile('w5_order.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'say "hello"',
        new_string: 'say "world"',
      });
      expect(res.success).toBe(true);
      expect(res.data?.match_strategy).toBe('exact');
      const after = await fsPromises.readFile(file, 'utf8');
      // 仅替换 exact 那处，curly 那处不动
      expect(after).toBe(`say "world"\n.then \u201Chello\u201D\n`);
    });
  });

  // ─── W5 (2026-05-12) CRLF detect/preserve 端到端 ───────────────────────
  //
  // edit-line-ending.ts 单测覆盖了 detect / normalize / convert 字节级行为。
  // 本块覆盖 fileEditTool 端到端：CRLF 文件 + LF oldString 能命中 + 写回保持
  // CRLF；LF 文件不动；mixed 文件归一为 CRLF（git autocrlf 哲学）。
  describe('W5 CRLF detect/preserve（e2e）', () => {
    it('CRLF 文件 + LLM 给 LF oldString → 命中 + 写回保持 CRLF', async () => {
      const original = 'line1\r\nline2\r\nline3\r\n';
      const file = await writeFile('w5_crlf.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'line2', // LF / 单行（无所谓）
        new_string: 'newline',
      });
      expect(res.success).toBe(true);
      const after = await fsPromises.readFile(file, 'utf8');
      // ending 仍是 CRLF（其他行不动），仅命中行内容变了
      expect(after).toBe('line1\r\nnewline\r\nline3\r\n');
    });

    it('CRLF 文件 + LLM 给 LF 多行 oldString → 命中 + 写回保持 CRLF', async () => {
      const original = 'line1\r\nline2\r\nline3\r\n';
      const file = await writeFile('w5_crlf_multi.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'line1\nline2', // LF 形态
        new_string: 'a\nb',
      });
      expect(res.success).toBe(true);
      const after = await fsPromises.readFile(file, 'utf8');
      // new_string 也走 CRLF 协议（normalize → convert 链路）
      expect(after).toBe('a\r\nb\r\nline3\r\n');
    });

    it('LF 文件不动 → 写回仍 LF', async () => {
      const original = 'line1\nline2\nline3\n';
      const file = await writeFile('w5_lf.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'line2',
        new_string: 'newline',
      });
      expect(res.success).toBe(true);
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe('line1\nnewline\nline3\n');
      // 显式确认没引入 \r
      expect(after).not.toContain('\r');
    });

    it('mixed CRLF + LF 文件 → 归一为 CRLF（git autocrlf 哲学）', async () => {
      // 任意 CRLF 出现就按 CRLF 看待，写回时全文件 CRLF
      const original = 'a\r\nb\nc\r\n';
      const file = await writeFile('w5_mixed.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'b',
        new_string: 'B',
      });
      expect(res.success).toBe(true);
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe('a\r\nB\r\nc\r\n');
    });

    it('CRLF 文件 + replace_all=true → 全部替换 + 写回保持 CRLF', async () => {
      const original = 'a\r\na\r\na\r\n';
      const file = await writeFile('w5_crlf_all.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'a',
        new_string: 'b',
        replace_all: true,
      });
      expect(res.success).toBe(true);
      expect(res.data?.replacements).toBe(3);
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe('b\r\nb\r\nb\r\n');
    });

    it('CRLF + curly quote + tab 全套（fuzzy 4 级 + CRLF preserve 集成）', async () => {
      const original = `\t${`\u201Chello\u201D`}\r\n`;
      const file = await writeFile('w5_full_combo.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: '    "hello"', // 4 spaces + ASCII + LF
        new_string: '    "world"',
      });
      expect(res.success).toBe(true);
      expect(res.data?.match_strategy).toBe('curly_quote_whitespace');
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe('    "world"\r\n');
    });
  });

  // ─── W5 (2026-05-12) unified diff snippet 端到端 ───────────────────────
  //
  // edit-snippet.ts 单测覆盖 getSnippetForPatch 字节级行为。本块覆盖
  // fileEditTool.execute 成功 result.data.snippet 字段在不同场景下的形态。
  describe('W5 unified diff snippet（e2e）', () => {
    it('单次 edit 成功 → result.data.snippet 含 +/- 标注 + ±4 context', async () => {
      const original = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8'].join('\n') + '\n';
      const file = await writeFile('w5_snip_single.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'l5',
        new_string: 'L5_CHANGED',
      });
      expect(res.success).toBe(true);
      expect(res.data?.snippet).toBeDefined();
      const snippet = String(res.data?.snippet);
      expect(snippet).toContain('5\t- l5');
      expect(snippet).toContain('5\t+ L5_CHANGED');
      // ±4 context 含 l1-l4 + l6-l8
      expect(snippet).toContain('1\t  l1');
      expect(snippet).toContain('8\t  l8');
    });

    it('replace_all=true 多处替换 → snippet 仅展示首处 hunk（避免长度爆炸）', async () => {
      const original = 'a\nb\nc\nd\nb\ne\nb\nf\n';
      const file = await writeFile('w5_snip_all.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'b',
        new_string: 'B',
        replace_all: true,
      });
      expect(res.success).toBe(true);
      expect(res.data?.replacements).toBe(3);
      const snippet = String(res.data?.snippet);
      // 至少一个改动展示出来
      expect(snippet).toContain('- b');
      expect(snippet).toContain('+ B');
    });

    it('fuzzy 命中（curly_quote）+ snippet 展示文件实际改动', async () => {
      const original = `say \u201Chello\u201D\n`;
      const file = await writeFile('w5_snip_fuzzy.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'say "hello"',
        new_string: 'say "world"',
      });
      expect(res.success).toBe(true);
      expect(res.data?.match_strategy).toBe('curly_quote');
      const snippet = String(res.data?.snippet);
      // snippet 看到的是文件真实形态（curly → ASCII 的转换）
      expect(snippet).toContain('- say \u201Chello\u201D');
      expect(snippet).toContain('+ say "world"');
    });

    it('snippet 不破坏向后兼容（旧字段 replacements / match_strategy / old_lines / new_lines 仍存在）', async () => {
      const original = 'foo\n';
      const file = await writeFile('w5_snip_bc.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'foo',
        new_string: 'bar',
      });
      expect(res.success).toBe(true);
      // 旧字段仍在
      expect(res.data?.replacements).toBe(1);
      expect(res.data?.match_strategy).toBe('exact');
      expect(res.data?.old_lines).toEqual(['foo']);
      expect(res.data?.new_lines).toEqual(['bar']);
      // 新字段补上
      expect(res.data?.snippet).toBeDefined();
    });
  });

  // ─── W5 (2026-05-12) Markdown trailing whitespace 保护 ─────────────────
  //
  // 双 trailing space = Markdown hard line break。TabTin 当前**没有**主动
  // strip 行为——本块测试是"未雨绸缪"的 regression guard：未来如果有人加
  // normalize 链路忘了 .md 边界，这个测试会立刻提示。
  describe('W5 Markdown trailing whitespace 保护（regression guard）', () => {
    it('.md 文件含双 trailing space（hard line break）→ edit 后保留', async () => {
      const original = 'line1  \nline2  \nline3\n'; // line1/2 都是双 trailing space
      const file = await writeFile('w5_md_hardbreak.md', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'line2',
        new_string: 'newline',
      });
      expect(res.success).toBe(true);
      const after = await fsPromises.readFile(file, 'utf8');
      // line1 / line3 不动；line2 被替换但 trailing 双空格仍然在
      expect(after).toBe('line1  \nnewline  \nline3\n');
      // 显式确认双 trailing space 没被吃掉
      expect(after).toContain('line1  \n');
      expect(after).toContain('newline  \n');
    });

    it('.mdx 文件 trailing whitespace 同款保留', async () => {
      const original = 'paragraph  \n  \nnext\n';
      const file = await writeFile('w5_mdx.mdx', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'next',
        new_string: 'NEXT',
      });
      expect(res.success).toBe(true);
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe('paragraph  \n  \nNEXT\n');
    });
  });

  // ─── W5 收尾轮 reviewer 修复 (2026-05-12) ──────────────────────────────
  //
  // 三视角 reviewer 找出 4 个严重问题，本块测试钉死收尾修复行为：
  //   - BOM detect/preserve（产品视角硬伤）
  //   - NOT_UNIQUE 文案不再让 Agent 误用 replace_all（用户视角 S2）
  //   - snippet 多 hunk 加"+N more"提示（技术 M2）
  describe('W5 收尾轮 reviewer 修复（e2e）', () => {
    it('BOM 文件：read 端 LLM 看不到 BOM + edit 端命中 + 写回保持 BOM', async () => {
      // 模拟 Windows / Excel 导出的 UTF-8 BOM 文件：磁盘首字节是 \uFEFF
      // LLM 通过 read_file 看到的是干净文本（read 端 normalizeReadText 剥 BOM）
      // 抄给 edit 的 old_string 不含 BOM —— W5 收尾前必失败，修复后必成功
      const original = '\uFEFFline1\nline2\nline3\n';
      const file = await writeFile('w5_bom.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'line2', // LLM 不含 BOM 的 oldString
        new_string: 'newline',
      });
      expect(res.success).toBe(true);
      const after = await fsPromises.readFile(file, 'utf8');
      // 写回保持 BOM 标记（不丢）
      expect(after).toBe('\uFEFFline1\nnewline\nline3\n');
      expect(after.charCodeAt(0)).toBe(0xfeff);
    });

    it('BOM + 首行 edit：不含 BOM 的 oldString 也能命中第一行', async () => {
      const original = '\uFEFFfirst-line\nsecond\n';
      const file = await writeFile('w5_bom_first.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'first-line', // 注意：不含 BOM
        new_string: 'FIRST',
      });
      expect(res.success).toBe(true);
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe('\uFEFFFIRST\nsecond\n');
    });

    it('无 BOM 文件：写回不引入 BOM', async () => {
      const original = 'plain\ntext\n';
      const file = await writeFile('w5_no_bom.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'plain',
        new_string: 'PLAIN',
      });
      expect(res.success).toBe(true);
      const after = await fsPromises.readFile(file, 'utf8');
      expect(after).toBe('PLAIN\ntext\n');
      expect(after.charCodeAt(0)).not.toBe(0xfeff);
    });

    it('BOM + CRLF + curly + tab 全套（最毒文件场景）', async () => {
      // 模拟最不友好的 Windows 中文环境：BOM + CRLF + curly quote + tab
      const original = `\uFEFF\t\u201Chello\u201D\r\n\tworld\r\n`;
      const file = await writeFile('w5_worst_case.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        // LLM 给最常见的 LF + 4 spaces + ASCII 形态
        old_string: '    "hello"',
        new_string: '    "WORLD"',
      });
      expect(res.success).toBe(true);
      expect(res.data?.match_strategy).toBe('curly_quote_whitespace');
      const after = await fsPromises.readFile(file, 'utf8');
      // 写回保持 BOM + CRLF + 其他行 tab；改的那行用 new_string 字面（4 spaces + ASCII）
      expect(after).toBe(`\uFEFF    "WORLD"\r\n\tworld\r\n`);
    });

    it('NOT_UNIQUE 文案：line_trimmed 多匹配明示 strategy + 不让 Agent 误用 replace_all', async () => {
      // 跨行 + 缩进差异：单行 'hello' 是子串会被 exact 命中。用跨多行的 LLM 无缩进
      // old_string 才能触发 line_trimmed 路径（exact 找不到，逐行 trim 命中两处）。
      const original = '  hello\n  world\nbar\n  hello\n  world\n';
      const file = await writeFile('w5_not_unique_lt.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'hello\nworld', // 无缩进，跨两行 → line_trimmed 命中两处
        new_string: 'hi\nthere',
      });
      expect(res.success).toBe(false);
      const errStr = String(res.error);
      expect(errStr).toContain('Found 2 matches');
      expect(errStr).toContain('whitespace normalization');
      expect(errStr).toContain('byte-exact');
      // 不应再让 Agent set replace_all
      expect(errStr).not.toContain('set replace_all to true');
    });

    it('snippet 多 hunk：replace_all 改多处时 snippet 含"+N more hunks"提示', async () => {
      // 让 replace_all 命中 3 处但 hunk 之间相距足够远，diff 包会拆成多个 hunk
      const lines: string[] = [];
      for (let i = 0; i < 50; i++) lines.push(`line${i}`);
      lines[5] = 'TARGET';
      lines[20] = 'TARGET';
      lines[45] = 'TARGET';
      const original = lines.join('\n') + '\n';
      const file = await writeFile('w5_multi_hunk.txt', original);
      const res = await fileEditTool.execute({
        path: file,
        old_string: 'TARGET',
        new_string: 'CHANGED',
        replace_all: true,
      });
      expect(res.success).toBe(true);
      expect(res.data?.replacements).toBe(3);
      const snippet = String(res.data?.snippet);
      expect(snippet).toContain('+ CHANGED');
      // 多 hunk 提示
      expect(snippet).toContain('more hunks not shown');
    });
  });
});

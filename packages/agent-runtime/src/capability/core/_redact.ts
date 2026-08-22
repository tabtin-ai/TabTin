/**
 * Skill 凭据脱敏 helper —— W2.3 ShellCap 扩展（D2.3.1 决策路径 A）。
 *
 * **设计意图**：
 *
 * 退役命令工具实现在返回 stdout / stderr 给 LLM 之前，会对**本次注入的
 * Skill credential env values** 做字面替换脱敏。ShellCap 作为唯一命令工具
 * 必须保留这一安全行为，否则敏感凭据会
 * 通过 stdout 进 LLM 上下文 + 持久化到 messages.jsonl。
 *
 * **为什么 helper 抽到 `_redact.ts` 而不是放在 BackendSession 层**
 * （详见总控 §"Stage 2 · D2.3.1 决策"段）：
 *
 *   1. 脱敏只对 **skill credential 派生 env** 做，不对**用户传的普通 env**
 *      做（避免 `PATH` / `HOME` 等系统配置值被误替换成 `***REDACTED***`
 *      让 LLM 困惑）。
 *   2. BackendSession.ExecOptions.env 字段不区分两类 env —— 接口冻结
 *      （W1.1 9 核心文件不许改），无法显式标记哪些 env 是 secret。
 *   3. 在 ShellCap 层做脱敏：
 *      - 只用 SkillCredentialResolver 派生的 secret env 做 replacement source；
 *        用户 input.env 压根不参与脱敏决策。
 *      - ShellCap.run_terminal_command 接 `env` 入参（来自 LLM），同时通过
 *        SkillContextProvider 拿 skill credential env —— 仅后者参与脱敏
 *        replacement source，前者不参与。
 *
 * **未来加 PythonCap / NetworkCap 等执行类 Cap**：
 *   - 它们各自决定"哪些 env 是 secret"——可能完全不接 SkillContextProvider，
 *     也可能用其他 secret 源（OAuth token / DB connection string）。
 *   - 各自 import 本 helper 复用 `redactSecretsInOutput`，不需要在 BackendSession 层
 *     做"通杀脱敏"。
 *
 * **算法 / 阈值**：与 `tools/core-tools.ts::redactSecretsInOutput` 保持
 * 1:1 字面对齐：
 *
 *   - 字面子串替换（`split` + `join`），不做 regex / 关键字扫描
 *   - 跳过短 value（< MIN_SECRET_VALUE_LENGTH = 8）—— 与后端
 *     `apps/tabtin_django/apps/credential_vault/skill_reveal.py::MIN_SECRET_VALUE_LENGTH`
 *     双向契约，避免短 value 把业务文本染成 `***REDACTED***` 沼泽
 *   - 替换为 `***REDACTED***`，保留"出现过"信号利于 Agent 诊断
 *     （如 curl -v 的 `Authorization: Bearer ***REDACTED***` 仍能识别
 *     出是认证头，只是被脱敏了）
 *
 * **复杂度**：O(N*M)，N = output 长度，M = secret env 数。typical M ≤ 4，
 * 单次 stdout 几十 KB → 个位数 ms 完成。
 *
 * **不抽到 `_utils.ts`**：那里是"所有 Core Cap 共享的最小工具集"
 * （jsonError / describeError / ensureSession / normalizeStringList）。
 * 脱敏属于 ShellCap 特有领域逻辑，未来可扩展给执行类 Cap 但不属于纯
 * 类型层基础设施。独立文件让单测覆盖与变更隔离都更清晰。
 */

const MIN_SECRET_VALUE_LENGTH = 8;
const REDACT_PLACEHOLDER = '***REDACTED***';

function collectRedactVariants(value: string): string[] {
  if (!value || value.length < MIN_SECRET_VALUE_LENGTH) return [];
  const variants = new Set<string>([value]);
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  variants.add(b64);
  // bugbot 评审  low：补 base64url 变体（`+`→`-`、`/`→`_`、去 padding），
  // CLI/JSON 常用 url-safe base64 打印同一 secret，只加标准 base64 会漏。
  const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (b64url !== b64) variants.add(b64url);
  // 无 padding 的标准 base64（部分工具输出去掉尾部 =）
  const b64NoPad = b64.replace(/=+$/, '');
  if (b64NoPad !== b64) variants.add(b64NoPad);
  return [...variants].sort((a, b) => b.length - a.length);
}

/**
 * 对 output 字符串做脱敏 —— 仅对 `secretEnv` 中长度 ≥ 8 的 value 做
 * 字面替换。
 *
 * @param output  原始 stdout / stderr 拼接字符串
 * @param secretEnv  本次注入的 skill credential env 字典（key/value
 *                   都是字符串；只对 value 做替换）
 * @returns 脱敏后的字符串。`secretEnv` 为空 / undefined 时直接返回 output
 *          原样（避免无意义遍历）。
 */
export function redactSecretsInOutput(
  output: string,
  secretEnv: Record<string, string> | undefined,
): string {
  if (!secretEnv) return output;
  let result = output;
  const variants: string[] = [];
  for (const value of Object.values(secretEnv)) {
    variants.push(...collectRedactVariants(value));
  }
  variants.sort((a, b) => b.length - a.length);
  for (const variant of variants) {
    if (result.includes(variant)) {
      result = result.split(variant).join(REDACT_PLACEHOLDER);
    }
  }
  return result;
}

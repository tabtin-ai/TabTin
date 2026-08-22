/**
 * ActionLoopDetector — 操作循环检测
 *
 * 维护最近 N 步操作的滑动窗口，通过比较 JSON 序列化
 * 检测重复模式。当窗口内相似度超过阈值时判定为循环。
 *
 * 实例应 per-tab 维护，不同 tab 独立检测。
 */

const WINDOW_SIZE = 20;
const SIMILARITY_THRESHOLD = 0.85;

export interface LoopDetectionResult {
  looping: boolean;
  hint?: string;
}

export class ActionLoopDetector {
  private window: string[] = [];

  recordAction(action: { type: string; selector?: string; value?: string; [key: string]: any }): void {
    this.window.push(this.actionSignature(action));
    if (this.window.length > WINDOW_SIZE) {
      this.window.shift();
    }
  }

  private actionSignature(action: Record<string, any>): string {
    const { type, selector, value, index, x, y } = action;
    return JSON.stringify({ type, selector, value, index, x, y });
  }

  isLooping(): LoopDetectionResult {
    if (this.window.length < 4) {
      return { looping: false };
    }

    const total = this.window.length;

    const singleResult = this.detectSingleActionDominance(total);
    if (singleResult) return singleResult;

    const cycleResult = this.detectRepeatingCycle(total);
    if (cycleResult) return cycleResult;

    return { looping: false };
  }

  reset(): void {
    this.window = [];
  }

  /**
   * 单动作频率检测：某个动作出现次数 / 窗口大小 >= 阈值
   */
  private detectSingleActionDominance(total: number): LoopDetectionResult | null {
    const counts = new Map<string, number>();
    for (const entry of this.window) {
      counts.set(entry, (counts.get(entry) || 0) + 1);
    }

    let maxCount = 0;
    for (const count of counts.values()) {
      if (count > maxCount) maxCount = count;
    }

    if (maxCount / total >= SIMILARITY_THRESHOLD) {
      return {
        looping: true,
        hint: `检测到操作循环（最近 ${total} 步中有 ${maxCount} 步相似），建议尝试不同的方法`,
      };
    }

    return null;
  }

  /**
   * 短周期循环检测（周期 2-4）：如 A-B-A-B 或 A-B-C-A-B-C
   * 通过比较 window[i] === window[i + period] 的匹配率
   */
  private detectRepeatingCycle(total: number): LoopDetectionResult | null {
    for (let period = 2; period <= Math.min(4, Math.floor(total / 2)); period++) {
      let matchCount = 0;
      const comparisons = total - period;
      for (let i = 0; i < comparisons; i++) {
        if (this.window[i] === this.window[i + period]) {
          matchCount++;
        }
      }
      if (comparisons > 0 && matchCount / comparisons >= SIMILARITY_THRESHOLD) {
        return {
          looping: true,
          hint: `检测到操作循环（最近 ${total} 步呈现周期为 ${period} 的重复模式），建议尝试不同的方法`,
        };
      }
    }
    return null;
  }
}

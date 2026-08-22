/**
 * 测试用硬红线检查器——包装 @tabtin/security-policy（与宿主装配同形）。
 * 不可放进 src（会进 baseline）；亦不可引用宿主包（AH-003）。
 */

import { checkHardlineCommand as checkHardlineCommandV3 } from '@tabtin/security-policy';
import type { HardlineCommandChecker } from '../../src/capability/core/shell.js';

/** 生产同款：真实硬红线规则表。 */
export const testHardlineChecker: HardlineCommandChecker = (command) =>
  checkHardlineCommandV3(command);

/** 永不命中——仅用于不关心硬红线的构造契约 / 描述审计类测试。 */
export const allowAllHardlineChecker: HardlineCommandChecker = () => ({ hit: false });

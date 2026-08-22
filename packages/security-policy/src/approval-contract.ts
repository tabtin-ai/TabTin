/**
 * Browser-safe approval wire constants.
 *
 * Keep this module free of Node built-ins so renderer approval surfaces can import
 * the contract without loading the host-only judge / path normalization graph.
 */

/** file 类抽不到路径时写入 decision_reason.path 的占位符。UI 不得据此渲染「添加文件夹」。 */
export const UNKNOWN_WORKSPACE_OUT_PATH = '<unknown>';

/**
 * workingDirPayload — Workspace 工作目录保存的 updateSpace payload 构造
 *
 * 执行根 SSOT 是 Space/Workspace；`AgentUpdate` 已不再接受 working_dir。
 * 后端 Workspace schema 的 `working_dir_type` 是
 * `Optional[Literal["code","mixed","doc"]]`——空字符串会直接 422。清空目录时应
 * **省略** `working_dir_type`，仅在有合法值时携带。
 */

type WorkingDirType = 'code' | 'mixed' | 'doc'

export interface WorkingDirUpdatePayload {
  working_dir: string
  working_dir_type?: WorkingDirType
}

export function buildWorkingDirUpdatePayload(
  workingDir: string,
  workingDirType: WorkingDirType | '',
): WorkingDirUpdatePayload {
  if (!workingDirType) {
    // 清空目录（或 type 未设）：不携带 working_dir_type，
    // 后端 service 对 working_dir="" 会联动清空 type
    return { working_dir: workingDir }
  }
  return { working_dir: workingDir, working_dir_type: workingDirType }
}

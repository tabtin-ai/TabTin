"""TabCode 自定义 context builder。

为 Agent 提供当前代码项目的上下文：项目路径、Git 分支、变更文件、当前文件。
当有 remote Daemon Git status 时，跳过本地 Git 字段以避免冗余。
"""

from typing import List


class CodeContextBuilder:
    """构建 TabCode 的 Agent 上下文。"""

    def build(self, state: dict, context: dict) -> List[str]:
        lines = ["Active app: TabCode"]

        project_path = (
            state.get("current_code_project_path")
            or context.get("current_code_project_path")
        )
        if project_path:
            lines.append(f"project_path: {project_path}")

        has_remote_git = isinstance(state.get("_remote_git_status"), dict)
        if not has_remote_git:
            git_branch = (
                state.get("current_git_branch")
                or context.get("current_git_branch")
            )
            if git_branch:
                lines.append(f"git_branch: {git_branch}")

            git_changed_files = (
                state.get("current_git_changed_files")
                or context.get("current_git_changed_files")
            )
            if git_changed_files:
                lines.append(f"git_changed_files: {git_changed_files}")

        current_file = (
            state.get("current_code_file")
            or context.get("current_code_file")
        )
        if current_file:
            lines.append(f"current_file: {current_file}")

        return lines

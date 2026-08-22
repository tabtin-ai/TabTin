根据已暂存改动，写一条符合 Conventional Commits 的 git commit message。

## 要求

1. 只输出一行：`type(scope): summary`；scope 可省略，写成 `type: summary`
2. type 只能是：feat / fix / docs / style / refactor / test / chore / perf / ci / build
3. summary 用英文或与 diff 主要语言一致，简洁准确，不超过 72 个字符
4. 只依据提供的文件列表与 diff 摘要，不要臆造未出现的改动
5. 若 diff 被截断，仍根据已有信息概括，不要声称已阅读全部改动
6. 不要使用引号、markdown、列表或任何解释性前后缀

## 禁止

- 禁止输出多行 body / footer
- 禁止输出「生成提交信息」「commit message」等元描述
- 禁止编造 issue 编号或未提供的业务背景

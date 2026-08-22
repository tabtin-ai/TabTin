# tabtin-filegen

随 `tabtin` CLI 一起分发的文件生成工具，从 JSON spec 生成 **xlsx / docx / pptx / pdf**。

- 承接  / ：agent-runtime 只发布 `local_file` artifact，不生成内容；本工具就是 PRD 里说的「外部生成工具」。
- 用成熟宽松许可证库：`openpyxl`(MIT) / `python-docx`(MIT) / `python-pptx`(MIT) / `reportlab`(BSD)。
- 中文 PDF 通过 reportlab 内置 CID 字体 `STSong-Light` 渲染，无需打包字体文件。
- 打包成 PyInstaller 自包含二进制后，**客户端无需安装 Python**。

## 设计

- `registry.py`：唯一扩展点。新增文件类型 = 在 `generators/` 加一个模块 + `register(...)`，CLI / Go 代理都不用改。
- 每种类型一份独立 JSON spec（见 `tabtin-filegen schema --type <t>`）。

## 用法

> Agent 不直接调本二进制——统一走 Go CLI 代理 `tabtin file create / schema / list-types`
> （内部透传到这里）。下面的 `tabtin-filegen ...` 是底层等价形式，便于本地调试。

```bash
# 生成（spec 走 stdin / @文件 / 字面量）
echo '{"sheets":[{"header":["名称","数量"],"rows":[["苹果",3]]}]}' \
  | tabtin-filegen create --type xlsx --output report.xlsx --spec -

# 列出支持的类型
tabtin-filegen list-types

# 查看某类型的 spec 结构
tabtin-filegen schema --type pdf
```

成功时 stdout 输出 `{"path", "file_type", "file_size"}`；失败时 stderr 输出 `{"error": {"code", "message"}}` 并以非零码退出。

## 开发

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev,build]"
pytest
ruff check src tests
```

## 打包（每个目标 OS+arch 各构建一次）

PyInstaller **不能交叉编译**。必须在目标机器上跑 `bash build.sh`（Intel Mac 出 `darwin-x64`，Apple Silicon 出 `darwin-arm64`）。脚本会同时写出：

- `dist/tabtin-filegen`（运行期通用名）
- `dist/tabtin-filegen-<os>-<arch>`（打包选档，避免 dual-arch 复用错架构，见 ）

```bash
bash packages/tabtin-filegen-python/build.sh
```

Apple Silicon 上打 Intel 包时，必须提供预先构建的 `dist/tabtin-filegen-darwin-x64`；禁止把本机 arm64 产物打进 x64 包。

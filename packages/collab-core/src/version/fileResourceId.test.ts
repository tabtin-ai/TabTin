/**
 * 前后端 UUID5 路径映射对齐测试。
 *
 * 期望值由 Python 后端生成：
 *   python3 -c "import uuid; ns = uuid.UUID('33b00000-0000-4000-8000-000000000001'); print(uuid.uuid5(ns, <path>))"
 *
 * 若本测试失败，说明 namespace 或 UUID5 计算路径与
 * `apps/tabtin_django/apps/orchestration/services/daemon_checkpoint_service.py::_FILE_RESOURCE_NAMESPACE`
 * 不对齐 → conversation-anchors 查询将永远查不到后端写入的 ChangeLog。
 */
import { describe, expect, it } from "vitest"
import { filePathToResourceId } from "./fileResourceId"

describe("filePathToResourceId (aligns with backend uuid5)", () => {
  it("src/main.py => expected UUID5", async () => {
    const id = await filePathToResourceId("src/main.py")
    expect(id).toBe("0e25709d-2049-5e7f-9e06-2128ecc0fb5a")
  })

  it("empty string => expected UUID5", async () => {
    const id = await filePathToResourceId("")
    expect(id).toBe("d9e08438-c065-5cf7-9818-644bb50c14ba")
  })

  it("apps/README.md => expected UUID5", async () => {
    const id = await filePathToResourceId("apps/README.md")
    expect(id).toBe("4868f22e-5f14-5e4c-b402-80834ba020d2")
  })

  it("trims path before hashing (parity with Python .strip())", async () => {
    const a = await filePathToResourceId("  src/main.py  ")
    const b = await filePathToResourceId("src/main.py")
    expect(a).toBe(b)
  })

  it("null-ish input normalized to empty string", async () => {
    const a = await filePathToResourceId(undefined as unknown as string)
    const b = await filePathToResourceId("")
    expect(a).toBe(b)
  })
})

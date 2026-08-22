package errcode

import (
	"strings"
	"testing"
)

// resetDomainRegistryForTest 清空 domain 全局注册表。
// 因 RegisterDomain 设计为 init() 阶段一次性调用、全程 panic-on-conflict，
// 不向 production API 暴露 reset；测试场景下通过同包可见性直接重置。
func resetDomainRegistryForTest(t *testing.T) {
	t.Helper()
	domainMu.Lock()
	defer domainMu.Unlock()
	domainCodes = map[string][]ErrorCode{}
	allDomainSet = map[ErrorCode]bool{}
}

// expectPanic 断言 fn 会 panic，且 panic message 包含 wantSubstr。
// wantSubstr 为空时只断言 panic 发生。
func expectPanic(t *testing.T, wantSubstr string, fn func()) {
	t.Helper()
	defer func() {
		r := recover()
		if r == nil {
			t.Fatalf("expected panic, got none (want substring %q)", wantSubstr)
		}
		if wantSubstr == "" {
			return
		}
		msg, ok := r.(string)
		if !ok {
			if err, isErr := r.(error); isErr {
				msg = err.Error()
			} else {
				t.Fatalf("panic value is not string/error: %T %v", r, r)
			}
		}
		if !strings.Contains(msg, wantSubstr) {
			t.Fatalf("panic message %q does not contain %q", msg, wantSubstr)
		}
	}()
	fn()
}

// TestRegisterDomain_Success 验证正常注册路径 + AllDomainCodes / IsDomainCode 查询。
func TestRegisterDomain_Success(t *testing.T) {
	resetDomainRegistryForTest(t)

	codes := []ErrorCode{
		"TABDOC_VERSION_CONFLICT",
		"TABDOC_BLOCK_NOT_FOUND",
	}
	RegisterDomain("TABDOC", codes)

	if !IsDomainCode("TABDOC_VERSION_CONFLICT") {
		t.Errorf("IsDomainCode(TABDOC_VERSION_CONFLICT) = false, want true")
	}
	if !IsDomainCode("TABDOC_BLOCK_NOT_FOUND") {
		t.Errorf("IsDomainCode(TABDOC_BLOCK_NOT_FOUND) = false, want true")
	}
	if IsDomainCode("TABDOC_NEVER_REGISTERED") {
		t.Errorf("IsDomainCode(TABDOC_NEVER_REGISTERED) = true, want false")
	}

	got := AllDomainCodes()
	gotTabdoc, ok := got["TABDOC"]
	if !ok {
		t.Fatalf("AllDomainCodes() missing TABDOC, got keys=%v", keysOf(got))
	}
	if len(gotTabdoc) != 2 {
		t.Fatalf("TABDOC codes len = %d, want 2", len(gotTabdoc))
	}
	if gotTabdoc[0] != "TABDOC_VERSION_CONFLICT" || gotTabdoc[1] != "TABDOC_BLOCK_NOT_FOUND" {
		t.Errorf("TABDOC codes order/content wrong: %v", gotTabdoc)
	}
}

// TestRegisterDomain_DuplicatePrefix 同一 prefix 重复注册必须 panic（开发期早 fail）。
func TestRegisterDomain_DuplicatePrefix(t *testing.T) {
	resetDomainRegistryForTest(t)

	RegisterDomain("TABDOC", []ErrorCode{"TABDOC_A"})

	expectPanic(t, "已注册", func() {
		RegisterDomain("TABDOC", []ErrorCode{"TABDOC_B"})
	})
}

// TestRegisterDomain_PrefixNotUpper prefix 必须全大写。
func TestRegisterDomain_PrefixNotUpper(t *testing.T) {
	resetDomainRegistryForTest(t)

	expectPanic(t, "全大写", func() {
		RegisterDomain("Tabdoc", []ErrorCode{"Tabdoc_A"})
	})
}

// TestRegisterDomain_PrefixEmpty prefix 不能为空。
func TestRegisterDomain_PrefixEmpty(t *testing.T) {
	resetDomainRegistryForTest(t)

	expectPanic(t, "prefix 不能为空", func() {
		RegisterDomain("", []ErrorCode{"_X"})
	})
}

// TestRegisterDomain_CodeNotPrefixed code 必须以 prefix+"_" 开头。
func TestRegisterDomain_CodeNotPrefixed(t *testing.T) {
	resetDomainRegistryForTest(t)

	expectPanic(t, "必须以", func() {
		RegisterDomain("TABDOC", []ErrorCode{"OTHER_CODE"})
	})
}

// TestRegisterDomain_CodeNotUpper code 必须全大写。
func TestRegisterDomain_CodeNotUpper(t *testing.T) {
	resetDomainRegistryForTest(t)

	// 用 prefix 含小写无法测“仅 code 小写”的分支——因为 prefix 校验会先 fail；
	// 这里构造一个以 "TABDOC_" 开头但混了小写的 code。
	expectPanic(t, "全大写", func() {
		RegisterDomain("TABDOC", []ErrorCode{"TABDOC_lowercase"})
	})
}

// TestRegisterDomain_CodeContainsDigit code 不允许含数字（spec §5.4）。
func TestRegisterDomain_CodeContainsDigit(t *testing.T) {
	resetDomainRegistryForTest(t)

	expectPanic(t, "不允许含数字", func() {
		RegisterDomain("TABDOC", []ErrorCode{"TABDOC_ERR_001"})
	})
}

// TestRegisterDomain_CodeTooLong code 长度 > 40 必须 panic。
func TestRegisterDomain_CodeTooLong(t *testing.T) {
	resetDomainRegistryForTest(t)

	// "TABDOC_" 长 7，再补 34 个 X = 41 字符（首次越界）。
	longTail := strings.Repeat("X", 34)
	long := ErrorCode("TABDOC_" + longTail)
	if len(string(long)) != 41 {
		t.Fatalf("test fixture invalid: len(long) = %d, want 41", len(string(long)))
	}

	expectPanic(t, "超过 40", func() {
		RegisterDomain("TABDOC", []ErrorCode{long})
	})
}

// TestRegisterDomain_CodeBoundaryLength code 长度恰好 = 40 必须成功（边界确认）。
func TestRegisterDomain_CodeBoundaryLength(t *testing.T) {
	resetDomainRegistryForTest(t)

	// "TABDOC_" 长 7 + 33 个 X = 40 字符。
	tail := strings.Repeat("X", 33)
	exact := ErrorCode("TABDOC_" + tail)
	if len(string(exact)) != 40 {
		t.Fatalf("test fixture invalid: len(exact) = %d, want 40", len(string(exact)))
	}

	RegisterDomain("TABDOC", []ErrorCode{exact})
	if !IsDomainCode(exact) {
		t.Errorf("40-char code should be accepted but IsDomainCode = false")
	}
}

// TestRegisterDomain_CrossDomainDuplicate 跨 domain 同一 code 重复必须 panic。
// 由于 code 必须以 prefix+"_" 开头，跨 domain 同 code 物理上几乎不可能发生；
// 但仍按 user prompt 要求显式断言这条防御性校验存在——一旦未来有人改了
// "code 必须以 prefix 开头" 的契约（比如允许 alias），这条校验会兜底。
//
// 构造方式：让 "TABDOC" 注册一个码后，让另一个 prefix "TABDOC_X" 也注册
// 同字面值的码——两个 prefix 都满足 “code 以 prefix+"_" 开头”。
func TestRegisterDomain_CrossDomainDuplicate(t *testing.T) {
	resetDomainRegistryForTest(t)

	// 先注册 TABDOC_X_SHARED 给 prefix=TABDOC。
	shared := ErrorCode("TABDOC_X_SHARED")
	RegisterDomain("TABDOC", []ErrorCode{shared})

	// 再尝试用 prefix=TABDOC_X 注册同样的 code——满足 “以 TABDOC_X_ 开头”，
	// 但已被另一个 domain 占用。
	expectPanic(t, "已在其他 domain 注册", func() {
		RegisterDomain("TABDOC_X", []ErrorCode{shared})
	})
}

// TestIsErrorCode_GenericPreserved generic 闭集判定保留原语义。
func TestIsErrorCode_GenericPreserved(t *testing.T) {
	resetDomainRegistryForTest(t)

	if !IsErrorCode("AUTH_INVALID") {
		t.Errorf("IsErrorCode(AUTH_INVALID) = false, want true (generic)")
	}
	if !IsErrorCode("INTERNAL_ERROR") {
		t.Errorf("IsErrorCode(INTERNAL_ERROR) = false, want true (generic)")
	}
	if IsErrorCode("NOT_A_REAL_CODE") {
		t.Errorf("IsErrorCode(NOT_A_REAL_CODE) = true, want false")
	}
}

// TestIsErrorCode_DomainAfterRegister domain code 注册后必须被 IsErrorCode 识别。
func TestIsErrorCode_DomainAfterRegister(t *testing.T) {
	resetDomainRegistryForTest(t)

	if IsErrorCode("TABDOC_VERSION_CONFLICT") {
		t.Errorf("pre-register: IsErrorCode(TABDOC_VERSION_CONFLICT) = true, want false")
	}

	RegisterDomain("TABDOC", []ErrorCode{"TABDOC_VERSION_CONFLICT"})

	if !IsErrorCode("TABDOC_VERSION_CONFLICT") {
		t.Errorf("post-register: IsErrorCode(TABDOC_VERSION_CONFLICT) = false, want true")
	}
	// generic 仍要识别。
	if !IsErrorCode("AUTH_INVALID") {
		t.Errorf("post-register generic regressed: IsErrorCode(AUTH_INVALID) = false")
	}
}

// TestAllIncludingDomain 合并集合包含 generic + 所有 domain。
func TestAllIncludingDomain(t *testing.T) {
	resetDomainRegistryForTest(t)

	RegisterDomain("TABDOC", []ErrorCode{
		"TABDOC_VERSION_CONFLICT",
		"TABDOC_BLOCK_NOT_FOUND",
	})
	RegisterDomain("TABDATA", []ErrorCode{
		"TABDATA_VIEW_LOCKED",
	})

	all := AllIncludingDomain()
	got := make(map[ErrorCode]bool, len(all))
	for _, c := range all {
		got[c] = true
	}

	// generic 全部在内。
	for _, c := range All() {
		if !got[c] {
			t.Errorf("AllIncludingDomain missing generic %q", c)
		}
	}
	// domain 全部在内。
	for _, c := range []ErrorCode{
		"TABDOC_VERSION_CONFLICT",
		"TABDOC_BLOCK_NOT_FOUND",
		"TABDATA_VIEW_LOCKED",
	} {
		if !got[c] {
			t.Errorf("AllIncludingDomain missing domain %q", c)
		}
	}

	// 计数：20 generic + 3 domain = 23。若 generic 闭集后续扩缩，此用例失败提示需同步更新。
	wantLen := len(All()) + 3
	if len(all) != wantLen {
		t.Errorf("AllIncludingDomain len = %d, want %d", len(all), wantLen)
	}
}

// TestAllDomainCodes_Snapshot 验证返回值是 deep copy，调用方修改不污染注册表。
func TestAllDomainCodes_Snapshot(t *testing.T) {
	resetDomainRegistryForTest(t)
	RegisterDomain("TABDOC", []ErrorCode{"TABDOC_A", "TABDOC_B"})

	got := AllDomainCodes()
	got["TABDOC"][0] = "MUTATED"
	got["INJECTED"] = []ErrorCode{"X"}

	again := AllDomainCodes()
	if again["TABDOC"][0] != "TABDOC_A" {
		t.Errorf("registry mutated through returned slice: %v", again["TABDOC"])
	}
	if _, exists := again["INJECTED"]; exists {
		t.Errorf("registry mutated through returned map")
	}
}

// TestRegisterDomain_InputSliceImmutability 调用方修改传入切片不污染注册表。
func TestRegisterDomain_InputSliceImmutability(t *testing.T) {
	resetDomainRegistryForTest(t)
	in := []ErrorCode{"TABDOC_A", "TABDOC_B"}
	RegisterDomain("TABDOC", in)

	in[0] = "TABDOC_TAMPERED"

	got := AllDomainCodes()["TABDOC"]
	if got[0] != "TABDOC_A" {
		t.Errorf("registry shares backing array with caller: got[0]=%q", got[0])
	}
}

func keysOf(m map[string][]ErrorCode) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

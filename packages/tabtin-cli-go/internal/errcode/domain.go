package errcode

// Domain 闭集运行时注册表。
//
// 与 codes.go 中的 generic 闭集（20 个跨语言强制 mirror 的码）正交：
// 每个 App 在自己包的 init() 中调用 RegisterDomain，把自己负责的一组
// domain code（如 TABDOC_VERSION_CONFLICT、TABDATA_VIEW_LOCKED）声明
// 进来。运行期通过 IsDomainCode / IsErrorCode 校验。
//
// 命名约定（与 cli-protocol.md §5.4 一致）：
//   - 全大写 + 下划线分隔
//   - 必须以 "<PREFIX>_" 开头，PREFIX 即注册时传入的 domain 名
//   - 长度 ≤ 40
//   - 禁止含数字（避免 TABDOC_ERR_001 这种无语义命名）
//
// 注：本文件不属于 generic 闭集 mirror 范围，三栈 mirror 同步脚本
// （scripts/check-error-codes-sync.py）只读 codes.go。

import (
	"fmt"
	"strings"
	"sync"
)

// domain code 最大长度（字符）。
// 与 cli-protocol.md §5.4 “[MUST] 长度 ≤ 40 字符（避免 stdout 过宽）” 保持一致。
const maxDomainCodeLength = 40

var (
	domainMu sync.RWMutex
	// prefix → 该 domain 注册的全部 code（值拷贝，已校验合法）。
	domainCodes = map[string][]ErrorCode{}
	// 已注册的全部 domain code 集合，供 O(1) 查询。
	allDomainSet = map[ErrorCode]bool{}
)

// RegisterDomain 注册一个 App 的 domain code 闭集。
//
// 参数：
//   - prefix: 全大写 domain 前缀（如 "TABDOC"），不能为空。
//   - codes:  该 domain 的全部错误码，每一项必须以 prefix+"_" 开头。
//
// 调用约束：
//   - 同一 prefix 只能注册一次（重复 panic，开发期就暴露漏写）。
//   - codes 内任意一项跨 domain 重复出现也会 panic。
//   - 任一校验不通过都会 panic——RegisterDomain 设计为 init() 阶段
//     调用，panic 等价于编译期失败，更符合“错误码闭集”的契约语义。
func RegisterDomain(prefix string, codes []ErrorCode) {
	if prefix == "" {
		panic("errcode.RegisterDomain: prefix 不能为空")
	}
	if prefix != strings.ToUpper(prefix) {
		panic(fmt.Sprintf("errcode.RegisterDomain: prefix %q 必须全大写", prefix))
	}
	if strings.ContainsAny(prefix, "0123456789") {
		panic(fmt.Sprintf("errcode.RegisterDomain: prefix %q 不允许含数字", prefix))
	}

	domainMu.Lock()
	defer domainMu.Unlock()

	if _, exists := domainCodes[prefix]; exists {
		panic(fmt.Sprintf("errcode.RegisterDomain: prefix %q 已注册", prefix))
	}

	wantPrefix := prefix + "_"
	for _, code := range codes {
		codeStr := string(code)
		if !strings.HasPrefix(codeStr, wantPrefix) {
			panic(fmt.Sprintf(
				"errcode.RegisterDomain: code %q 必须以 %q 开头",
				codeStr, wantPrefix,
			))
		}
		if codeStr != strings.ToUpper(codeStr) {
			panic(fmt.Sprintf("errcode.RegisterDomain: code %q 必须全大写", codeStr))
		}
		if strings.ContainsAny(codeStr, "0123456789") {
			panic(fmt.Sprintf("errcode.RegisterDomain: code %q 不允许含数字", codeStr))
		}
		if len(codeStr) > maxDomainCodeLength {
			panic(fmt.Sprintf(
				"errcode.RegisterDomain: code %q 长度 %d 超过 %d",
				codeStr, len(codeStr), maxDomainCodeLength,
			))
		}
		if allDomainSet[code] {
			panic(fmt.Sprintf(
				"errcode.RegisterDomain: code %q 已在其他 domain 注册",
				codeStr,
			))
		}
		allDomainSet[code] = true
	}

	// 拷贝一份避免后续调用方修改原切片影响注册表。
	stored := make([]ErrorCode, len(codes))
	copy(stored, codes)
	domainCodes[prefix] = stored
}

// AllDomainCodes 返回所有已注册的 domain code，按 prefix 分组。
// 返回的 map 与切片均为只读副本，调用方可安全修改。
func AllDomainCodes() map[string][]ErrorCode {
	domainMu.RLock()
	defer domainMu.RUnlock()

	out := make(map[string][]ErrorCode, len(domainCodes))
	for prefix, codes := range domainCodes {
		copied := make([]ErrorCode, len(codes))
		copy(copied, codes)
		out[prefix] = copied
	}
	return out
}

// IsDomainCode 判断 code 是否在某个已注册的 domain 闭集中。
// 注意：generic 闭集（codes.go）不算 domain code——如需统一判定，
// 使用 IsErrorCode（generic ∪ domain）。
func IsDomainCode(code ErrorCode) bool {
	domainMu.RLock()
	defer domainMu.RUnlock()
	return allDomainSet[code]
}

// AllIncludingDomain 返回 generic 闭集 + 所有已注册 domain code 的合并集合。
// 顺序：先 generic（与 All() 一致），后 domain（按注册顺序的 prefix 分组，
// 每组内部按注册时切片顺序）。该函数主要用于 --help / 文档列表场景；
// 真正判断码是否合法请用 IsErrorCode，O(1) + 不分配。
func AllIncludingDomain() []ErrorCode {
	generic := All()

	domainMu.RLock()
	defer domainMu.RUnlock()

	total := len(generic)
	for _, codes := range domainCodes {
		total += len(codes)
	}

	out := make([]ErrorCode, 0, total)
	out = append(out, generic...)
	for _, codes := range domainCodes {
		out = append(out, codes...)
	}
	return out
}

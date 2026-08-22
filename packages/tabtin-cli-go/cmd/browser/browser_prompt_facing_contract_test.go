// browser_prompt_facing_contract_test.go — Wave 1 / Task E
//
// 钉死 agent-prompt 依赖的 browser CLI 声明面（live CommandDef，非 Go 源码解析）：
//  1. open 必填 --url，且无 ArgsMapping（禁止位置参数 URL）
//  2. print 必填 --save
//  3. capabilities 叶子命令存在
//
// 小型跨语言桥：
//   - 本文件从 GetCommandDef 实际树计算上述值，并与 JSON fixture 做完整比较；
//   - packages/agent-prompt 的 TS test 只读 fixture，再验证真实 prompt section。
//
// fixture 更新（从仓库根执行）：
//
//	cd packages/tabtin-cli-go &&
//	TABTIN_BROWSER_PROMPT_CONTRACT_EXPORT=../../packages/agent-prompt/src/__tests__/fixtures/browser-cli-prompt-contract.json \
//	  go test ./cmd/browser -run TestExportBrowserPromptFacingContractFixture -count=1
package browser

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

const browserPromptFacingContractFixtureRelPath = "packages/agent-prompt/src/__tests__/fixtures/browser-cli-prompt-contract.json"

type browserPromptFacingCommand struct {
	Use           string   `json:"use"`
	RequiredFlags []string `json:"requiredFlags"`
	ArgsMapping   []string `json:"argsMapping"`
}

type browserPromptFacingPrint struct {
	RequiredFlags []string `json:"requiredFlags"`
}

type browserPromptFacingCapabilities struct {
	Exists bool `json:"exists"`
}

type browserPromptFacingContract struct {
	SchemaVersion int                             `json:"schemaVersion"`
	Open          browserPromptFacingCommand      `json:"open"`
	Print         browserPromptFacingPrint        `json:"print"`
	Capabilities  browserPromptFacingCapabilities `json:"capabilities"`
}

func lookupBrowserLeafDef(root *cobra.Command, rel string) (*cmdutil.CommandDef, bool) {
	for _, leaf := range walkLeafBrowserCommands(root) {
		if browserRelativePath(leaf) != rel {
			continue
		}
		def := cmdutil.GetCommandDef(leaf)
		return def, def != nil
	}
	return nil, false
}

func findBrowserLeafDef(t *testing.T, root *cobra.Command, rel string) *cmdutil.CommandDef {
	t.Helper()
	def, ok := lookupBrowserLeafDef(root, rel)
	if ok {
		return def
	}
	t.Fatalf("找不到 browser 叶子命令 %q", rel)
	return nil
}

func requiredFlagNames(def *cmdutil.CommandDef) []string {
	names := make([]string, 0, len(def.Flags))
	for _, fl := range def.Flags {
		if fl.Required {
			names = append(names, fl.Name)
		}
	}
	sort.Strings(names)
	return names
}

func buildBrowserPromptFacingContract(t *testing.T) browserPromptFacingContract {
	t.Helper()
	root := NewCmdBrowser(cmdutil.NewFactory())
	openDef := findBrowserLeafDef(t, root, "open")
	printDef := findBrowserLeafDef(t, root, "print")
	_, capabilitiesExists := lookupBrowserLeafDef(root, "capabilities")

	argsMapping := append([]string{}, openDef.ArgsMapping...)
	return browserPromptFacingContract{
		SchemaVersion: 1,
		Open: browserPromptFacingCommand{
			Use:           openDef.Use,
			RequiredFlags: requiredFlagNames(openDef),
			ArgsMapping:   argsMapping,
		},
		Print: browserPromptFacingPrint{
			RequiredFlags: requiredFlagNames(printDef),
		},
		Capabilities: browserPromptFacingCapabilities{
			Exists: capabilitiesExists,
		},
	}
}

func readBrowserPromptFacingContractFixture(t *testing.T) browserPromptFacingContract {
	t.Helper()
	path := filepath.Join(repoRoot(t), filepath.FromSlash(browserPromptFacingContractFixtureRelPath))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取 %s: %v", browserPromptFacingContractFixtureRelPath, err)
	}
	var fixture browserPromptFacingContract
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("解析 %s: %v", browserPromptFacingContractFixtureRelPath, err)
	}
	return fixture
}

func marshalBrowserPromptFacingContract(contract browserPromptFacingContract) ([]byte, error) {
	raw, err := json.MarshalIndent(contract, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(raw, '\n'), nil
}

func TestBrowserPromptFacingCLIContract(t *testing.T) {
	got := buildBrowserPromptFacingContract(t)
	want := readBrowserPromptFacingContractFixture(t)
	if !reflect.DeepEqual(got, want) {
		gotJSON, _ := marshalBrowserPromptFacingContract(got)
		wantJSON, _ := marshalBrowserPromptFacingContract(want)
		t.Fatalf("%s 与 live browser CommandDef 树不一致\nwant fixture:\n%s\ngot live tree:\n%s\n"+
			"运行文件头的 TABTIN_BROWSER_PROMPT_CONTRACT_EXPORT 命令更新 fixture",
			browserPromptFacingContractFixtureRelPath, wantJSON, gotJSON)
	}
}

func TestExportBrowserPromptFacingContractFixture(t *testing.T) {
	outPath := os.Getenv("TABTIN_BROWSER_PROMPT_CONTRACT_EXPORT")
	if outPath == "" {
		t.Skip("TABTIN_BROWSER_PROMPT_CONTRACT_EXPORT 未设置")
	}
	raw, err := marshalBrowserPromptFacingContract(buildBrowserPromptFacingContract(t))
	if err != nil {
		t.Fatalf("marshal prompt-facing browser contract: %v", err)
	}
	if err := os.WriteFile(outPath, raw, 0o644); err != nil {
		t.Fatalf("write %s: %v", outPath, err)
	}
}

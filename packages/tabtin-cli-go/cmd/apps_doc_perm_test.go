package cmd

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestDocPermMounted(t *testing.T) {
	cmd := newTestDocCmd(t)
	for _, path := range []string{
		"perm get", "perm set",
		"shared-with-me",
	} {
		parts := strings.Split(path, " ")
		found, _, err := cmd.Find(parts)
		if err != nil || found == nil {
			t.Errorf("命令 %q 未挂载: %v", path, err)
		}
	}
}

func TestDocHTMLShareCommandRemoved(t *testing.T) {
	cmd := newTestDocCmd(t)
	parent, _, err := cmd.Find([]string{"html-share"})
	if err == nil && parent != nil && parent.Name() == "html-share" {
		t.Fatal("doc html-share 应已移除（：改走文档级 share）")
	}
	for _, leaf := range []string{"get", "set", "off"} {
		c, _, err := cmd.Find([]string{"html-share", leaf})
		if err == nil && c != nil && c.Name() == leaf {
			t.Fatalf("doc html-share %s 应已移除", leaf)
		}
	}
}

func TestDocPermSetIsFullReplaceRiskWrite(t *testing.T) {
	cmd := newTestDocCmd(t)
	setCmd, _, err := cmd.Find([]string{"perm", "set"})
	if err != nil || setCmd == nil {
		t.Fatalf("doc perm set 不存在: %v", err)
	}
	def := cmdutil.GetCommandDef(setCmd)
	if def == nil {
		t.Fatal("doc perm set 无 CommandDef")
	}
	if def.Risk != cmdutil.RiskWrite {
		t.Fatalf("perm set Risk=%q, want RiskWrite", def.Risk)
	}
	if !strings.Contains(def.Long, "全量") && !strings.Contains(def.Long, "replace") {
		t.Fatalf("perm set Long 应强调全量 replace，got: %s", def.Long)
	}
	if !strings.Contains(def.Long, "TABTIN_USER_ID") || !strings.Contains(def.Long, "user_id") {
		t.Fatalf("perm set Long 应说明从 JWT/TABTIN_USER_ID 识别自身 admin，got: %s", def.Long)
	}
	if def.DryRun == nil {
		t.Fatal("perm set 缺 DryRun")
	}
}

func TestParseDocPermEntrySpec(t *testing.T) {
	got, err := parseDocPermEntrySpec("user:usr_abc:admin")
	if err != nil {
		t.Fatal(err)
	}
	if got["subject_type"] != "user" || got["subject_id"] != "usr_abc" || got["permission"] != "admin" {
		t.Fatalf("unexpected entry: %#v", got)
	}
	if _, err := parseDocPermEntrySpec("user:usr_abc"); err == nil {
		t.Fatal("短格式应失败")
	}
	if _, err := parseDocPermEntrySpec("group:x:admin"); err == nil {
		t.Fatal("非法 subject_type 应失败")
	}
}

func TestValidateDocPermSetRequiresSelfAdmin(t *testing.T) {
	t.Setenv("TABTIN_USER_ID", "usr_me")
	t.Setenv("TABTIN_JWT", "")
	t.Setenv("TABTIN_TOKEN", "")

	ctx := &cmdutil.RunContext{FlagValues: map[string]any{}}
	if err := validateDocPermSetFlags(ctx); err == nil {
		t.Fatal("空 entries 应失败")
	}

	// 仅有他人 admin：旧逻辑会放行，现应拒绝
	ctx = &cmdutil.RunContext{FlagValues: map[string]any{
		"entry": []string{"user:usr_bob:admin"},
	}}
	if err := validateDocPermSetFlags(ctx); err == nil {
		t.Fatal("无自身 user:<me>:admin 应失败")
	} else if !strings.Contains(err.Error(), "usr_me") {
		t.Fatalf("错误应点名自身 id，got: %v", err)
	}

	ctx = &cmdutil.RunContext{FlagValues: map[string]any{
		"entry": []string{"user:usr_me:admin", "user:usr_bob:editor"},
	}}
	if err := validateDocPermSetFlags(ctx); err != nil {
		t.Fatalf("含自身 admin 不应失败: %v", err)
	}
	entries, ok := ctx.FlagValues["entries"].([]map[string]any)
	if !ok || len(entries) != 2 {
		t.Fatalf("entries 未写入 FlagValues: %#v", ctx.FlagValues["entries"])
	}
}

func TestValidateDocPermSetFailClosedWithoutCallerID(t *testing.T) {
	t.Setenv("TABTIN_USER_ID", "")
	t.Setenv("TABTIN_JWT", "")
	t.Setenv("TABTIN_TOKEN", "")

	ctx := &cmdutil.RunContext{
		Factory:    cmdutil.NewFactory(),
		FlagValues: map[string]any{"entry": []string{"user:usr_anyone:admin"}},
	}
	err := validateDocPermSetFlags(ctx)
	if err == nil {
		t.Fatal("无 caller id 时应 fail-closed")
	}
	if !strings.Contains(err.Error(), "user:<your-id>:admin") && !strings.Contains(err.Error(), "TABTIN_USER_ID") {
		t.Fatalf("应提示显式 --entry / TABTIN_USER_ID，got: %v", err)
	}
}

func TestValidateDocPermSetReadsJWTUserID(t *testing.T) {
	t.Setenv("TABTIN_USER_ID", "")
	token := testAccessTokenWithUserID(t, "usr_from_jwt")
	t.Setenv("TABTIN_JWT", token)
	t.Setenv("TABTIN_TOKEN", "")

	ctx := &cmdutil.RunContext{
		Factory:    cmdutil.NewFactory(),
		FlagValues: map[string]any{"entry": []string{"user:usr_from_jwt:admin"}},
	}
	if err := validateDocPermSetFlags(ctx); err != nil {
		t.Fatalf("JWT user_id 应对齐自身 admin: %v", err)
	}
}

func TestUserIDFromAccessToken(t *testing.T) {
	token := testAccessTokenWithUserID(t, "usr_xyz")
	got, err := userIDFromAccessToken(token)
	if err != nil || got != "usr_xyz" {
		t.Fatalf("got %q err=%v", got, err)
	}
	if _, err := userIDFromAccessToken("ttn_not_a_jwt"); err == nil {
		t.Fatal("非 JWT 应失败")
	}
}

func testAccessTokenWithUserID(t *testing.T, userID string) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	payload, err := json.Marshal(map[string]any{"user_id": userID, "token_type": "access"})
	if err != nil {
		t.Fatal(err)
	}
	body := base64.RawURLEncoding.EncodeToString(payload)
	return header + "." + body + ".sig"
}

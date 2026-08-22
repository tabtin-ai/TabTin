package table

import (
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestParseSetAssignmentAlwaysString(t *testing.T) {
	cases := []struct {
		raw  string
		key  string
		want string
	}{
		{raw: "测试单选=好吧", key: "测试单选", want: "好吧"},
		{raw: "标题=123", key: "标题", want: "123"},
		{raw: "score=3", key: "score", want: "3"},
		{raw: "done=true", key: "done", want: "true"},
		{raw: "empty=null", key: "empty", want: "null"},
		{raw: `tags=["a","b"]`, key: "tags", want: `["a","b"]`},
		{raw: "empty=", key: "empty", want: ""},
		{raw: " title = 123 ", key: "title", want: "123"},
	}
	for _, tc := range cases {
		key, val, err := parseSetAssignment(tc.raw)
		if err != nil {
			t.Fatalf("%q: %v", tc.raw, err)
		}
		if key != tc.key {
			t.Fatalf("%q key=%q want %q", tc.raw, key, tc.key)
		}
		got, ok := val.(string)
		if !ok {
			t.Fatalf("%q val type=%T want string", tc.raw, val)
		}
		if got != tc.want {
			t.Fatalf("%q val=%q want %q", tc.raw, got, tc.want)
		}
	}
}

func TestParseSetAssignmentRejectsBadShape(t *testing.T) {
	if _, _, err := parseSetAssignment("nolequals"); err == nil {
		t.Fatal("expected error")
	}
	if _, _, err := parseSetAssignment("=value"); err == nil {
		t.Fatal("expected error for empty key")
	}
}

func TestValidateRecordUpdateFlagsFromSet(t *testing.T) {
	ctx := &cmdutil.RunContext{
		FlagValues: map[string]any{
			"table-id":  "table-1",
			"record-id": "rec-1",
			"set":       []string{"标题=123", "score=3"},
		},
	}
	if err := validateRecordUpdateFlags(ctx); err != nil {
		t.Fatal(err)
	}
	if _, still := ctx.FlagValues["set"]; still {
		t.Fatal("set should be removed after expansion")
	}
	data, ok := ctx.FlagValues["data"].(map[string]any)
	if !ok {
		t.Fatalf("data type=%T", ctx.FlagValues["data"])
	}
	if data["标题"] != "123" {
		t.Fatalf("标题=%#v (must stay string, not number)", data["标题"])
	}
	if data["score"] != "3" {
		t.Fatalf("score=%#v (must stay string)", data["score"])
	}
}

func TestValidateRecordUpdateFlagsRequiresDataOrSet(t *testing.T) {
	ctx := &cmdutil.RunContext{
		FlagValues: map[string]any{"record-id": "rec-1"},
	}
	if err := validateRecordUpdateFlags(ctx); err == nil {
		t.Fatal("expected error")
	}
}

func TestAdaptRecordUpdateForwardsFieldKeyType(t *testing.T) {
	_, path, body, err := adaptRecordUpdate(&cmdutil.RunContext{}, "POST", "/table/update", map[string]any{
		"record_id":      "rec-1",
		"data":           map[string]any{"测试单选": "好吧"},
		"field_key_type": "name",
	})
	if err != nil {
		t.Fatal(err)
	}
	if path != "/api/tabdata/records/rec-1" {
		t.Fatalf("path=%s", path)
	}
	if body["field_key_type"] != "name" {
		t.Fatalf("body=%#v", body)
	}
	data, ok := body["data"].(map[string]any)
	if !ok || data["测试单选"] != "好吧" {
		t.Fatalf("data=%#v", body["data"])
	}
}

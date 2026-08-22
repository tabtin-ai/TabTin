package cmd

import (
	"strings"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestEventCommand_HasListAndShowSubcommands(t *testing.T) {
	cmd := newCmdEvent(nil)
	if cmd == nil {
		t.Fatal("newCmdEvent 不应返回 nil")
	}
	if cmd.Use != "event" {
		t.Errorf("event 命令 Use 应为 \"event\"，实际：%q", cmd.Use)
	}

	subNames := map[string]bool{}
	for _, sub := range cmd.Commands() {
		subNames[sub.Name()] = true
	}
	if !subNames["list"] {
		t.Error("event 子命令应包含 \"list\"")
	}
	if !subNames["show"] {
		t.Error("event 子命令应包含 \"show\"")
	}
}

func findRegisteredSchema(suffix string) *cmdutil.CommandSchema {
	for _, s := range cmdutil.GetRegisteredCommands() {
		if s.Name == suffix || strings.HasSuffix(s.Name, " "+suffix) {
			return &s
		}
	}
	return nil
}

func TestEventListSchema_RegisteredViaPipeline(t *testing.T) {
	_ = newCmdEvent(nil)
	s := findRegisteredSchema("event list")
	if s == nil {
		t.Fatal("event list 应通过 RegisterCommand 自动注册 Schema")
	}
	if s.Method != "GET" {
		t.Errorf("list schema Method 应为 GET，实际：%q", s.Method)
	}
	if s.Path != "/api/registry/events" {
		t.Errorf("list schema Path 应为 /api/registry/events，实际：%q", s.Path)
	}
}

func TestEventShowSchema_RegisteredViaPipeline(t *testing.T) {
	_ = newCmdEvent(nil)
	s := findRegisteredSchema("event show")
	if s == nil {
		t.Fatal("event show 应通过 RegisterCommand 自动注册 Schema")
	}
	if s.Method != "GET" {
		t.Errorf("show schema Method 应为 GET，实际：%q", s.Method)
	}
	if s.Path != "/api/registry/events/{event_key}" {
		t.Errorf("show schema Path 应为 /api/registry/events/{event_key}，实际：%q", s.Path)
	}
}

package cmd

import (
	"reflect"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestPluginLaunchContract(t *testing.T) {
	pluginCmd := newCmdPlugin(cmdutil.NewFactory())
	launchCmd, remaining, err := pluginCmd.Find([]string{"launch"})
	if err != nil {
		t.Fatalf("find plugin launch: %v", err)
	}
	if launchCmd == nil || launchCmd.Name() != "launch" || len(remaining) != 0 {
		t.Fatalf("plugin launch is not mounted as a cobra leaf: cmd=%v remaining=%v", launchCmd, remaining)
	}

	def := cmdutil.GetCommandDef(launchCmd)
	if def == nil {
		t.Fatal("plugin launch is missing its CommandDef")
	}
	if def.Route != cmdutil.RouteCliServer {
		t.Errorf("Route = %q, want %q", def.Route, cmdutil.RouteCliServer)
	}
	if def.Method != "POST" {
		t.Errorf("Method = %q, want POST", def.Method)
	}
	if def.Path != "/plugin/launch" {
		t.Errorf("Path = %q, want /plugin/launch", def.Path)
	}
	if want := []string{"plugin_id"}; !reflect.DeepEqual(def.ArgsMapping, want) {
		t.Errorf("ArgsMapping = %v, want %v", def.ArgsMapping, want)
	}
	if !def.RequiresAgent || !def.IncludeAgentID {
		t.Errorf("agent context = (requires=%t include=%t), want both true", def.RequiresAgent, def.IncludeAgentID)
	}
	if def.Risk != cmdutil.RiskWrite || !def.RiskDeclared {
		t.Errorf("risk declaration = (%q, declared=%t), want (%q, declared=true)", def.Risk, def.RiskDeclared, cmdutil.RiskWrite)
	}
	wantFlags := map[string]cmdutil.FlagType{
		"service-id":   cmdutil.FlagString,
		"title":        cmdutil.FlagString,
		"open-browser": cmdutil.FlagBool,
		"require-mcp":  cmdutil.FlagBool,
	}
	for name, wantType := range wantFlags {
		flag := launchCmd.Flags().Lookup(name)
		if flag == nil {
			t.Errorf("plugin launch flag --%s is not registered", name)
			continue
		}
		var gotType cmdutil.FlagType
		for _, defFlag := range def.Flags {
			if defFlag.Name == name {
				gotType = defFlag.Type
				break
			}
		}
		if gotType != wantType {
			t.Errorf("flag --%s type = %q, want %q", name, gotType, wantType)
		}
	}
}

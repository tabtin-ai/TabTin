package cmdutil

import "testing"

func TestEffectiveRuntimeHeuristics(t *testing.T) {
	cases := []struct {
		name string
		def  CommandDef
		want RuntimeRequirement
	}{
		{
			name: "explicit local",
			def:  CommandDef{Runtime: RuntimeLocal, Path: "/api/tabdoc/documents"},
			want: RuntimeLocal,
		},
		{
			name: "api path implies cloud",
			def:  CommandDef{Route: RouteCliServer, Path: "/api/tabdoc/documents"},
			want: RuntimeCloud,
		},
		{
			name: "table pseudo path is local by default",
			def:  CommandDef{Route: RouteCliServer, Path: "/table/list"},
			want: RuntimeLocal,
		},
		{
			name: "remote path implies hybrid",
			def:  CommandDef{Route: RouteCliServer, Path: "/space/list", RemotePath: "/api/context/spaces"},
			want: RuntimeHybrid,
		},
		{
			name: "direct route implies cloud",
			def:  CommandDef{Route: RouteDirect},
			want: RuntimeCloud,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.def.EffectiveRuntime(); got != tc.want {
				t.Fatalf("EffectiveRuntime()=%q want %q", got, tc.want)
			}
		})
	}
}

func TestAllowsDjango(t *testing.T) {
	if !(CommandDef{Path: "/api/tabmemo/memos/"}.AllowsDjango()) {
		t.Fatal("api path should allow django")
	}
	if (CommandDef{Path: "/browser/open"}.AllowsDjango()) {
		t.Fatal("browser path should not allow django")
	}
	if !(CommandDef{AdaptRequest: func(ctx *RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
		return method, path, body, nil
	}}.AllowsDjango()) {
		t.Fatal("AdaptRequest should allow django (hybrid)")
	}
}

/**
 *  skill import / npm install — Go CLI helpers
 */

package cmd

import (
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestResolveNpmPackage(t *testing.T) {
	cases := []struct {
		name    string
		args    []string
		fromNpm string
		want    string
	}{
		{name: "npm prefix", args: []string{"npm:@scope/foo"}, want: "@scope/foo"},
		{name: "from-npm flag", fromNpm: "@scope/bar", want: "@scope/bar"},
		{name: "from-npm strips prefix", fromNpm: "npm:@scope/baz", want: "@scope/baz"},
		{name: "canonical key", args: []string{"user:web-search"}, want: ""},
		{name: "empty", want: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := &cmdutil.RunContext{
				Args:       tc.args,
				FlagValues: map[string]any{},
			}
			if tc.fromNpm != "" {
				ctx.FlagValues["from-npm"] = tc.fromNpm
			}
			got := resolveNpmPackage(ctx)
			if got != tc.want {
				t.Fatalf("resolveNpmPackage = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestSkillInstallKey(t *testing.T) {
	ctx := &cmdutil.RunContext{Args: []string{"user:a"}, FlagValues: map[string]any{}}
	if got := skillInstallKey(ctx); got != "user:a" {
		t.Fatalf("got %q", got)
	}
}

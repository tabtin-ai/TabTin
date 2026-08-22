package table

import (
	"reflect"
	"testing"
)

func TestCoerceLinkTargetIDs(t *testing.T) {
	cases := []struct {
		name    string
		body    map[string]any
		want    []string
		wantErr bool
	}{
		{"empty", map[string]any{}, []string{}, false},
		{"json array string", map[string]any{"targets": `["a","b"]`}, []string{"a", "b"}, false},
		{"csv", map[string]any{"target_ids": "a,b;c"}, []string{"a", "b", "c"}, false},
		{"object array", map[string]any{"targets": []any{map[string]any{"id": "x"}, "y"}}, []string{"x", "y"}, false},
		{"bad elem", map[string]any{"targets": []any{1}}, nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := coerceLinkTargetIDs(tc.body)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected err: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

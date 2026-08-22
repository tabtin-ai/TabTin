package skillbundle

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTestBundle(t *testing.T, root string) *Bundle {
	t.Helper()
	skillA := filepath.Join(root, "tabtin-demo-a")
	skillB := filepath.Join(root, "tabtin-demo-b")
	if err := os.MkdirAll(skillA, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(skillA, "refs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(skillB, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillA, "SKILL.md"), []byte("---\nname: tabtin-demo-a\ndescription: A\n---\n# A\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillA, "refs", "note.md"), []byte("# note\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillB, "SKILL.md"), []byte("---\nname: tabtin-demo-b\ndescription: B\n---\n# B\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	shaA, err := HashDir(skillA)
	if err != nil {
		t.Fatal(err)
	}
	shaB, err := HashDir(skillB)
	if err != nil {
		t.Fatal(err)
	}
	m := Manifest{
		BundleVersion: "1",
		CLIVersion:    "0.1.0-test",
		SkillCount:    2,
		Skills: []ManifestSkill{
			{
				Name: "tabtin-demo-a", CanonicalName: "demo-a", Description: "A", Version: "1.0.0",
				ContentSHA256: shaA, Runtime: "cloud", Requires: Requires{Bins: []string{"tabtin"}},
				CLIHelp: "tabtin commands doc --format json",
			},
			{
				Name: "tabtin-demo-b", CanonicalName: "demo-b", Description: "B", Version: "1.0.0",
				ContentSHA256: shaB, Runtime: "local", Requires: Requires{Bins: []string{"tabtin"}},
				CLIHelp: "tabtin commands browser --format json",
			},
		},
	}
	raw, _ := json.MarshalIndent(m, "", "  ")
	if err := os.WriteFile(filepath.Join(root, ManifestFileName), append(raw, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	b, err := OpenBundle(root)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestListAndRead(t *testing.T) {
	root := t.TempDir()
	b := writeTestBundle(t, root)
	list, err := b.List("")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("list len=%d", len(list))
	}
	if list[0].Name != "tabtin-demo-a" || list[0].Requires.Bins[0] != "tabtin" {
		t.Fatalf("unexpected list[0]: %+v", list[0])
	}
	data, path, err := b.Read("tabtin-demo-a", "")
	if err != nil {
		t.Fatal(err)
	}
	if path != "SKILL.md" || !strings.Contains(string(data), "name: tabtin-demo-a") {
		t.Fatalf("read path=%s data=%q", path, data)
	}
	data, path, err = b.Read("tabtin-demo-a", "refs/note.md")
	if err != nil {
		t.Fatal(err)
	}
	if path != "refs/note.md" || !strings.Contains(string(data), "# note") {
		t.Fatalf("read ref failed")
	}
	if _, _, err := b.Read("tabtin-demo-a", "../tabtin-demo-b/SKILL.md"); err == nil {
		t.Fatal("expected path escape error")
	}
}

func TestInstallSyncRemoveOwnership(t *testing.T) {
	bundleRoot := t.TempDir()
	agents := t.TempDir()
	b := writeTestBundle(t, bundleRoot)

	res, err := b.Install(agents, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Installed) != 2 {
		t.Fatalf("installed=%v", res.Installed)
	}
	// 幂等
	res2, err := b.Install(agents, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(res2.Skipped) != 2 {
		t.Fatalf("expected skip on idempotent install, got %+v", res2)
	}

	// 制造漂移再 sync
	skillPath := filepath.Join(agents, "tabtin-demo-a", "SKILL.md")
	if err := os.WriteFile(skillPath, []byte("drift\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 更新 ownership sha 假装旧版
	own, _ := readOwnership(filepath.Join(agents, "tabtin-demo-a"))
	own.ContentSHA256 = "deadbeef"
	raw, _ := json.MarshalIndent(own, "", "  ")
	_ = os.WriteFile(filepath.Join(agents, "tabtin-demo-a", OwnershipFileName), append(raw, '\n'), 0o644)

	syncRes, err := b.Sync(agents)
	if err != nil {
		t.Fatal(err)
	}
	if len(syncRes.Updated) < 1 {
		t.Fatalf("expected update on sync, got %+v", syncRes)
	}
	data, _ := os.ReadFile(skillPath)
	if !strings.Contains(string(data), "tabtin-demo-a") {
		t.Fatalf("sync did not restore content: %q", data)
	}

	doc, err := b.Doctor(agents)
	if err != nil {
		t.Fatal(err)
	}
	if !doc.OK {
		t.Fatalf("doctor should be ok after sync: %+v", doc)
	}

	rm, err := b.Remove(agents, []string{"tabtin-demo-a"})
	if err != nil {
		t.Fatal(err)
	}
	if len(rm.Removed) != 1 {
		t.Fatalf("remove=%+v", rm)
	}
	if _, err := os.Stat(filepath.Join(agents, "tabtin-demo-a")); !os.IsNotExist(err) {
		t.Fatal("skill dir should be gone")
	}
	// demo-b 仍在
	if _, err := os.Stat(filepath.Join(agents, "tabtin-demo-b")); err != nil {
		t.Fatal("remove should not delete other skills")
	}
}

func TestConflictDoesNotOverwrite(t *testing.T) {
	bundleRoot := t.TempDir()
	agents := t.TempDir()
	b := writeTestBundle(t, bundleRoot)

	foreign := filepath.Join(agents, "tabtin-demo-a")
	if err := os.MkdirAll(foreign, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(foreign, "SKILL.md"), []byte("user skill\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := b.Install(agents, []string{"tabtin-demo-a"})
	if err == nil {
		t.Fatal("expected conflict error")
	}
	if _, ok := err.(*ConflictError); !ok {
		t.Fatalf("want ConflictError, got %T %v", err, err)
	}
	if len(res.Conflicts) != 1 {
		t.Fatalf("conflicts=%v", res.Conflicts)
	}
	data, _ := os.ReadFile(filepath.Join(foreign, "SKILL.md"))
	if string(data) != "user skill\n" {
		t.Fatalf("user file overwritten: %q", data)
	}

	// sync 也不覆盖
	_, err = b.Sync(agents)
	if err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(filepath.Join(foreign, "SKILL.md"))
	if string(data) != "user skill\n" {
		t.Fatalf("sync overwrote user file: %q", data)
	}
}

func TestRemoveDoesNotDeleteForeign(t *testing.T) {
	bundleRoot := t.TempDir()
	agents := t.TempDir()
	b := writeTestBundle(t, bundleRoot)
	foreign := filepath.Join(agents, "tabtin-demo-a")
	_ = os.MkdirAll(foreign, 0o755)
	_ = os.WriteFile(filepath.Join(foreign, "SKILL.md"), []byte("user\n"), 0o644)

	rm, err := b.Remove(agents, []string{"tabtin-demo-a"})
	if err != nil {
		t.Fatal(err)
	}
	if len(rm.Skipped) != 1 || len(rm.Removed) != 0 {
		t.Fatalf("should skip foreign: %+v", rm)
	}
	if _, err := os.Stat(foreign); err != nil {
		t.Fatal("foreign skill must remain")
	}
}

func TestOpenBundleRejectsNonPrefixed(t *testing.T) {
	root := t.TempDir()
	m := Manifest{
		BundleVersion: "1",
		CLIVersion:    "x",
		Skills:        []ManifestSkill{{Name: "demo-a", ContentSHA256: "abc"}},
	}
	raw, _ := json.Marshal(m)
	_ = os.WriteFile(filepath.Join(root, ManifestFileName), raw, 0o644)
	if _, err := OpenBundle(root); err == nil {
		t.Fatal("expected prefix validation error")
	}
}

func TestOpenBundleRejectsPathEscapeName(t *testing.T) {
	root := t.TempDir()
	m := Manifest{
		BundleVersion: "1",
		CLIVersion:    "x",
		Skills: []ManifestSkill{{
			Name: "tabtin-x/../../evil", ContentSHA256: "abc",
		}},
	}
	raw, _ := json.Marshal(m)
	_ = os.WriteFile(filepath.Join(root, ManifestFileName), raw, 0o644)
	if _, err := OpenBundle(root); err == nil {
		t.Fatal("expected path-escape name rejection")
	}
}

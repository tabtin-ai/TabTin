// Package skillbundle 提供第三方 Agent Skill 包的读/装/同步/诊断/卸载。
//
// 包内 skills/（随 @tabtin/cli tarball）是权威内容；~/.agents/skills/tabtin-*
// 只是供 Cursor/Claude/Codex 原生扫描的物化副本。
package skillbundle

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

const (
	// EnvBundleDir 覆盖包内 Skill 根（npm 启动器会设置）。
	EnvBundleDir = "TABTIN_SKILLS_BUNDLE_DIR"
	// EnvAgentsSkillsDir 覆盖第三方 Agent Skills 目录（与 agent-runtime 对齐）。
	EnvAgentsSkillsDir = "TABTIN_AGENTS_SKILLS_DIR"

	OwnershipFileName = ".tabtin-skill.json"
	ManifestFileName  = "manifest.json"
	ManagedByTabTin   = "tabtin"
	ExternalPrefix    = "tabtin-"
)

// Manifest 是 bundle 根目录的 manifest.json。
type Manifest struct {
	BundleVersion string         `json:"bundle_version"`
	CLIVersion    string         `json:"cli_version"`
	SkillCount    int            `json:"skill_count"`
	GeneratedAt   string         `json:"generated_at,omitempty"`
	Skills        []ManifestSkill `json:"skills"`
}

// ManifestSkill 是一条导出 Skill 元数据。
type ManifestSkill struct {
	Name            string   `json:"name"`
	CanonicalName   string   `json:"canonical_name"`
	Description     string   `json:"description"`
	Version         string   `json:"version"`
	Source          string   `json:"source"`
	ContentSHA256   string   `json:"content_sha256"`
	Runtime         string   `json:"runtime"`
	Requires        Requires `json:"requires"`
	CLIHelp         string   `json:"cli_help"`
	CLIDomain       *string  `json:"cli_domain"`
	Category        *string  `json:"category"`
	AutoActivateFor []string `json:"auto_activate_for,omitempty"`
	Siblings        []string `json:"siblings,omitempty"`
}

type Requires struct {
	Bins []string `json:"bins"`
}

// Ownership 写在物化目录内，标记本包管理范围。
type Ownership struct {
	ManagedBy     string `json:"managed_by"`
	ExternalName  string `json:"external_name"`
	CanonicalName string `json:"canonical_name"`
	ContentSHA256 string `json:"content_sha256"`
	CLIVersion    string `json:"cli_version"`
	BundleVersion string `json:"bundle_version"`
}

// SkillInfo 是 list 输出条目。
type SkillInfo struct {
	Name          string   `json:"name"`
	Description   string   `json:"description"`
	Version       string   `json:"version"`
	Source        string   `json:"source"`
	ContentSHA256 string   `json:"content_sha256"`
	Runtime       string   `json:"runtime"`
	Requires      Requires `json:"requires"`
	CLIHelp       string   `json:"cli_help,omitempty"`
	CanonicalName string   `json:"canonical_name"`
	Siblings      []string `json:"siblings,omitempty"`
	Installed     bool     `json:"installed,omitempty"`
	InSync        *bool    `json:"in_sync,omitempty"`
}

// ConflictError 表示目标目录存在非本包管理的同名 Skill。
type ConflictError struct {
	Name string
	Path string
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("skill %q exists at %s but is not managed by tabtin", e.Name, e.Path)
}

// Bundle 封装包内权威 Skill 树。
type Bundle struct {
	Root     string
	Manifest Manifest
	byName   map[string]ManifestSkill
}

// OpenBundle 加载并校验 manifest。
func OpenBundle(root string) (*Bundle, error) {
	root = filepath.Clean(root)
	manifestPath := filepath.Join(root, ManifestFileName)
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("open skill bundle at %s: %w", root, err)
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("parse manifest: %w", err)
	}
	if m.BundleVersion == "" {
		return nil, errors.New("manifest missing bundle_version")
	}
	byName := make(map[string]ManifestSkill, len(m.Skills))
	for _, s := range m.Skills {
		if err := validateExternalName(s.Name); err != nil {
			return nil, err
		}
		if _, dup := byName[s.Name]; dup {
			return nil, fmt.Errorf("duplicate skill name %q in manifest", s.Name)
		}
		byName[s.Name] = s
	}
	return &Bundle{Root: root, Manifest: m, byName: byName}, nil
}

// ResolveBundleRoot 按优先级找包内 skills 根。
func ResolveBundleRoot() (string, error) {
	if v := strings.TrimSpace(os.Getenv(EnvBundleDir)); v != "" {
		return filepath.Clean(v), nil
	}
	// npm 布局：<pkg>/binaries/tabtin-* 与 <pkg>/skills 同级
	if exe, err := os.Executable(); err == nil {
		binDir := filepath.Dir(exe)
		candidate := filepath.Join(filepath.Dir(binDir), "skills")
		if fileExists(filepath.Join(candidate, ManifestFileName)) {
			return candidate, nil
		}
		// 二进制就在 package 根旁
		candidate = filepath.Join(binDir, "skills")
		if fileExists(filepath.Join(candidate, ManifestFileName)) {
			return candidate, nil
		}
	}
	// 仓库开发：从 cwd 向上找 packages/tabtin-cli/skills
	wd, err := os.Getwd()
	if err == nil {
		if found := walkUpSkills(wd); found != "" {
			return found, nil
		}
	}
	return "", fmt.Errorf("skill bundle not found; set %s or run generate-skills-bundle", EnvBundleDir)
}

func walkUpSkills(start string) string {
	dir := start
	for i := 0; i < 12; i++ {
		candidate := filepath.Join(dir, "packages", "tabtin-cli", "skills")
		if fileExists(filepath.Join(candidate, ManifestFileName)) {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return ""
}

// ResolveAgentsSkillsDir 默认 ~/.agents/skills。
func ResolveAgentsSkillsDir() string {
	if v := strings.TrimSpace(os.Getenv(EnvAgentsSkillsDir)); v != "" {
		return filepath.Clean(v)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".agents", "skills")
}

// List 返回包内全部 Skill（可选标注安装态）。
func (b *Bundle) List(agentsDir string) ([]SkillInfo, error) {
	out := make([]SkillInfo, 0, len(b.Manifest.Skills))
	names := make([]string, 0, len(b.Manifest.Skills))
	for name := range b.byName {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		s := b.byName[name]
		info := SkillInfo{
			Name:          s.Name,
			Description:   s.Description,
			Version:       s.Version,
			Source:        "bundled",
			ContentSHA256: s.ContentSHA256,
			Runtime:       s.Runtime,
			Requires:      s.Requires,
			CLIHelp:       s.CLIHelp,
			CanonicalName: s.CanonicalName,
			Siblings:      s.Siblings,
		}
		if agentsDir != "" {
			dest := filepath.Join(agentsDir, name)
			if st, err := os.Stat(dest); err == nil && st.IsDir() {
				info.Installed = true
				own, err := readOwnership(dest)
				if err == nil && own.ManagedBy == ManagedByTabTin {
					inSync := own.ContentSHA256 == s.ContentSHA256 &&
						own.CLIVersion == b.Manifest.CLIVersion
					info.InSync = &inSync
				}
			}
		}
		out = append(out, info)
	}
	return out, nil
}

// Read 读取 skill 内相对路径（默认 SKILL.md）；防路径穿越。
func (b *Bundle) Read(name, relPath string) ([]byte, string, error) {
	if err := validateExternalName(name); err != nil {
		return nil, "", err
	}
	s, ok := b.byName[name]
	if !ok {
		return nil, "", fmt.Errorf("skill %q not found in bundle", name)
	}
	if relPath == "" || relPath == "." {
		relPath = "SKILL.md"
	}
	relPath = filepath.ToSlash(relPath)
	if strings.HasPrefix(relPath, "/") || strings.Contains(relPath, "..") {
		return nil, "", fmt.Errorf("invalid relative path %q", relPath)
	}
	full := filepath.Join(b.Root, s.Name, filepath.FromSlash(relPath))
	root := filepath.Join(b.Root, s.Name)
	cleanFull, err := filepath.Abs(full)
	if err != nil {
		return nil, "", err
	}
	cleanRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, "", err
	}
	if cleanFull != cleanRoot && !strings.HasPrefix(cleanFull, cleanRoot+string(os.PathSeparator)) {
		return nil, "", fmt.Errorf("path escapes skill root: %q", relPath)
	}
	data, err := os.ReadFile(cleanFull)
	if err != nil {
		return nil, "", err
	}
	return data, relPath, nil
}

// ListPath 列出 skill 下一层目录项（类 ls）。
func (b *Bundle) ListPath(name, relPath string) ([]map[string]any, error) {
	if err := validateExternalName(name); err != nil {
		return nil, err
	}
	if _, ok := b.byName[name]; !ok {
		return nil, fmt.Errorf("skill %q not found in bundle", name)
	}
	relPath = strings.Trim(filepath.ToSlash(relPath), "/")
	if strings.Contains(relPath, "..") || strings.HasPrefix(relPath, "/") {
		return nil, fmt.Errorf("invalid relative path %q", relPath)
	}
	root := filepath.Join(b.Root, name)
	dir := root
	if relPath != "" {
		dir = filepath.Join(root, filepath.FromSlash(relPath))
	}
	cleanDir, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	cleanRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if cleanDir != cleanRoot && !strings.HasPrefix(cleanDir, cleanRoot+string(os.PathSeparator)) {
		return nil, fmt.Errorf("path escapes skill root: %q", relPath)
	}
	entries, err := os.ReadDir(cleanDir)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		if e.Name() == OwnershipFileName {
			continue
		}
		info := map[string]any{
			"name":  e.Name(),
			"type":  "file",
			"is_dir": e.IsDir(),
		}
		if e.IsDir() {
			info["type"] = "dir"
		}
		out = append(out, info)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i]["name"].(string) < out[j]["name"].(string)
	})
	return out, nil
}

// InstallResult 是 install/sync 的汇总。
type InstallResult struct {
	Target     string   `json:"target"`
	Installed  []string `json:"installed"`
	Updated    []string `json:"updated"`
	Skipped    []string `json:"skipped,omitempty"`
	Conflicts  []string `json:"conflicts,omitempty"`
	BundleVer  string   `json:"bundle_version"`
	CLIVersion string   `json:"cli_version"`
}

// Install 将全部（或指定）Skill 物化到 agentsDir。冲突不覆盖。
func (b *Bundle) Install(agentsDir string, only []string) (*InstallResult, error) {
	if err := os.MkdirAll(agentsDir, 0o755); err != nil {
		return nil, err
	}
	names := only
	if len(names) == 0 {
		for name := range b.byName {
			names = append(names, name)
		}
		sort.Strings(names)
	}
	res := &InstallResult{
		Target:     agentsDir,
		BundleVer:  b.Manifest.BundleVersion,
		CLIVersion: b.Manifest.CLIVersion,
	}
	var conflicts []*ConflictError
	for _, name := range names {
		if err := validateExternalName(name); err != nil {
			return nil, err
		}
		s, ok := b.byName[name]
		if !ok {
			return nil, fmt.Errorf("skill %q not found in bundle", name)
		}
		dest := filepath.Join(agentsDir, name)
		action, err := b.materializeOne(s, dest, false)
		if err != nil {
			var c *ConflictError
			if errors.As(err, &c) {
				conflicts = append(conflicts, c)
				res.Conflicts = append(res.Conflicts, name)
				continue
			}
			return nil, err
		}
		switch action {
		case "installed":
			res.Installed = append(res.Installed, name)
		case "updated":
			res.Updated = append(res.Updated, name)
		case "skipped":
			res.Skipped = append(res.Skipped, name)
		}
	}
	if len(conflicts) > 0 {
		return res, conflicts[0]
	}
	return res, nil
}

// Sync 强制用包内版本覆盖本包管理的目录；非本包冲突仍不碰。
func (b *Bundle) Sync(agentsDir string) (*InstallResult, error) {
	if err := os.MkdirAll(agentsDir, 0o755); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(b.byName))
	for name := range b.byName {
		names = append(names, name)
	}
	sort.Strings(names)
	res := &InstallResult{
		Target:     agentsDir,
		BundleVer:  b.Manifest.BundleVersion,
		CLIVersion: b.Manifest.CLIVersion,
	}
	for _, name := range names {
		s := b.byName[name]
		dest := filepath.Join(agentsDir, name)
		action, err := b.materializeOne(s, dest, true)
		if err != nil {
			var c *ConflictError
			if errors.As(err, &c) {
				res.Conflicts = append(res.Conflicts, name)
				continue
			}
			return nil, err
		}
		switch action {
		case "installed":
			res.Installed = append(res.Installed, name)
		case "updated":
			res.Updated = append(res.Updated, name)
		case "skipped":
			res.Skipped = append(res.Skipped, name)
		}
	}
	return res, nil
}

func (b *Bundle) materializeOne(s ManifestSkill, dest string, forceManaged bool) (string, error) {
	src := filepath.Join(b.Root, s.Name)
	if _, err := os.Stat(src); err != nil {
		return "", fmt.Errorf("bundle skill dir missing: %s: %w", src, err)
	}

	if st, err := os.Stat(dest); err == nil && st.IsDir() {
		own, err := readOwnership(dest)
		if err != nil || own.ManagedBy != ManagedByTabTin {
			return "", &ConflictError{Name: s.Name, Path: dest}
		}
		if !forceManaged && own.ContentSHA256 == s.ContentSHA256 &&
			own.CLIVersion == b.Manifest.CLIVersion {
			return "skipped", nil
		}
		if err := replaceDirAtomic(src, dest, ownershipFor(s, b)); err != nil {
			return "", err
		}
		return "updated", nil
	} else if err != nil && !os.IsNotExist(err) {
		return "", err
	}

	if err := replaceDirAtomic(src, dest, ownershipFor(s, b)); err != nil {
		return "", err
	}
	return "installed", nil
}

func ownershipFor(s ManifestSkill, b *Bundle) Ownership {
	return Ownership{
		ManagedBy:     ManagedByTabTin,
		ExternalName:  s.Name,
		CanonicalName: s.CanonicalName,
		ContentSHA256: s.ContentSHA256,
		CLIVersion:    b.Manifest.CLIVersion,
		BundleVersion: b.Manifest.BundleVersion,
	}
}

// DoctorReport 诊断 CLI/Skill 漂移与冲突。
type DoctorReport struct {
	BundleRoot    string              `json:"bundle_root"`
	AgentsDir     string              `json:"agents_dir"`
	BundleVersion string              `json:"bundle_version"`
	CLIVersion    string              `json:"cli_version"`
	OK            bool                `json:"ok"`
	Drifts        []map[string]string `json:"drifts,omitempty"`
	Conflicts     []map[string]string `json:"conflicts,omitempty"`
	Missing       []string            `json:"missing,omitempty"`
	Orphans       []string            `json:"orphans,omitempty"`
}

// Doctor 检查物化副本与包内权威版本。
func (b *Bundle) Doctor(agentsDir string) (*DoctorReport, error) {
	rep := &DoctorReport{
		BundleRoot:    b.Root,
		AgentsDir:     agentsDir,
		BundleVersion: b.Manifest.BundleVersion,
		CLIVersion:    b.Manifest.CLIVersion,
		OK:            true,
	}
	entries, err := os.ReadDir(agentsDir)
	if err != nil {
		if os.IsNotExist(err) {
			for name := range b.byName {
				rep.Missing = append(rep.Missing, name)
			}
			sort.Strings(rep.Missing)
			rep.OK = len(rep.Missing) == 0
			return rep, nil
		}
		return nil, err
	}
	seen := map[string]bool{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		dest := filepath.Join(agentsDir, name)
		if !strings.HasPrefix(name, ExternalPrefix) {
			continue
		}
		seen[name] = true
		s, inBundle := b.byName[name]
		own, err := readOwnership(dest)
		if err != nil || own.ManagedBy != ManagedByTabTin {
			if inBundle {
				rep.Conflicts = append(rep.Conflicts, map[string]string{
					"name": name, "path": dest, "reason": "not_managed_by_tabtin",
				})
				rep.OK = false
			}
			continue
		}
		if !inBundle {
			rep.Orphans = append(rep.Orphans, name)
			rep.OK = false
			continue
		}
		if own.ContentSHA256 != s.ContentSHA256 || own.CLIVersion != b.Manifest.CLIVersion {
			rep.Drifts = append(rep.Drifts, map[string]string{
				"name":              name,
				"installed_sha256":  own.ContentSHA256,
				"bundle_sha256":     s.ContentSHA256,
				"installed_cli":     own.CLIVersion,
				"bundle_cli":        b.Manifest.CLIVersion,
			})
			rep.OK = false
		}
	}
	for name := range b.byName {
		if !seen[name] {
			// 也检查目录是否存在但没进 seen（不应）
			dest := filepath.Join(agentsDir, name)
			if _, err := os.Stat(dest); os.IsNotExist(err) {
				rep.Missing = append(rep.Missing, name)
			}
		}
	}
	sort.Strings(rep.Missing)
	sort.Strings(rep.Orphans)
	if len(rep.Missing) > 0 {
		rep.OK = false
	}
	return rep, nil
}

// RemoveResult 是 remove 汇总。
type RemoveResult struct {
	Target  string   `json:"target"`
	Removed []string `json:"removed"`
	Skipped []string `json:"skipped,omitempty"`
}

// Remove 只删除本包管理的 tabtin-* 目录。
func (b *Bundle) Remove(agentsDir string, only []string) (*RemoveResult, error) {
	res := &RemoveResult{Target: agentsDir}
	names := only
	if len(names) == 0 {
		for name := range b.byName {
			names = append(names, name)
		}
		sort.Strings(names)
	}
	for _, name := range names {
		if _, ok := b.byName[name]; !ok && len(only) > 0 {
			return nil, fmt.Errorf("skill %q not in bundle", name)
		}
		dest := filepath.Join(agentsDir, name)
		st, err := os.Stat(dest)
		if os.IsNotExist(err) {
			res.Skipped = append(res.Skipped, name)
			continue
		}
		if err != nil {
			return nil, err
		}
		if !st.IsDir() {
			res.Skipped = append(res.Skipped, name)
			continue
		}
		own, err := readOwnership(dest)
		if err != nil || own.ManagedBy != ManagedByTabTin {
			res.Skipped = append(res.Skipped, name)
			continue
		}
		if err := os.RemoveAll(dest); err != nil {
			return nil, err
		}
		res.Removed = append(res.Removed, name)
	}
	return res, nil
}

func readOwnership(dir string) (Ownership, error) {
	var own Ownership
	raw, err := os.ReadFile(filepath.Join(dir, OwnershipFileName))
	if err != nil {
		return own, err
	}
	if err := json.Unmarshal(raw, &own); err != nil {
		return own, err
	}
	return own, nil
}

// replaceDirAtomic 先写临时目录再 rename 替换，避免半安装。
func replaceDirAtomic(src, dest string, own Ownership) error {
	parent := filepath.Dir(dest)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp(parent, ".tabtin-skill-tmp-*")
	if err != nil {
		return err
	}
	tmpAlive := true
	defer func() {
		if tmpAlive {
			_ = os.RemoveAll(tmp)
		}
	}()

	if err := copyDir(src, tmp); err != nil {
		return err
	}
	ownRaw, err := json.MarshalIndent(own, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(tmp, OwnershipFileName), append(ownRaw, '\n'), 0o644); err != nil {
		return err
	}

	// 优先原子 rename；Windows 上目录 rename 常被杀毒/索引拒绝（Access is denied），
	// 失败则 mkdir+overlay 拷贝，不先删已有目录。
	if _, err := os.Stat(dest); err == nil {
		backup := dest + ".bak-" + fmt.Sprintf("%d", os.Getpid())
		if err := os.Rename(dest, backup); err == nil {
			if err := os.Rename(tmp, dest); err != nil {
				_ = os.Rename(backup, dest)
				if runtime.GOOS == "windows" {
					return finalizeViaOverlay(tmp, dest, own, &tmpAlive)
				}
				return err
			}
			tmpAlive = false
			_ = os.RemoveAll(backup)
			return nil
		}
		// dest 挪不开：直接 overlay 进现有目录
		if runtime.GOOS == "windows" {
			return finalizeViaOverlay(tmp, dest, own, &tmpAlive)
		}
		return err
	}

	if err := os.Rename(tmp, dest); err != nil {
		if runtime.GOOS == "windows" {
			return finalizeViaOverlay(tmp, dest, own, &tmpAlive)
		}
		return err
	}
	tmpAlive = false
	return nil
}

func finalizeViaOverlay(tmp, dest string, own Ownership, tmpAlive *bool) error {
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	if err := overlayDir(tmp, dest); err != nil {
		return fmt.Errorf("overlay into %s: %w", dest, err)
	}
	ownRaw, err := json.MarshalIndent(own, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dest, OwnershipFileName), append(ownRaw, '\n'), 0o644); err != nil {
		return err
	}
	*tmpAlive = true // 让 defer 清掉 tmp
	return nil
}

// overlayDir 把 src 树覆盖写入已存在的 dest（Windows rename 失败时的保守路径）。
func overlayDir(src, dest string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dest, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		return copyFile(path, target)
	})
}

func copyDir(src, dest string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return os.MkdirAll(dest, 0o755)
		}
		target := filepath.Join(dest, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return fmt.Errorf("refusing to copy symlink: %s", path)
		}
		return copyFile(path, target)
	})
}

func copyFile(src, dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// validateExternalName 拒绝路径分隔符与 ..，防止 Join(agentsDir, name) 逃逸。
func validateExternalName(name string) error {
	if name == "" {
		return errors.New("manifest skill missing name")
	}
	if !strings.HasPrefix(name, ExternalPrefix) {
		return fmt.Errorf("skill %q must start with %s", name, ExternalPrefix)
	}
	if strings.ContainsAny(name, `/\`) || strings.Contains(name, "..") {
		return fmt.Errorf("skill name %q contains path separators", name)
	}
	if name != filepath.Base(name) {
		return fmt.Errorf("skill name %q must be a single path segment", name)
	}
	for _, r := range name {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.'
		if !ok {
			return fmt.Errorf("skill name %q has invalid character %q", name, r)
		}
	}
	return nil
}

// HashDir 计算目录内容确定性 sha256（与生成器算法一致：相对路径排序后拼接）。
func HashDir(root string) (string, error) {
	var files []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Name() == ".DS_Store" || d.Name() == OwnershipFileName {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		files = append(files, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(files)
	h := sha256.New()
	for _, rel := range files {
		h.Write([]byte(rel))
		h.Write([]byte{0})
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			return "", err
		}
		h.Write(data)
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

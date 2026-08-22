package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var profileNameRe = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

type ProfileConfig struct {
	BaseURL string `json:"baseURL,omitempty"`
	Token   string `json:"token,omitempty"`
	// RefreshToken 由 Device Flow / JWT 登录写入；UserApiKey（ttn_）模式可为空。
	RefreshToken string `json:"refreshToken,omitempty"`
	// DefaultSpace 存 Workspace ID（ Space 终态退役）。JSON key 保留
	// `defaultSpace` 兼容存量 profile；`tabtin workspace use` 与新 `--workspace-id`
	// 全局 flag 写这个字段。字段名待下游读取点收敛后再统一改成 DefaultWorkspace。
	DefaultSpace string `json:"defaultSpace,omitempty"`
	// DefaultAgent 与 DefaultSpace 是两个独立身份：Workspace（历史字段名 Space）是
	// 执行现场容器，Agent 是执行身份。历史上 `agent use` 曾把 agent id 写进
	// DefaultSpace，导致后续命令把 agent id 当 space id（ 同源混用），现已拆开。
	DefaultAgent        string `json:"defaultAgent,omitempty"`
	DefaultOrganization string `json:"defaultOrganization,omitempty"`
	Label               string `json:"label,omitempty"`
}

type GlobalDefaults struct {
	Format string `json:"format,omitempty"`
}

type CLIConfig struct {
	Version        int                       `json:"version"`
	CurrentProfile string                    `json:"currentProfile"`
	Profiles       map[string]*ProfileConfig `json:"profiles"`
	Defaults       GlobalDefaults            `json:"defaults"`
}

func Dir() string {
	if d := os.Getenv("TABTIN_CONFIG_DIR"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".tabtin")
}

func FilePath() string {
	return filepath.Join(Dir(), "config.json")
}

func Load() (*CLIConfig, error) {
	path := FilePath()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return defaultConfig(), nil
		}
		return nil, fmt.Errorf("读取配置文件失败: %w", err)
	}

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("解析配置文件失败: %w", err)
	}

	if _, ok := raw["version"]; !ok {
		return migrateV1(raw)
	}

	var cfg CLIConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("解析配置文件失败: %w", err)
	}
	if cfg.Profiles == nil {
		cfg.Profiles = make(map[string]*ProfileConfig)
	}
	if cfg.CurrentProfile == "" {
		cfg.CurrentProfile = "default"
	}
	return &cfg, nil
}

func Save(cfg *CLIConfig) error {
	dir := Dir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("创建配置目录失败: %w", err)
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化配置失败: %w", err)
	}

	path := FilePath()
	tmpPath := fmt.Sprintf("%s.tmp.%d", path, os.Getpid())

	if err := os.WriteFile(tmpPath, data, 0600); err != nil {
		return fmt.Errorf("写入临时文件失败: %w", err)
	}

	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("替换配置文件失败: %w", err)
	}
	return nil
}

func defaultConfig() *CLIConfig {
	return &CLIConfig{
		Version:        2,
		CurrentProfile: "default",
		Profiles:       map[string]*ProfileConfig{"default": {}},
		Defaults:       GlobalDefaults{Format: "json"},
	}
}

func migrateV1(raw map[string]any) (*CLIConfig, error) {
	p := &ProfileConfig{}
	if v, ok := raw["baseURL"].(string); ok {
		p.BaseURL = v
	}
	if v, ok := raw["token"].(string); ok {
		p.Token = v
	}
	if v, ok := raw["defaultSpace"].(string); ok {
		p.DefaultSpace = v
	}

	cfg := &CLIConfig{
		Version:        2,
		CurrentProfile: "default",
		Profiles:       map[string]*ProfileConfig{"default": p},
		Defaults:       GlobalDefaults{Format: "json"},
	}

	_ = Save(cfg)
	return cfg, nil
}

func ValidateProfileName(name string) error {
	if len(name) == 0 || len(name) > 64 {
		return fmt.Errorf("profile 名称长度需在 1-64 之间")
	}
	if !profileNameRe.MatchString(name) {
		return fmt.Errorf("profile 名称只能包含字母、数字、下划线和连字符")
	}
	return nil
}

func MaskToken(token string) string {
	if len(token) <= 10 {
		return "***"
	}
	return token[:4] + "***" + token[len(token)-3:]
}

func (c *CLIConfig) CurrentProfileConfig() *ProfileConfig {
	name := ResolveProfileName(c)
	p, ok := c.Profiles[name]
	if !ok {
		p = &ProfileConfig{}
		c.Profiles[name] = p
	}
	return p
}

func ResolveProfileName(cfg *CLIConfig) string {
	if env := os.Getenv("TABTIN_PROFILE"); env != "" {
		return env
	}
	if cfg.CurrentProfile != "" {
		return cfg.CurrentProfile
	}
	return "default"
}

func ResolveToken(profile *ProfileConfig) string {
	if v := os.Getenv("TABTIN_JWT"); v != "" {
		return v
	}
	if v := os.Getenv("TABTIN_TOKEN"); v != "" {
		return v
	}
	if profile == nil {
		return ""
	}
	return profile.Token
}

// ResolveRefreshToken 仅读 profile（环境变量不注入 refresh，避免 CI 误用）。
func ResolveRefreshToken(profile *ProfileConfig) string {
	if profile == nil {
		return ""
	}
	return profile.RefreshToken
}

// ResolveWorkspaceID 解析当前执行 Workspace ID（ Space 终态退役）。
//
// 读取顺序：TABTIN_WORKSPACE_ID > TABTIN_SPACE_ID（过渡期兜底） >
// profile.DefaultSpace（历史字段名，实际存 Workspace ID）。
//
// 存量调用方可继续用 `ResolveSpaceID` 别名，新代码请用本函数以保持语义清晰。
func ResolveWorkspaceID(profile *ProfileConfig) string {
	if v := os.Getenv("TABTIN_WORKSPACE_ID"); v != "" {
		return v
	}
	if v := os.Getenv("TABTIN_SPACE_ID"); v != "" {
		return v
	}
	if profile == nil {
		return ""
	}
	return profile.DefaultSpace
}

// ResolveSpaceID 是 ResolveWorkspaceID 的过渡期别名。
//
// Deprecated: 使用 `ResolveWorkspaceID`。
func ResolveSpaceID(profile *ProfileConfig) string {
	return ResolveWorkspaceID(profile)
}

// ResolveAgentID 解析当前执行 Agent 身份：环境变量 TABTIN_AGENT_ID 优先，
// 其次 profile.DefaultAgent（由 `tabtin agent use` 写入）。**不回落 Space ID**——
// Agent 与 Space 是不同实体，把 Space ID 当 Agent ID 是  的根因。
func ResolveAgentID(profile *ProfileConfig) string {
	if v := os.Getenv("TABTIN_AGENT_ID"); v != "" {
		return v
	}
	if profile != nil {
		return profile.DefaultAgent
	}
	return ""
}

func ResolveOrganizationID(profile *ProfileConfig) string {
	if v := os.Getenv("TABTIN_ORGANIZATION_ID"); v != "" {
		return v
	}
	return profile.DefaultOrganization
}

func ResolveBaseURL(profile *ProfileConfig) string {
	if v := os.Getenv("TABTIN_API_URL"); v != "" {
		return strings.TrimRight(v, "/")
	}
	if profile != nil && profile.BaseURL != "" {
		return strings.TrimRight(profile.BaseURL, "/")
	}
	return ""
}

func DaemonDiscoveryPath() string {
	return filepath.Join(Dir(), "daemon-server.json")
}

func DaemonLogPaths() []string {
	home, _ := os.UserHomeDir()
	return []string{
		filepath.Join(home, ".tabtin-daemon", "daemon.log"),
		filepath.Join(home, ".tabtin", "daemon", "daemon.log"),
		filepath.Join(home, ".tabtin", "logs", "daemon.log"),
	}
}

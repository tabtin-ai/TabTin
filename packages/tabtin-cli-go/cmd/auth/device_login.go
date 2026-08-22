package auth

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/TabTin/tabtin-cli/internal/config"
)

// deviceCodeResponse 对齐 Django POST /api/auth/device/code 的 data 字段。
type deviceCodeResponse struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

type deviceTokenData struct {
	AccessToken  string         `json:"access_token"`
	RefreshToken string         `json:"refresh_token"`
	TokenType    string         `json:"token_type"`
	ExpiresIn    int            `json:"expires_in"`
	User         map[string]any `json:"user"`
}

type apiEnvelope struct {
	Success bool            `json:"success"`
	Code    string          `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

func defaultAPIURL() string {
	if v := os.Getenv("TABTIN_API_URL"); v != "" {
		return strings.TrimRight(v, "/")
	}
	return "https://api.example.com"
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

func postJSON(baseURL, path string, payload any) (*apiEnvelope, int, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, 0, err
	}
	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(baseURL, "/")+path, bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	var env apiEnvelope
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		return nil, resp.StatusCode, fmt.Errorf("解析响应失败: %w", err)
	}
	return &env, resp.StatusCode, nil
}

// runDeviceLogin 发起浏览器/设备码登录，写回 access + refresh token。
func runDeviceLogin(baseURL, profileName, label string, cfg *config.CLIConfig) error {
	baseURL = strings.TrimRight(baseURL, "/")
	env, status, err := postJSON(baseURL, "/api/auth/device/code", map[string]any{
		"client_id":   "tabtin-cli",
		"scope":       "cli",
		"device_name": hostnameOr("cli"),
	})
	if err != nil {
		return fmt.Errorf("申请 device code 失败: %w", err)
	}
	if status >= 400 || env == nil || !env.Success {
		msg := "申请 device code 失败"
		if env != nil && env.Message != "" {
			msg = env.Message
		}
		return fmt.Errorf("%s (HTTP %d, code=%s)", msg, status, envCode(env))
	}

	var codeData deviceCodeResponse
	if err := json.Unmarshal(env.Data, &codeData); err != nil {
		return fmt.Errorf("解析 device code 响应失败: %w", err)
	}
	if codeData.DeviceCode == "" || codeData.UserCode == "" {
		return fmt.Errorf("device code 响应缺少必要字段")
	}

	interval := codeData.Interval
	if interval < 5 {
		interval = 5
	}
	expiresIn := codeData.ExpiresIn
	if expiresIn <= 0 {
		expiresIn = 900
	}
	deadline := time.Now().Add(time.Duration(expiresIn) * time.Second)

	verifyURL := codeData.VerificationURIComplete
	if verifyURL == "" {
		verifyURL = codeData.VerificationURI
	}
	fmt.Fprintf(os.Stderr, "在浏览器中打开并确认授权：\n  %s\n", verifyURL)
	fmt.Fprintf(os.Stderr, "若浏览器未自动打开，请手动访问上述地址，并输入授权码：%s\n", codeData.UserCode)
	openBrowser(verifyURL)

	for time.Now().Before(deadline) {
		time.Sleep(time.Duration(interval) * time.Second)

		tokenEnv, tokenStatus, tokenErr := postJSON(baseURL, "/api/auth/device/token", map[string]any{
			"device_code": codeData.DeviceCode,
			"grant_type":  "urn:ietf:params:oauth:grant-type:device_code",
		})
		if tokenErr != nil {
			return fmt.Errorf("轮询 token 失败: %w", tokenErr)
		}
		code := envCode(tokenEnv)
		switch code {
		case "AUTHORIZATION_PENDING":
			fmt.Fprintf(os.Stderr, ".")
			continue
		case "SLOW_DOWN":
			interval += 5
			fmt.Fprintf(os.Stderr, "\n轮询过快，间隔调整为 %ds\n", interval)
			continue
		case "ACCESS_DENIED":
			return fmt.Errorf("用户拒绝了授权")
		case "EXPIRED_TOKEN", "INVALID_GRANT":
			return fmt.Errorf("device code 已过期或无效，请重新登录")
		}

		if tokenStatus >= 400 || tokenEnv == nil || !tokenEnv.Success {
			msg := "换取 token 失败"
			if tokenEnv != nil && tokenEnv.Message != "" {
				msg = tokenEnv.Message
			}
			return fmt.Errorf("%s (HTTP %d, code=%s)", msg, tokenStatus, code)
		}

		var tokenData deviceTokenData
		if err := json.Unmarshal(tokenEnv.Data, &tokenData); err != nil {
			return fmt.Errorf("解析 token 响应失败: %w", err)
		}
		if tokenData.AccessToken == "" {
			return fmt.Errorf("token 响应缺少 access_token")
		}

		p, ok := cfg.Profiles[profileName]
		if !ok {
			p = &config.ProfileConfig{}
			cfg.Profiles[profileName] = p
		}
		p.BaseURL = baseURL
		p.Token = tokenData.AccessToken
		p.RefreshToken = tokenData.RefreshToken
		if label != "" {
			p.Label = label
		}
		cfg.CurrentProfile = profileName
		if err := config.Save(cfg); err != nil {
			return fmt.Errorf("保存配置失败: %w", err)
		}

		fmt.Fprintf(os.Stderr, "\n✓ 已登录 Profile '%s' (%s)\n", profileName, baseURL)
		if user, ok := tokenData.User["nickname"].(string); ok && user != "" {
			fmt.Fprintf(os.Stderr, "✓ 当前用户: %s\n", user)
		} else if user, ok := tokenData.User["username"].(string); ok && user != "" {
			fmt.Fprintf(os.Stderr, "✓ 当前用户: %s\n", user)
		}
		return nil
	}
	return fmt.Errorf("授权超时（%ds），请重试 tabtin auth login", expiresIn)
}

func hostnameOr(fallback string) string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return fallback
	}
	return h
}

func envCode(env *apiEnvelope) string {
	if env == nil {
		return ""
	}
	return env.Code
}

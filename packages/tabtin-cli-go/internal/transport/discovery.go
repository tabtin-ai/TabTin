package transport

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/TabTin/tabtin-cli/internal/config"
)

const maxDiscoveryFileAge = 7 * 24 * time.Hour

type discoveryFile struct {
	Sock      string `json:"sock"`
	Token     string `json:"token"`
	PID       int    `json:"pid"`
	StartedAt string `json:"startedAt,omitempty"`
}

// discoveryFiles 是 ~/.tabtin/ 下 CLI Server 发现文件的优先级（Alive PID + 有效 sock/token 才命中）。
//
// Electron 优先于 Daemon（BR-20）：用户在 Electron 里和 Agent 对话时，期望 tabtin browser 等命令
// 走内嵌浏览器（server.json / dev-server.json），而不是 Daemon 无头 Playwright（daemon-server.json）。
// 仅 Electron 未运行时才会落到 Daemon。显式 TABTIN_SOCK 仍覆盖一切。
var discoveryFiles = []string{
	"server.json",
	"dev-server.json",
	"daemon-server.json",
}

func discoveryDebugEnabled() bool {
	return os.Getenv("TABTIN_DISCOVERY_DEBUG") == "1" || os.Getenv("TABTIN_DEBUG") == "1"
}

func discoveryDebugf(format string, args ...any) {
	if !discoveryDebugEnabled() {
		return
	}
	fmt.Fprintf(os.Stderr, "[tabtin-discovery] "+format+"\n", args...)
}

// maybeStrictEnvelope 按 TABTIN_STRICT_ENVELOPE 环境变量决定是否包 EnvelopeValidator。
//
// **默认关闭** —— 因为 Django 后端 envelope 迁移（cli-migration-plan.md 阶段 2）还没完成，
// 大量旧 endpoint 仍返回 {success, data} 旧 envelope。如果默认开启，所有调旧 endpoint 的
// 命令（tabtin table list 等）会返回 LEGACY_SHAPE 错误，把现有 CLI 全部打废。
//
// 开启方式：export TABTIN_STRICT_ENVELOPE=1
//   - 用于测试新写的命令是否符合规范
//   - Django 全栈迁完后改默认开启（届时删除本环境变量判断）
func maybeStrictEnvelope(tr Transport) Transport {
	if os.Getenv("TABTIN_STRICT_ENVELOPE") == "1" {
		return WithEnvelopeValidation(tr)
	}
	return tr
}

func Discover() Transport {
	// 包装顺序（自内向外）：
	//   底层 transport → [STRICT] EnvelopeValidator → AutoRecovery（仅 socket/http）
	//   底层 transport → [STRICT] EnvelopeValidator → DjangoFallbackWarning（Django 直连）
	//
	// 默认不挂 EnvelopeValidator，仅当 TABTIN_STRICT_ENVELOPE=1 时挂。详见 maybeStrictEnvelope。
	if sock := os.Getenv("TABTIN_SOCK"); sock != "" {
		token := os.Getenv("_TABTIN_TRANSPORT_TOKEN")
		if token != "" {
			discoveryDebugf("select env TABTIN_SOCK sock=%q token_present=true", sock)
			SetTransportState(sock, token)
			return wrapAutoRecovery(maybeStrictEnvelope(NewSocketTransport(sock, token)))
		}
		discoveryDebugf("skip env TABTIN_SOCK sock=%q reason=missing_transport_token", sock)
	}

	if port := os.Getenv("TABTIN_PORT"); port != "" {
		token := os.Getenv("_TABTIN_TRANSPORT_TOKEN")
		if token != "" {
			discoveryDebugf("select env TABTIN_PORT port=%q token_present=true", port)
			SetTransportState("", token)
			return wrapAutoRecovery(maybeStrictEnvelope(NewHTTPTransport(fmt.Sprintf("http://127.0.0.1:%s", port), token)))
		}
		discoveryDebugf("skip env TABTIN_PORT port=%q reason=missing_transport_token", port)
	}

	for _, file := range discoveryFiles {
		if d := tryReadDiscoveryFile(file); d != nil {
			discoveryDebugf("select discovery file=%q sock=%q pid=%d", file, d.Sock, d.PID)
			SetTransportState(d.Sock, d.Token)
			return wrapAutoRecovery(maybeStrictEnvelope(NewSocketTransport(d.Sock, d.Token)))
		}
	}

	cfg, err := config.Load()
	if err == nil {
		profile := cfg.CurrentProfileConfig()
		baseURL := config.ResolveBaseURL(profile)
		token := config.ResolveToken(profile)
		if baseURL != "" && token != "" {
			discoveryDebugf("fallback django base_url=%q token_present=true", baseURL)
			return WithDjangoFallbackWarning(maybeStrictEnvelope(NewDjangoTransport(baseURL, token)))
		}
		discoveryDebugf("skip django fallback base_url_present=%t token_present=%t", baseURL != "", token != "")
	} else {
		discoveryDebugf("skip config load error=%v", err)
	}

	discoveryDebugf("no transport discovered")
	return nil
}

func tryReadDiscoveryFile(filename string) *discoveryFile {
	dir := config.Dir()
	fpath := filepath.Join(dir, filename)

	data, err := os.ReadFile(fpath)
	if err != nil {
		if os.IsNotExist(err) {
			discoveryDebugf("skip discovery file=%q path=%q reason=missing", filename, fpath)
		} else {
			discoveryDebugf("skip discovery file=%q path=%q reason=read_error error=%v", filename, fpath, err)
		}
		return nil
	}

	var d discoveryFile
	if err := json.Unmarshal(data, &d); err != nil {
		discoveryDebugf("skip discovery file=%q path=%q reason=json_error error=%v", filename, fpath, err)
		return nil
	}

	if d.Sock == "" || d.Token == "" {
		missing := []string{}
		if d.Sock == "" {
			missing = append(missing, "sock")
		}
		if d.Token == "" {
			missing = append(missing, "token")
		}
		discoveryDebugf("skip discovery file=%q path=%q reason=missing_fields fields=%s pid=%d", filename, fpath, strings.Join(missing, ","), d.PID)
		return nil
	}

	if d.StartedAt != "" {
		if t, err := time.Parse(time.RFC3339Nano, d.StartedAt); err == nil {
			if time.Since(t) > maxDiscoveryFileAge {
				removeErr := os.Remove(fpath)
				discoveryDebugf("remove discovery file=%q path=%q reason=expired started_at=%q remove_error=%v", filename, fpath, d.StartedAt, removeErr)
				return nil
			}
		} else {
			discoveryDebugf("keep discovery file=%q path=%q reason=started_at_parse_error started_at=%q error=%v", filename, fpath, d.StartedAt, err)
		}
	}

	if d.PID > 0 && !isProcessAlive(d.PID) {
		removeErr := os.Remove(fpath)
		discoveryDebugf("remove discovery file=%q path=%q reason=pid_not_alive pid=%d sock=%q remove_error=%v", filename, fpath, d.PID, d.Sock, removeErr)
		return nil
	}

	return &d
}

func tryDiscoverFromFiles() *discoveryFile {
	for _, file := range discoveryFiles {
		if d := tryReadDiscoveryFile(file); d != nil {
			return d
		}
	}
	return nil
}

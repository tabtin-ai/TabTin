package cmdutil

import (
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/TabTin/tabtin-cli/internal/config"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

type Factory struct {
	configOnce    sync.Once
	transportOnce sync.Once

	cfg *config.CLIConfig
	tr  transport.Transport

	Format        output.Format
	GlobalTimeout time.Duration
	JQExpr        string

	// Quiet：--quiet / -Q / TABTIN_QUIET=1 时设 true。
	// 行为（Sprint 1.C）：
	//   - 成功路径：stdout 抑制（含 batch 每行 + summary）
	//   - 失败路径：error envelope 仍走 stderr（必出，agent 协议）
	//   - dry-run：stderr "=== Dry Run ===" header 抑制；stdout plan 仍输出（plan 是核心信息）
	//   - transport / Daemon 提示等"进度提示"类 stderr 抑制
	Quiet bool

	// OutputPath：--output <path> 时设非空。**long flag only**——不能加 -o 短形式，
	// 否则与现有 `agent run -o` / `api -o` / `table export csv -o` 等子命令的 -o 冲突，
	// Cobra 会 panic："unable to redefine 'o' shorthand"。
	// 短形式延到模块迁移 Sprint 一并清理。
	OutputPath string
}

func NewFactory() *Factory {
	return &Factory{
		Format: output.FormatJSON,
	}
}

func (f *Factory) Config() (*config.CLIConfig, error) {
	var err error
	f.configOnce.Do(func() {
		f.cfg, err = config.Load()
	})
	return f.cfg, err
}

func (f *Factory) Transport() (transport.Transport, error) {
	f.transportOnce.Do(func() {
		tr := transport.Discover()
		if tr != nil {
			// Daemon 回退提示已挪到 transport.WithDjangoFallbackWarning，
			// 在首次真实 Request 时触发，避免 `--help` 路径误打 stderr。
			var mws []transport.Middleware
			if os.Getenv("TABTIN_VERBOSE") == "1" || os.Getenv("TABTIN_DEBUG") == "1" {
				mws = append(mws, transport.WithVerboseLog())
			}
			if len(mws) > 0 {
				tr = transport.ApplyMiddleware(tr, mws...)
			}
		}
		f.tr = tr
	})
	if f.tr == nil {
		return nil, fmt.Errorf("无法连接到 TabTin。请确保 Electron 或 Daemon 正在运行，或配置 API 直连")
	}
	return f.tr, nil
}

// StreamTransport 返回支持 SSE 的传输实现（本地 Socket/HTTP 或 Django 直连）。
func (f *Factory) StreamTransport() (transport.StreamTransport, error) {
	tr, err := f.Transport()
	if err != nil {
		return nil, err
	}
	if st, ok := tr.(transport.StreamTransport); ok {
		return st, nil
	}
	return nil, fmt.Errorf("当前传输层不支持流式连接")
}

func (f *Factory) Profile() (*config.ProfileConfig, error) {
	cfg, err := f.Config()
	if err != nil {
		return nil, err
	}
	return cfg.CurrentProfileConfig(), nil
}

func (f *Factory) ResetTransport() {
	f.transportOnce = sync.Once{}
	f.tr = nil
}

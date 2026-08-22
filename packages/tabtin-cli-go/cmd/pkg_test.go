// W3 — pkg.go 纯函数单测。
//
// 覆盖的关键纯函数(不需后端):
//   - parsePkgRef / parseForkRef:CLI 入参解析
//   - pkgComputeBundleSHA256:与服务端 services.compute_bundle_sha256 必须一致
//   - pkgValidateInside:防御路径穿越
//   - pkgInferFromDir:从目录推断 ns/name
//   - pkgShouldIgnore:扫描时跳过敏感 / 临时文件
//
// 端到端 publish/install/yank/fork/revert 涉及 PR HTTP,留给 harness 做 e2e。
//
// W4 新增:
//   - TestPkgGetFile_RetryOn5xx / TestPkgGetFile_NoRetryOn404:download 重试
//   - TestContentType_FetchFromBackend / TestContentType_FallbackOnError
package cmd

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestParsePkgRef_Valid(t *testing.T) {
	cases := []struct {
		ref     string
		ns      string
		name    string
		version *int
	}{
		{"demo/hello", "demo", "hello", nil},
		{"demo/hello@3", "demo", "hello", intPtr(3)},
		{"a-b/c.d", "a-b", "c.d", nil},
		{"a_b/c-d_e@10", "a_b", "c-d_e", intPtr(10)},
		{"123abc/x.y_z", "123abc", "x.y_z", nil},
	}
	for _, c := range cases {
		r, err := parsePkgRef(c.ref)
		if err != nil {
			t.Errorf("ref=%q parse failed: %v", c.ref, err)
			continue
		}
		if r.Namespace != c.ns || r.Name != c.name {
			t.Errorf("ref=%q got ns=%q name=%q, want ns=%q name=%q",
				c.ref, r.Namespace, r.Name, c.ns, c.name)
		}
		if (r.Version == nil) != (c.version == nil) ||
			(r.Version != nil && *r.Version != *c.version) {
			t.Errorf("ref=%q version mismatch", c.ref)
		}
	}
}

func TestParsePkgRef_Invalid(t *testing.T) {
	bad := []string{
		"",
		"/",
		"demo/",
		"/hello",
		"DEMO/hello",  // 大写不允许
		"demo/HELLO",  // 大写不允许
		"-demo/hello", // 不能以 - 开头
		"demo/-hello",
		"demo/hello@x", // 非数字版本
		"demo/hello@",
		"demo", // 缺少 /
	}
	for _, s := range bad {
		if _, err := parsePkgRef(s); err == nil {
			t.Errorf("ref=%q expected error but parsed OK", s)
		}
	}
}

func TestParseForkRef_RejectsVersion(t *testing.T) {
	if _, err := parseForkRef("demo/hello@3"); err == nil {
		t.Errorf("parseForkRef should reject @version")
	}
	if _, err := parseForkRef("demo/hello"); err != nil {
		t.Errorf("parseForkRef should accept bare ref: %v", err)
	}
}

func TestComputeBundleSHA256_MatchesPythonAlgo(t *testing.T) {
	// 与 services.compute_bundle_sha256 同算法:
	//   sorted (path, sha256) by path → for each: hasher.update(f"{path}:{sha256}")
	files := []pkgFile{
		{Path: "b.txt", SHA256: "bbb"},
		{Path: "a.txt", SHA256: "aaa"},
		{Path: "c/d.txt", SHA256: "ccc"},
	}
	got := pkgComputeBundleSHA256(files)

	// 手算期望:排序后 a.txt → b.txt → c/d.txt
	h := sha256.New()
	h.Write([]byte("a.txt:aaa"))
	h.Write([]byte("b.txt:bbb"))
	h.Write([]byte("c/d.txt:ccc"))
	want := hex.EncodeToString(h.Sum(nil))

	if got != want {
		t.Errorf("bundle sha mismatch\n got=%s\nwant=%s", got, want)
	}
}

func TestComputeBundleSHA256_OrderIndependent(t *testing.T) {
	a := []pkgFile{
		{Path: "x", SHA256: "1"},
		{Path: "y", SHA256: "2"},
	}
	b := []pkgFile{
		{Path: "y", SHA256: "2"},
		{Path: "x", SHA256: "1"},
	}
	if pkgComputeBundleSHA256(a) != pkgComputeBundleSHA256(b) {
		t.Errorf("bundle sha 应与文件顺序无关")
	}
}

func TestValidateInside_Safe(t *testing.T) {
	root := t.TempDir()
	abs, err := pkgValidateInside("foo/bar.txt", root)
	if err != nil {
		t.Fatalf("safe path rejected: %v", err)
	}
	expectedPrefix, _ := filepath.Abs(root)
	if !strings.HasPrefix(abs, expectedPrefix) {
		t.Errorf("resolved path %q not under root %q", abs, expectedPrefix)
	}
}

func TestValidateInside_RejectsTraversal(t *testing.T) {
	root := t.TempDir()
	bad := []string{
		"/etc/passwd",
		"../escape.txt",
		"../../etc/passwd",
		"..",
	}
	for _, p := range bad {
		if _, err := pkgValidateInside(p, root); err == nil {
			t.Errorf("path %q should be rejected", p)
		}
	}
}

func TestInferFromDir_SkillsLayout(t *testing.T) {
	// packages/apps/<ns>/skills/<name> 模式
	ns, name := pkgInferFromDir("/abs/packages/apps/demo/skills/hello")
	if ns != "demo" || name != "hello" {
		t.Errorf("got ns=%q name=%q, want ns=demo name=hello", ns, name)
	}
}

func TestInferFromDir_GenericLayout(t *testing.T) {
	ns, name := pkgInferFromDir("/abs/foo/bar")
	if ns != "foo" || name != "bar" {
		t.Errorf("got ns=%q name=%q, want ns=foo name=bar", ns, name)
	}
}

func TestShouldIgnore(t *testing.T) {
	cases := []struct {
		name   string
		ignore bool
	}{
		{"file.py", false},
		{"SKILL.md", false},
		{".DS_Store", true},
		{"Thumbs.db", true},
		{".env", true},
		{".env.local", true},
		{"credentials.json", true},
		{"a.pyc", true},
		{"a.pem", true},
		{"a.so", true},
		{"normal.json", false},
	}
	for _, c := range cases {
		got := pkgShouldIgnore(c.name)
		if got != c.ignore {
			t.Errorf("%q: got=%v want=%v", c.name, got, c.ignore)
		}
	}
}

func TestResolveLatestAvailable(t *testing.T) {
	items := []map[string]any{
		{"version_seq": float64(3), "is_yanked": false},
		{"version_seq": float64(2), "is_yanked": true},
		{"version_seq": float64(1), "is_yanked": false},
	}
	got, err := pkgResolveLatestAvailable(items, nil)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got != 3 {
		t.Errorf("got=%d want=3", got)
	}

	// 排除 v3 → 应回退到 v1(因为 v2 yanked)
	excluded := 3
	got, err = pkgResolveLatestAvailable(items, &excluded)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got != 1 {
		t.Errorf("excluded=3, got=%d want=1", got)
	}

	// 全部 yanked
	allYanked := []map[string]any{
		{"version_seq": float64(1), "is_yanked": true},
	}
	if _, err := pkgResolveLatestAvailable(allYanked, nil); err == nil {
		t.Errorf("expected err when all yanked")
	}
}

func intPtr(v int) *int {
	return &v
}

// ─── W4-修2: pkgGetFile retry on 5xx / no retry on 4xx ─────────────

func TestPkgGetFile_RetryOn5xx(t *testing.T) {
	// 模拟前 2 次返回 503,第 3 次返回 200。期望 pkgGetFile 成功且尝试 3 次。
	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&attempts, 1)
		if n < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("upstream busy"))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("hello-world"))
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "out.bin")
	// 加快测试 — 用更短的 backoff(直接缩 backoff 不可能,采用 ctx 与 monkeypatch 等替代)
	// 这里直接 accept 真实 backoff(1s + 2s = 3s),保持简单
	t0 := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	err := pkgGetFile(ctx, srv.URL, dest)
	elapsed := time.Since(t0)
	if err != nil {
		t.Fatalf("expected eventual success, got err=%v after %d attempts in %s",
			err, attempts, elapsed)
	}
	if attempts != 3 {
		t.Errorf("expected 3 attempts, got %d", attempts)
	}
	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read dest: %v", err)
	}
	if string(data) != "hello-world" {
		t.Errorf("expected file content 'hello-world', got %q", data)
	}
}

func TestPkgGetFile_NoRetryOn404(t *testing.T) {
	// 4xx 立即 abort,不重试。
	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error": "presigned url expired"}`))
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "out.bin")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	err := pkgGetFile(ctx, srv.URL, dest)
	if err == nil {
		t.Fatalf("expected error on 404, got nil")
	}
	if attempts != 1 {
		t.Errorf("expected 1 attempt on 404 (no retry), got %d", attempts)
	}
	// 错误应该是 non-retryable type
	var nonRetryable *pkgGetFileNonRetryableErr
	if !errors.As(err, &nonRetryable) {
		t.Errorf("expected pkgGetFileNonRetryableErr, got %T: %v", err, err)
	} else if nonRetryable.StatusCode != 404 {
		t.Errorf("expected status 404, got %d", nonRetryable.StatusCode)
	}
}

// ─── W4-修3: content_type fetch / fallback ─────────────────────────

func TestContentType_FetchFromBackend(t *testing.T) {
	// 模拟后端返回自定义 mime 字典(包含 .custom 扩展)。
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 端点路径必须匹配
		if !strings.HasSuffix(r.URL.Path, "/utils/content-types") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{
  "success": true,
  "code": "ok",
  "message": "ok",
  "data": {
    "map": {
      ".custom": "application/x-custom",
      ".py": "text/x-python"
    },
    "default": "application/octet-stream"
  }
}`)
	}))
	defer srv.Close()

	pkgResetContentTypeCache()
	t.Cleanup(func() {
		// 测试后清空 override + cache,避免污染其他测试
		pkgSetContentTypeFetchOverride(nil)
		pkgResetContentTypeCache()
	})

	pkgSetContentTypeFetchOverride(func(ctx context.Context) (map[string]string, string, error) {
		return pkgFetchContentTypesViaURL(ctx, srv.URL)
	})

	// 自定义扩展 .custom 来自后端
	if got := pkgGuessContentType("file.custom"); got != "application/x-custom" {
		t.Errorf("expected backend mime application/x-custom for .custom, got %q", got)
	}
	// 已知扩展 .py 也是 text/x-python(后端字典里有)
	if got := pkgGuessContentType("script.py"); got != "text/x-python" {
		t.Errorf("expected text/x-python for .py, got %q", got)
	}
	// 未知扩展 fallback 到 default
	if got := pkgGuessContentType("file.unknown"); got != "application/octet-stream" {
		t.Errorf("expected default application/octet-stream for unknown ext, got %q", got)
	}
}

func TestContentType_FallbackOnError(t *testing.T) {
	// 后端 500,Go CLI fallback 到内置兜底
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	pkgResetContentTypeCache()
	t.Cleanup(func() {
		pkgSetContentTypeFetchOverride(nil)
		pkgResetContentTypeCache()
	})

	pkgSetContentTypeFetchOverride(func(ctx context.Context) (map[string]string, string, error) {
		return pkgFetchContentTypesViaURL(ctx, srv.URL)
	})

	// fallback 后:.py 应仍是内置 mapping 的 text/x-python
	if got := pkgGuessContentType("a.py"); got != "text/x-python" {
		t.Errorf("expected fallback text/x-python for .py, got %q", got)
	}
	// .md 也应有
	if got := pkgGuessContentType("README.md"); got != "text/markdown" {
		t.Errorf("expected fallback text/markdown for .md, got %q", got)
	}
	// 未知扩展 → default
	if got := pkgGuessContentType("unknown.xyz"); got != "application/octet-stream" {
		t.Errorf("expected fallback default for .xyz, got %q", got)
	}
}

// TestContentType_ProductionPathUsesOverride 验证 W5-修1:Execute() 真实调
// registerPkgContentTypeFetcher 后,生产代码路径下 pkgGuessContentType 会用
// 后端 SSoT 而不是内置 fallback。
//
// 测试策略:模拟 cli-server 启动时的注入流程 —— 用 NewFactory() + 设环境变量
// TABTIN_API_URL 让 ResolveBaseURL 命中 httptest 桩,验证桩里返回的自定义 mime
// 真实生效。同时校验 override 已被注册(非 nil)。
func TestContentType_ProductionPathUsesOverride(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/utils/content-types") {
			http.NotFound(w, r)
			return
		}
		atomic.AddInt32(&hits, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{
  "success": true,
  "code": "ok",
  "message": "ok",
  "data": {
    "map": {".prod-only": "application/x-prod"},
    "default": "application/octet-stream"
  }
}`)
	}))
	defer srv.Close()

	t.Setenv("TABTIN_API_URL", srv.URL)

	pkgResetContentTypeCache()
	t.Cleanup(func() {
		pkgSetContentTypeFetchOverride(nil)
		pkgResetContentTypeCache()
	})

	// 模拟 Execute() 入口:NewFactory + registerPkgContentTypeFetcher
	f := cmdutil.NewFactory()
	registerPkgContentTypeFetcher(f)

	// 验收 1:override 已被设置(非 nil)
	if pkgContentTypeFetchOverride == nil {
		t.Fatalf("registerPkgContentTypeFetcher 未设置 pkgContentTypeFetchOverride")
	}

	// 验收 2:首次调用 pkgGuessContentType 触发 lazy fetch,命中 httptest 桩
	if got := pkgGuessContentType("file.prod-only"); got != "application/x-prod" {
		t.Errorf("expected backend mime application/x-prod for .prod-only, got %q", got)
	}
	if atomic.LoadInt32(&hits) == 0 {
		t.Errorf("expected at least 1 hit on httptest /utils/content-types, got 0")
	}
	// 验收 3:lazy fetch 仅一次(后续走缓存)
	_ = pkgGuessContentType("other.xyz")
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Errorf("expected fetch only once due to cache, got %d hits", got)
	}
}

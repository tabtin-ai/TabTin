//go:build windows

package transport

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
)

func TestSocketTransportRequestOverWindowsNamedPipe(t *testing.T) {
	pipePath := `\\.\pipe\tabtin-cli-go-test-` + time.Now().Format("20060102150405.000000000")
	listener, err := winio.ListenPipe(pipePath, nil)
	if err != nil {
		t.Fatalf("ListenPipe: %v", err)
	}

	server := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if got := r.Header.Get("X-TabTin-Token"); got != "test-token" {
				http.Error(w, "bad token", http.StatusUnauthorized)
				t.Errorf("X-TabTin-Token = %q, want test-token", got)
				return
			}
			if r.URL.Path != "/health" {
				http.Error(w, "bad path", http.StatusNotFound)
				t.Errorf("path = %q, want /health", r.URL.Path)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true,
				"data": map[string]string{
					"status": "ok",
				},
			})
		}),
	}
	errCh := make(chan error, 1)
	go func() {
		errCh <- server.Serve(listener)
	}()
	defer func() {
		_ = server.Close()
		select {
		case err := <-errCh:
			if err != nil && err != http.ErrServerClosed {
				t.Fatalf("Serve: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("Serve did not stop after server.Close")
		}
	}()

	tr := NewSocketTransport(pipePath, "test-token")
	resp, err := tr.Request(context.Background(), "GET", "/health", nil, &RequestOptions{Timeout: 2 * time.Second})
	if err != nil {
		t.Fatalf("Request: %v", err)
	}
	if resp.Status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", resp.Status, string(resp.Data))
	}

	var body struct {
		OK bool `json:"ok"`
	}
	if err := json.Unmarshal(resp.Data, &body); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if !body.OK {
		t.Fatalf("ok = false; body=%s", string(resp.Data))
	}
}

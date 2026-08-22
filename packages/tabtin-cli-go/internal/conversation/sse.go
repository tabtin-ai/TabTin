package conversation

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"

	"github.com/TabTin/tabtin-cli/internal/transport"
)

type EventHandler func(event AgentEvent)

// ConnectSSE 通过 StreamTransport 建立 SSE，统一本地与 Django 直连路径。
func ConnectSSE(ctx context.Context, st transport.StreamTransport, threadID, sessionID string, handler EventHandler) error {
	if ctx == nil {
		ctx = context.Background()
	}
	path := "/agent/stream?thread_id=" + url.QueryEscape(threadID) + "&session_id=" + url.QueryEscape(sessionID)

	rc, err := st.Stream(ctx, path, &transport.RequestOptions{Timeout: transport.DefaultTimeout()})
	if err != nil {
		return fmt.Errorf("建立 SSE 失败: %w", err)
	}
	defer rc.Close()

	reader := bufio.NewReader(rc)
	parseSSEStream(ctx, reader, handler)
	return nil
}

func parseSSEStream(ctx context.Context, reader *bufio.Reader, handler EventHandler) {
	var eventType string
	var dataLines []string

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		line, err := reader.ReadString('\n')
		if err != nil {
			if len(dataLines) > 0 {
				dispatchEvent(eventType, dataLines, handler)
			}
			if err != io.EOF && ctx.Err() == nil && (os.Getenv("TABTIN_VERBOSE") == "1" || os.Getenv("TABTIN_DEBUG") == "1") {
				fmt.Fprintf(os.Stderr, "[sse] 读流结束: %v\n", err)
			}
			return
		}

		line = strings.TrimRight(line, "\r\n")

		if line == "" {
			if len(dataLines) > 0 {
				dispatchEvent(eventType, dataLines, handler)
			}
			eventType = ""
			dataLines = nil
			continue
		}

		if strings.HasPrefix(line, ":") {
			continue
		}

		colonIdx := strings.Index(line, ":")
		if colonIdx < 0 {
			continue
		}

		field := line[:colonIdx]
		value := line[colonIdx+1:]
		if strings.HasPrefix(value, " ") {
			value = value[1:]
		}

		switch field {
		case "event":
			eventType = value
		case "data":
			dataLines = append(dataLines, value)
		}
	}
}

func dispatchEvent(eventType string, dataLines []string, handler EventHandler) {
	data := strings.Join(dataLines, "\n")
	if data == "" {
		return
	}

	var event AgentEvent
	if err := json.Unmarshal([]byte(data), &event); err != nil {
		if os.Getenv("TABTIN_VERBOSE") == "1" || os.Getenv("TABTIN_DEBUG") == "1" {
			fmt.Fprintf(os.Stderr, "[sse] 事件解析失败 (type=%s): %v\n", eventType, err)
		}
		return
	}

	if event.Type == "" && eventType != "" {
		event.Type = eventType
	}
	if event.Type == "" {
		return
	}

	event.Normalize()
	handler(event)
}

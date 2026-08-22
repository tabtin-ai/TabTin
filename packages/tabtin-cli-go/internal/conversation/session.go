package conversation

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"time"

	"github.com/TabTin/tabtin-cli/internal/transport"
)

type SessionClient struct {
	tr transport.Transport
}

func NewSessionClient(tr transport.Transport) *SessionClient {
	return &SessionClient{tr: tr}
}

func (c *SessionClient) CreateSession(ctx context.Context, spaceID, modelID string) (*SessionInfo, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	body := map[string]any{"space_id": spaceID}
	if modelID != "" {
		body["model_id"] = modelID
	}

	resp, err := c.tr.Request(ctx, "POST", "/agent/session/create", body, &transport.RequestOptions{Timeout: 30 * time.Second})
	if err != nil {
		return nil, fmt.Errorf("创建会话失败: %w", err)
	}
	if resp.Status != 200 {
		return nil, fmt.Errorf("创建会话失败 (status %d): %s", resp.Status, string(resp.Data))
	}

	return parseSessionInfo(resp.Data)
}

func (c *SessionClient) GetSession(ctx context.Context, sessionID string) (*SessionInfo, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	resp, err := c.tr.Request(ctx, "GET", "/agent/session?session_id="+url.QueryEscape(sessionID), nil, nil)
	if err != nil {
		return nil, fmt.Errorf("获取会话信息失败: %w", err)
	}
	if resp.Status >= 400 {
		return nil, fmt.Errorf("获取会话信息失败: HTTP %d", resp.Status)
	}
	return parseSessionInfo(resp.Data)
}

func (c *SessionClient) SendMessage(ctx context.Context, spaceID, message, sessionID, modelID string) (*SessionInfo, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	body := map[string]any{
		"space_id": spaceID,
		"message":  message,
	}
	if sessionID != "" {
		body["session_id"] = sessionID
	}
	if modelID != "" {
		body["model_id"] = modelID
	}

	resp, err := c.tr.Request(ctx, "POST", "/agent/message", body, &transport.RequestOptions{Timeout: 60 * time.Second})
	if err != nil {
		return nil, fmt.Errorf("发送消息失败: %w", err)
	}
	if resp.Status != 200 {
		return nil, fmt.Errorf("发送消息失败 (status %d): %s", resp.Status, string(resp.Data))
	}

	return parseSessionInfo(resp.Data)
}

func (c *SessionClient) ListThreads(ctx context.Context, spaceID string, limit int) ([]ThreadSummary, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	path := "/agent/threads?space_id=" + url.QueryEscape(spaceID)
	if limit > 0 {
		path += fmt.Sprintf("&limit=%d", limit)
	}

	resp, err := c.tr.Request(ctx, "GET", path, nil, nil)
	if err != nil {
		return nil, fmt.Errorf("获取历史失败: %w", err)
	}

	var result struct {
		Data struct {
			Sessions []ThreadSummary `json:"sessions"`
		} `json:"data"`
	}
	if err := json.Unmarshal(resp.Data, &result); err != nil {
		var alt struct {
			Sessions []ThreadSummary `json:"sessions"`
		}
		if err2 := json.Unmarshal(resp.Data, &alt); err2 == nil {
			return alt.Sessions, nil
		}
		return nil, fmt.Errorf("解析历史失败: %w", err)
	}
	return result.Data.Sessions, nil
}

func (c *SessionClient) ListModels(ctx context.Context, spaceID string) ([]ModelInfo, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	path := "/agent/models"
	if spaceID != "" {
		path += "?space_id=" + url.QueryEscape(spaceID)
	}

	resp, err := c.tr.Request(ctx, "GET", path, nil, nil)
	if err != nil {
		return nil, fmt.Errorf("获取模型列表失败: %w", err)
	}

	var result struct {
		Data struct {
			Models []ModelInfo `json:"models"`
		} `json:"data"`
	}
	if err := json.Unmarshal(resp.Data, &result); err != nil {
		var alt struct {
			Models []ModelInfo `json:"models"`
		}
		if err2 := json.Unmarshal(resp.Data, &alt); err2 == nil {
			return alt.Models, nil
		}
		return nil, fmt.Errorf("解析模型列表失败: %w", err)
	}
	return result.Data.Models, nil
}

// ChatStream 通过 POST /agent/chat 一步完成创建会话+发送消息+SSE 流。
// 返回的 SessionInfo 从 SSE 的 session_start 事件中提取。
func ChatStream(ctx context.Context, pst transport.PostStreamTransport, spaceID, message, sessionID, modelID string, handler EventHandler) (*SessionInfo, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	body := map[string]any{
		"space_id": spaceID,
		"message":  message,
	}
	if sessionID != "" {
		body["session_id"] = sessionID
	}
	if modelID != "" {
		body["model_id"] = modelID
	}

	rc, err := pst.PostStream(ctx, "/agent/chat", body, nil)
	if err != nil {
		return nil, fmt.Errorf("建立对话流失败: %w", err)
	}
	defer rc.Close()

	var info SessionInfo
	wrappedHandler := func(event AgentEvent) {
		if event.Type == "session_start" {
			info.SessionID = event.SessionID
			info.ThreadID = event.ThreadID
		}
		handler(event)
	}

	reader := bufio.NewReader(rc)
	parseSSEStream(ctx, reader, wrappedHandler)

	if info.SessionID == "" {
		return nil, fmt.Errorf("对话流结束但未收到 session_start 事件")
	}
	return &info, nil
}

func parseSessionInfo(data json.RawMessage) (*SessionInfo, error) {
	var wrapper struct {
		Data SessionInfo `json:"data"`
	}
	if err := json.Unmarshal(data, &wrapper); err == nil && wrapper.Data.SessionID != "" {
		return &wrapper.Data, nil
	}

	var info SessionInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return nil, fmt.Errorf("解析会话信息失败: %w", err)
	}
	return &info, nil
}

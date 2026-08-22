// cmd/agent/current_test.go
//
//  回归：`tabtin agent current` 不得再把 Space ID 冒充 agent_id。
// 修复后 current 改为解析当前 Space 的真实 execution_agent_id。
// 这里直接覆盖响应解析纯函数 parseSpaceExecutionAgent（避开 transport mock）。
package agent

import "testing"

func TestParseSpaceExecutionAgent_DjangoEnvelope(t *testing.T) {
	body := []byte(`{"success":true,"data":{"id":"86e98b5d-8a05-4120-af07-78f224516ff4","execution_agent_id":"462e9094-dbe9-451c-90fe-b83e8669f3ba","execution_binding_source":"space.control_device"}}`)
	agentID, src, err := parseSpaceExecutionAgent(body)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if agentID != "462e9094-dbe9-451c-90fe-b83e8669f3ba" {
		t.Errorf("expected execution_agent_id, got %q", agentID)
	}
	// 关键：解出的 agent_id 不能等于 Space ID（这正是  的错误行为）。
	if agentID == "86e98b5d-8a05-4120-af07-78f224516ff4" {
		t.Errorf("agent_id 不应等于 space id（ 回归）")
	}
	if src != "space.control_device" {
		t.Errorf("expected binding source, got %q", src)
	}
}

func TestParseSpaceExecutionAgent_UnwrappedData(t *testing.T) {
	body := []byte(`{"id":"sp-1","execution_agent_id":"agent-1","execution_binding_source":"space.bound_device"}`)
	agentID, src, err := parseSpaceExecutionAgent(body)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if agentID != "agent-1" || src != "space.bound_device" {
		t.Errorf("got agentID=%q src=%q", agentID, src)
	}
}

func TestParseSpaceExecutionAgent_NoExecutionAgent(t *testing.T) {
	// Space 未绑定执行 Agent：execution_agent_id 为 null → 返回空，由调用方报明确错误，
	// 绝不回落到 space id。
	body := []byte(`{"success":true,"data":{"id":"sp-1","execution_agent_id":null,"execution_binding_source":"none"}}`)
	agentID, _, err := parseSpaceExecutionAgent(body)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if agentID != "" {
		t.Errorf("expected empty agent id when unbound, got %q", agentID)
	}
}

func TestParseSpaceExecutionAgent_InvalidJSON(t *testing.T) {
	if _, _, err := parseSpaceExecutionAgent([]byte(`not json`)); err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

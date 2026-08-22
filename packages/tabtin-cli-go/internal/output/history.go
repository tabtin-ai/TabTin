package output

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

const maxHistoryEntries = 100

type HistoryEntry struct {
	Timestamp string         `json:"timestamp"`
	Command   string         `json:"command"`
	Method    string         `json:"method,omitempty"`
	Path      string         `json:"path,omitempty"`
	Status    int            `json:"status,omitempty"`
	DurationMs int64         `json:"duration_ms,omitempty"`
	Error     string         `json:"error,omitempty"`
}

func historyFilePath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".tabtin", "cli-history.json")
}

func RecordHistory(entry HistoryEntry) {
	entries := LoadHistory()
	entries = append(entries, entry)
	if len(entries) > maxHistoryEntries {
		entries = entries[len(entries)-maxHistoryEntries:]
	}

	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(historyFilePath()), 0755)
	_ = os.WriteFile(historyFilePath(), data, 0600)
}

func LoadHistory() []HistoryEntry {
	data, err := os.ReadFile(historyFilePath())
	if err != nil {
		return nil
	}
	var entries []HistoryEntry
	_ = json.Unmarshal(data, &entries)
	return entries
}

func NowTimestamp() string {
	return time.Now().Format(time.RFC3339)
}

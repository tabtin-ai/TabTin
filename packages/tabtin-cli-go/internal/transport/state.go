package transport

import "sync"

var _state struct {
	mu    sync.RWMutex
	sock  string
	token string
}

func SetTransportState(sock, token string) {
	_state.mu.Lock()
	defer _state.mu.Unlock()
	_state.sock = sock
	_state.token = token
}

func GetTransportState() (sock, token string) {
	_state.mu.RLock()
	defer _state.mu.RUnlock()
	return _state.sock, _state.token
}

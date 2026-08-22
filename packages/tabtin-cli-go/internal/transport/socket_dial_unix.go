//go:build !windows

package transport

import (
	"net"
	"time"
)

func dialSocket(socketPath string, timeout time.Duration) (net.Conn, error) {
	return net.DialTimeout("unix", socketPath, timeout)
}

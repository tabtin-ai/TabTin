//go:build windows

package transport

import (
	"net"
	"time"

	"github.com/Microsoft/go-winio"
)

func dialSocket(socketPath string, timeout time.Duration) (net.Conn, error) {
	return winio.DialPipe(socketPath, &timeout)
}

package transport

import (
	"bufio"
	"io"
)

func newBufReader(r io.Reader) *bufio.Reader {
	return bufio.NewReader(r)
}

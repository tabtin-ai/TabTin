package version

import (
	"fmt"
	"runtime"
)

var (
	Version   = "dev"
	GitCommit = "unknown"
	BuildDate = "unknown"
)

func Full() string {
	return fmt.Sprintf("%s (%s, %s)", Version, GitCommit, BuildDate)
}

func UserAgent() string {
	return fmt.Sprintf("tabtin-cli/%s (%s/%s)", Version, runtime.GOOS, runtime.GOARCH)
}

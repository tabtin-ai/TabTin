package cmdutil

import (
	"fmt"
	"regexp"
)

var validPathParamRe = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// ValidatePathParam rejects path parameters containing path-traversal or injection characters.
func ValidatePathParam(param, paramName string) error {
	if !validPathParamRe.MatchString(param) {
		return fmt.Errorf("非法 %s: %q", paramName, param)
	}
	return nil
}

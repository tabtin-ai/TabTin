package output

import "fmt"

const (
	ExitOK               = 0
	ExitGeneral          = 1
	ExitValidation       = 2
	ExitAuth             = 3
	ExitPermission       = 4
	ExitNotFound         = 5
	ExitNetwork          = 6
	ExitTimeout          = 7
	ExitServiceUnavail   = 8
	// ExitConfirmation：破坏性操作缺 --yes（confirmation_required）。
	ExitConfirmation = 9
	ExitInternal     = 10
)

type ExitError struct {
	Code int
}

func (e *ExitError) Error() string {
	return fmt.Sprintf("exit status %d", e.Code)
}

func NewExitError(code int) *ExitError {
	return &ExitError{Code: code}
}

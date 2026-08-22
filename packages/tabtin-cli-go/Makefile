BINARY_NAME=tabtin
VERSION=$(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
GIT_COMMIT=$(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_DATE=$(shell date -u +"%Y-%m-%dT%H:%M:%SZ")
LDFLAGS=-ldflags "-s -w \
	-X github.com/TabTin/tabtin-cli/internal/version.Version=$(VERSION) \
	-X github.com/TabTin/tabtin-cli/internal/version.GitCommit=$(GIT_COMMIT) \
	-X github.com/TabTin/tabtin-cli/internal/version.BuildDate=$(BUILD_DATE)"

.PHONY: build clean test install build-all checksums

build:
	go build $(LDFLAGS) -o dist/$(BINARY_NAME) .

install:
	go install $(LDFLAGS) .

clean:
	rm -rf dist/

test:
	go test ./...

lint:
	go vet ./...

build-all: clean
	@echo "Building for all platforms..."
	@mkdir -p dist

	GOOS=darwin  GOARCH=arm64 go build $(LDFLAGS) -o dist/$(BINARY_NAME)-darwin-arm64 .
	GOOS=darwin  GOARCH=amd64 go build $(LDFLAGS) -o dist/$(BINARY_NAME)-darwin-amd64 .
	GOOS=linux   GOARCH=amd64 go build $(LDFLAGS) -o dist/$(BINARY_NAME)-linux-amd64 .
	GOOS=linux   GOARCH=arm64 go build $(LDFLAGS) -o dist/$(BINARY_NAME)-linux-arm64 .
	GOOS=windows GOARCH=amd64 go build $(LDFLAGS) -o dist/$(BINARY_NAME)-windows-amd64.exe .
	GOOS=windows GOARCH=arm64 go build $(LDFLAGS) -o dist/$(BINARY_NAME)-windows-arm64.exe .

	@echo "✓ All platforms built"
	@ls -lh dist/

checksums:
	@cd dist && shasum -a 256 $(BINARY_NAME)-* > checksums.txt
	@echo "✓ Checksums generated"
	@cat dist/checksums.txt

release: build-all checksums
	@echo "✓ Release artifacts ready in dist/"

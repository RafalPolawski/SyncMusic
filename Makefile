# Common development tasks. Run `make help` for a list.

GO        ?= go
NPM       ?= npm
VERSION   ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
IMAGE     ?= syncmusic:local
LDFLAGS   := -s -w -X github.com/RafalPolawski/SyncMusic/internal/buildinfo.Version=$(VERSION)

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-14s %s\n", $$1, $$2}'

.PHONY: web
web: ## Build the web client into internal/webui/dist
	cd web && $(NPM) ci && $(NPM) run build

.PHONY: build
build: web ## Build bin/syncmusic with the web client embedded
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o bin/syncmusic ./cmd/syncmusic

.PHONY: run
run: ## Run the server against ./music (set SYNCMUSIC_PASSWORD to require a login)
	mkdir -p music data
	SYNCMUSIC_MUSIC_DIR=./music SYNCMUSIC_DATA_DIR=./data $(GO) run ./cmd/syncmusic

.PHONY: dev
dev: ## Start the Vite dev server (proxying the API to localhost:8080)
	cd web && $(NPM) run dev

.PHONY: test
test: test-go test-web ## Run all unit and integration tests

.PHONY: test-go
test-go: ## Go tests with the race detector
	$(GO) test -race ./...

.PHONY: test-web
test-web: ## Web unit tests
	cd web && $(NPM) test

.PHONY: e2e
e2e: ## End-to-end tests (needs ffmpeg and a Playwright Chromium)
	cd web && $(NPM) run build && $(NPM) run e2e

.PHONY: lint
lint: ## Lint Go and web code
	golangci-lint run ./...
	cd web && $(NPM) run lint && $(NPM) run typecheck && $(NPM) run format:check

.PHONY: fmt
fmt: ## Format Go and web code
	gofmt -w cmd internal
	cd web && $(NPM) run format

.PHONY: docker
docker: ## Build the container image
	docker build --build-arg VERSION=$(VERSION) -t $(IMAGE) .

.PHONY: clean
clean: ## Remove build output
	rm -rf bin dist web/coverage web/test-results web/playwright-report
	find internal/webui/dist -mindepth 1 ! -name .gitkeep -delete

-include .dev/.env
export

SHELL := /bin/bash

# Build configuration
VERSION    ?= $(shell git tag -l --sort=-creatordate | head -n 1)
BUILD_INFO ?= dev-build $(shell git log -1 --pretty=format:'%h %ad' --date=short)
BUILD_OS   ?= $(shell go env GOOS)
BUILD_ARCH ?= $(shell go env GOARCH)

.EXPORT_ALL_VARIABLES:
.PHONY: help lint lint-fix run stop build clean
.DEFAULT_GOAL := help

help: ## 💬 This help message :)
	@figlet $@ || true
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(firstword $(MAKEFILE_LIST)) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

lint: ## 🔍 Lint & format check only, use for CI
	@figlet $@ || true
	go tool -modfile=.dev/tools.mod golangci-lint run -c .dev/golangci.yaml

lint-fix: ## ✨ Lint & try to format & fix
	@figlet $@ || true
	go tool -modfile=.dev/tools.mod golangci-lint run -c .dev/golangci.yaml --fix

run: ## 🏃 Run application, used for local development
	@figlet $@ || true
	@go tool -modfile=.dev/tools.mod air -c .dev/air.toml

stop: ## 🛑 Stop THIS repo's dev server (air + tmp/main); clusters untouched
	@figlet $@ || true
	@# Kill only processes whose /proc/<pid>/exe IS this repo's tmp/main, or an
	@# `air` binary whose cwd is this repo. Matching on exe+cwd (not cmdline) is
	@# deliberate — a broad `pkill -f kubeatlas|air` would also catch stray
	@# editors and unrelated dev servers. Linux-only by design (uses /proc).
	@here="$(CURDIR)"; bin="$$here/tmp/main"; n=0; \
	match() { case "$$1" in "$$bin") return 0;; */air) [ "$$2" = "$$here" ];; *) return 1;; esac; }; \
	for pid in $$(pgrep -f 'air\.toml|tmp/main' 2>/dev/null); do \
	  [ "$$pid" = "$$$$" ] && continue; \
	  exe=$$(readlink -f "/proc/$$pid/exe" 2>/dev/null) || continue; \
	  cwd=$$(readlink -f "/proc/$$pid/cwd" 2>/dev/null) || continue; \
	  match "$$exe" "$$cwd" || continue; \
	  kill "$$pid" 2>/dev/null && { echo "  🛑 stopped $$pid ($$exe)"; n=$$((n+1)); }; \
	done; \
	if [ "$$n" -eq 0 ]; then echo "  ✅ no dev server running"; else \
	  sleep 2; \
	  for pid in $$(pgrep -f 'air\.toml|tmp/main' 2>/dev/null); do \
	    exe=$$(readlink -f "/proc/$$pid/exe" 2>/dev/null) || continue; \
	    cwd=$$(readlink -f "/proc/$$pid/cwd" 2>/dev/null) || continue; \
	    match "$$exe" "$$cwd" && kill -9 "$$pid" 2>/dev/null && echo "  💥 force-killed $$pid"; \
	  done; \
	fi

build: ## 🔨 Build application binary
	@figlet $@ || true
	CGO_ENABLED=0 GOOS=$(BUILD_OS) GOARCH=$(BUILD_ARCH) go build -o bin/kubeatlas \
	  -ldflags "-X 'main.version=$(VERSION)' -X 'main.buildInfo=$(BUILD_INFO)'" \
	  ./server

clean: ## 🧹 Clean up and reset
	@figlet $@ || true
	@rm -rf tmp bin

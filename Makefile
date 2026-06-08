.PHONY: build build:cli build:tui test test:all install install:all clean release help

# Default target
help:
	@echo "Cast Development Commands"
	@echo ""
	@echo "Usage: make <target>"
	@echo ""
	@echo "Targets:"
	@echo "  build          Build TypeScript CLI and TUI"
	@echo "  build:cli      Build CLI only"
	@echo "  build:tui      Build TUI only"
	@echo "  test           Run TypeScript test suite"
	@echo "  test:all       Run all tests (TS + Python)"
	@echo "  install        Install all dependencies"
	@echo "  install:all     Install all dependencies (alias for install)"
	@echo "  clean          Clean test artifacts and build outputs"
	@echo "  release        Create changeset and open PR"
	@echo ""

# Build commands
build: build:cli build:tui

build:cli:
	cd typescript/cast-cli && npm run build

build:tui:
	cd typescript/cast-tui && npm run build

# Test commands
test:
	npm test

test:all:
	npm test && cd python && python -m pytest tests/python -v

# Install commands
install:
	npm install && cd typescript && npm install

install:all: install

# Clean commands
clean:
	npm run clean:test
	cd typescript/cast-cli && rm -rf dist oclif.manifest.json
	cd typescript/cast-tui && rm -rf dist
	rm -rf coverage .nyc_output python/.coverage python/coverage

# Release commands
release:
	@npx changeset

release:push: release
	@git add .changeset/
	@git diff --cached --quiet && echo "No changeset created. Run 'make release' first." || \
		(git commit -m "feat: add changeset" && git push -u origin HEAD)

.DEFAULT_GOAL := help
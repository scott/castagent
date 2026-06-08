.PHONY: help build build-cli build-tui test test-all install clean release

help:
	@echo "Cast Development Commands"
	@echo ""
	@echo "Usage: make <target>"
	@echo ""
	@echo "Targets:"
	@echo "  build       Build TypeScript CLI and TUI"
	@echo "  build-cli   Build CLI only"
	@echo "  build-tui   Build TUI only"
	@echo "  test        Run TypeScript test suite"
	@echo "  test-all    Run all tests (TS + Python)"
	@echo "  install     Install all dependencies"
	@echo "  clean       Clean build and test artifacts"
	@echo "  release     Create changeset for version bump"
	@echo ""

build: build-cli build-tui

build-cli:
	cd typescript/cast-cli && npm run build

build-tui:
	cd typescript/cast-tui && npm run build

test:
	npm test

test-all:
	npm test && cd python && python -m pytest tests/python -v

install:
	npm install && cd typescript && npm install

clean:
	npm run clean:test
	cd typescript/cast-cli && rm -rf dist oclif.manifest.json
	cd typescript/cast-tui && rm -rf dist
	rm -rf coverage .nyc_output python/.coverage python/coverage

release:
	npx changeset

.DEFAULT_GOAL := help
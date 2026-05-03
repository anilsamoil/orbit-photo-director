.PHONY: help install test test-py test-worker test-frontend lint tick watch deploy soak clean

PYTHON ?= python3
BUN ?= bun
RCLONE_REMOTE ?= r2:map-astroanil-dev

help:
	@echo "Orbit Photo Director — make targets:"
	@echo "  install        Install Python + JS dependencies"
	@echo "  test           Run all test suites (Python + Worker + Frontend)"
	@echo "  test-py        Run Python tests only"
	@echo "  test-worker    Run Cloudflare Worker tests"
	@echo "  test-frontend  Run frontend tests"
	@echo "  lint           Run ruff (Python) + tsc (TS)"
	@echo "  tick           Run one generator tick → out/"
	@echo "  watch          Run generator daemon (30-min loop)"
	@echo "  deploy         rclone sync out/ to Cloudflare R2"
	@echo "  soak SCENARIO  Inject a failure scenario (network-kill, daemon-kill, ...)"
	@echo "  clean          Remove build artifacts + out/"

install:
	$(PYTHON) -m pip install -e ".[dev]"
	cd worker && $(BUN) install
	cd frontend && $(BUN) install

test: test-py test-worker test-frontend

test-py:
	$(PYTHON) -m pytest tests/ -v

test-worker:
	cd worker && $(BUN) run test

test-frontend:
	cd frontend && $(BUN) run test

lint:
	$(PYTHON) -m ruff check generator/ tests/
	cd worker && $(BUN) run typecheck
	cd frontend && $(BUN) run typecheck

tick:
	$(PYTHON) -m generator.main

watch:
	$(PYTHON) -m generator.daemon

deploy:
	@which rclone > /dev/null || (echo "rclone not installed"; exit 1)
	rclone sync out/v/ $(RCLONE_REMOTE)/v/ --progress
	rclone copyto out/manifest.json $(RCLONE_REMOTE)/manifest.json

soak:
	@test -n "$(SCENARIO)" || (echo "Usage: make soak SCENARIO=network-kill"; exit 1)
	bash scripts/soak/inject_failure.sh $(SCENARIO)

clean:
	rm -rf out/ build/ dist/ .pytest_cache/ .coverage htmlcov/
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true

.PHONY: help install test test-py test-worker test-frontend lint tick watch deploy soak clean ll2-diff glm-smoke

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
	@echo "  ll2-diff       Diff live LL2 schema against tests/fixtures/ll2-response-2026-05.json"
	@echo "  glm-smoke      Live-S3 smoke test for the GLM sampler (v1.3.2 verify)"
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

LL2_URL ?= https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=1
LL2_FIXTURE ?= tests/fixtures/ll2-response-2026-05.json

# Diff the live LL2 (Launch Library 2) API response shape against the pinned
# fixture. Fires when status.json's `launches_schema_hash` differs from the
# fixture hash and the frontend shows the stale-launches banner — operator
# needs to see WHAT changed (added / removed / renamed keys) without
# manually running jq. Compares the set of jq paths in the first result.
ll2-diff:
	@command -v jq >/dev/null 2>&1 || (echo "ll2-diff: jq not installed (brew install jq)"; exit 1)
	@test -f $(LL2_FIXTURE) || (echo "ll2-diff: fixture missing: $(LL2_FIXTURE)"; exit 1)
	@echo "ll2-diff: fetching $(LL2_URL)"
	@curl -sS -H 'User-Agent: orbit-photo-director/ll2-diff' "$(LL2_URL)" > /tmp/ll2-live.json \
	  || (echo "ll2-diff: curl failed (LL2 down or rate-limited?)"; exit 1)
	@jq -e '.results | length > 0' /tmp/ll2-live.json >/dev/null \
	  || (echo "ll2-diff: live response has no .results[0] — schema may have changed at the top level"; jq 'keys' /tmp/ll2-live.json; exit 1)
	@jq '.results[0] | [paths(scalars)] | map(map(tostring) | join(".")) | sort | unique | .[]' /tmp/ll2-live.json | sed 's/^"//;s/"$$//' | sort -u > /tmp/ll2-live-paths.txt
	@jq '.results[0] | [paths(scalars)] | map(map(tostring) | join(".")) | sort | unique | .[]' $(LL2_FIXTURE) | sed 's/^"//;s/"$$//' | sort -u > /tmp/ll2-fixture-paths.txt
	@echo "ll2-diff: schema paths in fixture but NOT in live (potentially removed/renamed):"
	@comm -23 /tmp/ll2-fixture-paths.txt /tmp/ll2-live-paths.txt | sed 's/^/  - /' || true
	@echo ""
	@echo "ll2-diff: schema paths in live but NOT in fixture (new):"
	@comm -13 /tmp/ll2-fixture-paths.txt /tmp/ll2-live-paths.txt | sed 's/^/  + /' || true
	@echo ""
	@echo "ll2-diff: full live first-result saved to /tmp/ll2-live.json"

# Live-S3 smoke test for the GLM sampler (v1.5.5.0 / weather v1.3.2).
# Build a GLMSampler at "now" and report what it finds. Use this to verify
# the live path after real-world deployment when NOAA S3 has data for
# today. In simulated-2026 dev env this prints "0 granules" because the
# bucket only has data through 2025 — that's expected, not a bug.
glm-smoke:
	$(PYTHON) scripts/glm_smoke.py

clean:
	rm -rf out/ build/ dist/ .pytest_cache/ .coverage htmlcov/
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true

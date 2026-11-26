#!/usr/bin/env python3
"""Extract the W-02 UI test report and render its check table for CI."""

import json
import math
import os
from pathlib import Path
import re
import sys

from check_ios_screenshot import validate_screenshot

CHECKS = (
    "Secure context and matching SHA-256",
    "MapLibre worker and dynamic Map import",
    "WebGL2 on the Map canvas",
    "Map renders a bundled tile",
    "ISS pixels and vertical-perspective geometry",
    "GET, DELETE, POST and PUT bridge fidelity",
    "Bundled tiles at 50 tiles per second",
    "localStorage after app relaunch",
    "WebContent termination and same-tab recovery",
    "Scripted pan and zoom, peak memory",
)
CHECK_IDS = tuple(range(1, len(CHECKS) + 1))
DEVICE_REQUIRED = {"reason": "Requires on-device proof before W-03 can be called done", "gate": "G1-device"}
TEST = "HostProofTests/testOfflineHostProof()"
FULL_STRESS_MS = 600_000
BLOCKED_HOSTS = ["g1-fetch.invalid", "g1-websocket.invalid", "g1-xhr.invalid"]
SCREENSHOT_TABS = {4: "map", 5: "iss"}


def parse_checks(value):
    if value is None:
        return CHECK_IDS
    valid = {str(number) for number in CHECK_IDS}
    tokens = [token.strip() for token in value.split(",")]
    for token in tokens:
        if token not in valid:
            raise ValueError(f"Unknown G1_CHECKS id: {token!r}")
    return tuple(sorted({int(token) for token in tokens}))


def exported_attachment(directory, attachments, name, suffix):
    pattern = re.compile(rf"{re.escape(name)}(?:_\d+_[0-9a-fA-F-]{{36}})?(?:{re.escape(suffix)})?")
    matches = []
    for attachment in attachments:
        if not pattern.fullmatch(attachment.get("suggestedHumanReadableName", "")):
            continue
        filename = attachment.get("exportedFileName")
        if not isinstance(filename, str) or not filename or Path(filename).name != filename:
            raise ValueError(f"Invalid exported filename for {name}")
        path = directory / filename
        if path.suffix.lower() == suffix and path.is_file() and path.stat().st_size > 0:
            matches.append(path)
    if len(matches) != 1:
        raise ValueError(f"Expected one nonempty {name}{suffix} attachment, got {len(matches)}")
    return matches[0]


def validate_passing_evidence(number, evidence, directory, attachments):
    if number in (1, 9):
        egress = evidence.get("egress")
        if (
            not isinstance(egress, dict)
            or egress.get("connectSrcBlockedHosts") != BLOCKED_HOSTS
            or egress.get("capacitorHttp") != "G1_BRIDGE_DENIED"
            or egress.get("capacitorHttpNativeClass") != "G1_BRIDGE_DENIED"
        ):
            raise ValueError(f"Check {number} is missing browser or native egress-denial evidence")
    elif number == 10:
        elapsed = evidence.get("actualDurationMs")
        memory = evidence.get("memory")
        if not isinstance(memory, dict):
            memory = {}
        rss = memory.get("peakBytes")
        observed = memory.get("observedDurationMs")
        if (
            evidence.get("requestedDurationMs") != FULL_STRESS_MS
            or type(elapsed) not in (int, float)
            or (type(elapsed) is float and not math.isfinite(elapsed))
            or elapsed < FULL_STRESS_MS
            or type(observed) is not int or observed < FULL_STRESS_MS
            or type(rss) is not int or rss <= 0
        ):
            raise ValueError("Check 10 is missing full-duration stress or WebContent peak RSS evidence")
    elif number in SCREENSHOT_TABS:
        tab = SCREENSHOT_TABS[number]
        png = exported_attachment(directory, attachments, f"G1-{tab}", ".png")
        validate_screenshot(png, proof_tab=tab)


def escape_markdown(value):
    return (
        value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace("|", "&#124;").replace("`", "&#96;")
    )


def main(output, outcome):
    try:
        selected_checks = parse_checks(os.environ.get("G1_CHECKS"))
    except ValueError as error:
        print(error, file=sys.stderr)
        return 1

    directory = output / "attachments"
    results = [
        {
            "id": number,
            "status": "not-run",
            "evidence": {"reason": "No result was captured from the UI test"}
            if number in selected_checks else DEVICE_REQUIRED.copy(),
        }
        for number in CHECK_IDS
    ]
    attachments = []
    report = {}
    errors = []
    rows = {number: [] for number in CHECK_IDS}
    try:
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        attachments = [
            item for test in manifest if test.get("testIdentifier") == TEST
            for item in test.get("attachments", [])
        ]
        report_path = exported_attachment(directory, attachments, "G1-proof-results", ".json")
        native_report = json.loads(report_path.read_text(encoding="utf-8"))
        native_rows = native_report["results"]
        if not isinstance(native_rows, list):
            raise ValueError("Expected a list of proof results")
        for row in native_rows:
            number = row.get("id") if isinstance(row, dict) else None
            if type(number) is not int or number not in rows:
                errors.append(f"Proof evidence export: Unexpected check number: {number!r}")
                continue
            rows[number].append(row)
        report = native_report
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        errors.append(f"Proof evidence export: {error}")

    for number, matches in rows.items():
        if not matches:
            continue
        if len(matches) > 1:
            error = f"Duplicate result for check {number}"
            errors.append(f"Proof evidence export: {error}")
            if number in selected_checks:
                results[number - 1].update(status="fail", evidence={"evidenceError": error})
            continue
        result = matches[0]
        status = result.get("status")
        if number not in selected_checks:
            if status != "not-run":
                errors.append(f"Proof evidence export: Unselected check {number} must have status not-run")
            continue
        if status not in ("pass", "fail", "blocked", "not-run"):
            errors.append(f"Proof evidence export: Invalid status for check {number}")
            continue
        evidence = result.get("evidence")
        if not isinstance(evidence, dict) or not evidence:
            error = f"Missing or invalid evidence for check {number}"
            errors.append(f"Proof evidence export: {error}")
            if status == "pass":
                results[number - 1].update(status="fail", evidence={"evidenceError": error})
            continue
        if status == "pass":
            try:
                validate_passing_evidence(number, evidence, directory, attachments)
            except (OSError, ValueError, TypeError, AttributeError) as error:
                status = "fail"
                if number in SCREENSHOT_TABS:
                    evidence["screenshotError"] = str(error)
                    errors.append(f"Proof evidence export (G1-{SCREENSHOT_TABS[number]}): {error}")
                else:
                    evidence["evidenceError"] = str(error)
                    errors.append(f"Proof evidence export: {error}")
        results[number - 1] = {**result, "status": status}

    if outcome == "success" and any(
        len(rows[number]) != 1 or rows[number][0].get("status") != "pass" for number in selected_checks
    ):
        errors.append("Successful XCTest run is missing passing check evidence")

    report.update(
        results=results,
        selectedChecks=selected_checks,
        testOutcome=outcome,
        evidenceExportErrors=errors,
        workflow={
            "runID": os.environ.get("GITHUB_RUN_ID"),
            "attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
            "revision": os.environ.get("GITHUB_SHA"),
            "simulator": os.environ.get("SIMULATOR_NAME"),
            "runtime": os.environ.get("SIMULATOR_RUNTIME"),
        },
    )
    (output / "proof-results.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    table = ["# SNAP iOS host proof", "", f"XCTest step reported `{outcome}`.", ""]
    table.extend(["| # | Check | Result | Evidence |", "| - | - | - | - |"])
    for result, name in zip(results, CHECKS, strict=True):
        evidence = escape_markdown(json.dumps(result["evidence"], ensure_ascii=False, sort_keys=True))
        status = result["status"] if result["id"] in selected_checks else "not-run (on-device required)"
        table.append(f'| {result["id"]} | {name} | {status} | {evidence} |')
    if errors:
        table.extend(["", "## Proof evidence export errors", ""])
        table.extend(f"- {escape_markdown(error)}" for error in errors)
    (output / "checks.md").write_text("\n".join(table) + "\n", encoding="utf-8")
    for error in errors:
        print(error, file=sys.stderr)
    return int(outcome == "success" and bool(errors))


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1]), sys.argv[2]))

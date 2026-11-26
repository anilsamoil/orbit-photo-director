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
TEST = "HostProofTests/testOfflineHostProof()"
FULL_STRESS_MS = 600_000
BLOCKED_HOSTS = ["g1-fetch.invalid", "g1-websocket.invalid", "g1-xhr.invalid"]


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


def main(output, outcome):
    directory = output / "attachments"
    results = [
        {"id": i, "status": "not-run", "evidence": {"reason": "No result was captured from the UI test"}}
        for i in range(1, 11)
    ]
    attachments = []
    report = {}
    errors = []
    try:
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        attachments = [
            item for test in manifest if test.get("testIdentifier") == TEST
            for item in test.get("attachments", [])
        ]
        report_path = exported_attachment(directory, attachments, "G1-proof-results", ".json")
        native_report = json.loads(report_path.read_text(encoding="utf-8"))
        seen = set()
        for result in native_report["results"]:
            number = result["id"]
            allowed = {"pass", "fail", "blocked", "not-run"}
            if type(number) is not int or number not in range(1, 11) or number in seen:
                raise ValueError(f"Unexpected check number: {number}")
            if result["status"] not in allowed or not isinstance(result["evidence"], dict) or not result["evidence"]:
                raise ValueError(f"Invalid status or missing evidence for check {number}")
            results[number - 1] = result
            seen.add(number)
        report = native_report
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        errors.append(f"Proof evidence export: {error}")

    if outcome == "success":
        if any(result["status"] != "pass" for result in results):
            errors.append("Successful XCTest run is missing passing check evidence")
        else:
            for index in (0, 8):
                egress = results[index]["evidence"].get("egress")
                if (
                    not isinstance(egress, dict)
                    or egress.get("connectSrcBlockedHosts") != BLOCKED_HOSTS
                    or egress.get("capacitorHttp") != "G1_BRIDGE_DENIED"
                    or egress.get("capacitorHttpNativeClass") != "G1_BRIDGE_DENIED"
                ):
                    errors.append(f"Check {index + 1} is missing browser or native egress-denial evidence")
            evidence = results[9]["evidence"]
            elapsed = evidence.get("actualDurationMs")
            memory = evidence.get("memory")
            if not isinstance(memory, dict):
                memory = {}
            rss = memory.get("peakBytes")
            observed = memory.get("observedDurationMs")
            if (
                evidence.get("requestedDurationMs") != FULL_STRESS_MS
                or type(elapsed) not in (int, float) or not math.isfinite(elapsed) or elapsed < FULL_STRESS_MS
                or type(observed) is not int or observed < FULL_STRESS_MS
                or type(rss) is not int or rss <= 0
            ):
                errors.append("Successful XCTest run is missing full-duration stress or WebContent peak RSS evidence")

    for number, tab in ((4, "map"), (5, "iss")):
        result = results[number - 1]
        if result["status"] != "pass":
            continue
        name = f"G1-{tab}"
        try:
            png = exported_attachment(directory, attachments, name, ".png")
            validate_screenshot(png, proof_tab=tab)
        except (OSError, ValueError, TypeError, AttributeError) as error:
            result["status"] = "fail"
            result["evidence"]["screenshotError"] = str(error)
            errors.append(f"Proof evidence export ({name}): {error}")

    report.update(
        results=results,
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
        evidence = json.dumps(result["evidence"], ensure_ascii=False, sort_keys=True)
        evidence = (
            evidence.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace("|", "&#124;").replace("`", "&#96;")
        )
        table.append(f'| {result["id"]} | {name} | {result["status"]} | {evidence} |')
    (output / "checks.md").write_text("\n".join(table) + "\n", encoding="utf-8")
    for error in errors:
        print(error, file=sys.stderr)
    return int(outcome == "success" and bool(errors))


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1]), sys.argv[2]))

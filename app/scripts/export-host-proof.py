#!/usr/bin/env python3
"""Extract the W-02 UI test report and render its check table for CI."""

import hashlib
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
FIXTURE_DIGEST = hashlib.sha256(bytes(range(256)) * 16).hexdigest()
FIXTURE_ORIGIN = "capacitor://localhost"
BRIDGE_REQUESTS = (
    ("GET", "/manifest.json", ""),
    ("DELETE", "/api/browser/profiles/g1-fixture/targets/g1-synthetic", ""),
    ("POST", "/api/log", '{"target_id":"g1-synthetic","notes":"Limb—合","action":"shoot"}\n'),
    ("PUT", "/api/browser/profiles/g1-fixture/targets",
     '{"targets":[{"id":"g1-synthetic","name":"Earth – 北","geom":{"type":"point","lat":28,"lon":-97}}]}\n'),
)
GEOMETRY_CHECKS = {
    "projection", "field of view", "pitch clamp", "camera radius", "sub-point", "limb", "nadir filled",
    "nested property", "nasa tiles", "horizon and nadir poses applied", "zoom 12 applied",
}


def parse_checks(value):
    if value is None:
        return CHECK_IDS
    valid = {str(number) for number in CHECK_IDS}
    tokens = [token.strip(" \t\n\r") for token in value.split(",")]
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


def object_field(record, key):
    value = record.get(key)
    return value if isinstance(value, dict) else {}


def integer_at_least(value, minimum):
    return type(value) is int and value >= minimum


def finite_number(value):
    return type(value) in (int, float) and (type(value) is int or math.isfinite(value))


def identity(value):
    return isinstance(value, str) and bool(value.strip())


def validate_tile_pixels(evidence, tab):
    layer = "carto-dark-layer" if tab == "map" else "iss-lit"
    positive = evidence.get("positive")
    if (
        evidence.get("layer") != layer
        or not integer_at_least(positive, 8)
        or type(evidence.get("negative")) is not int or evidence["negative"] != 0
        or not integer_at_least(evidence.get("pixelsSampled"), positive)
        or not integer_at_least(evidence.get("localTileResponses"), 1)
    ):
        raise ValueError(f"Missing {tab} raster, local response or pixel-control evidence")


def validate_geometry(geometry):
    checks = geometry.get("checks")
    if (
        not isinstance(checks, list) or len(checks) != len(GEOMETRY_CHECKS)
        or not all(isinstance(check, dict) and isinstance(check.get("name"), str)
                   and check.get("pass") is True for check in checks)
        or {check["name"] for check in checks} != GEOMETRY_CHECKS
    ):
        raise ValueError("Check 5 is missing passing ISS geometry assertions")
    for name in ("horizon", "nadir", "zoom12"):
        sample = object_field(geometry, name)
        runtime = object_field(sample, "runtime")
        if (
            sample.get("projection") != "vertical-perspective"
            or runtime.get("projection") != "vertical-perspective"
            or runtime.get("shaderVariant") != "globe"
            or runtime.get("transition") != 1
        ):
            raise ValueError(f"Check 5 is missing rendered ISS geometry for {name}")
    zoom12 = object_field(geometry, "zoom12")
    zoom = object_field(zoom12, "applied").get("zoom")
    if not finite_number(zoom) or abs(zoom - 12) >= 0.001 or not integer_at_least(zoom12.get("tilePixels"), 8):
        raise ValueError("Check 5 is missing ISS zoom 12 raster evidence")
    for name in ("horizon", "nadir"):
        sample = geometry[name]
        applied = object_field(sample, "applied")
        measures = ("verticalFovDeg", "pitchDeg", "analyticPitchDeg", "maxPitchDeg",
                    "radiusErrorM", "subpointErrorDeg", "earthFraction", "expectedZoom")
        if (
            sample.get("preset") != name or sample.get("appliedPose") is not True
            or not all(finite_number(sample.get(key)) for key in measures)
        ):
            raise ValueError(f"Check 5 is missing measured ISS camera pose for {name}")
        zoom = applied.get("zoom")
        roll = applied.get("roll")
        if (
            not finite_number(zoom) or abs(zoom - sample["expectedZoom"]) >= 0.001
            or not finite_number(roll) or abs((roll % 360) - 180) >= 0.01
        ):
            raise ValueError(f"Check 5 applied zoom or roll is outside tolerance for {name}")
        if abs(sample["verticalFovDeg"] - 81.20259) >= 0.02:
            raise ValueError(f"Check 5 field of view is outside tolerance for {name}")
        if abs(sample["pitchDeg"] - sample["analyticPitchDeg"]) >= 0.5 or sample["maxPitchDeg"] < 90:
            raise ValueError(f"Check 5 pitch is outside tolerance for {name}")
        if abs(sample["radiusErrorM"]) >= 2_000:
            raise ValueError(f"Check 5 camera radius error is outside tolerance for {name}")
        if not 0 <= sample["subpointErrorDeg"] < 0.05:
            raise ValueError(f"Check 5 sub-point error is outside tolerance for {name}")

    limb_error = geometry["horizon"].get("limbErrorDeg")
    if not finite_number(limb_error) or abs(limb_error) >= 1:
        raise ValueError("Check 5 requires a measured horizon limb error below 1 degree")
    if not 0.98 < geometry["nadir"]["earthFraction"] <= 1:
        raise ValueError("Check 5 requires nadir Earth coverage above 98%")


def validate_bridge(evidence):
    verbs = evidence.get("verbs")
    if not isinstance(verbs, list) or len(verbs) != len(BRIDGE_REQUESTS):
        raise ValueError("Check 6 requires exactly four native bridge receipts")
    for receipt, (method, path, json_body) in zip(verbs, BRIDGE_REQUESTS, strict=True):
        body = json_body.encode("utf-8")
        headers = {"accept": "application/json", "x-g1-fixture": "g1"}
        if body:
            headers["content-type"] = "application/json"
        if (
            not isinstance(receipt, dict)
            or receipt.get("method") != method or receipt.get("path") != path
            or receipt.get("headers") != headers
            or type(receipt.get("bytes")) is not int or receipt["bytes"] != len(body)
            or receipt.get("bodyAbsent") is not (not body)
            or (body and receipt.get("receivedBodyHex") != body.hex())
            or (not body and ("receivedBodyHex" in receipt or receipt.get("unexpectedBodyRejected") is not True))
        ):
            raise ValueError(f"Check 6 has an incomplete or mismatched {method} native bridge receipt")


def validate_tile_routes(evidence):
    count = evidence.get("count")
    elapsed = evidence.get("elapsedMs")
    rate = evidence.get("tilesPerSecond")
    paths = evidence.get("observedPaths")
    if (
        type(count) is not int or count != 100
        or not isinstance(paths, list) or len(paths) != count
        or paths != [f"/__g1/tiles/{index}.png" for index in range(count)]
        or not integer_at_least(evidence.get("witnessedPaths"), count) or evidence["witnessedPaths"] != count
        or not integer_at_least(evidence.get("bytesPerTile"), 1)
        or evidence.get("route") != "/__g1/tiles/<index>.png" or evidence.get("cache") != "no-store"
        or not finite_number(elapsed) or not 0 < elapsed <= count * 1000 / 50
        or not finite_number(rate) or rate < 50 or not math.isclose(rate * elapsed, count * 1000)
    ):
        raise ValueError("Check 7 requires 100 per-path native tile observations and at least 50 tiles/s throughput")


def validate_lifecycle(number, evidence):
    before = object_field(evidence, "before")
    after = object_field(evidence, "after")
    if (
        not identity(before.get("documentId")) or not identity(after.get("documentId"))
        or before["documentId"] == after["documentId"]
        or before.get("localOrigin") != FIXTURE_ORIGIN or after.get("localOrigin") != FIXTURE_ORIGIN
    ):
        raise ValueError(f"Check {number} requires two distinct WebView documents at the local origin")
    if number == 8:
        if (
            evidence.get("appQuitObserved") is not True
            or not identity(evidence.get("beforeLaunchId")) or not identity(evidence.get("afterLaunchId"))
            or evidence["beforeLaunchId"] == evidence["afterLaunchId"]
            or not integer_at_least(evidence.get("beforeAppPID"), 1)
            or not integer_at_least(evidence.get("afterAppPID"), 1)
            or evidence["beforeAppPID"] == evidence["afterAppPID"]
            or not identity(before.get("token")) or before["token"] != after.get("token")
        ):
            raise ValueError("Check 8 requires an observed quit, distinct native launches and the same storage token")
    else:
        if (
            before.get("tab") != "tab-iss" or after.get("tab") != "tab-iss"
            or type(evidence.get("terminationCallbacks")) is not int or evidence["terminationCallbacks"] != 1
            or not integer_at_least(evidence.get("reloads"), 1)
        ):
            raise ValueError("Check 9 requires a native termination callback and reload on the ISS tab")
        validate_tile_pixels(object_field(evidence, "tiles"), "iss")


def validate_stress(evidence):
    elapsed = evidence.get("actualDurationMs")
    memory = object_field(evidence, "memory")
    if (
        evidence.get("requestedDurationMs") != FULL_STRESS_MS
        or not finite_number(elapsed) or elapsed < FULL_STRESS_MS
        or not integer_at_least(memory.get("observedDurationMs"), FULL_STRESS_MS)
        or not integer_at_least(memory.get("peakBytes"), 1)
        or type(evidence.get("webProcessTerminations")) is not int or evidence["webProcessTerminations"] != 0
    ):
        raise ValueError("Check 10 is missing full-duration stress or WebContent peak RSS evidence")
    sessions = evidence.get("sessions")
    half_ms = FULL_STRESS_MS / 2
    max_gap_ms = 30_000
    if not isinstance(sessions, list) or len(sessions) != 2:
        raise ValueError("Check 10 is missing both renderer stress sessions")
    for tab, session in zip(("map", "iss"), sessions, strict=True):
        if not isinstance(session, dict):
            raise ValueError("Check 10 has an invalid renderer stress session")
        duration = session.get("elapsedMs")
        moves = session.get("moves")
        times = session.get("verifiedMoveTimesMs")
        if (
            session.get("tab") != tab or not finite_number(duration) or duration < half_ms
            or not integer_at_least(moves, 2) or session.get("tileFrames") != moves
            or not integer_at_least(session.get("minimumTilePixels"), 8)
            or not isinstance(times, list) or len(times) != moves
            or not all(finite_number(time) and 0 <= time <= duration for time in times)
            or times[0] > max_gap_ms
            or any(not 0 < next_time - time <= max_gap_ms for time, next_time in zip(times, times[1:]))
            or not any(half_ms - max_gap_ms <= time <= half_ms for time in times)
        ):
            raise ValueError(f"Check 10 is missing verified full-duration raster frames for {tab}")
    if not math.isclose(elapsed, sum(session["elapsedMs"] for session in sessions)):
        raise ValueError("Check 10 stress duration does not match its renderer timelines")


def validate_passing_evidence(number, evidence):
    if number in (1, 9):
        egress = object_field(evidence, "egress")
        if (
            egress.get("connectSrcBlockedHosts") != BLOCKED_HOSTS
            or egress.get("capacitorHttp") != "G1_BRIDGE_DENIED"
            or egress.get("capacitorHttpNativeClass") != "G1_BRIDGE_DENIED"
        ):
            raise ValueError(f"Check {number} is missing browser or native egress-denial evidence")

    if number == 1:
        if (
            evidence.get("localOrigin") != FIXTURE_ORIGIN or evidence.get("isSecureContext") is not True
            or evidence.get("web") != FIXTURE_DIGEST or evidence.get("native") != FIXTURE_DIGEST
            or evidence.get("bytes") != 4096
        ):
            raise ValueError("Check 1 is missing secure context or matching SHA-256 fixture evidence")
    elif number == 2:
        workers = evidence.get("workers")
        if (
            evidence.get("featureQuery") is not True or evidence.get("dynamicMapTabLoaded") is not True
            or not isinstance(workers, list) or not any(
                isinstance(worker, dict) and worker.get("type") == "module" and not worker.get("error")
                and isinstance(worker.get("url"), str)
                and re.fullmatch(r"(?:capacitor://localhost)?/assets/maplibre-gl-worker-[^/]+\.js", worker["url"])
                for worker in workers
            )
        ):
            raise ValueError("Check 2 is missing the bundled MapLibre worker, feature response or dynamic Map tab")
    elif number == 3:
        version = evidence.get("version")
        if (
            not isinstance(version, str) or not version.startswith("WebGL 2.0")
            or not integer_at_least(evidence.get("width"), 1) or not integer_at_least(evidence.get("height"), 1)
        ):
            raise ValueError("Check 3 is missing a WebGL2 version or drawing-buffer dimensions")
    elif number in SCREENSHOT_TABS:
        validate_tile_pixels(evidence, SCREENSHOT_TABS[number])
        if number == 5:
            validate_geometry(object_field(evidence, "geometry"))
    elif number == 6:
        validate_bridge(evidence)
    elif number == 7:
        validate_tile_routes(evidence)
    elif number in (8, 9):
        validate_lifecycle(number, evidence)
    elif number == 10:
        validate_stress(evidence)


def identify_malformed_id(value):
    if type(value) is float and value in CHECK_IDS:
        return int(value)
    if isinstance(value, str):
        match = re.fullmatch(r"0*(10|[1-9])(?:\.0+)?", value.strip())
        if match:
            return int(match[1])
    return None


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
    invalid_rows = {}
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
                error = f"Unexpected check number: {number!r}"
                errors.append(f"Proof evidence export: {error}")
                affected = identify_malformed_id(number)
                for selected in selected_checks if affected is None else (affected,):
                    invalid_rows[selected] = error
                continue
            rows[number].append(row)
        report = native_report
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        errors.append(f"Proof evidence export: {error}")

    for number, matches in rows.items():
        if number in selected_checks and number in invalid_rows:
            results[number - 1].update(status="fail", evidence={"evidenceError": invalid_rows[number]})
            continue
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
            if status in ("pass", "fail"):
                results[number - 1].update(status="fail", evidence={"evidenceError": error})
            continue
        if status == "pass":
            try:
                validate_passing_evidence(number, evidence)
            except (ValueError, OverflowError) as error:
                status = "fail"
                evidence["evidenceError"] = str(error)
                errors.append(f"Proof evidence export: {error}")
            if status == "pass" and number in SCREENSHOT_TABS:
                tab = SCREENSHOT_TABS[number]
                try:
                    png = exported_attachment(directory, attachments, f"G1-{tab}", ".png")
                    validate_screenshot(png, proof_tab=tab)
                except (OSError, ValueError, TypeError, AttributeError) as error:
                    status = "fail"
                    evidence["screenshotError"] = str(error)
                    errors.append(f"Proof evidence export (G1-{tab}): {error}")
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

import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib


EXPORTER = Path(__file__).with_name("export-host-proof.py")
MAP_MARKER = (0, 255, 0)
ISS_MARKER = (196, 90, 40)
BLOCKED_HOSTS = ["g1-fetch.invalid", "g1-websocket.invalid", "g1-xhr.invalid"]
DEVICE_REQUIRED = {"reason": "Requires on-device proof before W-03 can be called done", "gate": "G1-device"}


def passing_evidence():
    origin = "capacitor://localhost"
    digest = hashlib.sha256(bytes(range(256)) * 16).hexdigest()
    egress = {
        "connectSrcBlockedHosts": BLOCKED_HOSTS,
        "capacitorHttp": "G1_BRIDGE_DENIED",
        "capacitorHttpNativeClass": "G1_BRIDGE_DENIED",
    }
    pixels = {"positive": 24, "negative": 0, "pixelsSampled": 64, "localTileResponses": 1}
    map_pixels = {**pixels, "layer": "carto-dark-layer"}
    iss_pixels = {**pixels, "layer": "iss-lit"}
    projection = "vertical-perspective"
    projected = {"projection": projection, "runtime": {"projection": projection, "shaderVariant": "globe", "transition": 1}}
    pose = {
        **projected, "appliedPose": True, "verticalFovDeg": 81.20259, "pitchDeg": 30, "analyticPitchDeg": 30,
        "maxPitchDeg": 90, "radiusErrorM": 0, "subpointErrorDeg": 0, "earthFraction": 1,
        "applied": {"zoom": 10, "roll": -180}, "expectedZoom": 10,
    }
    geometry = {
        "horizon": {**pose, "preset": "horizon", "limbErrorDeg": -0.999},
        "nadir": {**pose, "preset": "nadir", "limbErrorDeg": None},
        "zoom12": {**projected, "applied": {"zoom": 12}, "tilePixels": 24},
        "checks": [{"name": name, "pass": True} for name in (
            "projection", "field of view", "pitch clamp", "camera radius", "sub-point", "limb", "nadir filled",
            "nested property", "nasa tiles", "horizon and nadir poses applied", "zoom 12 applied",
        )],
    }
    receipts = []
    for method, path, body in (
        ("GET", "/manifest.json", ""),
        ("DELETE", "/api/browser/profiles/g1-fixture/targets/g1-synthetic", ""),
        ("POST", "/api/log", '{"target_id":"g1-synthetic","notes":"Limb—合","action":"shoot"}\n'),
        ("PUT", "/api/browser/profiles/g1-fixture/targets",
         '{"targets":[{"id":"g1-synthetic","name":"Earth – 北","geom":{"type":"point","lat":28,"lon":-97}}]}\n'),
    ):
        headers = {"accept": "application/json", "x-g1-fixture": "g1"}
        content = body.encode("utf-8")
        receipt = {"method": method, "path": path, "headers": headers, "bodyAbsent": not body, "bytes": len(content)}
        if body:
            headers["content-type"] = "application/json"
            receipt["receivedBodyHex"] = content.hex()
        else:
            receipt["unexpectedBodyRejected"] = True
        receipts.append(receipt)
    state = {"tab": "tab-iss", "token": "synthetic-token", "localOrigin": origin}
    before = {**state, "documentId": "first-doc"}
    after = {**state, "documentId": "second-doc"}
    move_times = list(range(29_000, 300_000, 29_000))
    return {
        1: {"localOrigin": origin, "isSecureContext": True, "web": digest, "native": digest, "bytes": 4096, "egress": egress},
        2: {"workers": [{"url": f"{origin}/assets/maplibre-gl-worker-fixture.js", "type": "module"}],
            "featureQuery": True, "dynamicMapTabLoaded": True},
        3: {"version": "WebGL 2.0", "width": 32, "height": 32},
        4: map_pixels,
        5: {**iss_pixels, "geometry": geometry},
        6: {"verbs": receipts},
        7: {"count": 100, "elapsedMs": 2000, "tilesPerSecond": 50, "bytesPerTile": 64, "witnessedPaths": 100,
            "observedPaths": [f"/__g1/tiles/{index}.png" for index in range(100)],
            "route": "/__g1/tiles/<index>.png", "cache": "no-store"},
        8: {"before": before, "after": after, "beforeLaunchId": "first-app", "afterLaunchId": "second-app",
            "beforeAppPID": 10, "afterAppPID": 20, "appQuitObserved": True},
        9: {"before": before, "after": after, "terminationCallbacks": 1, "reloads": 1, "egress": egress, "tiles": iss_pixels},
        10: {"requestedDurationMs": 600_000, "actualDurationMs": 600_000, "webProcessTerminations": 0,
             "memory": {"observedDurationMs": 600_000, "peakBytes": 123_456},
             "sessions": [{"tab": tab, "elapsedMs": 300_000, "moves": len(move_times),
                           "tileFrames": len(move_times), "minimumTilePixels": 8, "verifiedMoveTimesMs": move_times}
                          for tab in ("map", "iss")]},
    }


def fixture_png(marker):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    dark = bytes((16, 24, 33))
    edge = b"\0" + dark * 32
    middle = b"\0" + dark * 8 + bytes(marker) * 16 + dark * 8
    scanlines = edge * 8 + middle * 16 + edge * 8
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 32, 32, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(scanlines))
        + chunk(b"IEND", b"")
    )


class HostProofExportTests(unittest.TestCase):
    def export(self, outcome, screenshots, *, failed_checks=(), checks=None,
               performed_checks=range(1, 11), checks_without_details=(), evidence_overrides=None, extra_rows=()):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            directory = output / "attachments"
            directory.mkdir()
            results = [
                {
                    "id": check_id,
                    "status": "fail" if check_id in failed_checks else "pass",
                    "evidence": {"probe": f"check {check_id}"},
                }
                for check_id in range(1, 11)
            ]
            details = passing_evidence()
            for result in results:
                if result["id"] not in performed_checks:
                    result.update(status="not-run", evidence=DEVICE_REQUIRED.copy())
                elif result["status"] == "pass" and result["id"] not in checks_without_details:
                    result["evidence"].update(details[result["id"]])
            for number, evidence in (evidence_overrides or {}).items():
                results[number - 1]["evidence"] = evidence
            results.extend(extra_rows)
            (directory / "report.json").write_text(json.dumps({"results": results}), encoding="utf-8")
            attachments = [{"suggestedHumanReadableName": "G1-proof-results", "exportedFileName": "report.json"}]
            for name, png in screenshots.items():
                filename = f"{name}.png"
                (directory / filename).write_bytes(png)
                attachments.append({"suggestedHumanReadableName": name, "exportedFileName": filename})
            manifest = [{"testIdentifier": "HostProofTests/testOfflineHostProof()", "attachments": attachments}]
            (directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            process = subprocess.run(
                [sys.executable, "-B", str(EXPORTER), str(output), outcome],
                capture_output=True, text=True, check=False, env={} if checks is None else {"G1_CHECKS": checks},
            )
            report_path = output / "proof-results.json"
            table_path = output / "checks.md"
            report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.exists() else None
            table = table_path.read_text(encoding="utf-8") if table_path.exists() else None
        return process, report, table

    def test_failed_xctest_marks_passing_rows_with_missing_or_invalid_png(self):
        process, report, table = self.export("failure", {"G1-iss": fixture_png(MAP_MARKER)})
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(report["testOutcome"], "failure")
        self.assertEqual(len(report["evidenceExportErrors"]), 2)
        for index, name, expected in (
            (3, "Map renders a bundled tile", "Expected one nonempty G1-map.png attachment"),
            (4, "ISS pixels and vertical-perspective geometry", "missing iss fixture tile marker"),
        ):
            row = report["results"][index]
            self.assertEqual(row["status"], "fail")
            self.assertEqual(row["evidence"]["probe"], f"check {index + 1}")
            self.assertIn(expected, row["evidence"]["screenshotError"])
            self.assertIn(expected, report["evidenceExportErrors"][index - 3])
            self.assertIn(f"| {index + 1} | {name} | fail |", table)
            self.assertIn(expected, table)
        self.assertEqual(
            [row["id"] for row in report["results"] if row["status"] == "pass"],
            [1, 2, 3, 6, 7, 8, 9, 10],
        )

    def test_successful_xctest_with_invalid_png_fails_export(self):
        process, report, table = self.export(
            "success", {"G1-map": b"broken image", "G1-iss": fixture_png(ISS_MARKER)}
        )
        self.assertEqual(process.returncode, 1)
        self.assertEqual(report["results"][3]["status"], "fail")
        self.assertIn("invalid PNG signature", report["results"][3]["evidence"]["screenshotError"])
        self.assertEqual(report["results"][4]["status"], "pass")
        self.assertIn("| 5 | ISS pixels and vertical-perspective geometry | pass |", table)

    def test_successful_xctest_with_both_pngs_preserves_all_checks(self):
        process, report, _ = self.export(
            "success", {"G1-map": fixture_png(MAP_MARKER), "G1-iss": fixture_png(ISS_MARKER)}
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(report["evidenceExportErrors"], [])
        self.assertEqual(report["selectedChecks"], list(range(1, 11)))
        self.assertEqual([row["status"] for row in report["results"]], ["pass"] * 10)

    def test_passing_geometry_flags_cannot_override_measured_limits(self):
        for preset, key, value, expected in (
            ("horizon", "limbErrorDeg", 90, "horizon limb error below 1 degree"),
            ("horizon", "limbErrorDeg", -1, "horizon limb error below 1 degree"),
            ("horizon", "limbErrorDeg", 1, "horizon limb error below 1 degree"),
            ("horizon", "verticalFovDeg", 80, "field of view"),
            ("nadir", "pitchDeg", 30.5, "pitch"),
            ("nadir", "maxPitchDeg", 89, "pitch"),
            ("horizon", "radiusErrorM", -2000, "radius error"),
            ("horizon", "applied", {"zoom": 2, "roll": 180}, "applied zoom or roll"),
            ("nadir", "applied", {"zoom": 10, "roll": 0}, "applied zoom or roll"),
            ("nadir", "subpointErrorDeg", 0.05, "sub-point error"),
            ("nadir", "earthFraction", 0.98, "nadir Earth coverage"),
        ):
            with self.subTest(preset=preset, key=key, value=value):
                evidence = passing_evidence()[5]
                evidence["geometry"][preset][key] = value
                process, report, table = self.export(
                    "success", {"G1-iss": fixture_png(ISS_MARKER)}, checks="5",
                    performed_checks=(5,), evidence_overrides={5: evidence},
                )
                row = report["results"][4]
                self.assertEqual((process.returncode, row["status"]), (1, "fail"), process.stderr)
                self.assertIn(expected, row["evidence"]["evidenceError"])
                self.assertIn("| 5 | ISS pixels and vertical-perspective geometry | fail |", table)
                self.assertIn(expected, table)

    def test_full_mode_still_requires_egress_and_stress_evidence(self):
        process, report, table = self.export(
            "success", {"G1-map": fixture_png(MAP_MARKER), "G1-iss": fixture_png(ISS_MARKER)},
            checks_without_details=(9, 10),
        )
        self.assertEqual(process.returncode, 1)
        self.assertEqual(len(report["evidenceExportErrors"]), 2)
        for number, expected in (
            (9, "Check 9 is missing browser or native egress-denial evidence"),
            (10, "missing full-duration stress or WebContent peak RSS evidence"),
        ):
            row = report["results"][number - 1]
            self.assertEqual(row["status"], "fail")
            self.assertIn(expected, row["evidence"]["evidenceError"])
            self.assertIn(expected, process.stderr)
            self.assertIn(expected, table)
        self.assertIn("| 9 | WebContent termination and same-tab recovery | fail |", table)
        self.assertIn("| 10 | Scripted pan and zoom, peak memory | fail |", table)

    def test_scoped_success_requires_only_selected_checks(self):
        process, report, table = self.export("success", {}, checks="8, 6, 1, 8", performed_checks=(1, 6, 8))
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(report["selectedChecks"], [1, 6, 8])
        self.assertEqual(report["evidenceExportErrors"], [])
        for row in report["results"]:
            if row["id"] in (1, 6, 8):
                self.assertEqual(row["status"], "pass")
            else:
                self.assertEqual(row["status"], "not-run")
                self.assertEqual(row["evidence"], DEVICE_REQUIRED)
        self.assertEqual(table.count("| not-run (on-device required) |"), 7)

    def test_scoped_success_requires_check_1_egress_evidence(self):
        process, report, table = self.export(
            "success", {}, checks="1", performed_checks=(1,), checks_without_details=(1,),
        )
        self.assertEqual(process.returncode, 1)
        expected = "Check 1 is missing browser or native egress-denial evidence"
        self.assertEqual(report["results"][0]["status"], "fail")
        self.assertIn(expected, report["results"][0]["evidence"]["evidenceError"])
        self.assertIn("| 1 | Secure context and matching SHA-256 | fail |", table)
        self.assertIn(expected, process.stderr)

    def test_scoped_check_1_is_validated_when_another_check_failed(self):
        for outcome, returncode in (("success", 1), ("failure", 0)):
            with self.subTest(outcome=outcome):
                process, report, table = self.export(
                    outcome, {}, checks="1,6,8", performed_checks=(1, 6, 8),
                    checks_without_details=(1,), failed_checks=(6,),
                )
                self.assertEqual(process.returncode, returncode, process.stderr)
                check1, check6, check8 = (report["results"][index] for index in (0, 5, 7))
                self.assertEqual([check1["status"], check6["status"], check8["status"]], ["fail", "fail", "pass"])
                expected = "Check 1 is missing browser or native egress-denial evidence"
                self.assertIn(expected, check1["evidence"]["evidenceError"])
                self.assertIn("| 1 | Secure context and matching SHA-256 | fail |", table)
                self.assertIn(expected, table)
                self.assertEqual("missing passing check evidence" in table, outcome == "success")

    def test_incorrect_egress_and_stress_evidence_on_failed_xctest(self):
        evidence = {
            1: {"egress": {
                "connectSrcBlockedHosts": BLOCKED_HOSTS[:-1],
                "capacitorHttp": "G1_BRIDGE_DENIED",
                "capacitorHttpNativeClass": "G1_BRIDGE_DENIED",
            }},
            9: {"egress": {
                "connectSrcBlockedHosts": BLOCKED_HOSTS,
                "capacitorHttp": "G1_BRIDGE_DENIED",
                "capacitorHttpNativeClass": "unexpected",
            }},
            10: {
                "requestedDurationMs": 600_000,
                "actualDurationMs": 600_000,
                "memory": {"observedDurationMs": 599_999, "peakBytes": 123_456},
            },
        }
        process, report, table = self.export(
            "failure", {}, checks="1,9,10", performed_checks=(1, 9, 10), evidence_overrides=evidence,
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        for number in (1, 9, 10):
            row = report["results"][number - 1]
            self.assertEqual(row["status"], "fail")
            self.assertIn(row["evidence"]["evidenceError"], table)

    def test_duplicate_check_discards_first_row_and_reports_contract_error(self):
        process, report, table = self.export(
            "success", {}, checks="1,6,8", performed_checks=(1, 6, 8),
            extra_rows=({"id": 1, "status": "fail", "evidence": {"reason": "duplicate evidence"}},),
        )
        self.assertEqual(process.returncode, 1, process.stderr)
        self.assertEqual(report["results"][0]["status"], "fail")
        self.assertEqual(report["results"][5]["status"], "pass")
        self.assertEqual(report["results"][7]["status"], "pass")
        self.assertNotIn("egress", report["results"][0]["evidence"])
        self.assertNotIn("duplicate evidence", table)
        self.assertIn("Duplicate result for check 1", process.stderr)
        self.assertIn("Duplicate result for check 1", report["evidenceExportErrors"][0])
        self.assertIn("Duplicate result for check 1", table.split("## Proof evidence export errors")[1])

    def test_malformed_duplicate_id_invalidates_its_selected_check(self):
        for check_id in (8.0, "8"):
            with self.subTest(check_id=check_id):
                process, report, table = self.export(
                    "success", {}, checks="6,8", performed_checks=(6, 8),
                    extra_rows=({"id": check_id, "status": "fail", "evidence": {"reason": "duplicate evidence"}},),
                )
                self.assertEqual(process.returncode, 1, process.stderr)
                self.assertEqual(report["results"][5]["status"], "pass")
                self.assertEqual(report["results"][7]["status"], "fail")
                self.assertIn("Unexpected check number", report["results"][7]["evidence"]["evidenceError"])
                self.assertIn("| 8 | localStorage after app relaunch | fail |", table)

    def test_unidentifiable_id_invalidates_all_selected_checks(self):
        process, report, table = self.export(
            "failure", {}, checks="6,8", performed_checks=(6, 8),
            extra_rows=({"id": [], "status": "fail", "evidence": {"reason": "unknown row"}},),
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        for index in (5, 7):
            self.assertEqual(report["results"][index]["status"], "fail")
            self.assertIn("Unexpected check number", report["results"][index]["evidence"]["evidenceError"])
        self.assertEqual(table.count("| fail |"), 2)
        self.assertEqual(table.count("| not-run (on-device required) |"), 8)

    def test_placeholder_cannot_stand_in_for_any_passing_evidence(self):
        process, report, table = self.export(
            "success", {"G1-map": fixture_png(MAP_MARKER), "G1-iss": fixture_png(ISS_MARKER)},
            evidence_overrides={number: {"placeholder": True} for number in range(1, 11)},
        )
        self.assertEqual(process.returncode, 1, process.stderr)
        self.assertEqual([row["status"] for row in report["results"]], ["fail"] * 10)
        self.assertEqual(table.count("| fail |"), 10)
        self.assertEqual(len(report["evidenceExportErrors"]), 10)

    def test_bridge_write_bytes_and_bodyless_rejection_are_verified(self):
        for index, key, value in ((0, "unexpectedBodyRejected", False), (1, "headers", {}),
                                  (2, "receivedBodyHex", "00"), (3, "path", "/api/log")):
            with self.subTest(index=index, key=key):
                evidence = passing_evidence()[6]
                evidence["verbs"][index][key] = value
                process, report, table = self.export(
                    "success", {}, checks="6", performed_checks=(6,), evidence_overrides={6: evidence},
                )
                self.assertEqual(process.returncode, 1, process.stderr)
                self.assertEqual(report["results"][5]["status"], "fail")
                self.assertIn("native bridge receipt", table)

    def test_tile_observations_and_relaunch_identities_are_verified(self):
        proof = passing_evidence()
        proof[7]["observedPaths"][-1] = proof[7]["observedPaths"][0]
        proof[8]["after"]["documentId"] = proof[8]["before"]["documentId"]
        process, report, table = self.export(
            "success", {}, checks="7,8", performed_checks=(7, 8),
            evidence_overrides={7: proof[7], 8: proof[8]},
        )
        self.assertEqual(process.returncode, 1, process.stderr)
        self.assertEqual([report["results"][index]["status"] for index in (6, 7)], ["fail", "fail"])
        self.assertIn("per-path native tile observations", table)
        self.assertIn("distinct WebView documents", table)

    def test_tile_benchmark_requires_exact_count_and_minimum_rate(self):
        for count, elapsed, rate in ((101, 1000, 101), (100, 2500, 40), (100, 2000.000001, 50)):
            with self.subTest(count=count, rate=rate):
                evidence = passing_evidence()[7]
                evidence.update(count=count, elapsedMs=elapsed, tilesPerSecond=rate, witnessedPaths=count,
                                observedPaths=[f"/__g1/tiles/{index}.png" for index in range(count)])
                process, report, table = self.export(
                    "success", {}, checks="7", performed_checks=(7,), evidence_overrides={7: evidence},
                )
                self.assertEqual((process.returncode, report["results"][6]["status"]), (1, "fail"), process.stderr)
                self.assertIn("| 7 | Bundled tiles at 50 tiles per second | fail |", table)

    def test_stress_requires_full_duration_for_each_renderer_and_memory_trace(self):
        short_renderer = passing_evidence()[10]
        short_renderer["sessions"][0]["elapsedMs"] = 299_999
        short_renderer["sessions"][1]["elapsedMs"] = 300_001
        short_trace = passing_evidence()[10]
        short_trace["memory"]["observedDurationMs"] = 599_999
        for evidence, expected in (
            (short_renderer, "missing verified full-duration raster frames for map"),
            (short_trace, "missing full-duration stress or WebContent peak RSS evidence"),
        ):
            with self.subTest(expected=expected):
                process, report, table = self.export(
                    "success", {}, checks="10", performed_checks=(10,), evidence_overrides={10: evidence},
                )
                row = report["results"][9]
                self.assertEqual((process.returncode, row["status"]), (1, "fail"), process.stderr)
                self.assertIn(expected, row["evidence"]["evidenceError"])
                self.assertIn("| 10 | Scripted pan and zoom, peak memory | fail |", table)
                self.assertIn(expected, table)

    def test_stress_duration_and_rss_without_regular_raster_frames_does_not_pass(self):
        stress = passing_evidence()[10]
        stress["sessions"][0]["verifiedMoveTimesMs"][1] = 60_000
        process, report, table = self.export(
            "success", {}, checks="10", performed_checks=(10,), evidence_overrides={10: stress},
        )
        self.assertEqual(process.returncode, 1, process.stderr)
        self.assertEqual(report["results"][9]["status"], "fail")
        self.assertIn("missing verified full-duration raster frames for map", table)

    def test_excluded_evidence_is_canonical(self):
        for evidence in ({"waived": True}, None):
            with self.subTest(evidence=evidence):
                process, report, table = self.export(
                    "success", {}, checks="1", performed_checks=(1,), evidence_overrides={2: evidence},
                )
                self.assertEqual(process.returncode, 0, process.stderr)
                self.assertEqual(report["results"][1], {"id": 2, "status": "not-run", "evidence": DEVICE_REQUIRED})
                self.assertNotIn("waived", table)
                self.assertEqual(table.count("| not-run (on-device required) |"), 9)

    def test_passing_selected_row_with_invalid_evidence_fails(self):
        process, report, table = self.export(
            "success", {}, checks="6,8", performed_checks=(6, 8), evidence_overrides={6: []},
        )
        self.assertEqual(process.returncode, 1, process.stderr)
        row = report["results"][5]
        self.assertEqual(row["status"], "fail")
        self.assertIn("Missing or invalid evidence for check 6", row["evidence"]["evidenceError"])
        self.assertIn("| 6 | GET, DELETE, POST and PUT bridge fidelity | fail |", table)
        self.assertEqual(report["results"][7]["status"], "pass")

    def test_failed_selected_check_8_keeps_failure_with_unusable_evidence(self):
        error = "Missing or invalid evidence for check 8"
        expected_evidence = {"evidenceError": error}
        for evidence in ({}, None, ["invalid"]):
            with self.subTest(evidence=evidence):
                process, report, table = self.export(
                    "failure", {}, checks="8", performed_checks=(8,),
                    failed_checks=(8,), evidence_overrides={8: evidence},
                )
                self.assertEqual(process.returncode, 0, process.stderr)
                self.assertEqual(report["results"][7], {
                    "id": 8, "status": "fail", "evidence": expected_evidence,
                })
                self.assertIn(f"| 8 | localStorage after app relaunch | fail | {json.dumps(expected_evidence)} |", table)
                self.assertIn(error, process.stderr)

    def test_successful_xctest_with_failed_selected_check_fails_export(self):
        process, report, table = self.export(
            "success", {}, checks="1,6,7,8", performed_checks=(1, 6, 7, 8), failed_checks=(7,),
        )
        self.assertEqual(process.returncode, 1)
        self.assertIn("missing passing check evidence", process.stderr)
        self.assertEqual(report["results"][6]["status"], "fail")
        self.assertIn("| 7 | Bundled tiles at 50 tiles per second | fail |", table)

    def test_unselected_check_cannot_be_reported_as_passing(self):
        process, report, table = self.export("success", {}, checks="1", performed_checks=(1, 2))
        self.assertEqual(process.returncode, 1)
        self.assertIn("Unselected check 2 must have status not-run", process.stderr)
        self.assertEqual(report["results"][1]["status"], "not-run")
        self.assertIn("| 2 | MapLibre worker and dynamic Map import | not-run (on-device required) |", table)

    def test_rejects_unknown_or_empty_check_ids(self):
        for checks in ("1,11", "01", "", "1,"):
            with self.subTest(checks=checks):
                process, report, _ = self.export("success", {}, checks=checks)
                self.assertEqual(process.returncode, 1)
                self.assertIn("Unknown G1_CHECKS id", process.stderr)
                self.assertIsNone(report)

    def test_selection_trims_only_space_tab_line_feed_and_carriage_return(self):
        process, report, _ = self.export(
            "success", {}, checks=" \t8\n\r,\r\n6\t ", performed_checks=(6, 8),
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(report["selectedChecks"], [6, 8])
        for whitespace in ("\v", "\f", "\u00a0", "\u200b"):
            with self.subTest(whitespace=whitespace):
                process, report, _ = self.export(
                    "success", {}, checks=f"{whitespace}8", performed_checks=(8,),
                )
                self.assertEqual(process.returncode, 1)
                self.assertIn("Unknown G1_CHECKS id", process.stderr)
                self.assertIsNone(report)

    def test_failed_probes_do_not_require_screenshots(self):
        process, report, _ = self.export("failure", {}, failed_checks=(4, 5))
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(report["evidenceExportErrors"], [])
        self.assertEqual(report["results"][3]["evidence"], {"probe": "check 4"})
        self.assertEqual(report["results"][4]["evidence"], {"probe": "check 5"})


if __name__ == "__main__":
    unittest.main()

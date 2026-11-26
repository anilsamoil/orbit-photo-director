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
    def export(self, outcome, screenshots, *, failed_checks=()):
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
            for index in (0, 8):
                results[index]["evidence"]["egress"] = {
                    "connectSrcBlockedHosts": BLOCKED_HOSTS,
                    "capacitorHttp": "G1_BRIDGE_DENIED",
                    "capacitorHttpNativeClass": "G1_BRIDGE_DENIED",
                }
            results[9]["evidence"].update(
                requestedDurationMs=600_000,
                actualDurationMs=600_000,
                memory={"observedDurationMs": 600_000, "peakBytes": 123_456},
            )
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
                capture_output=True, text=True, check=False,
            )
            report = json.loads((output / "proof-results.json").read_text(encoding="utf-8"))
            table = (output / "checks.md").read_text(encoding="utf-8")
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
        self.assertEqual([row["status"] for row in report["results"]], ["pass"] * 10)

    def test_failed_probes_do_not_require_screenshots(self):
        process, report, _ = self.export("failure", {}, failed_checks=(4, 5))
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(report["evidenceExportErrors"], [])
        self.assertEqual(report["results"][3]["evidence"], {"probe": "check 4"})
        self.assertEqual(report["results"][4]["evidence"], {"probe": "check 5"})


if __name__ == "__main__":
    unittest.main()

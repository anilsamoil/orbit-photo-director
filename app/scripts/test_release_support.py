from base64 import b64encode
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import plistlib
from subprocess import CompletedProcess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import call, patch
from zipfile import ZIP_DEFLATED, ZipFile

SPEC = importlib.util.spec_from_file_location(
    "release_support", Path(__file__).with_name("release-support.py")
)
support = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(support)


class ReleaseSupportTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(TemporaryDirectory()))

    def test_assets_are_transferred_only_after_integrity_checks(self):
        project = self.root / "project"
        fixture = project / "public-proof" / "__g1"
        fixture.mkdir(parents=True)
        (fixture / "build.json").write_text("{}")
        (fixture.parent / "index.html").write_text("<html></html>")
        (project / "public").mkdir()
        for name in support.PROJECT_ASSETS[1:]:
            (project / name).write_text(name)

        artifact = self.root / "artifact"
        support.package_assets(project, artifact)
        destination = self.root / "native"
        destination.mkdir()
        with redirect_stdout(io.StringIO()):
            support.restore_assets(destination, artifact)
        self.assertEqual({file.name for file in destination.iterdir()}, set(support.PROJECT_ASSETS))
        manifest = json.loads((artifact / support.MANIFEST).read_text())
        self.assertIn("public-proof/__g1/build.json", manifest)
        (artifact / "public-proof" / "index.html").write_text("<html>Tampered</html>")
        aborted = self.root / "aborted"
        aborted.mkdir()
        with self.assertRaisesRegex(support.ReleaseError, "SHA-256 manifest mismatch"):
            support.restore_assets(aborted, artifact)
        self.assertEqual(list(aborted.iterdir()), [])

    def test_build_numbers_increase_across_run_boundaries(self):
        self.assertEqual(support.build_number(99, 99), "1.99.99")
        self.assertEqual(support.build_number(100, 1), "2.0.1")
        self.assertEqual(support.build_number(999_899, 99), "9999.99.99")
        for run, attempt in ((1, 100), (999_900, 1), (0, 1)):
            with self.assertRaises(support.ReleaseError):
                support.build_number(run, attempt)

    def test_export_plists_preserve_the_build_and_limit_it_to_internal_testing(self):
        options = self.root / "options"
        with patch.dict("os.environ", TEAM_ID="TEAMID0000", GITHUB_RUN_NUMBER="2", GITHUB_RUN_ATTEMPT="4"):
            support.prepare_export(options)
        self.assertEqual((options / "build-number").read_text(), "1.2.4\n")
        for destination in ("export", "upload"):
            value = plistlib.loads((options / f"{destination}.plist").read_bytes())
            self.assertEqual(value, {
                "method": "app-store-connect",
                "signingStyle": "automatic",
                "teamID": "TEAMID0000",
                "destination": destination,
                "uploadSymbols": True,
                "manageAppVersionAndBuildNumber": False,
                "testFlightInternalTestingOnly": True,
            })

    def test_summary_keeps_only_redacted_diagnostics_markers_and_outcome(self):
        source = self.root / "raw.log"
        output = self.root / "safe.log"
        auth = self.root / "work" / "AuthKey"
        env = {
            "TEAM_ID": "TEAMID0000",
            "APP_STORE_CONNECT_KEY_ID": "FIXTURE_KEY_IDENTIFIER",
            "APP_STORE_CONNECT_ISSUER_ID": "FIXTURE_ISSUER_IDENTIFIER",
            "APP_STORE_CONNECT_PRIVATE_KEY": "FIXTURE_KEY_BYTES\nFIXTURE_NEXT_LINE",
        }
        encoded = b64encode(b"synthetic credential data").decode("ascii")
        uuid = "01234567-89ab-cdef-0123-456789abcdef"
        source.write_text("\n".join([
            f"credential: {encoded}",
            "Build phase detail",
            f'warning: could not read "{auth}" or alternate/AuthKey_fixture',
            f'/Users/fixture-account/project/file.swift: error: No profiles for {support.BUNDLE_ID}',
            'warning: Your team "FIXTURE_TEAM_NAME" has no devices',
            "warning: Your team 'FIXTURE_TEAM_NAME' has no devices",
            'warning: configuration at "/home/fixture-account/path with spaces/settings"',
            'warning: configuration at "~/path with spaces/settings"',
            'warning: configuration at “/Users/fixture-account/path with spaces/settings”',
            'warning: configuration at /Users/fixture-account/path with spaces/settings',
            f"error: fixture@example.invalid {uuid} 01234567-89abcdef01234567",
            *[f"error: rejected {value}" for secret in env.values() for value in secret.splitlines()],
            *[f"error: {identity}: FIXTURE_CERTIFICATE (TEAMID0000) was rejected" for identity in (
                "Apple", "Apple Development", "Apple Distribution", "Apple Distribution Managed",
            )],
            "error: Could not load Apple Distribution: FIXTURE_CERTIFICATE",
            "** ARCHIVE FAILED **",
        ]))
        support.redact_log(source, output, auth, "archive", 65, env)
        filtered = output.read_text()
        for forbidden in (
            str(auth), "AuthKey", "FIXTURE", "TEAMID0000", "@", uuid, "01234567-89abcdef01234567",
            "fixture-account", "path with spaces", encoded, "credential:", "Build phase detail",
        ):
            self.assertNotIn(forbidden, filtered)
        self.assertTrue(filtered.startswith("Xcode archive: failed (exit 65)\n"))
        self.assertIn(f"error: No profiles for {support.BUNDLE_ID}", filtered)
        self.assertEqual(filtered.count("warning: Your team [redacted] has no devices"), 2)
        self.assertEqual(filtered.count("Apple Distribution: [redacted] was rejected"), 4)
        self.assertIn("error: Could not load Apple Distribution: [redacted]", filtered)
        self.assertIn("** ARCHIVE FAILED **", filtered)

    def test_summary_refuses_private_key_marker_even_on_discarded_line(self):
        source = self.root / "raw.log"
        source.write_bytes(support.PRIVATE_MARKER)
        with self.assertRaisesRegex(support.ReleaseError, "marker found"):
            support.redact_log(source, self.root / "refused.log", self.root / "key", "archive", 0, {})
        self.assertFalse((self.root / "refused.log").exists())

    def test_entitlements_request_codesign_xml(self):
        app = self.root / "App.app"
        command = ("codesign", "-d", "--entitlements", "-", "--xml", app)
        entitlements = {"com.apple.developer.team-identifier": "TEAMID0000"}
        with patch.object(support.subprocess, "run", return_value=CompletedProcess(
            command, 0, stdout=plistlib.dumps(entitlements), stderr=b"fixture diagnostic",
        )) as run:
            self.assertEqual(support.read_entitlements(app), entitlements)
        run.assert_called_once_with(command, input=None, capture_output=True, check=False)

    def test_entitlements_fall_back_to_checked_der_conversion(self):
        app = self.root / "App.app"
        xml = ("codesign", "-d", "--entitlements", "-", "--xml", app)
        der = ("codesign", "-d", "--entitlements", "-", "--der", app)
        derq = ("derq", "query", "--xml")
        encoded = b"fixture DER"
        entitlements = {"com.apple.developer.team-identifier": "TEAMID0000"}
        for status, data in ((1, b"unsupported option"), (0, b"[Dict]"), (0, b"")):
            with self.subTest(xml_status=status, xml_shape=data), patch.object(
                support.subprocess, "run", side_effect=[
                    CompletedProcess(xml, status, stdout=data),
                    CompletedProcess(der, 0, stdout=encoded),
                    CompletedProcess(derq, 0, stdout=plistlib.dumps(entitlements)),
                ],
            ) as run:
                self.assertEqual(support.read_entitlements(app), entitlements)
                self.assertEqual(run.call_args_list, [
                    call(xml, input=None, capture_output=True, check=False),
                    call(der, input=None, capture_output=True, check=False),
                    call(derq, input=encoded, capture_output=True, check=False),
                ])

    def test_entitlements_reject_nonzero_der_and_converter_statuses(self):
        for statuses, failing_tool in (((1, 1), "codesign"), ((1, 0, 1), "derq")):
            with self.subTest(tool=failing_tool), patch.object(support.subprocess, "run", side_effect=[
                CompletedProcess((), status, stdout=plistlib.dumps({})) for status in statuses
            ]) as run:
                with self.assertRaisesRegex(support.ReleaseError, f"{failing_tool} failed"):
                    support.read_entitlements(self.root / "App.app")
                self.assertEqual(run.call_count, len(statuses))

    def test_scans_uncompressed_data_inside_an_ipa(self):
        ipa = self.root / "fixture.ipa"
        with ZipFile(ipa, "w", compression=ZIP_DEFLATED) as archive:
            archive.writestr("Payload/App.app/fixture.txt", b"valid artifact")
        support.scan_artifacts([ipa])
        with ZipFile(ipa, "w", compression=ZIP_DEFLATED) as archive:
            archive.writestr("Payload/App.app/fixture.txt", b"x" * (1024 * 1024 - 3) + support.PRIVATE_MARKER)
        with self.assertRaisesRegex(support.ReleaseError, "marker found"):
            support.scan_artifacts([ipa])

    def test_signing_verification_reports_only_public_fields(self):
        team = "TEAMID0000"
        bundle = support.BUNDLE_ID
        app = self.root / "App.app"
        markers = app / "public" / "__g1"
        markers.mkdir(parents=True)
        (markers / "build.json").write_text("{}")
        (app / "Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": bundle,
            "CFBundleVersion": "1.2.4",
            "CFBundleShortVersionString": "1.0",
            "ITSAppUsesNonExemptEncryption": False,
        }))
        for phase, identity, profile_type in (
            ("archive", "Apple Development", "Development"),
            ("export", "Apple Distribution", "App Store"),
        ):
            entitlements = {
                "application-identifier": f"{team}.{bundle}",
                "com.apple.developer.team-identifier": team,
            }
            profile = {
                "TeamIdentifier": [team],
                "ApplicationIdentifierPrefix": [team],
                "Entitlements": entitlements,
            }
            if phase == "archive":
                entitlements["get-task-allow"] = True
                profile["ProvisionedDevices"] = ["FIXTURE_DEVICE_IDENTIFIER"]
            signature = f"Identifier={bundle}\nTeamIdentifier={team}\nAuthority={identity}: fixture identity\n"
            results = [b"", signature.encode(), plistlib.dumps(entitlements), plistlib.dumps(profile)]
            with (
                self.subTest(phase=phase),
                patch.dict("os.environ", TEAM_ID=team),
                patch.object(support, "run_silently", side_effect=results),
                redirect_stdout(io.StringIO()) as log,
            ):
                support.verify_signing(app, "1.2.4", phase)
                self.assertEqual(log.getvalue().splitlines(), [
                    f"Build 1.2.4 · {bundle}",
                    f"Verified {phase} signature · {identity}, {profile_type} profile",
                    f"Team ID: {team}",
                    f"Entitlement keys: {', '.join(sorted(entitlements))}",
                ])


if __name__ == "__main__":
    unittest.main()

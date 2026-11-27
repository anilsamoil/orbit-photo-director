from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import plistlib
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
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

    def test_redaction_only_writes_the_filtered_log(self):
        source = self.root / "raw.log"
        output = self.root / "safe.log"
        auth = self.root / "work" / "AuthKey"
        env = {
            "TEAM_ID": "TEAMID0000",
            "APP_STORE_CONNECT_KEY_ID": "FIXTURE_KEY_IDENTIFIER",
            "APP_STORE_CONNECT_ISSUER_ID": "FIXTURE_ISSUER_IDENTIFIER",
            "APP_STORE_CONNECT_PRIVATE_KEY": "FIXTURE_KEY_BYTES\nFIXTURE_NEXT_LINE",
        }
        source.write_text(
            f"{auth} alternate/AuthKey_fixture\n"
            + "\n".join(env.values())
            + "\nfixture@example.invalid\n"
            + " Signing Identity: Apple Development: fixture identity\n"
            + "** ARCHIVE SUCCEEDED **\n"
        )
        support.redact_log(source, output, auth, env)
        filtered = output.read_text()
        for forbidden in (str(auth), "AuthKey", "FIXTURE", "TEAMID0000", "@", "fixture identity"):
            self.assertNotIn(forbidden, filtered)
        self.assertIn("ARCHIVE SUCCEEDED", filtered)
        source.write_bytes(support.PRIVATE_MARKER)
        with self.assertRaisesRegex(support.ReleaseError, "marker found"):
            support.redact_log(source, self.root / "refused.log", auth, env)
        self.assertFalse((self.root / "refused.log").exists())

    def test_scans_uncompressed_data_inside_an_ipa(self):
        ipa = self.root / "fixture.ipa"
        with ZipFile(ipa, "w", compression=ZIP_DEFLATED) as archive:
            archive.writestr("Payload/App.app/fixture.txt", b"valid artifact")
        support.scan_artifacts([ipa])
        with ZipFile(ipa, "w", compression=ZIP_DEFLATED) as archive:
            archive.writestr("Payload/App.app/fixture.txt", b"x" * (1024 * 1024 - 3) + support.PRIVATE_MARKER)
        with self.assertRaisesRegex(support.ReleaseError, "marker found"):
            support.scan_artifacts([ipa])

    def test_signing_verification_reports_no_identifiers(self):
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
        entitlements = {
            "application-identifier": f"{team}.{bundle}",
            "com.apple.developer.team-identifier": team,
        }
        profile = {
            "TeamIdentifier": [team],
            "ApplicationIdentifierPrefix": [team],
            "Entitlements": entitlements,
        }
        signature = f"Identifier={bundle}\nTeamIdentifier={team}\nAuthority=Apple Distribution: fixture identity\n"
        results = [b"", signature.encode(), plistlib.dumps(entitlements), plistlib.dumps(profile)]
        with (
            patch.dict("os.environ", TEAM_ID=team),
            patch.object(support, "run_silently", side_effect=results),
            redirect_stdout(io.StringIO()) as log,
        ):
            support.verify_signing(app, "1.2.4", "export")
        self.assertIn("Apple Distribution, App Store profile", log.getvalue())
        self.assertNotIn(team, log.getvalue())
        self.assertNotIn("fixture identity", log.getvalue())


if __name__ == "__main__":
    unittest.main()

import importlib.util
import json
from pathlib import Path
import plistlib
from subprocess import CompletedProcess
import sys
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("archive_privacy", Path(__file__).with_name("check-archive-privacy.py"))
privacy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(privacy)


EMPTY_MANIFEST = {
    "NSPrivacyTracking": False,
    "NSPrivacyTrackingDomains": [],
    "NSPrivacyCollectedDataTypes": [],
    "NSPrivacyAccessedAPITypes": [],
}
UUID = "01234567-ABCD-0123-4567-0123456789AB"
DIFFERENT_UUID = "FEDCBA98-000F-0001-0002-000000000003"
LOCKFILE = Path(__file__).resolve().parents[1] / (
    "ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
)


def write_plist(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(plistlib.dumps(data))


class ArchivePrivacyTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.archive = self.root / "proof.xcarchive"
        self.app = self.archive / "Products/Applications/App.app"
        write_plist(self.app / "Info.plist", {"CFBundleIdentifier": "dev.astroanil.snap", "CFBundleVersion": "101"})
        self.source_packages = self.root / "SourcePackages"
        self.lock = self.root / "Package.resolved"
        self.lock.write_bytes(LOCKFILE.read_bytes())
        for sdk, bundle_id in privacy.SDK_BUNDLE_IDS.items():
            container = self.source_packages / "artifacts" / privacy.PACKAGE / sdk / f"{sdk}.xcframework"
            write_plist(container / "Info.plist", {"AvailableLibraries": [{
                "SupportedPlatform": "ios", "SupportedArchitectures": ["arm64"],
                "LibraryIdentifier": "ios-arm64", "LibraryPath": f"{sdk}.framework",
            }]})
            source = container / "ios-arm64" / f"{sdk}.framework"
            framework = self.framework(sdk)
            write_plist(framework / "Info.plist", {"CFBundleIdentifier": bundle_id, "CFBundleExecutable": sdk})
            for location in (source, framework):
                write_plist(location / privacy.MANIFEST, EMPTY_MANIFEST)
                (location / sdk).write_text(UUID, encoding="utf-8")

        self.bad_signature = None
        self.checkout_revision = privacy.REVISION
        self.output = self.root / "privacy-check.log"
        self.patch = patch.object(privacy, "command", self.verify_tool)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def framework(self, sdk):
        return self.app / "Frameworks" / f"{sdk}.framework"

    def verify_tool(self, args):
        binary = Path(args[-1])
        tool = Path(args[0]).name
        if tool == "git":
            return CompletedProcess(args, 0, self.checkout_revision + "\n", "")
        if tool == "codesign":
            self.assertIn("--strict", args)
            self.assertIn("-R=" + privacy.VENDOR_REQUIREMENT, args)
            status = int(binary.name == self.bad_signature)
            return CompletedProcess(args, status, "", "/private/path/verification-detail" if status else "")
        if tool == "xcrun":
            return CompletedProcess(args, 0, f"UUID: {binary.read_text()} (arm64) {binary}\n", "")
        self.fail(f"Unexpected verification tool: {tool}")

    def run_check(self):
        with patch.object(sys, "argv", [
            "check-archive-privacy.py", "--archive", str(self.archive), "--package-resolved", str(self.lock),
            "--source-packages", str(self.source_packages), "--output", str(self.output),
        ]):
            result = privacy.main()
        evidence = self.output.read_text(encoding="utf-8")
        self.assertNotIn(str(self.root), evidence)
        return result, evidence

    def test_pinned_binary_sdks_and_archive_build(self):
        result, evidence = self.run_check()
        self.assertEqual(result, 0, evidence)
        self.assertIn("SNAP archive build 101", evidence)
        self.assertIn(f"capacitor-swift-pm 8.6.2 revision {privacy.REVISION}", evidence)
        for sdk in privacy.SDK_BUNDLE_IDS:
            self.assertIn(f"{sdk} 8.6.2 XCFramework vendor signature verified", evidence)
            self.assertIn(f"Frameworks/{sdk}.framework/{privacy.MANIFEST}", evidence)
        self.assertIn("SDK privacy check passed", evidence)

    def test_sdk_manifest_in_a_top_level_resource_bundle(self):
        target = self.app / "Capacitor_Capacitor.bundle" / "Resources" / privacy.MANIFEST
        target.parent.mkdir(parents=True)
        (self.framework("Capacitor") / privacy.MANIFEST).rename(target)
        result, evidence = self.run_check()
        self.assertEqual(result, 0, evidence)
        self.assertIn("Capacitor_Capacitor.bundle/Resources/PrivacyInfo.xcprivacy", evidence)

    def test_manifest_in_an_unrelated_bundle_does_not_cover_an_sdk(self):
        (self.framework("Cordova") / privacy.MANIFEST).unlink()
        write_plist(self.app / "Other.bundle" / privacy.MANIFEST, EMPTY_MANIFEST)
        result, evidence = self.run_check()
        self.assertEqual(result, 1)
        self.assertIn("Missing archived SDK privacy manifest for Cordova", evidence)

    def test_missing_required_keys_and_broken_plist_fail(self):
        manifest = self.framework("Cordova") / privacy.MANIFEST
        for data in (plistlib.dumps({"NSPrivacyTracking": False}), b"<?xml version='1.0'?><plist><dict>"):
            with self.subTest(data=data):
                manifest.write_bytes(data)
                result, evidence = self.run_check()
                self.assertEqual(result, 1)
                self.assertIn("FAILED:", evidence)
                self.assertIn("archived Cordova SDK", evidence)

    def test_missing_reasons_and_changed_declarations_fail(self):
        for reasons, message in (([], "Invalid required-reason API declaration"), (["CA92.1"], "declarations differ")):
            with self.subTest(reasons=reasons):
                write_plist(self.framework("Cordova") / privacy.MANIFEST, {
                    **EMPTY_MANIFEST, "NSPrivacyAccessedAPITypes": [{
                        "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryUserDefaults",
                        "NSPrivacyAccessedAPITypeReasons": reasons,
                    }],
                })
                result, evidence = self.run_check()
                self.assertEqual(result, 1)
                self.assertIn(message, evidence)

    def test_bad_signature_fails_without_exposing_tool_output(self):
        self.bad_signature = "Cordova.xcframework"
        result, evidence = self.run_check()
        self.assertEqual(result, 1)
        self.assertIn("Cordova 8.6.2 vendor signature failed", evidence)
        self.assertNotIn("/private/path/verification-detail", evidence)
        self.assertNotIn("check passed", evidence)

    def test_wrong_archive_sdk_binary_fails(self):
        (self.framework("Capacitor") / "Capacitor").write_text(DIFFERENT_UUID, encoding="utf-8")
        result, evidence = self.run_check()
        self.assertEqual(result, 1)
        self.assertIn("Archived Capacitor binary does not match the resolved SDK", evidence)

    def test_wrong_checkout_revision_fails(self):
        self.checkout_revision = "0" * 40
        result, evidence = self.run_check()
        self.assertEqual(result, 1)
        self.assertIn("checkout does not match Package.resolved", evidence)

    def test_unknown_package_requires_inventory_review(self):
        lock = json.loads(self.lock.read_bytes())
        lock["pins"].append({"identity": "unknown"})
        self.lock.write_text(json.dumps(lock), encoding="utf-8")
        result, evidence = self.run_check()
        self.assertEqual(result, 1)
        self.assertIn("Package.resolved differs from the reviewed SDK inventory", evidence)

    def test_unreviewed_embedded_framework_requires_inventory_review(self):
        self.framework("Unexpected").mkdir()
        result, evidence = self.run_check()
        self.assertEqual(result, 1)
        self.assertIn("Embedded frameworks differ from the reviewed SDK inventory", evidence)


if __name__ == "__main__":
    unittest.main()

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
        self.output = self.root / "privacy-check.json"
        self.markdown = self.root / "privacy-check.md"
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
            "--markdown-output", str(self.markdown),
        ]):
            result = privacy.main()
        report = self.output.read_text(encoding="utf-8")
        summary = self.markdown.read_text(encoding="utf-8")
        for output in (report, summary):
            self.assertNotIn(str(self.root), output)
        return result, json.loads(report), summary

    def test_pinned_binary_sdks_and_archive_build(self):
        result, evidence, summary = self.run_check()
        self.assertEqual(result, 0, evidence)
        self.assertEqual(evidence, {
            "outcome": "succeeded",
            "archive_build_number": "101",
            "binary_dependencies": "present",
            "sdks": [
                {
                    "name": sdk,
                    "version": "8.6.2",
                    "revision": "b945758eaf3f034cea377e3138a60611cb40a88b",
                    "binary_framework": f"{sdk}.xcframework",
                    "vendor_signature": "verified",
                    "manifests": [{
                        "path": f"Products/Applications/App.app/Frameworks/{sdk}.framework/PrivacyInfo.xcprivacy",
                        "accessed_api_types": [],
                    }],
                } for sdk in ("Capacitor", "Cordova")
            ],
            "host_manifest": None,
        })
        self.assertIn("Archive build 101", summary)
        self.assertIn("SDK privacy check passed", summary)
        self.assertIn("Capacitor 8.6.2 vendor signature verified", summary)

    def test_sdk_manifest_in_a_top_level_resource_bundle(self):
        target = self.app / "Capacitor_Capacitor.bundle" / "Resources" / privacy.MANIFEST
        target.parent.mkdir(parents=True)
        (self.framework("Capacitor") / privacy.MANIFEST).rename(target)
        result, evidence, _ = self.run_check()
        self.assertEqual(result, 0, evidence)
        self.assertEqual(evidence["sdks"][0]["manifests"][0]["path"],
                         "Products/Applications/App.app/Capacitor_Capacitor.bundle/Resources/PrivacyInfo.xcprivacy")

    def test_manifest_path_outside_archive_is_rejected(self):
        manifest = self.framework("Cordova") / privacy.MANIFEST
        outside = self.root / "outside" / privacy.MANIFEST
        outside.parent.mkdir()
        manifest.rename(outside)
        manifest.symlink_to(outside)
        result, evidence, summary = self.run_check()
        self.assertEqual(result, 1)
        self.assertEqual(evidence["sdks"][1]["manifests"], [])
        self.assertNotIn("outside", json.dumps(evidence) + summary)

    def test_unreviewed_path_component_is_not_published(self):
        unreviewed = "fixture-value-outside-reviewed-layout"
        target = self.framework("Cordova") / unreviewed / privacy.MANIFEST
        target.parent.mkdir()
        (self.framework("Cordova") / privacy.MANIFEST).rename(target)
        result, evidence, summary = self.run_check()
        self.assertEqual(result, 1)
        self.assertEqual(evidence["sdks"][1]["manifests"], [])
        self.assertNotIn(unreviewed, json.dumps(evidence) + summary)

    def test_invalid_archive_build_is_not_published(self):
        path = self.app / "Info.plist"
        info = plistlib.loads(path.read_bytes())
        info["CFBundleVersion"] = "1..4"
        write_plist(path, info)
        result, evidence, summary = self.run_check()
        self.assertEqual(result, 1)
        self.assertIsNone(evidence["archive_build_number"])
        self.assertNotIn("1..4", json.dumps(evidence) + summary)

    def test_manifest_in_an_unrelated_bundle_does_not_cover_an_sdk(self):
        (self.framework("Cordova") / privacy.MANIFEST).unlink()
        write_plist(self.app / "Other.bundle" / privacy.MANIFEST, EMPTY_MANIFEST)
        result, evidence, _ = self.run_check()
        self.assertEqual(result, 1)
        self.assertEqual(evidence["failure"], "Missing archived SDK privacy manifest for Cordova")

    def test_missing_required_keys_and_broken_plist_fail(self):
        manifest = self.framework("Cordova") / privacy.MANIFEST
        for data in (plistlib.dumps({"NSPrivacyTracking": False}), b"<?xml version='1.0'?><plist><dict>"):
            with self.subTest(data=data):
                manifest.write_bytes(data)
                result, evidence, _ = self.run_check()
                self.assertEqual(result, 1)
                self.assertEqual(evidence["outcome"], "failed")
                self.assertIn("archived Cordova SDK", evidence["failure"])

    def test_missing_reasons_and_changed_declarations_fail(self):
        for reasons, message in (([], "Invalid required-reason API declaration"), (["CA92.1"], "declarations differ")):
            with self.subTest(reasons=reasons):
                write_plist(self.framework("Cordova") / privacy.MANIFEST, {
                    **EMPTY_MANIFEST, "NSPrivacyAccessedAPITypes": [{
                        "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryUserDefaults",
                        "NSPrivacyAccessedAPITypeReasons": reasons,
                    }],
                })
                result, evidence, _ = self.run_check()
                self.assertEqual(result, 1)
                self.assertIn(message, evidence["failure"])

    def test_documented_api_reasons_pass(self):
        declarations = {
            "FileTimestamp": ["DDA9.1", "C617.1", "3B52.1", "0A2A.1"],
            "SystemBootTime": ["35F9.1", "8FFB.1", "3D61.1"],
            "DiskSpace": ["85F4.1", "E174.1", "7D9E.1", "B728.1"],
            "ActiveKeyboards": ["3EC4.1", "54BD.1"],
            "UserDefaults": ["CA92.1", "1C8F.1", "C56D.1", "AC6B.1"],
        }
        write_plist(self.app / privacy.MANIFEST, {
            **EMPTY_MANIFEST, "NSPrivacyAccessedAPITypes": [
                {
                    "NSPrivacyAccessedAPIType": f"NSPrivacyAccessedAPICategory{category}",
                    "NSPrivacyAccessedAPITypeReasons": reasons,
                }
                for category, reasons in declarations.items()
            ],
        })
        result, evidence, _ = self.run_check()
        self.assertEqual(result, 0, evidence)
        self.assertEqual(evidence["host_manifest"], {
            "path": "Products/Applications/App.app/PrivacyInfo.xcprivacy",
            "accessed_api_types": [
                {"category": f"NSPrivacyAccessedAPICategory{category}", "reasons": sorted(reasons)}
                for category, reasons in sorted(declarations.items())
            ],
        })

    def test_public_manifests_contain_only_validated_category_and_reason_values(self):
        unpublished = "unreviewed-fixture-value"
        manifest = {
            **EMPTY_MANIFEST,
            "NSPrivacyTracking": True,
            "NSPrivacyTrackingDomains": [unpublished],
            "NSPrivacyAccessedAPITypes": [{
                "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryUserDefaults",
                "NSPrivacyAccessedAPITypeReasons": ["CA92.1"],
                "AdditionalField": unpublished,
            }],
        }
        source = self.source_packages / "artifacts" / privacy.PACKAGE / "Cordova"
        write_plist(source / "Cordova.xcframework/ios-arm64/Cordova.framework" / privacy.MANIFEST, manifest)
        write_plist(self.framework("Cordova") / privacy.MANIFEST, manifest)
        result, evidence, summary = self.run_check()
        self.assertEqual(result, 0, evidence)
        self.assertEqual(evidence["sdks"][1]["manifests"][0]["accessed_api_types"], [
            {"category": "NSPrivacyAccessedAPICategoryUserDefaults", "reasons": ["CA92.1"]},
        ])
        self.assertNotIn(unpublished, json.dumps(evidence) + summary)

    def test_unsupported_api_categories_and_reasons_fail(self):
        for category, reasons in (
            ("Invented", ["CA92.1"]),
            ("UserDefaults", ["FFFF.9"]),
            ("UserDefaults", ["CA92.1", "DDA9.1"]),
        ):
            with self.subTest(category=category, reasons=reasons):
                write_plist(self.app / privacy.MANIFEST, {
                    **EMPTY_MANIFEST, "NSPrivacyAccessedAPITypes": [{
                        "NSPrivacyAccessedAPIType": f"NSPrivacyAccessedAPICategory{category}",
                        "NSPrivacyAccessedAPITypeReasons": reasons,
                    }],
                })
                result, evidence, _ = self.run_check()
                self.assertEqual(result, 1, evidence)
                self.assertEqual(evidence["failure"], "Invalid required-reason API declaration for host app")

    def test_bad_signature_fails_without_exposing_tool_output(self):
        self.bad_signature = "Cordova.xcframework"
        result, evidence, summary = self.run_check()
        self.assertEqual(result, 1)
        self.assertEqual(evidence["sdks"][1]["vendor_signature"], "failed")
        self.assertIn("Cordova 8.6.2 vendor signature failed", summary)
        self.assertNotIn("/private/path/verification-detail", json.dumps(evidence) + summary)
        self.assertNotIn("check passed", summary)

    def test_wrong_archive_sdk_binary_fails(self):
        (self.framework("Capacitor") / "Capacitor").write_text(DIFFERENT_UUID, encoding="utf-8")
        result, evidence, _ = self.run_check()
        self.assertEqual(result, 1)
        self.assertIn("Archived Capacitor binary does not match the resolved SDK", evidence["failure"])

    def test_wrong_checkout_revision_fails(self):
        self.checkout_revision = "0" * 40
        result, evidence, _ = self.run_check()
        self.assertEqual(result, 1)
        self.assertIn("checkout does not match Package.resolved", evidence["failure"])

    def test_unknown_package_requires_inventory_review(self):
        lock = json.loads(self.lock.read_bytes())
        lock["pins"].append({"identity": "unknown"})
        self.lock.write_text(json.dumps(lock), encoding="utf-8")
        result, evidence, _ = self.run_check()
        self.assertEqual(result, 1)
        self.assertEqual(evidence["failure"], "Package.resolved differs from the reviewed SDK inventory")

    def test_unreviewed_embedded_framework_requires_inventory_review(self):
        self.framework("Unexpected").mkdir()
        result, evidence, _ = self.run_check()
        self.assertEqual(result, 1)
        self.assertEqual(evidence["failure"], "Embedded frameworks differ from the reviewed SDK inventory")


if __name__ == "__main__":
    unittest.main()

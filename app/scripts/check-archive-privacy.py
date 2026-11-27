#!/usr/bin/env python3
"""Verify the reviewed W-03 SDK inventory in the archive selected for upload."""

import argparse
import json
from pathlib import Path
import plistlib
import re
import subprocess
from xml.parsers.expat import ExpatError

PACKAGE = "capacitor-swift-pm"
VERSION = "8.6.2"
REVISION = "b945758eaf3f034cea377e3138a60611cb40a88b"
SDK_BUNDLE_IDS = {
    "Capacitor": "com.capacitorjs.ios.Capacitor",
    "Cordova": "com.getcapacitor.ios.CapacitorCordova",
}
VENDOR_REQUIREMENT = (
    'anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists '
    'and certificate leaf[field.1.2.840.113635.100.6.1.13] exists '
    'and certificate leaf[subject.OU] = "9YN2HU59K8"'
)
MANIFEST = "PrivacyInfo.xcprivacy"
APPROVED_API_REASONS = {
    "NSPrivacyAccessedAPICategoryFileTimestamp": {"DDA9.1", "C617.1", "3B52.1", "0A2A.1"},
    "NSPrivacyAccessedAPICategorySystemBootTime": {"35F9.1", "8FFB.1", "3D61.1"},
    "NSPrivacyAccessedAPICategoryDiskSpace": {"85F4.1", "E174.1", "7D9E.1", "B728.1"},
    "NSPrivacyAccessedAPICategoryActiveKeyboards": {"3EC4.1", "54BD.1"},
    "NSPrivacyAccessedAPICategoryUserDefaults": {"CA92.1", "1C8F.1", "C56D.1", "AC6B.1"},
}


class PrivacyCheckError(ValueError):
    """An error with a fixed message safe to publish."""


def read_plist(path, description):
    try:
        with path.open("rb") as file:
            value = plistlib.load(file)
    except (OSError, ValueError, plistlib.InvalidFileException, ExpatError) as error:
        raise PrivacyCheckError(f"Missing or invalid plist for {description}") from error
    if not isinstance(value, dict):
        raise PrivacyCheckError(f"Expected a plist dictionary for {description}")
    return value


def validate_manifest(path, description):
    manifest = read_plist(path, description)
    tracking = manifest.get("NSPrivacyTracking")
    domains = manifest.get("NSPrivacyTrackingDomains", [])
    collected = manifest.get("NSPrivacyCollectedDataTypes")
    accessed = manifest.get("NSPrivacyAccessedAPITypes")
    if (
        type(tracking) is not bool
        or not isinstance(domains, list) or not all(isinstance(domain, str) and domain for domain in domains)
        or bool(domains) != tracking
        or not isinstance(collected, list) or not isinstance(accessed, list)
    ):
        raise PrivacyCheckError(f"Missing or invalid privacy manifest keys for {description}")
    for record in collected:
        if (
            not isinstance(record, dict)
            or not isinstance(record.get("NSPrivacyCollectedDataType"), str)
            or type(record.get("NSPrivacyCollectedDataTypeLinked")) is not bool
            or type(record.get("NSPrivacyCollectedDataTypeTracking")) is not bool
            or not isinstance(record.get("NSPrivacyCollectedDataTypePurposes"), list)
            or not record["NSPrivacyCollectedDataTypePurposes"]
            or not all(isinstance(purpose, str) and purpose for purpose in record["NSPrivacyCollectedDataTypePurposes"])
        ):
            raise PrivacyCheckError(f"Invalid collected data declaration for {description}")
    for record in accessed:
        if not isinstance(record, dict):
            raise PrivacyCheckError(f"Invalid required-reason API declaration for {description}")
        category = record.get("NSPrivacyAccessedAPIType")
        reasons = record.get("NSPrivacyAccessedAPITypeReasons")
        if (
            not isinstance(category, str) or category not in APPROVED_API_REASONS
            or not isinstance(reasons, list) or not reasons
            or not all(isinstance(reason, str) and reason in APPROVED_API_REASONS[category] for reason in reasons)
        ):
            raise PrivacyCheckError(f"Invalid required-reason API declaration for {description}")
    return manifest


def archive_manifest_path(path, archive, allowed_parts):
    relative_path = path.relative_to(archive)
    if (
        not set(relative_path.parts) <= allowed_parts | {"Products", "Applications", "App.app", MANIFEST}
        or not path.resolve().is_relative_to(archive.resolve())
    ):
        raise PrivacyCheckError("Privacy manifest path differs from the reviewed archive layout")
    return relative_path.as_posix()


def manifest_evidence(relative_path, manifest):
    return {
        "path": relative_path,
        "accessed_api_types": sorted(
            (
                {
                    "category": record["NSPrivacyAccessedAPIType"],
                    "reasons": sorted(record["NSPrivacyAccessedAPITypeReasons"]),
                }
                for record in manifest["NSPrivacyAccessedAPITypes"]
            ),
            key=lambda record: (record["category"], record["reasons"]),
        ),
    }


def command(arguments):
    return subprocess.run(arguments, capture_output=True, text=True, check=False, timeout=90)


def verify_resolution(lockfile, source_packages):
    try:
        lock = json.loads(lockfile.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PrivacyCheckError("Invalid package lock data") from error
    pins = lock.get("pins") if isinstance(lock, dict) else None
    if not isinstance(pins, list) or len(pins) != 1 or not isinstance(pins[0], dict):
        raise PrivacyCheckError("Package.resolved differs from the reviewed SDK inventory")
    pin = pins[0]
    if (
        pin.get("identity") != PACKAGE or pin.get("kind") != "remoteSourceControl"
        or pin.get("location") != f"https://github.com/ionic-team/{PACKAGE}.git"
        or pin.get("state") != {"revision": REVISION, "version": VERSION}
    ):
        raise PrivacyCheckError("Package.resolved differs from the reviewed SDK inventory")
    checkout = source_packages / "checkouts" / PACKAGE
    result = command(["/usr/bin/git", "-C", str(checkout), "rev-parse", "--verify", "HEAD"])
    if result.returncode or result.stdout.strip() != REVISION:
        raise PrivacyCheckError("Xcode's SDK checkout does not match Package.resolved")
    artifacts = source_packages / "artifacts"
    expected = {Path(PACKAGE, sdk, f"{sdk}.xcframework") for sdk in SDK_BUNDLE_IDS}
    actual = {path.relative_to(artifacts) for path in artifacts.rglob("*.xcframework")}
    if actual != expected:
        raise PrivacyCheckError("Xcode's downloaded binary framework inventory differs from the reviewed SDKs")


def device_slice(xcframework, sdk):
    libraries = read_plist(xcframework / "Info.plist", f"{sdk} XCFramework").get("AvailableLibraries")
    if not isinstance(libraries, list):
        raise PrivacyCheckError(f"Missing slice inventory for {sdk}")
    choices = [
        library for library in libraries
        if isinstance(library, dict) and library.get("SupportedPlatform") == "ios"
        and "SupportedPlatformVariant" not in library and library.get("SupportedArchitectures") == ["arm64"]
    ]
    if len(choices) != 1 or choices[0].get("LibraryPath") != f"{sdk}.framework":
        raise PrivacyCheckError(f"Expected one iOS arm64 device framework for {sdk}")
    identifier = choices[0].get("LibraryIdentifier")
    if not isinstance(identifier, str) or not re.fullmatch(r"ios-[a-z0-9_]+", identifier):
        raise PrivacyCheckError(f"Invalid iOS device library identifier for {sdk}")
    return xcframework / identifier / f"{sdk}.framework"


def mach_uuid(binary, sdk):
    result = command(["/usr/bin/xcrun", "dwarfdump", "--uuid", str(binary)])
    match = re.match(r"UUID: ([0-9A-Fa-f-]{36}) \(arm64\) ", result.stdout)
    if result.returncode or not match:
        raise PrivacyCheckError(f"Missing arm64 binary identity for {sdk}")
    return match[1].lower()


def sdk_manifests(app, framework, accepted_bundle_names):
    paths = set(framework.rglob(MANIFEST))
    for bundle in app.rglob("*.bundle"):
        if bundle.name in accepted_bundle_names:
            paths.update(bundle.rglob(MANIFEST))
    return sorted(paths)


def check_sdk(archive, app, source_packages, evidence):
    sdk = evidence["name"]
    xcframework = source_packages / "artifacts" / PACKAGE / sdk / evidence["binary_framework"]
    signature = command(["/usr/bin/codesign", "--verify", "--strict", "-R=" + VENDOR_REQUIREMENT, str(xcframework)])
    if signature.returncode:
        evidence["vendor_signature"] = "failed"
        raise PrivacyCheckError(f"Could not verify the Apple Developer ID signature for {sdk} XCFramework")
    evidence["vendor_signature"] = "verified"

    device = device_slice(xcframework, sdk)
    framework = app / "Frameworks" / f"{sdk}.framework"
    info = read_plist(framework / "Info.plist", f"archived {sdk} framework")
    if info.get("CFBundleIdentifier") != SDK_BUNDLE_IDS[sdk] or info.get("CFBundleExecutable") != sdk:
        raise PrivacyCheckError(f"Unexpected archive framework identity for {sdk}")
    if mach_uuid(device / sdk, sdk) != mach_uuid(framework / sdk, sdk):
        raise PrivacyCheckError(f"Archived {sdk} binary does not match the resolved SDK device slice")

    reviewed = validate_manifest(device / MANIFEST, f"resolved {sdk} device slice")
    bundle_names = {f"{sdk}.bundle", f"{sdk}_{sdk}.bundle", f"{PACKAGE}_{sdk}.bundle"}
    paths = sdk_manifests(app, framework, bundle_names)
    if not paths:
        raise PrivacyCheckError(f"Missing archived SDK privacy manifest for {sdk}")
    allowed_parts = bundle_names | {"Frameworks", framework.name, "Resources"}
    for path in paths:
        relative_path = archive_manifest_path(path, archive, allowed_parts)
        archived = validate_manifest(path, f"archived {sdk} SDK")
        if archived != reviewed:
            raise PrivacyCheckError(f"Archived {sdk} privacy declarations differ from the resolved SDK")
        evidence["manifests"].append(manifest_evidence(relative_path, archived))


def check_archive(archive, lockfile, source_packages, evidence):
    apps = list((archive / "Products" / "Applications").glob("*.app"))
    if len(apps) != 1 or apps[0].name != "App.app":
        raise PrivacyCheckError("Expected exactly one reviewed app in the selected archive")
    app = apps[0]
    info = read_plist(app / "Info.plist", "archived app")
    build = info.get("CFBundleVersion")
    if (
        info.get("CFBundleIdentifier") != "dev.astroanil.snap"
        or not isinstance(build, str) or not re.fullmatch(r"[0-9]+(?:\.[0-9]+){0,2}", build)
    ):
        raise PrivacyCheckError("Unexpected archived app identifier or build")
    evidence["archive_build_number"] = build
    verify_resolution(lockfile, source_packages)
    evidence["sdks"] = [
        {
            "name": sdk,
            "version": VERSION,
            "revision": REVISION,
            "binary_framework": f"{sdk}.xcframework",
            "vendor_signature": "not checked",
            "manifests": [],
        }
        for sdk in sorted(SDK_BUNDLE_IDS)
    ]
    evidence["binary_dependencies"] = "present" if evidence["sdks"] else "no binary dependencies"
    embedded = {framework.name for framework in (app / "Frameworks").glob("*.framework")}
    if embedded != {f"{sdk}.framework" for sdk in SDK_BUNDLE_IDS}:
        raise PrivacyCheckError("Embedded frameworks differ from the reviewed SDK inventory")
    for sdk in evidence["sdks"]:
        check_sdk(archive, app, source_packages, sdk)

    host_manifest = app / MANIFEST
    if host_manifest.exists():
        relative_path = archive_manifest_path(host_manifest, archive, set())
        manifest = validate_manifest(host_manifest, "host app")
        evidence["host_manifest"] = manifest_evidence(relative_path, manifest)


def markdown_summary(evidence):
    lines = ["# SDK privacy evidence", ""]
    if evidence["outcome"] == "succeeded":
        lines.append("SDK privacy check passed.")
    else:
        lines.append(f"SDK privacy check failed. {evidence['failure']}.")
    if evidence["archive_build_number"] is not None:
        lines.extend(["", f"Archive build {evidence['archive_build_number']}."])
    if evidence["sdks"]:
        lines.append("")
        lines.extend(
            f"- {sdk['name']} {sdk['version']} vendor signature {sdk['vendor_signature']}."
            for sdk in evidence["sdks"]
        )
    elif evidence["binary_dependencies"] == "no binary dependencies":
        lines.extend(["", "No binary dependencies."])
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--package-resolved", type=Path, required=True)
    parser.add_argument("--source-packages", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--markdown-output", type=Path, required=True)
    args = parser.parse_args()
    evidence = {
        "outcome": "failed",
        "archive_build_number": None,
        "binary_dependencies": "unverified",
        "sdks": [],
        "host_manifest": None,
    }
    try:
        check_archive(args.archive, args.package_resolved, args.source_packages, evidence)
    except PrivacyCheckError as error:
        evidence["failure"] = str(error)
    except (OSError, ValueError, subprocess.SubprocessError):
        evidence["failure"] = "Could not read an input or complete a verification command"
    else:
        evidence["outcome"] = "succeeded"
    args.output.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    args.markdown_output.write_text(markdown_summary(evidence), encoding="utf-8")
    return int(evidence["outcome"] == "failed")


if __name__ == "__main__":
    raise SystemExit(main())

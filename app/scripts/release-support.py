#!/usr/bin/env python3
"""Build inputs and redacted evidence for the signed HostProof workflow."""

import argparse
from fnmatch import fnmatchcase
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
from xml.parsers.expat import ExpatError
from zipfile import BadZipFile, ZipFile

PROJECT_ASSETS = ("public-proof", "HostProof-Info.plist", "capacitor.config.json", "config.xml")
MANIFEST = "sha256-manifest.json"
BUNDLE_ID = "dev.astroanil.snap"
PRIVATE_MARKER = b"BEGIN PRIVATE KEY"
SECRET_NAMES = (
    "APP_STORE_CONNECT_KEY_ID",
    "APP_STORE_CONNECT_ISSUER_ID",
    "APP_STORE_CONNECT_PRIVATE_KEY",
)
XCODE_MARKER = re.compile(r"\*\* [A-Z][A-Z0-9 _-]* (?:SUCCEEDED|FAILED) \*\*")
XCODE_DIAGNOSTIC = re.compile(r"^warning:|error:", re.IGNORECASE)
SIGNING_IDENTITY = re.compile(
    r"\bApple(?: (?:Distribution Managed|Distribution|Development))?:[^\n]*?\([A-Z0-9]{10}\)",
    re.IGNORECASE,
)
BARE_SIGNING_IDENTITY = re.compile(
    r"\bApple (?:Distribution Managed|Distribution|Development):(?![ \t]*\[redacted\])[^\n]*",
    re.IGNORECASE,
)
HOME_ROOT = r"(?:/Users/|/home/|~/)"
HOME_PATH = re.compile(
    rf'''"{HOME_ROOT}[^"\n]+"|'{HOME_ROOT}[^'\n]+'|“{HOME_ROOT}[^”\n]+”|‘{HOME_ROOT}[^’\n]+’'''
    rf"|{HOME_ROOT}[^\n]+?(?=:(?:\d+:)*[ \t]*(?:error|warning):|$)",
    re.IGNORECASE | re.MULTILINE,
)
UUID_LIKE = re.compile(
    r"\b(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|[0-9a-f]{8}-[0-9a-f]{16}"
    r"|[0-9a-f]{32}|[0-9a-f]{40})\b", re.IGNORECASE,
)


class ReleaseError(ValueError):
    pass


def asset_inventory(directory):
    if not (directory / "public-proof" / "__g1" / "build.json").is_file():
        raise ReleaseError("Proof assets are missing their build marker")
    if not (directory / "public-proof" / "index.html").is_file():
        raise ReleaseError("Proof assets are missing their entrypoint")
    files = {}
    for path in sorted(directory.rglob("*")):
        relative = path.relative_to(directory)
        if path.is_symlink() or relative.parts[0] not in (*PROJECT_ASSETS, MANIFEST):
            raise ReleaseError("Unexpected item in the proof assets")
        if path.is_file() and relative.as_posix() != MANIFEST:
            with path.open("rb") as file:
                files[relative.as_posix()] = hashlib.file_digest(file, "sha256").hexdigest()
    if not all(name in files for name in PROJECT_ASSETS[1:]):
        raise ReleaseError("Proof assets are missing a required project resource")
    return files


def copy_assets(source, destination):
    for name in PROJECT_ASSETS:
        path = source / name
        if path.is_symlink():
            raise ReleaseError("Proof assets may not be symbolic links")
        if name == "public-proof":
            shutil.copytree(path, destination / name, symlinks=True)
        else:
            shutil.copyfile(path, destination / name)


def package_assets(project, artifact):
    artifact.mkdir()
    copy_assets(project, artifact)
    (artifact / MANIFEST).write_text(
        json.dumps(asset_inventory(artifact), indent=2) + "\n", encoding="utf-8"
    )


def restore_assets(project, artifact):
    actual = asset_inventory(artifact)
    expected = json.loads((artifact / MANIFEST).read_text(encoding="utf-8"))
    if actual != expected:
        raise ReleaseError("Proof asset SHA-256 manifest mismatch")
    copy_assets(artifact, project)
    print(f"Verified {len(actual)} proof resources against their SHA-256 manifest")


def build_number(run, attempt):
    if not 1 <= run <= 999_899 or not 1 <= attempt <= 99:
        raise ReleaseError("Run number or attempt exceeds the CFBundleVersion range")
    return f"{1 + run // 100}.{run % 100}.{attempt}"


def prepare_export(directory):
    team = os.environ.get("TEAM_ID", "")
    if not re.fullmatch(r"[A-Z0-9]{10}", team):
        raise ReleaseError("Invalid Apple developer team ID")
    build = build_number(int(os.environ["GITHUB_RUN_NUMBER"]), int(os.environ["GITHUB_RUN_ATTEMPT"]))
    directory.mkdir()
    (directory / "build-number").write_text(build + "\n", encoding="ascii")
    for destination in ("export", "upload"):
        options = {
            "method": "app-store-connect",
            "signingStyle": "automatic",
            "teamID": team,
            "destination": destination,
            "uploadSymbols": True,
            "manageAppVersionAndBuildNumber": False,
            "testFlightInternalTestingOnly": True,
        }
        (directory / f"{destination}.plist").write_bytes(plistlib.dumps(options))


def run_silently(*args, output="stdout", input_data=None):
    process = subprocess.run(args, input=input_data, capture_output=True, check=False)
    if process.returncode:
        raise ReleaseError(f"{args[0]} failed during signing verification")
    return getattr(process, output)


def read_entitlements(app):
    command = ("codesign", "-d", "--entitlements", "-")
    try:
        xml = run_silently(*command, "--xml", app)
        entitlements = plistlib.loads(xml, fmt=plistlib.FMT_XML)
    except (ReleaseError, ValueError, ExpatError, plistlib.InvalidFileException):
        der = run_silently(*command, "--der", app)
        xml = run_silently("derq", "query", "--xml", input_data=der)
        entitlements = plistlib.loads(xml, fmt=plistlib.FMT_XML)
    if not isinstance(entitlements, dict) or any(
        not re.fullmatch(r"[A-Za-z0-9_.-]+", key) for key in entitlements
    ):
        raise ReleaseError("Invalid signed entitlement keys")
    return entitlements


def verify_signing(app, build, phase):
    team = os.environ["TEAM_ID"]
    if not re.fullmatch(r"[A-Z0-9]{10}", team):
        raise ReleaseError("Invalid Apple developer team ID")
    info = plistlib.loads((app / "Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != BUNDLE_ID or info.get("CFBundleVersion") != build:
        raise ReleaseError("Signed product bundle ID or build number does not match the release")
    if info.get("ITSAppUsesNonExemptEncryption") is not False:
        raise ReleaseError("Signed proof is missing the encryption exemption declaration")
    if not (app / "public" / "__g1" / "build.json").is_file():
        raise ReleaseError("Signed proof is missing its bundled build marker")
    run_silently("codesign", "--verify", "--deep", "--strict", app)
    signature = run_silently("codesign", "-dv", "--verbose=4", app, output="stderr").decode()
    facts = signature.splitlines()
    if f"TeamIdentifier={team}" not in facts or f"Identifier={BUNDLE_ID}" not in facts:
        raise ReleaseError("Signature does not match the requested team and app")
    entitlements = read_entitlements(app)
    profile = plistlib.loads(
        run_silently("security", "cms", "-D", "-i", app / "embedded.mobileprovision")
    )
    profile_entitlements = profile.get("Entitlements", {})
    permitted_app = profile_entitlements.get("application-identifier", "")
    signed_app = entitlements.get("application-identifier", "")
    if (
        team not in profile.get("TeamIdentifier", [])
        or entitlements.get("com.apple.developer.team-identifier") != team
        or profile_entitlements.get("com.apple.developer.team-identifier") != team
        or signed_app not in [f"{prefix}.{BUNDLE_ID}" for prefix in profile.get("ApplicationIdentifierPrefix", [])]
        or not fnmatchcase(signed_app, permitted_app)
        or profile.get("ProvisionsAllDevices")
    ):
        raise ReleaseError("Signed entitlements do not match the app, team and provisioning profile")

    debug = profile_entitlements.get("get-task-allow", False)
    if entitlements.get("get-task-allow", False) is not debug:
        raise ReleaseError("Signed debug entitlement does not match the provisioning profile")
    devices = profile.get("ProvisionedDevices")
    if phase == "archive" and debug is True and devices:
        if not any(line.startswith(("Authority=Apple Development", "Authority=iPhone Developer")) for line in facts):
            raise ReleaseError("Development profile does not match the signing certificate type")
        identity, profile_type = "Apple Development", "Development"
    elif debug is False and devices is None:
        if not any(line.startswith(("Authority=Apple Distribution", "Authority=iPhone Distribution")) for line in facts):
            raise ReleaseError("App Store profile does not match the signing certificate type")
        identity, profile_type = "Apple Distribution", "App Store"
    else:
        raise ReleaseError("Unexpected signing profile type for this release phase")
    version = info.get("CFBundleShortVersionString", "")
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,2}", version):
        raise ReleaseError("Invalid signed product marketing version")
    print(f"Build {build} · {BUNDLE_ID}")
    print(f"Verified {phase} signature · {identity}, {profile_type} profile")
    print(f"Team ID: {team}")
    print(f"Entitlement keys: {', '.join(sorted(entitlements))}")


def redact_log(source, output, auth_path, phase, status, environ):
    data = source.read_bytes()
    if PRIVATE_MARKER in data:
        raise ReleaseError("Private-key marker found in an Xcode log")
    lines = (line.strip() for line in data.decode("utf-8", errors="replace").splitlines())
    log = "\n".join(line for line in lines if XCODE_MARKER.fullmatch(line) or XCODE_DIAGNOSTIC.search(line))
    log = SIGNING_IDENTITY.sub("Apple Distribution: [redacted]", log)
    log = BARE_SIGNING_IDENTITY.sub("Apple Distribution: [redacted]", log)
    log = HOME_PATH.sub("[redacted home path]", log)
    secrets = [
        str(auth_path), str(auth_path.parent), environ.get("TEAM_ID", ""),
        *(environ.get(name, "") for name in SECRET_NAMES),
    ]
    literals = {line.strip() for secret in secrets for line in secret.splitlines() if line.strip()}
    for literal in sorted(literals, key=len, reverse=True):
        log = re.sub(re.escape(literal), "[redacted]", log, flags=re.IGNORECASE)
    log = re.sub(r"(?i)[^\s\"'<>]*AuthKey[^\s\"'<>]*", "[redacted key path]", log)
    log = re.sub(r"(?i)[\w.%+-]+@[\w.-]+\.[a-z]{2,}", "[redacted email]", log)
    log = re.sub(
        r"(?i)(Signing Identity:|Provisioning Profile:|Authority=|iPhone Developer:|iPhone Distribution:)"
        r"(?![ \t]*Apple Distribution: \[redacted\])[^\n]*",
        r"\1 [redacted signing detail]",
        log,
    )
    log = re.sub(r'''(?i)(\bteam[ \t]+)(?:"[^"\n]+"|'[^'\n]+'|“[^”\n]+”|‘[^’\n]+’)''', r"\1[redacted]", log)
    log = UUID_LIKE.sub("[redacted UUID]", log)
    outcome = "succeeded" if status == 0 else f"failed (exit {status})"
    output.write_text(f"Xcode {phase}: {outcome}\n" + (log + "\n" if log else ""), encoding="utf-8")


def scan_stream(file):
    tail = b""
    while chunk := file.read(1024 * 1024):
        combined = tail + chunk
        if PRIVATE_MARKER in combined:
            raise ReleaseError("Private-key marker found in release output")
        tail = combined[-(len(PRIVATE_MARKER) - 1):]


def scan_artifacts(paths):
    for path in paths:
        files = (file for file in path.rglob("*") if file.is_file()) if path.is_dir() else (path,)
        for file in files:
            with file.open("rb") as contents:
                scan_stream(contents)
            if file.suffix in {".ipa", ".zip"}:
                with ZipFile(file) as archive:
                    for member in archive.infolist():
                        if PRIVATE_MARKER.decode("ascii") in member.filename:
                            raise ReleaseError("Private-key marker found in an artifact member name")
                        with archive.open(member) as contents:
                            scan_stream(contents)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("package-assets", "restore-assets"):
        command = commands.add_parser(name)
        command.add_argument("project", type=Path)
        command.add_argument("artifact", type=Path)
    commands.add_parser("prepare-export").add_argument("directory", type=Path)
    signing = commands.add_parser("verify-signing")
    signing.add_argument("app", type=Path)
    signing.add_argument("build")
    signing.add_argument("phase", choices=("archive", "export"))
    redaction = commands.add_parser("redact")
    redaction.add_argument("source", type=Path)
    redaction.add_argument("output", type=Path)
    redaction.add_argument("auth_path", type=Path)
    redaction.add_argument("phase", choices=("archive", "export", "upload"))
    redaction.add_argument("status", type=int)
    commands.add_parser("scan").add_argument("paths", type=Path, nargs="+")
    args = parser.parse_args()

    try:
        if args.command == "package-assets":
            package_assets(args.project, args.artifact)
        elif args.command == "restore-assets":
            restore_assets(args.project, args.artifact)
        elif args.command == "prepare-export":
            prepare_export(args.directory)
        elif args.command == "verify-signing":
            verify_signing(args.app, args.build, args.phase)
        elif args.command == "redact":
            redact_log(args.source, args.output, args.auth_path, args.phase, args.status, os.environ)
        elif args.command == "scan":
            scan_artifacts(args.paths)
    except ReleaseError as error:
        sys.exit(str(error))
    except (KeyError, OSError, ValueError, BadZipFile, ExpatError, plistlib.InvalidFileException):
        sys.exit(f"Could not complete {args.command} with the supplied release inputs")


if __name__ == "__main__":
    main()

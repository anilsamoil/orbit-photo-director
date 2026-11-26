#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import plistlib
import shutil

parser = argparse.ArgumentParser(description="Prepare the bundled Capacitor web assets")
parser.add_argument("--host-proof", action="store_true", help="bundle the W-02 proof build")
args = parser.parse_args()

app = Path(__file__).resolve().parents[1]
config = json.loads((app / "capacitor.config.json").read_text())
if config != {"appId": "dev.astroanil.snap", "appName": "SNAP", "webDir": "www"}:
    raise SystemExit("The local host expects the checked-in Capacitor configuration")
source = app / ("host-proof/dist" if args.host_proof else config["webDir"])
if not (source / "index.html").is_file():
    raise SystemExit(f"Missing index.html in {source}")
marker = source / "__g1/build.json"
if args.host_proof and not marker.is_file():
    raise SystemExit("Run node app/host-proof/build.mjs before preparing HostProof")
if not args.host_proof and (marker.exists() or marker.is_symlink()):
    raise SystemExit(f"Proof marker found in standard web assets at {marker}")

resources = app / "ios/App/App"
public = resources / ("public-proof" if args.host_proof else "public")
if public.exists():
    shutil.rmtree(public)
shutil.copytree(source, public)
if args.host_proof:
    with (resources / "Info.plist").open("rb") as file:
        info = plistlib.load(file)
    info.pop("UIMainStoryboardFile", None)
    scenes = info["UIApplicationSceneManifest"]["UISceneConfigurations"]
    for scene in scenes["UIWindowSceneSessionRoleApplication"]:
        scene.pop("UISceneStoryboardFile", None)
    with (resources / "HostProof-Info.plist").open("wb") as file:
        plistlib.dump(info, file, sort_keys=False)
(resources / "capacitor.config.json").write_text(json.dumps(config, indent=2) + "\n")
(resources / "config.xml").write_text(
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    f'<widget id="{config["appId"]}" version="1.0.0" xmlns="http://www.w3.org/ns/widgets"/>\n'
)
print(f"Prepared {public.name} and Capacitor configuration")

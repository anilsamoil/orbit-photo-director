#!/usr/bin/env python3
import json
from pathlib import Path
import shutil

app = Path(__file__).resolve().parents[1]
config = json.loads((app / "capacitor.config.json").read_text())
if config != {"appId": "dev.astroanil.snap", "appName": "SNAP", "webDir": "www"}:
    raise SystemExit("W-01 expects the bundled placeholder configuration without a remote server or plugins")
resources = app / "ios/App/App"
public = resources / "public"
if public.exists():
    shutil.rmtree(public)
shutil.copytree(app / config["webDir"], public)
(resources / "capacitor.config.json").write_text(json.dumps(config, indent=2) + "\n")
(resources / "config.xml").write_text(
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    f'<widget id="{config["appId"]}" version="1.0.0" xmlns="http://www.w3.org/ns/widgets"/>\n'
)
print("Prepared bundled placeholder and Capacitor configuration")

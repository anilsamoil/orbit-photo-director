import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from generator.launch_publish import rclone_uploader
from scripts import hazard_refresh


@pytest.mark.parametrize("failure", ["exit", "timeout", "startup", "subprocess"])
def test_upload_diagnostics_are_withheld_from_cli_json(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
    failure: str,
):
    marker = "FAKE_SECRET_KEY_372"
    remote = f":s3,access_key_id={marker},secret_access_key={marker}:bucket"
    stderr = (
        f"auth failed https://example.invalid/object?X-Amz-Signature={marker} "
        f"{remote} "
        f"Authorization: Bearer {marker}\n"
    ).encode()

    def run(command, **options):
        if failure == "timeout":
            raise subprocess.TimeoutExpired(command, options["timeout"], stderr=stderr)
        if failure == "startup":
            raise OSError(stderr.decode())
        if failure == "subprocess":
            raise subprocess.SubprocessError(stderr.decode())
        return SimpleNamespace(returncode=7, stderr=stderr)

    monkeypatch.setattr("generator.launch_publish.shutil.which", lambda _: "/mock/rclone")
    monkeypatch.setattr("generator.launch_publish.subprocess.run", run)
    upload = rclone_uploader(remote)

    def refresh(*_args, **_kwargs):
        upload(tmp_path / "artifact.json", hazard_refresh.ARTIFACT, False)

    monkeypatch.setattr(hazard_refresh, "refresh_hazards", refresh)
    assert hazard_refresh.main([
        "--cache-dir", str(tmp_path), "--output", str(tmp_path), "--publish", "--remote", remote,
    ]) == 2
    printed = capsys.readouterr().out
    assert marker not in printed
    assert "https://" not in printed and "access_key_id" not in printed
    reason = json.loads(printed)["reason"]
    code = {"exit": "RCLONE_EXIT_7", "timeout": "RCLONE_TIMEOUT"}.get(failure, "RCLONE_EXECUTION_FAILED")
    assert reason.startswith(code)
    assert len(reason) <= 100

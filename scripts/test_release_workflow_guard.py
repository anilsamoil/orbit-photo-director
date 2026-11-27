import tempfile
from pathlib import Path
import unittest

from check_release_workflow_guard import check, RELEASE

VALID = """\
name: signing fixture
on:
  workflow_dispatch:
jobs:
  sign:
    environment: ios-release
    steps:
      - uses: example/action@0123456789abcdef0123456789abcdef01234567 # v1
      - name: Sign
        env:
          APP_STORE_CONNECT_KEY_ID: ${{ secrets.APP_STORE_CONNECT_KEY_ID }}
        run: |
          set -euo pipefail
          release
"""


class WorkflowGuardTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))

    def validate(self, release=VALID):
        (self.root / RELEASE).write_text(release, encoding="utf-8")
        return check(self.root)

    def test_accepts_dispatch_with_step_credentials(self):
        self.assertEqual(self.validate(), [])

    def test_rejects_signing_names_in_other_workflows(self):
        for text in ("# ios-release", "# APP_STORE_CONNECT_PRIVATE_KEY"):
            with self.subTest(text=text):
                (self.root / "other.yaml").write_text(text, encoding="utf-8")
                self.assertIn("contains a reserved signing name", self.validate()[0])

    def test_rejects_decoded_signing_names_in_other_workflows(self):
        for text in (
            r'env: {"\x41PP_STORE_CONNECT_KEY_ID": fixture}',
            r'env: {FIXTURE: "\x41PP_STORE_CONNECT_KEY_ID"}',
            'jobs:\n  deploy:\n    environment:\n      name: "ios-\\\n        release"\n',
            "jobs:\n  deploy:\n    environment: >-\n      ios-release\n",
        ):
            with self.subTest(text=text):
                (self.root / "other.yaml").write_text(text, encoding="utf-8")
                self.assertIn("other.yaml: contains a reserved signing name", self.validate())

    def test_rejects_invalid_yaml_in_other_workflows(self):
        (self.root / "other.yml").write_text("env: [fixture\n", encoding="utf-8")
        self.assertIn("other.yml: invalid workflow YAML", self.validate())

    def test_rejects_other_events(self):
        for event in ("push", "pull_request", "pull_request_target", "workflow_run"):
            with self.subTest(event=event):
                changed = VALID.replace("  workflow_dispatch:", f"  workflow_dispatch:\n  {event}:")
                self.assertIn("only workflow_dispatch", self.validate(changed)[0])

    def test_rejects_credentials_in_workflow_or_job_env(self):
        workflow_env = "env: { RELEASE_KEY: '${{ secrets.APP_STORE_CONNECT_KEY_ID }}' }\n"
        job_env = "    env: { APP_STORE_CONNECT_KEY_ID: fixture }\n"
        for changed in (workflow_env + VALID, VALID.replace("    steps:", job_env + "    steps:")):
            with self.subTest(changed=changed):
                self.assertIn("must use step-level env", self.validate(changed)[0])

    def test_rejects_wrong_environment(self):
        self.assertIn("protected environment", self.validate(VALID.replace("ios-release", "other"))[0])

    def test_rejects_protected_environment_on_another_job(self):
        changed = VALID + "  prepare:\n    environment: { name: ios-release }\n"
        self.assertIn("only the sign job", self.validate(changed)[0])

    def test_rejects_secret_reference_outside_protected_step_env(self):
        changed = VALID.replace("          release", "          release '${{ secrets.APP_STORE_CONNECT_KEY_ID }}'")
        self.assertIn("only be supplied to protected step env", self.validate(changed)[0])

    def test_rejects_shell_tracing(self):
        for command in ("set -x", "set -euxo pipefail", "set -o xtrace", "bash -x release"):
            with self.subTest(command=command):
                changed = VALID.replace("set -euo pipefail", command)
                self.assertIn("shell tracing is forbidden", self.validate(changed)[0])

    def test_rejects_unpinned_actions(self):
        for revision in ("main", "v1", "0123456"):
            with self.subTest(revision=revision):
                changed = VALID.replace("0123456789abcdef0123456789abcdef01234567", revision)
                self.assertIn("full commit SHA", self.validate(changed)[0])

    def test_rejects_duplicate_keys(self):
        changed = VALID.replace("  workflow_dispatch:", "  push:\non:\n  workflow_dispatch:")
        self.assertIn("invalid workflow YAML", self.validate(changed)[0])


if __name__ == "__main__":
    unittest.main()

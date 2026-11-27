#!/usr/bin/env python3
"""Check that iOS signing credentials stay inside the dispatch-only workflow."""

from pathlib import Path
import re
import sys

import yaml

WORKFLOWS = Path(__file__).resolve().parents[1] / ".github/workflows"
RELEASE = "ios-release.yml"
SECRET = "APP_STORE_CONNECT_"
ENVIRONMENT = "ios-release"
PIN = re.compile(r"(?!\./)[\w.-]+/[\w.-]+(?:/[\w.-]+)*@[0-9a-fA-F]{40}")
TRACE = re.compile(
    r"\b(?:set|bash|sh)[ \t]+(?:(?:[+-][A-Za-z]+|--[A-Za-z-]+)[ \t]+)*"
    r"(?:-[A-Za-z]*x[A-Za-z]*\b|-o[ \t]+xtrace\b)"
)
SECRET_REFERENCE = re.compile(r"\bsecrets(?:\s*\.\s*|\s*\[\s*['\"])APP_STORE_CONNECT_", re.IGNORECASE)


class WorkflowLoader(yaml.BaseLoader):
    def compose_node(self, parent, index):
        if self.check_event(yaml.AliasEvent):
            raise yaml.YAMLError("aliases are unsupported in the signed workflow")
        return super().compose_node(parent, index)

    def construct_mapping(self, node, deep=False):
        mapping = super().construct_mapping(node, deep)
        if len(mapping) != len(node.value):
            raise yaml.YAMLError("duplicate keys in the signed workflow")
        return mapping


def nodes(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from nodes(child)
    elif isinstance(value, list):
        for child in value:
            yield from nodes(child)


def mentions_secret(value, text_matches):
    if isinstance(value, dict):
        return any(
            mentions_secret(key, text_matches) or mentions_secret(child, text_matches)
            for key, child in value.items()
        )
    if isinstance(value, list):
        return any(mentions_secret(child, text_matches) for child in value)
    return isinstance(value, str) and text_matches(value)


def environment_name(job):
    value = job.get("environment")
    return value.get("name") if isinstance(value, dict) else value


def check(directory):
    errors = []
    for path in sorted(directory.iterdir()):
        if path.suffix in (".yaml", ".yml") and path.name != RELEASE:
            text = path.read_text(encoding="utf-8")
            if SECRET in text.upper() or ENVIRONMENT in text.lower():
                errors.append(f"{path.name}: contains a reserved signing name")

    try:
        workflow = yaml.load((directory / RELEASE).read_text(encoding="utf-8"), Loader=WorkflowLoader)
    except (OSError, ValueError, yaml.YAMLError):
        return errors + [f"{RELEASE}: missing or invalid workflow YAML"]
    if not isinstance(workflow, dict):
        return errors + [f"{RELEASE}: expected a workflow mapping"]

    triggers = workflow.get("on")
    if not (
        triggers in ("workflow_dispatch", ["workflow_dispatch"])
        or isinstance(triggers, dict) and set(triggers) == {"workflow_dispatch"}
    ):
        errors.append(f"{RELEASE}: only workflow_dispatch can trigger signing")

    jobs = workflow.get("jobs")
    if not isinstance(jobs, dict) or any(not isinstance(job, dict) for job in jobs.values()):
        return errors + [f"{RELEASE}: missing or invalid jobs"]
    signed = jobs.get("sign", {})
    if environment_name(signed) != ENVIRONMENT:
        errors.append(f"{RELEASE}: sign job must use the protected environment")
    if any(str(environment_name(job)).lower() == ENVIRONMENT for name, job in jobs.items() if name != "sign"):
        errors.append(f"{RELEASE}: only the sign job may use the protected environment")
    if any(mentions_secret(scope.get("env"), lambda text: SECRET in text.upper()) for scope in [workflow, *jobs.values()]):
        errors.append(f"{RELEASE}: credentials must use step-level env")

    signed_steps = signed.get("steps", [])
    if not isinstance(signed_steps, list) or any(not isinstance(step, dict) for step in signed_steps):
        return errors + [f"{RELEASE}: invalid signing steps"]
    permitted_envs = {id(step.get("env")) for step in signed_steps if isinstance(step.get("env"), dict)}
    for mapping in nodes(workflow):
        if id(mapping) not in permitted_envs and any(
            isinstance(value, str) and SECRET_REFERENCE.search(value) for value in mapping.values()
        ):
            errors.append(f"{RELEASE}: secrets may only be supplied to protected step env")

        if "uses" in mapping:
            action = mapping["uses"]
            if not isinstance(action, str) or not PIN.fullmatch(action):
                errors.append(f"{RELEASE}: uses must be pinned to a full commit SHA")
        if any(
            isinstance(mapping.get(key), str) and TRACE.search(mapping[key].replace("\\\n", ""))
            for key in ("run", "shell")
        ):
            errors.append(f"{RELEASE}: shell tracing is forbidden")
    return errors


if __name__ == "__main__":
    errors = check(WORKFLOWS)
    if errors:
        sys.exit("\n".join(errors))
    print("Release workflow boundary checks passed")

#!/usr/bin/env python3
"""Terminate and sample the proof WebContent in a dedicated, booted simulator."""

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import uuid

APP_ID = "dev.astroanil.snap"
SAMPLE_PERIOD = 0.25
WEB_CONTENT = {"com.apple.WebKit.WebContent", "com.apple.WebKit.WebContent.Development"}


def process_table():
    output = subprocess.check_output(
        ["/bin/ps", "-axww", "-o", "pid=,ppid=,rss=,comm="], text=True, timeout=5
    )
    processes = {}
    for line in output.splitlines():
        fields = line.split(maxsplit=3)
        if len(fields) != 4:
            continue
        pid, parent, rss = map(int, fields[:3])
        processes[pid] = (parent, rss * 1024, Path(fields[3]).name)
    return processes


def identify_web_content(processes, app_pid, baseline, manager_pid):
    app = processes.get(app_pid)
    if app is None or app[2] != "App":
        raise ValueError("The requesting SNAP app process is absent")
    launchd = processes.get(app[0])
    if launchd is None or launchd[2] != "launchd_sim":
        raise ValueError("The SNAP app process is not a child of launchd_sim")
    if manager_pid is not None and app[0] != manager_pid:
        raise ValueError("The SNAP app process belongs to a different simulator")
    candidates = [
        pid for pid, (parent, _, executable) in processes.items()
        if parent == app[0] and executable in WEB_CONTENT and pid not in baseline
    ]
    return app[0], candidates


def find_web_content(app_pid, baseline, manager_pid):
    deadline = time.monotonic() + 12
    while True:
        processes = process_table()
        launchd_pid, candidates = identify_web_content(processes, app_pid, baseline, manager_pid)
        if len(candidates) == 1:
            return launchd_pid, candidates[0], processes[candidates[0]][1]
        if time.monotonic() >= deadline:
            raise ValueError(f"Expected one new WebContent child of simulator launchd {launchd_pid}, found {candidates}")
        time.sleep(SAMPLE_PERIOD)


def simulator_manager_pid(simulator, processes):
    try:
        output = subprocess.check_output(
            ["xcrun", "simctl", "spawn", simulator, "launchctl", "managerpid"],
            text=True, stderr=subprocess.DEVNULL, timeout=5
        )
        pid = int(output.strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    manager = processes.get(pid)
    return pid if manager is not None and manager[2] == "launchd_sim" else None


def app_documents(simulator):
    result = subprocess.run(
        ["xcrun", "simctl", "get_app_container", simulator, APP_ID, "data"],
        text=True, capture_output=True, timeout=5, check=False
    )
    if result.returncode == 0 and result.stdout.strip():
        return Path(result.stdout.strip()) / "Documents"
    return None


def write_response(path, payload):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload) + "\n")
    temporary.replace(path)


def handle_operation(command, baseline, sample, manager_pid):
    app_pid = command["appPID"]
    if not isinstance(app_pid, int) or not 1 < app_pid:
        raise ValueError("Invalid SNAP app PID")

    operation = command["operation"]
    if operation == "terminate":
        if sample is not None:
            raise ValueError("Memory monitoring is active during the requested termination")
        parent, pid, _ = find_web_content(app_pid, baseline, manager_pid)
        # Reconfirm the same process against one fresh snapshot before signaling.
        same_parent, candidates = identify_web_content(process_table(), app_pid, baseline, manager_pid)
        if parent != same_parent or candidates != [pid]:
            raise ValueError("The WebContent process changed before termination")
        os.kill(pid, signal.SIGTERM)
        baseline.add(pid)
        return {"pid": pid, "launchdPID": parent, "appPID": app_pid, "signal": "SIGTERM"}, None
    if operation == "memoryStart":
        if sample is not None:
            raise ValueError("Memory monitoring was already active")
        parent, pid, rss = find_web_content(app_pid, baseline, manager_pid)
        sample = {
            "process": "WebContent",
            "method": "macOS ps resident set size (RSS), sampled",
            "samplePeriodMs": int(SAMPLE_PERIOD * 1000),
            "pid": pid,
            "launchdPID": parent,
            "appPID": app_pid,
            "peakBytes": rss,
            "samples": 1,
            "missingSamples": 0,
            "startedNs": time.monotonic_ns(),
        }
        return {"pid": pid}, sample
    if operation == "memoryStop":
        if sample is None or sample["appPID"] != app_pid:
            raise ValueError("Missing memory observation for the requesting app")
        sample["observedDurationMs"] = (time.monotonic_ns() - sample.pop("startedNs")) // 1_000_000
        return sample, None
    raise ValueError(f"Unknown proof observer operation: {operation}")


def observe(simulator):
    started = time.time()
    processes = process_table()
    baseline = set(processes)
    manager_pid = simulator_manager_pid(simulator, processes)
    if manager_pid is None:
        print("Using launchd_sim ancestry of the requesting app in the selected device container", flush=True)
    documents = None
    handled = set()
    sample = None
    print(f"Observing dedicated simulator {simulator}", flush=True)
    while True:
        if documents is None or not documents.parent.is_dir():
            documents = app_documents(simulator)
            if documents is None:
                time.sleep(1)
                continue
        command_path = documents / "g1-observer-command.json"
        try:
            command = json.loads(command_path.read_text()) if command_path.stat().st_mtime >= started else None
        except FileNotFoundError:
            command = None

        if sample is not None:
            process = process_table().get(sample["pid"])
            if process and process[0] == sample["launchdPID"] and process[1] > 0 and process[2] in WEB_CONTENT:
                sample["peakBytes"] = max(sample["peakBytes"], process[1])
                sample["samples"] += 1
            else:
                sample["missingSamples"] += 1

        if command and command["id"] not in handled:
            request_id = command["id"]
            handled.add(request_id)
            try:
                result, sample = handle_operation(command, baseline, sample, manager_pid)
                response = {"id": request_id, "result": result}
                print(f"{command['operation']}: {json.dumps(result)}", flush=True)
            except (ValueError, OSError, subprocess.SubprocessError) as error:
                response = {"id": request_id, "error": str(error)}
                print(f"{command['operation']} failed: {error}", flush=True)
            write_response(documents / "g1-observer-response.json", response)

        time.sleep(SAMPLE_PERIOD)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("simulator_udid", type=uuid.UUID)
    observe(str(parser.parse_args().simulator_udid).upper())


if __name__ == "__main__":
    main()

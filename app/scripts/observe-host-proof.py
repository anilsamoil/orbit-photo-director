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
PROCESS_TIMEOUT = 10
SAMPLE_TIMEOUT = 1
MAX_SAMPLE_GAP_MS = 2000
WEB_CONTENT = {"com.apple.WebKit.WebContent", "com.apple.WebKit.WebContent.Development"}
PROCESS_ERRORS = (OSError, ValueError, subprocess.SubprocessError)


def process_table(timeout=PROCESS_TIMEOUT, pid=None):
    selection = ["-axww"] if pid is None else ["-ww", "-p", str(pid)]
    try:
        output = subprocess.check_output(
            ["/bin/ps", *selection, "-o", "pid=,ppid=,rss=,comm="],
            text=True, stderr=subprocess.PIPE, timeout=timeout,
        )
    except subprocess.CalledProcessError as error:
        if pid is not None and error.returncode == 1 and not error.output.strip() and not error.stderr.strip():
            return {}
        raise
    processes = {}
    for line in output.splitlines():
        fields = line.split(maxsplit=3)
        if len(fields) != 4:
            continue
        pid, parent, rss = map(int, fields[:3])
        processes[pid] = (parent, rss * 1024, Path(fields[3]).name)
    if not processes:
        raise ValueError("The process table is empty")
    return processes


def retry_process_table(stage, *, attempts, timeout):
    for attempt in range(1, attempts + 1):
        try:
            return process_table(timeout)
        except PROCESS_ERRORS as error:
            print(f"{stage} process snapshot {attempt}/{attempts} failed: {error}", flush=True)
            if attempt == attempts:
                raise
            time.sleep(SAMPLE_PERIOD)


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
    problem = "No process snapshot was collected"
    while (remaining := deadline - time.monotonic()) > 0:
        try:
            processes = process_table(min(remaining, 7))
        except PROCESS_ERRORS as error:
            problem = f"WebContent discovery process snapshot failed: {error}"
            print(problem, flush=True)
        else:
            launchd_pid, candidates = identify_web_content(processes, app_pid, baseline, manager_pid)
            if len(candidates) == 1 and processes[candidates[0]][1] > 0:
                return launchd_pid, candidates[0], processes[candidates[0]][1]
            problem = f"Expected one new WebContent child with RSS under simulator launchd {launchd_pid}, found {candidates}"
        time.sleep(min(SAMPLE_PERIOD, max(0, deadline - time.monotonic())))
    raise ValueError(problem)


def simulator_manager_pid(simulator, processes):
    try:
        output = subprocess.check_output(
            ["xcrun", "simctl", "spawn", simulator, "launchctl", "managerpid"],
            text=True, stderr=subprocess.DEVNULL, timeout=5
        )
        pid = int(output.strip())
    except PROCESS_ERRORS as error:
        print(f"Simulator launchd lookup failed: {error}", flush=True)
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
        processes = retry_process_table("WebContent confirmation", attempts=2, timeout=7)
        same_parent, candidates = identify_web_content(processes, app_pid, baseline, manager_pid)
        if parent != same_parent or candidates != [pid]:
            raise ValueError("The WebContent process changed before termination")
        os.kill(pid, signal.SIGTERM)
        baseline.add(pid)
        return {"pid": pid, "launchdPID": parent, "appPID": app_pid, "signal": "SIGTERM"}, None
    if operation == "memoryStart":
        if sample is not None:
            raise ValueError("Memory monitoring was already active")
        parent, pid, rss = find_web_content(app_pid, baseline, manager_pid)
        now = time.monotonic_ns()
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
            "samplingErrors": 0,
            "maxAllowedSampleGapMs": MAX_SAMPLE_GAP_MS,
            "startedNs": now,
            "lastSampleNs": now,
            "maxSampleGapNs": 0,
        }
        return {"pid": pid}, sample
    if operation == "memoryStop":
        if sample is None or sample["appPID"] != app_pid:
            raise ValueError("Missing memory observation for the requesting app")
        now = time.monotonic_ns()
        sample["observedDurationMs"] = (now - sample.pop("startedNs")) // 1_000_000
        gap = max(sample.pop("maxSampleGapNs"), now - sample.pop("lastSampleNs"))
        sample["maxSampleGapMs"] = (gap + 999_999) // 1_000_000
        return sample, None
    raise ValueError(f"Unknown proof observer operation: {operation}")


def sample_memory(sample):
    try:
        processes = process_table(SAMPLE_TIMEOUT, pid=sample["pid"])
    except PROCESS_ERRORS as error:
        sample["samplingErrors"] += 1
        print(f"RSS process snapshot failed: {error}", flush=True)
        return

    process = processes.get(sample["pid"])
    if process and process[0] == sample["launchdPID"] and process[1] > 0 and process[2] in WEB_CONTENT:
        now = time.monotonic_ns()
        sample["maxSampleGapNs"] = max(sample["maxSampleGapNs"], now - sample["lastSampleNs"])
        sample["lastSampleNs"] = now
        sample["peakBytes"] = max(sample["peakBytes"], process[1])
        sample["samples"] += 1
    else:
        sample["missingSamples"] += 1


def observe(simulator, ready_file):
    started = time.time()
    processes = retry_process_table("Startup", attempts=3, timeout=PROCESS_TIMEOUT)
    baseline = set(processes)
    manager_pid = simulator_manager_pid(simulator, processes)
    if manager_pid is None:
        print("Using launchd_sim ancestry of the requesting app in the selected device container", flush=True)
    documents = None
    handled = set()
    sample = None
    print(f"Observing dedicated simulator {simulator}", flush=True)
    if ready_file is not None:
        ready_file.touch()
    while True:
        cycle_started = time.monotonic()
        if documents is None or not documents.parent.is_dir():
            try:
                documents = app_documents(simulator)
            except PROCESS_ERRORS as error:
                documents = None
                print(f"Simulator app container lookup failed: {error}", flush=True)
            if documents is None:
                time.sleep(1)
                continue
        command_path = documents / "g1-observer-command.json"
        try:
            command = json.loads(command_path.read_text()) if command_path.stat().st_mtime >= started else None
        except FileNotFoundError:
            command = None
        except (OSError, ValueError) as error:
            command = None
            print(f"Simulator observer command lookup failed: {error}", flush=True)

        if sample is not None:
            sample_memory(sample)

        if command and command["id"] not in handled:
            request_id = command["id"]
            handled.add(request_id)
            try:
                result, sample = handle_operation(command, baseline, sample, manager_pid)
                response = {"id": request_id, "result": result}
                print(f"{command['operation']}: {json.dumps(result)}", flush=True)
            except PROCESS_ERRORS as error:
                response = {"id": request_id, "error": str(error)}
                print(f"{command['operation']} failed: {error}", flush=True)
            try:
                write_response(documents / "g1-observer-response.json", response)
            except OSError as error:
                print(f"Simulator observer response write failed: {error}", flush=True)

        time.sleep(max(0, SAMPLE_PERIOD - (time.monotonic() - cycle_started)))


def stop(signum, _frame):
    raise SystemExit(128 + signum)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("simulator_udid", type=uuid.UUID)
    parser.add_argument("--ready-file", type=Path)
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, stop)
    observe(str(args.simulator_udid).upper(), args.ready_file)


if __name__ == "__main__":
    main()

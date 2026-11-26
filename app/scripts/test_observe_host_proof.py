import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("observer", Path(__file__).with_name("observe-host-proof.py"))
observer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(observer)

MANAGER_PID = 100
APP_PID = 200
WEB_PID = 300
WEB_PROCESS = "com.apple.WebKit.WebContent"
PROCESSES = {
    MANAGER_PID: (1, 1, "launchd_sim"),
    APP_PID: (MANAGER_PID, 1, "App"),
    WEB_PID: (MANAGER_PID, 1024, WEB_PROCESS),
}


class HostProofObserverTests(unittest.TestCase):
    def test_startup_timeout_is_retried_before_observer_is_ready(self):
        failure = subprocess.TimeoutExpired(["/bin/ps"], observer.PROCESS_TIMEOUT)
        with tempfile.TemporaryDirectory() as directory:
            ready_file = Path(directory) / "observer.ready"
            with (
                patch.object(observer, "process_table", side_effect=[failure, PROCESSES]) as table,
                patch.object(observer, "simulator_manager_pid", return_value=MANAGER_PID),
                patch.object(observer, "app_documents", side_effect=KeyboardInterrupt),
                patch.object(observer.time, "sleep"),
                contextlib.redirect_stdout(io.StringIO()) as log,
                self.assertRaises(KeyboardInterrupt),
            ):
                observer.observe("SIMULATOR", ready_file)
            self.assertTrue(ready_file.is_file())
        self.assertEqual(table.call_count, 2)
        self.assertIn("Startup process snapshot 1/3 failed", log.getvalue())

    def test_discovery_retries_before_confirming_the_process_to_terminate(self):
        failure = subprocess.TimeoutExpired(["/bin/ps"], 7)
        baseline = {MANAGER_PID}
        with (
            patch.object(observer, "process_table", side_effect=[failure, PROCESSES, failure, PROCESSES]),
            patch.object(observer.time, "sleep"),
            patch.object(observer.os, "kill") as kill,
            contextlib.redirect_stdout(io.StringIO()) as log,
        ):
            result, sample = observer.handle_operation(
                {"operation": "terminate", "appPID": APP_PID}, baseline, None, MANAGER_PID,
            )
        kill.assert_called_once_with(WEB_PID, observer.signal.SIGTERM)
        self.assertEqual(result["pid"], WEB_PID)
        self.assertIn(WEB_PID, baseline)
        self.assertIsNone(sample)
        self.assertIn("WebContent discovery process snapshot failed", log.getvalue())
        self.assertIn("WebContent confirmation process snapshot 1/2 failed", log.getvalue())

    def test_pid_lookup_distinguishes_missing_renderer_from_command_failure(self):
        absent = subprocess.CalledProcessError(1, ["/bin/ps"], output="", stderr="")
        broken = subprocess.CalledProcessError(1, ["/bin/ps"], output="", stderr="failed")
        with patch.object(observer.subprocess, "check_output", side_effect=[absent, broken]) as command:
            self.assertEqual(observer.process_table(observer.SAMPLE_TIMEOUT, pid=WEB_PID), {})
            with self.assertRaises(subprocess.CalledProcessError):
                observer.process_table(observer.SAMPLE_TIMEOUT, pid=WEB_PID)
        self.assertEqual(
            command.call_args.args[0], ["/bin/ps", "-ww", "-p", str(WEB_PID), "-o", "pid=,ppid=,rss=,comm="],
        )

    def sample_memory(self, snapshots, times):
        with (
            patch.object(observer, "find_web_content", return_value=(MANAGER_PID, WEB_PID, 1024)),
            patch.object(observer, "process_table", side_effect=snapshots),
            patch.object(observer.time, "monotonic_ns", side_effect=[ms * 1_000_000 for ms in times]),
            contextlib.redirect_stdout(io.StringIO()) as log,
        ):
            _, sample = observer.handle_operation({"operation": "memoryStart", "appPID": APP_PID}, set(), None, MANAGER_PID)
            for _ in snapshots:
                observer.sample_memory(sample)
            result, _ = observer.handle_operation({"operation": "memoryStop", "appPID": APP_PID}, set(), sample, MANAGER_PID)
        return result, log.getvalue()

    def test_one_rss_timeout_keeps_collecting_without_fabricating_a_sample(self):
        timeout = subprocess.TimeoutExpired(["/bin/ps"], observer.SAMPLE_TIMEOUT)
        result, log = self.sample_memory([timeout, PROCESSES], [0, 1250, 1500])
        self.assertEqual(result["samples"], 2)
        self.assertEqual(result["samplingErrors"], 1)
        self.assertEqual(result["missingSamples"], 0)
        self.assertEqual(result["maxSampleGapMs"], 1250)
        self.assertLessEqual(result["maxSampleGapMs"], result["maxAllowedSampleGapMs"])
        self.assertIn("RSS process snapshot failed", log)

    def test_rss_result_reports_recovered_and_final_gaps(self):
        timeout = subprocess.TimeoutExpired(["/bin/ps"], observer.SAMPLE_TIMEOUT)
        for snapshots, times in (([timeout, PROCESSES], [0, 5000, 5100]), ([PROCESSES, timeout], [0, 100, 5100])):
            with self.subTest(times=times):
                result, _ = self.sample_memory(snapshots, times)
                self.assertEqual(result["maxSampleGapMs"], 5000)
                self.assertGreater(result["maxSampleGapMs"], result["maxAllowedSampleGapMs"])

    def test_absent_renderer_is_a_missing_sample(self):
        result, _ = self.sample_memory([{}], [0, 250])
        self.assertEqual(result["samplingErrors"], 0)
        self.assertEqual(result["missingSamples"], 1)


if __name__ == "__main__":
    unittest.main()

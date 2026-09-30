"""Cross-platform launcher for the local backend and frontend."""

import argparse
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WINDOWS = os.name == "nt"


def venv_python(root: Path = ROOT, windows: bool = WINDOWS) -> Path:
    return root / "backend" / ".venv" / ("Scripts/python.exe" if windows else "bin/python")


def environment_issues(root: Path = ROOT, which=shutil.which, windows: bool = WINDOWS) -> list[str]:
    issues = []
    if not venv_python(root, windows).is_file():
        issues.append("Backend environment missing. Create backend/.venv and install backend/requirements.txt.")
    if not (root / "frontend" / "node_modules").is_dir():
        issues.append("Frontend dependencies missing. Run npm ci inside frontend.")
    for command in ("node", "npm", "ffmpeg", "ffprobe"):
        if not which(command):
            issues.append(f"Missing dependency: {command}. Install it and ensure it is on PATH.")
    return issues


def stop_tree(process: subprocess.Popen):
    if process.poll() is not None:
        return
    if WINDOWS:
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Start the Local AI Video Clipper.")
    parser.add_argument("--check", action="store_true", help="check dependencies without starting servers")
    args = parser.parse_args()
    issues = environment_issues()
    if issues:
        print("\n".join(f"- {issue}" for issue in issues), file=sys.stderr)
        return 1
    if args.check:
        print("Ready: Python environment, frontend dependencies, Node, FFmpeg, and ffprobe found.")
        return 0

    npm = shutil.which("npm")
    process_options = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if WINDOWS
                       else {"start_new_session": True})
    backend = subprocess.Popen(
        [str(venv_python()), "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", "8000"],
        cwd=ROOT, **process_options)
    frontend_command = subprocess.list2cmdline([npm, "run", "dev"]) if WINDOWS else [npm, "run", "dev"]
    try:
        frontend = subprocess.Popen(frontend_command, cwd=ROOT / "frontend", shell=WINDOWS, **process_options)
    except Exception:
        stop_tree(backend)
        raise
    processes = (backend, frontend)
    interrupted = False
    print("Backend:  http://localhost:8000\nFrontend: http://localhost:3000\nPress Ctrl+C to stop both.")
    try:
        while all(process.poll() is None for process in processes):
            time.sleep(0.2)
    except KeyboardInterrupt:
        interrupted = True
    finally:
        for process in processes:
            stop_tree(process)
        for process in processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
    return 0 if interrupted else next((process.returncode for process in processes if process.returncode), 0)


if __name__ == "__main__":
    raise SystemExit(main())

import tempfile
import unittest
from pathlib import Path

import start


class LauncherTests(unittest.TestCase):
    def test_platform_paths_and_dependency_check(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "backend/.venv/bin").mkdir(parents=True)
            (root / "backend/.venv/bin/python").touch()
            (root / "frontend/node_modules").mkdir(parents=True)
            self.assertEqual(start.venv_python(root, False), root / "backend/.venv/bin/python")
            self.assertEqual(start.venv_python(root, True), root / "backend/.venv/Scripts/python.exe")
            self.assertEqual(start.environment_issues(root, lambda _: "/tool", False), [])
            issues = start.environment_issues(root, lambda _: None, True)
            self.assertTrue(any("Backend environment" in issue for issue in issues))
            self.assertTrue(any("ffmpeg" in issue for issue in issues))


if __name__ == "__main__":
    unittest.main()

import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("signature_overrides", ROOT / "signature-overrides.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def database_path(home):
    return home / "Library/Application Support/Cursor/User/globalStorage/state.vscdb"


def create_database(home, ids=None, targets=None, blob=False):
    database = database_path(home)
    database.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)")
        values = {"unrelated-setting": "unchanged"}
        if ids is not None:
            values[helper.OVERRIDE_KEY] = json.dumps(ids)
        if targets is not None:
            values[helper.TARGET_MARKER] = json.dumps(targets)
        for key, value in values.items():
            connection.execute("INSERT INTO ItemTable VALUES (?, ?)", (key, value.encode() if blob else value))
    return database


def read_rows(database):
    connection = sqlite3.connect(database)
    try:
        return dict(connection.execute("SELECT key, value FROM ItemTable"))
    finally:
        connection.close()


def executable(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    path.chmod(0o755)


class OverrideTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix=".signature-tests-", dir=ROOT)
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.app = self.home / "Cursor.app"
        self.workbench = self.app / "Contents/Resources/app/out/vs/workbench"
        self.workbench.mkdir(parents=True)
        (self.workbench / "workbench.glass.main.js").write_text(helper.OVERRIDE_KEY)
        self.database = create_database(self.home)
        self.stop = mock.patch.object(helper, "ensure_cursor_stopped")
        self.stopped = self.stop.start()
        self.addCleanup(self.stop.stop)

    def apply(self, action="install"):
        return helper.update_override(action, self.app, self.home)

    def backups(self):
        return sorted((self.database.parent / "cursor-opus-hack-backups").glob("*.json"))

    def test_install_adds_only_project_id_with_machine_target_and_scoped_backup(self):
        before = read_rows(self.database)
        self.apply()
        rows = read_rows(self.database)
        self.assertEqual(json.loads(rows[helper.OVERRIDE_KEY]), [helper.EXTENSION_ID])
        self.assertEqual(json.loads(rows[helper.TARGET_MARKER]), {helper.OVERRIDE_KEY: 1})
        self.assertEqual(rows["unrelated-setting"], before["unrelated-setting"])
        backup = json.loads(self.backups()[0].read_text())
        self.assertFalse(backup["valueExisted"])
        self.assertFalse(backup["targetEntryExisted"])
        self.assertNotIn("unrelated-setting", self.backups()[0].read_text())
        self.assertEqual(self.backups()[0].stat().st_mode & 0o777, 0o600)

    def test_ready_install_is_read_only_even_when_cursor_is_running(self):
        self.apply()
        before = read_rows(self.database)
        self.stopped.side_effect = RuntimeError("running")
        self.apply()
        self.apply("check")
        self.assertEqual(read_rows(self.database), before)
        self.assertEqual(len(self.backups()), 1)

    def test_install_preserves_other_ids_targets_and_blob_representation(self):
        self.database.unlink()
        self.database = create_database(self.home, ["other.extension"], {"other-setting": 0}, blob=True)
        self.apply()
        rows = read_rows(self.database)
        self.assertIsInstance(rows[helper.OVERRIDE_KEY], bytes)
        self.assertIsInstance(rows[helper.TARGET_MARKER], bytes)
        self.assertEqual(json.loads(rows[helper.OVERRIDE_KEY]), ["other.extension", helper.EXTENSION_ID])
        self.assertEqual(json.loads(rows[helper.TARGET_MARKER]), {"other-setting": 0, helper.OVERRIDE_KEY: 1})
        self.assertEqual(rows["unrelated-setting"], b"unchanged")

    def test_missing_or_wrong_machine_target_is_repaired_without_duplicate_id(self):
        self.database.unlink()
        self.database = create_database(self.home, [helper.EXTENSION_ID], {helper.OVERRIDE_KEY: 0})
        self.apply()
        rows = read_rows(self.database)
        self.assertEqual(json.loads(rows[helper.OVERRIDE_KEY]), [helper.EXTENSION_ID])
        self.assertEqual(json.loads(rows[helper.TARGET_MARKER])[helper.OVERRIDE_KEY], 1)

    def test_running_cursor_rejects_change_before_backup_or_database_write(self):
        before = read_rows(self.database)
        self.stopped.side_effect = RuntimeError("running")
        with self.assertRaisesRegex(RuntimeError, "running"):
            self.apply()
        self.assertEqual(read_rows(self.database), before)
        self.assertEqual(self.backups(), [])

    def test_cursor_restart_during_transaction_rejects_change(self):
        before = read_rows(self.database)
        self.stopped.side_effect = [None, RuntimeError("restarted")]
        with self.assertRaisesRegex(RuntimeError, "restarted"):
            self.apply()
        self.assertEqual(read_rows(self.database), before)
        self.assertEqual(self.backups(), [])

    def test_dry_run_validates_change_without_writes_or_backup(self):
        before = read_rows(self.database)
        helper.update_override("install", self.app, self.home, dry_run=True)
        self.assertEqual(read_rows(self.database), before)
        self.assertEqual(self.backups(), [])
        self.apply()
        installed = read_rows(self.database)
        helper.update_override("uninstall", self.app, self.home, dry_run=True)
        self.assertEqual(read_rows(self.database), installed)
        self.assertEqual(len(self.backups()), 1)
        self.stopped.side_effect = RuntimeError("running")
        with self.assertRaisesRegex(RuntimeError, "running"):
            helper.update_override("uninstall", self.app, self.home, dry_run=True)
        self.assertEqual(read_rows(self.database), installed)

    def test_backup_failure_rolls_back(self):
        before = read_rows(self.database)
        with mock.patch.object(helper, "backup_state", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.apply()
        self.assertEqual(read_rows(self.database), before)

    def test_uninstall_removes_only_project_id_and_preserves_other_scope(self):
        self.database.unlink()
        self.database = create_database(
            self.home, ["other.extension", helper.EXTENSION_ID, helper.EXTENSION_ID],
            {"other-setting": 0, helper.OVERRIDE_KEY: 1},
        )
        self.apply("uninstall")
        rows = read_rows(self.database)
        self.assertEqual(json.loads(rows[helper.OVERRIDE_KEY]), ["other.extension"])
        self.assertEqual(json.loads(rows[helper.TARGET_MARKER]), {"other-setting": 0, helper.OVERRIDE_KEY: 1})
        self.assertEqual(rows["unrelated-setting"], "unchanged")

    def test_uninstall_last_id_removes_only_its_key_and_target(self):
        self.apply()
        self.apply("uninstall")
        rows = read_rows(self.database)
        self.assertNotIn(helper.OVERRIDE_KEY, rows)
        self.assertEqual(json.loads(rows[helper.TARGET_MARKER]), {})
        self.assertEqual(rows["unrelated-setting"], "unchanged")
        self.stopped.side_effect = RuntimeError("running")
        self.apply("uninstall")
        self.assertEqual(len(self.backups()), 2)

    def test_uninstall_revokes_exception_after_downgrade(self):
        self.apply()
        (self.workbench / "workbench.glass.main.js").write_text("// legacy build")
        self.apply("uninstall")
        self.assertNotIn(helper.OVERRIDE_KEY, read_rows(self.database))

    def test_legacy_build_skips_override_and_does_not_require_created_database(self):
        (self.workbench / "workbench.glass.main.js").write_text("// legacy build")
        self.database.unlink()
        self.apply()
        self.apply("check")
        self.assertFalse(self.database.exists())
        self.assertEqual(self.backups(), [])

    def test_unknown_workbench_refuses_install(self):
        (self.workbench / "workbench.glass.main.js").unlink()
        with self.assertRaisesRegex(RuntimeError, "工作台"):
            self.apply()

    def test_desktop_workbench_candidate_is_supported(self):
        (self.workbench / "workbench.glass.main.js").unlink()
        (self.workbench / "workbench.desktop.main.js").write_text(helper.OVERRIDE_KEY)
        self.apply()
        self.assertIn(helper.OVERRIDE_KEY, read_rows(self.database))

    def test_missing_database_is_not_created(self):
        self.database.unlink()
        with self.assertRaisesRegex(RuntimeError, "尚未创建"):
            self.apply()
        self.apply("uninstall")
        self.assertFalse(self.database.exists())

    def test_check_reports_missing_exception_without_writes(self):
        before = read_rows(self.database)
        with self.assertRaisesRegex(RuntimeError, "缺失"):
            self.apply("check")
        self.assertEqual(read_rows(self.database), before)
        self.assertEqual(self.backups(), [])

    def test_malformed_values_are_preserved_instead_of_reset(self):
        for key, value in ((helper.OVERRIDE_KEY, "invalid json"), (helper.OVERRIDE_KEY, "{}"),
                           (helper.OVERRIDE_KEY, "[123]"), (helper.TARGET_MARKER, "[]")):
            with self.subTest(key=key, value=value):
                self.database.unlink()
                self.database = create_database(self.home)
                with sqlite3.connect(self.database) as connection:
                    connection.execute("INSERT INTO ItemTable VALUES (?, ?)", (key, value))
                before = read_rows(self.database)
                with self.assertRaises((RuntimeError, ValueError)):
                    self.apply()
                self.assertEqual(read_rows(self.database), before)
                self.assertEqual(self.backups(), [])

    def test_process_guard_ignores_node_mode_parent_but_rejects_gui_or_helpers(self):
        parent = os.getppid()
        with mock.patch.object(helper.subprocess, "check_output", return_value="{} {}/Contents/MacOS/Cursor\n".format(parent, self.app)):
            # Call the real function, not the no-op installed in setUp.
            self.stop.stop()
            helper.ensure_cursor_stopped(self.app)
            for process in ("/Applications/Cursor.app/Contents/MacOS/Cursor", "/elsewhere/Cursor Helper (Renderer)"):
                with mock.patch.object(helper.subprocess, "check_output", return_value="42424 " + process):
                    with self.assertRaisesRegex(RuntimeError, "完整退出"):
                        helper.ensure_cursor_stopped(self.app)


class ScriptIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.node = shutil.which("node")
        cls.real_app = Path(os.environ.get("CURSOR_APP", "/Applications/Cursor.app"))
        app_root = cls.real_app / "Contents/Resources/app"
        script = "process.stdout.write(require('./schema.js').generateResponseModule(process.argv[1]))"
        cls.schema = subprocess.check_output([cls.node, "-e", script, str(app_root)], cwd=ROOT, text=True)
        cls.version = json.loads((app_root / "package.json").read_text())["version"]
        cls.runtime = app_root / "node_modules/@bufbuild/protobuf"

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix=".signature-tests-", dir=ROOT)
        self.addCleanup(self.temporary.cleanup)
        self.sandbox = Path(self.temporary.name)
        self.home = self.sandbox / "home"
        self.app = self.sandbox / "Cursor.app"
        app_root = self.app / "Contents/Resources/app"
        workbench = app_root / "out/vs/workbench"
        workbench.mkdir(parents=True)
        (workbench / "workbench.glass.main.js").write_text(self.schema + "\n// " + helper.OVERRIDE_KEY)
        runtime = app_root / "node_modules/@bufbuild/protobuf"
        runtime.parent.mkdir(parents=True)
        runtime.symlink_to(self.runtime, target_is_directory=True)
        (app_root / "package.json").write_text(json.dumps({"version": self.version}))
        source = app_root / "extensions/cursor-always-local"
        (source / "dist").mkdir(parents=True)
        (source / "dist/main.js").write_text("module.exports = {};\n")
        (source / "package.json").write_text(json.dumps({"name": "cursor-always-local", "publisher": "anysphere", "version": "0.0.1", "main": "./dist/main.js"}))
        with (self.app / "Contents/Info.plist").open("wb") as output:
            plistlib.dump({"CFBundleShortVersionString": self.version}, output)
        executable(self.app / "Contents/MacOS/Cursor", '#!/bin/bash\nexec "' + self.node + '" "$@"\n')
        bin_dir = self.sandbox / "bin"
        executable(bin_dir / "ps", '#!/bin/sh\nprintf "%s\\n" "$FAKE_CURSOR_PROCESSES"\n')
        executable(bin_dir / "launchctl", '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LAUNCHCTL_LOG"\n')
        executable(bin_dir / "osascript", "#!/bin/sh\nexit 0\n")
        self.env = dict(os.environ, HOME=str(self.home), CURSOR_APP=str(self.app), CURSOR_OPUS_HACK_WATCHER="1",
                        PATH=str(bin_dir) + os.pathsep + os.environ["PATH"], FAKE_CURSOR_PROCESSES="",
                        LAUNCHCTL_LOG=str(self.sandbox / "launchctl.log"), PYTHONDONTWRITEBYTECODE="1")
        self.database = create_database(self.home, ["other.extension"], {"other-setting": 0, helper.OVERRIDE_KEY: 1})
        self.target = self.home / ".cursor/extensions/anysphere.cursor-always-local-0.0.2"
        self.registry = self.home / ".cursor/extensions/extensions.json"
        self.plist = self.home / "Library/LaunchAgents/com.yzs-lab.cursor-opus-hack.plist"
        self.plist.parent.mkdir(parents=True)
        self.plist.write_text("existing watcher")

    def run_script(self, name, running=False, success=True):
        env = dict(self.env)
        if running:
            env["FAKE_CURSOR_PROCESSES"] = "42424 /Applications/Cursor.app/Contents/MacOS/Cursor"
        result = subprocess.run(["/bin/bash", str(ROOT / name)], cwd=ROOT, env=env, text=True, capture_output=True, timeout=30)
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def test_install_reinstall_and_uninstall_real_scripts_in_temporary_home(self):
        self.run_script("install.sh")
        self.assertTrue((self.target / "node_modules/hook/dist/main.js").is_file())
        self.assertEqual(json.loads(read_rows(self.database)[helper.OVERRIDE_KEY]), ["other.extension", helper.EXTENSION_ID])
        original = self.registry.read_text()
        self.run_script("install.sh", running=True)
        self.assertEqual(json.loads(self.registry.read_text())[0]["version"], "0.0.2")
        self.assertEqual(len(json.loads(self.registry.read_text())), 1)
        before = read_rows(self.database)
        registry_before = self.registry.read_text()
        result = self.run_script("uninstall.sh", running=True, success=False)
        self.assertIn("完整退出", result.stderr)
        self.assertTrue(self.plist.exists())
        self.assertTrue(self.target.exists())
        self.assertEqual(read_rows(self.database), before)
        self.assertEqual(self.registry.read_text(), registry_before)
        self.run_script("uninstall.sh")
        self.assertFalse(self.plist.exists())
        self.assertFalse(self.target.exists())
        self.assertEqual(json.loads(self.registry.read_text()), [])
        self.assertEqual(json.loads(read_rows(self.database)[helper.OVERRIDE_KEY]), ["other.extension"])
        self.assertEqual(json.loads(read_rows(self.database)[helper.TARGET_MARKER]), {"other-setting": 0, helper.OVERRIDE_KEY: 1})
        self.assertTrue(original)

    def test_running_install_needing_override_leaves_extension_and_watcher_unchanged(self):
        before = read_rows(self.database)
        result = self.run_script("install.sh", running=True, success=False)
        self.assertIn("完整退出", result.stderr)
        self.assertFalse(self.target.exists())
        self.assertTrue(self.plist.exists())
        self.assertEqual(read_rows(self.database), before)

    def test_invalid_schema_leaves_signature_store_unchanged(self):
        workbench = self.app / "Contents/Resources/app/out/vs/workbench/workbench.glass.main.js"
        workbench.write_text("// no schema\n" + helper.OVERRIDE_KEY)
        before = read_rows(self.database)
        self.run_script("install.sh", success=False)
        self.assertEqual(read_rows(self.database), before)
        self.assertFalse(self.target.exists())

    def test_watcher_checks_missing_override_and_repairs_only_when_cursor_is_closed(self):
        self.run_script("install.sh")
        with sqlite3.connect(self.database) as connection:
            connection.execute("DELETE FROM ItemTable WHERE key = ?", (helper.OVERRIDE_KEY,))
        before = self.registry.read_text()
        result = self.run_script("watch.sh", running=True)
        self.assertIn("完整退出", result.stderr)
        self.assertEqual(self.registry.read_text(), before)
        self.assertNotIn(helper.OVERRIDE_KEY, read_rows(self.database))
        self.run_script("watch.sh")
        self.assertEqual(json.loads(read_rows(self.database)[helper.OVERRIDE_KEY]), [helper.EXTENSION_ID])
        ready = self.registry.read_text()
        self.run_script("watch.sh", running=True)
        self.assertEqual(self.registry.read_text(), ready)


if __name__ == "__main__":
    unittest.main()

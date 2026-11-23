#!/usr/bin/env python3
"""Manage only this project's Cursor application-scoped signature exception."""

import argparse
from contextlib import closing
import datetime
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

EXTENSION_ID = "anysphere.cursor-always-local"
OVERRIDE_KEY = "cursor.extensions.anysphereSignatureOverrides"
TARGET_MARKER = "__$__targetStorageMarker"
MACHINE_TARGET = 1


def requires_override(app):
    workbench = Path(app) / "Contents/Resources/app/out/vs/workbench"
    found = False
    for filename in ("workbench.glass.main.js", "workbench.desktop.main.js"):
        source = workbench / filename
        if source.is_file():
            found = True
            if OVERRIDE_KEY in source.read_text(encoding="utf-8"):
                return True
    if not found:
        raise RuntimeError("找不到 Cursor 工作台代码，未修改签名例外。")
    return False


def ensure_cursor_stopped(app):
    # install.sh invokes us from Cursor's Electron executable in Node mode. That
    # parent is not an editor instance and must not block its own installation.
    parent = os.getppid()
    output = subprocess.check_output(["ps", "-axo", "pid=,comm="], text=True)
    app_prefix = str(Path(app).resolve()) + "/"
    for line in output.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2 or int(parts[0]) == parent:
            continue
        executable = parts[1]
        name = Path(executable).name
        if executable.startswith(app_prefix) or name == "Cursor" or name.startswith("Cursor Helper"):
            raise RuntimeError(
                "需要修改 Cursor 的签名例外，但 Cursor 仍在运行。"
                "请完整退出 Cursor（Cmd+Q）后重试；没有停止应用或修改数据库。"
            )


def read_state(connection):
    rows = {}
    for key in (OVERRIDE_KEY, TARGET_MARKER):
        row = connection.execute("SELECT value FROM ItemTable WHERE key = ?", (key,)).fetchone()
        rows[key] = row[0] if row else None
    ids = json.loads(rows[OVERRIDE_KEY]) if rows[OVERRIDE_KEY] is not None else []
    targets = json.loads(rows[TARGET_MARKER]) if rows[TARGET_MARKER] is not None else {}
    if not isinstance(ids, list) or any(not isinstance(value, str) for value in ids):
        raise RuntimeError("签名例外不是字符串数组，未修改数据库。")
    if not isinstance(targets, dict):
        raise RuntimeError("Cursor 存储目标不是对象，未修改数据库。")
    return rows, ids, targets


def planned_state(action, rows, ids, targets):
    targets = dict(targets)
    if action == "install":
        ids = list(ids) if EXTENSION_ID in ids else list(ids) + [EXTENSION_ID]
        targets[OVERRIDE_KEY] = MACHINE_TARGET
        changed = rows[OVERRIDE_KEY] is None or json.loads(rows[OVERRIDE_KEY]) != ids
        changed = changed or json.loads(rows[TARGET_MARKER] or "{}").get(OVERRIDE_KEY) != MACHINE_TARGET
    else:
        ids = [value for value in ids if value != EXTENSION_ID]
        if not ids:
            targets.pop(OVERRIDE_KEY, None)
        changed = ids != json.loads(rows[OVERRIDE_KEY] or "[]")
        changed = changed or targets != json.loads(rows[TARGET_MARKER] or "{}")
    return changed, ids, targets


def backup_state(database, rows, targets, action):
    directory = database.parent / "cursor-opus-hack-backups"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    timestamp = datetime.datetime.now().astimezone()
    destination = directory / (timestamp.strftime("%Y%m%dT%H%M%S%f") + "-" + action + ".json")
    previous = rows[OVERRIDE_KEY]
    if isinstance(previous, bytes):
        previous = previous.decode("utf-8")
    backup = {
        "createdAt": timestamp.isoformat(),
        "database": str(database),
        "key": OVERRIDE_KEY,
        "extensionId": EXTENSION_ID,
        "valueExisted": rows[OVERRIDE_KEY] is not None,
        "previousValue": previous,
        "targetEntryExisted": OVERRIDE_KEY in targets,
        "previousTarget": targets.get(OVERRIDE_KEY),
    }
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        json.dump(backup, output, ensure_ascii=False, indent=2)
        output.write("\n")
    return destination


def update_override(action, app, home=None, dry_run=False):
    if action in ("install", "check") and not requires_override(app):
        return "当前 Cursor 无此签名例外机制，无需修改。"
    home = Path(home) if home is not None else Path.home()
    database = home / "Library/Application Support/Cursor/User/globalStorage/state.vscdb"
    if not database.is_file():
        if action == "uninstall":
            return "Cursor 存储不存在，无需撤销签名例外。"
        raise RuntimeError("Cursor 存储尚未创建；请先启动一次 Cursor，再完整退出并重新安装。")

    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=5)) as connection:
        rows, ids, targets = read_state(connection)
    changed, new_ids, new_targets = planned_state("install" if action == "check" else action, rows, ids, targets)
    if action == "check":
        if changed:
            raise RuntimeError("本项目的签名例外缺失或存储目标不正确，需要重新安装。")
        return "签名例外已就绪。"
    if not changed:
        return "签名例外已就绪，无需修改。" if action == "install" else "本项目签名例外已移除，无需修改。"

    if dry_run:
        ensure_cursor_stopped(app)
        return "签名例外变更预检查通过，未修改配置。"

    ensure_cursor_stopped(app)
    connection = sqlite3.connect(database.as_uri() + "?mode=rw", uri=True, timeout=5)
    try:
        connection.execute("BEGIN IMMEDIATE")
        rows, ids, targets = read_state(connection)
        changed, new_ids, new_targets = planned_state(action, rows, ids, targets)
        if not changed:
            return "签名例外已由其他进程更新，无需修改。"
        ensure_cursor_stopped(app)
        backup = backup_state(database, rows, targets, action)
        # Preserve the original TEXT/BLOB storage representation for both rows.
        for key, value in ((OVERRIDE_KEY, new_ids), (TARGET_MARKER, new_targets)):
            if key == OVERRIDE_KEY and not new_ids:
                connection.execute("DELETE FROM ItemTable WHERE key = ?", (key,))
                continue
            encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            if isinstance(rows[key], bytes):
                encoded = encoded.encode("utf-8")
            connection.execute(
                "INSERT INTO ItemTable (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, encoded),
            )
        connection.commit()
    finally:
        # Roll back on errors, including failure to create the scoped backup.
        connection.close()
    verb = "已添加" if action == "install" else "已撤销"
    return "{}单扩展签名例外：{}；原配置备份：{}".format(verb, EXTENSION_ID, backup)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "uninstall", "check"))
    parser.add_argument("--dry-run", action="store_true", help="Check a change without writing it")
    parser.add_argument("--app", default=os.environ.get("CURSOR_APP", "/Applications/Cursor.app"))
    args = parser.parse_args()
    try:
        message = update_override(args.action, args.app, dry_run=args.dry_run)
    except (RuntimeError, ValueError, OSError, sqlite3.Error, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        return 1
    if args.action != "check":
        print(message)
    return 0


if __name__ == "__main__":
    sys.exit(main())

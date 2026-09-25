"""Nightly backup of the database, keeping the last 14 days.

Run from cron as the proctor user, e.g. at 02:30 every night:
  30 2 * * * cd /opt/proctor/server && set -a && . /etc/proctor.env && set +a && .venv/bin/python ../deploy/backup.py
"""
import os
import sqlite3
import time
from datetime import datetime
from pathlib import Path

DEST = Path(os.environ.get("PROCTOR_BACKUP_DIR", "/opt/proctor/backups"))
KEEP_DAYS = 14
SOURCES = {"proctor": os.environ["PROCTOR_DB"]}

DEST.mkdir(parents=True, exist_ok=True)
stamp = datetime.now().strftime("%Y%m%d-%H%M")
for name, path in SOURCES.items():
    if not Path(path).exists():
        continue
    out = DEST / f"{name}-{stamp}.db"
    with sqlite3.connect(path) as src, sqlite3.connect(out) as dst:
        src.backup(dst)                      # safe while the server is running
    os.chmod(out, 0o600)
cutoff = time.time() - KEEP_DAYS * 86400
for f in DEST.glob("*.db"):
    if f.stat().st_mtime < cutoff:
        f.unlink()
print(f"Backup {stamp} done.")

#!/bin/zsh
# Rebuild the handbook: fresh screenshots from a throwaway local demo, then PDFs.
#   zsh handbook/tools/build.sh            (from the proctorv3 folder; needs Google Chrome)
#   zsh handbook/tools/build.sh --pdf-only (skip the screenshots)
set -e
ROOT=${0:A:h:h:h}; HB=$ROOT/handbook; PY=$ROOT/server/.venv/bin/python
TMP=$(mktemp -d); trap 'pkill -f "uvicorn app:app --port 8013" 2>/dev/null; pkill -f stage_demo.py 2>/dev/null; pkill -f "http.server 8014" 2>/dev/null; rm -rf $TMP' EXIT

if [[ "$1" != "--pdf-only" ]]; then
  export PROCTOR_SECRET=$($PY -c "import secrets; print(secrets.token_hex(32))") PROCTOR_DB=$TMP/demo.db PYTHONPATH=$ROOT/server
  unset DATABASE_URL PROCTOR_ENV
  PW=$($PY -c "import secrets; print(secrets.token_urlsafe(16))")
  (cd $ROOT/server && $PY -c "
import db; db.init()
with db.conn() as c:
    c.execute('INSERT INTO admins(username, pw_hash, created_ts, role) VALUES (?,?,?,?)', ('admin', db.hash_password('$PW'), db.now(), 'admin'))
    c.execute('INSERT INTO admins(username, pw_hash, created_ts, role, exam_quota) VALUES (?,?,?,?,?)', ('priya.s', db.hash_password('$PW'), db.now(), 'invigilator', 5))")
  (cd $ROOT/server && nohup $PY -m uvicorn app:app --port 8013 > $TMP/server.log 2>&1 &)
  for i in {1..60}; do curl -s -m 2 localhost:8013/api/health >/dev/null && break; sleep 0.5; done
  (cd $ROOT/server && nohup $PY $HB/tools/stage_demo.py http://localhost:8013 "$PW" > $TMP/stage.log 2>&1 &)
  for i in {1..120}; do grep -q staged $TMP/stage.log 2>/dev/null && break; sleep 0.5; done
  grep -q staged $TMP/stage.log || { cat $TMP/stage.log; exit 1; }

  # The real popup, with chrome.runtime stubbed to return each state
  mkdir -p $TMP/popup && cp $ROOT/extension/popup.js $TMP/popup/
  $PY - $ROOT/extension/popup.html $TMP/popup/popup.html <<'EOF'
import sys
src, out = sys.argv[1], sys.argv[2]
stub = '''<script>
const T = (s) => Date.parse(s) / 1000;
const base = {exam_code: "BA101-A-QUIZ2", name: "BA101 Section A: Quiz 2", roll_no: "25PGDM004", student_name: "Ananya Iyer",
  start_ts: T("2026-11-03T10:00:00+05:30"), end_ts: T("2026-11-03T10:30:00+05:30"), queue: [], offset: 0,
  allowed_sites: ["accounts.google.com", "desmos.com/calculator", "docs.google.com/forms/d/e/1FAIpQLSc7BA101Quiz2"]};
const NOW = {join: "2026-11-03T09:52:00+05:30", waiting: "2026-11-03T09:54:00+05:30", ok: "2026-11-03T10:12:00+05:30", bad: "2026-11-03T10:14:00+05:30", done: "2026-11-03T10:31:00+05:30"};
const mode = location.hash.slice(1) || "join", now = Date.parse(NOW[mode]);
Date.now = () => now;
const state = mode === "join" ? null : {...base, finished: mode === "done", lastUpload: now - 20000};
window.chrome = {runtime: {sendMessage: async () => ({ok: true, state, now: now / 1000, allowedNow: mode !== "bad"})}};
</script>
'''
s = open(src).read()
open(out, "w").write(s.replace('<script type="module" src="popup.js"></script>', stub + '<script type="module" src="popup.js"></script>'))
EOF
  (cd $TMP/popup && nohup python3 -m http.server 8014 --bind 127.0.0.1 > $TMP/popup.log 2>&1 &)
  sleep 1
  $PY $HB/tools/shoot.py $HB/src/img "$PW" http://127.0.0.1:8014/popup.html http://localhost:8013 priya.s
fi

$PY $HB/tools/print_pdf.py $HB/src $HB \
  "faculty-handbook:Exam Proctor Faculty Handbook" \
  "student-guide:Exam Proctor Student Guide" \
  "quick-checklist:Exam Proctor Quick Checklist"

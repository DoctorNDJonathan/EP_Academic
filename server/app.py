"""Exam Proctor v3: extension API + authenticated live dashboard.

Student side (Chrome extension, bearer token)
  GET  /api/exams/{code}   exam status before joining
  POST /api/join           exam code + roll number + PIN -> secret token
  POST /api/ingest         activity segments, current tab, open tabs (every change + every 30 s)
  GET  /bye?k=...          opened by Chrome if the extension is uninstalled

Admin side (session cookie; POST/PUT/DELETE also need header "X-Proctor: 1")
  /dashboard               single-page dashboard (login, exams, live monitor, admins)
  /api/auth/*, /api/admin/*

Run:  uvicorn app:app --port 8000   (one worker: rate limits and the gap
watcher live in this process; SQLite handles 200+ students comfortably)
"""
import asyncio
import csv
import io
import json
import os
import re
import secrets
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import db
import rules

PRODUCTION = os.environ.get("PROCTOR_ENV") == "production"
STATIC = Path(__file__).resolve().parent / "static"

END_GRACE_S = 900            # accept queued uploads for 15 min after the exam ends
GAP_S = 90                   # no contact for this long -> "offline" + monitoring_gap flag
MAX_CLOCK_AHEAD_S = 120
SESSION_COOKIE = "proctor_session"
SESSION_TTL_S = 12 * 3600

CODE_RE = re.compile(r"^[A-Za-z0-9_-]{2,32}$")
ROLL_RE = re.compile(r"^[A-Za-z0-9/_.-]{1,40}$")
DEVICE_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")
USER_RE = re.compile(r"^[A-Za-z0-9_.@-]{3,64}$")
KINDS = {"tab", "idle", "outside"}


# ---------------------------------------------------------------- rate limiting
_hits: dict[tuple, deque] = defaultdict(deque)


def _limited(bucket: str, key: str, limit: int, window_s: int, record: bool = True) -> bool:
    q, t = _hits[(bucket, key)], time.monotonic()
    while q and t - q[0] > window_s:
        q.popleft()
    if len(q) >= limit:
        return True
    if record:
        q.append(t)
    return False


def _ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


# ---------------------------------------------------------------- app + background gap watcher
async def _gap_watcher():
    while True:
        try:
            await asyncio.to_thread(_mark_gaps)
        except Exception as e:  # never let the watcher die
            print("gap watcher:", e)
        await asyncio.sleep(20)


def _mark_gaps():
    t = db.now()
    with db.conn() as c:
        rows = c.execute(
            "SELECT p.exam_code, p.roll_no, p.last_seen FROM presence p JOIN exams e ON e.code=p.exam_code "
            "WHERE e.start_ts<=? AND e.end_ts>=? AND p.last_seen<?", (t, t, t - GAP_S)).fetchall()
        for r in rows:
            start = max(r["last_seen"], _exam_start(c, r["exam_code"]))
            _flag(c, r["exam_code"], r["roll_no"], "monitoring_gap", "MEDIUM", seg_start=start,
                  duration=t - start, detail="Extension silent (closed browser, disabled extension, or network drop)")
        c.execute("DELETE FROM sessions WHERE expires_ts<?", (t,))


def _exam_start(c, code):
    return c.execute("SELECT start_ts FROM exams WHERE code=?", (code,)).fetchone()["start_ts"]


@asynccontextmanager
async def lifespan(_app):
    db.init()
    task = asyncio.create_task(_gap_watcher())
    yield
    task.cancel()
    db.close()


app = FastAPI(title="Exam Proctor", version="3.0", lifespan=lifespan,
              docs_url=None if PRODUCTION else "/docs", redoc_url=None,
              openapi_url=None if PRODUCTION else "/openapi.json")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    if PRODUCTION:
        resp.headers["Strict-Transport-Security"] = "max-age=31536000"
    if not request.url.path.startswith("/api/"):
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
            "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    return resp


# ---------------------------------------------------------------- helpers
def _exam(c, code: str):
    if not CODE_RE.match(code or ""):
        raise HTTPException(400, "Invalid exam code format.")
    row = c.execute("SELECT * FROM exams WHERE code=?", (code.upper(),)).fetchone()
    if not row:
        raise HTTPException(404, "No exam with this code. Check the code with your instructor.")
    return row


def _state(e, t):
    return "scheduled" if t < e["start_ts"] else ("running" if t <= e["end_ts"] else "finished")


def _sites(e) -> list[str]:
    return json.loads(e["allowed_sites"])


def _flag(c, exam, roll, rule, level, seg_start, duration=0.0, domain="", path="", title="", detail=""):
    """Create a flag, or extend it if this is the same visit seen again (same rule+domain+start)."""
    t = db.now()
    c.execute(
        "INSERT INTO flags(exam_code, roll_no, rule, level, domain, path, title, detail, seg_start, duration_s, "
        "created_ts, updated_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(exam_code, roll_no, rule, domain, seg_start) DO UPDATE SET "
        f"duration_s={db.GREATEST}(flags.duration_s, excluded.duration_s), "
        "updated_ts=CASE WHEN excluded.duration_s>flags.duration_s THEN excluded.updated_ts ELSE flags.updated_ts END, "
        "title=CASE WHEN excluded.title<>'' THEN excluded.title ELSE flags.title END",
        (exam, roll, rule, level, domain, path[:300], title[:300], detail, round(seg_start, 3),
         round(duration, 1), t, t))


# ================================================================ STUDENT API
class JoinIn(BaseModel):
    exam_code: str = Field(max_length=32)
    roll_no: str = Field(max_length=40)
    pin: str = Field(max_length=12)
    device_id: str = Field(max_length=64)
    consent: bool


class Seg(BaseModel):
    kind: str = Field(max_length=10)
    domain: str = Field(max_length=253)
    path: str = Field(default="", max_length=300)
    title: str = Field(default="", max_length=300)
    start_ts: float
    end_ts: float | None = None


class Tab(BaseModel):
    domain: str = Field(max_length=253)
    path: str = Field(default="", max_length=300)


class IngestIn(BaseModel):
    events: list[Seg] = Field(default=[], max_length=500)
    current: Seg | None = None
    open_tabs: list[Tab] = Field(default=[], max_length=200)


def _exam_public(e, t):
    return {"code": e["code"], "name": e["name"], "start_ts": e["start_ts"], "end_ts": e["end_ts"],
            "state": _state(e, t), "server_time": t, "allowed_sites": _sites(e),
            "grace_s": e["grace_s"], "flag_outside": bool(e["flag_outside"])}


@app.get("/api/health")
def health():
    return {"ok": True, "server_time": db.now()}


@app.get("/api/exams/{code}")
def exam_status(code: str):
    with db.conn() as c:
        e = _exam(c, code)
    t = db.now()
    return {k: v for k, v in _exam_public(e, t).items() if k not in ("allowed_sites",)}


@app.post("/api/join")
def join(body: JoinIn, request: Request):
    ip = _ip(request)
    if _limited("join-fail", ip, 10, 300, record=False):
        raise HTTPException(429, "Too many wrong attempts. Wait five minutes and try again.")
    if not body.consent:
        raise HTTPException(400, "Consent is required to join a monitored exam.")
    roll = body.roll_no.strip().upper()
    if not ROLL_RE.match(roll):
        raise HTTPException(400, "Invalid roll number format.")
    if not DEVICE_RE.match(body.device_id):
        raise HTTPException(400, "Invalid device ID. Reinstall the extension.")
    with db.conn() as c:
        e = _exam(c, body.exam_code)
        t = db.now()
        if t > e["end_ts"]:
            raise HTTPException(409, "This exam has already ended.")
        if not secrets.compare_digest(db.secret_hash("pin", e["code"], body.pin.strip()), e["pin_hash"]):
            _limited("join-fail", ip, 10, 300)
            raise HTTPException(403, "Incorrect exam PIN.")
        roster = {r: n for r, n in json.loads(e["roster"])}
        if roster and roll not in roster:
            _limited("join-fail", ip, 10, 300)
            raise HTTPException(403, "This roll number is not on the list for this exam. Check it, or ask the invigilator.")
        name = roster.get(roll, "")

        prev = c.execute("SELECT device_id FROM participants WHERE exam_code=? AND roll_no=?",
                         (e["code"], roll)).fetchone()
        if prev and prev["device_id"] != body.device_id:
            _flag(c, e["code"], roll, "device_changed", "MEDIUM", seg_start=t,
                  detail="Rejoined from a different browser or reinstalled extension")
        others = c.execute("SELECT roll_no FROM participants WHERE exam_code=? AND device_id=? AND roll_no<>?",
                           (e["code"], body.device_id, roll)).fetchall()
        for o in others:
            for r in (roll, o["roll_no"]):
                _flag(c, e["code"], r, "shared_device", "MEDIUM", seg_start=t,
                      detail=f"Browser shared by {roll} and {o['roll_no']}")

        token, ukey = secrets.token_urlsafe(32), secrets.token_urlsafe(18)
        c.execute(
            "INSERT INTO participants(exam_code, roll_no, name, device_id, joined_ts, token_hash, uninstall_key) "
            "VALUES (?,?,?,?,?,?,?) ON CONFLICT(exam_code, roll_no) DO UPDATE SET device_id=excluded.device_id, "
            "token_hash=excluded.token_hash, uninstall_key=excluded.uninstall_key, name=excluded.name",
            (e["code"], roll, name, body.device_id, t, db.secret_hash("token", token), ukey))
        c.execute("INSERT INTO presence(exam_code, roll_no, last_seen) VALUES (?,?,?) "
                  "ON CONFLICT(exam_code, roll_no) DO UPDATE SET last_seen=excluded.last_seen",
                  (e["code"], roll, t))
    return {**_exam_public(e, t), "roll_no": roll, "student_name": name, "token": token, "uninstall_key": ukey}


def _participant(c, request: Request):
    auth = request.headers.get("authorization", "")
    token = auth.removeprefix("Bearer ").strip()
    if not token or len(token) > 100:
        raise HTTPException(401, "Missing session token.")
    p = c.execute("SELECT * FROM participants WHERE token_hash=?", (db.secret_hash("token", token),)).fetchone()
    if not p:
        raise HTTPException(401, "Session not recognised. Join the exam again.")
    return p


@app.post("/api/ingest")
def ingest(body: IngestIn, request: Request):
    with db.conn() as c:
        p = _participant(c, request)
        e = _exam(c, p["exam_code"])
        code, roll = e["code"], p["roll_no"]
        t = db.now()
        if t > e["end_ts"] + END_GRACE_S:
            raise HTTPException(409, "Upload window for this exam has closed.")
        sites, grace, fo = _sites(e), e["grace_s"], bool(e["flag_outside"])
        s0, limit = e["start_ts"], min(e["end_ts"], t + MAX_CLOCK_AHEAD_S)
        running = s0 <= t <= e["end_ts"]

        # 1. A gap since the last contact (network drop, browser closed, extension disabled)
        pres = c.execute("SELECT last_seen FROM presence WHERE exam_code=? AND roll_no=?", (code, roll)).fetchone()
        if pres and t - pres["last_seen"] > GAP_S and pres["last_seen"] < e["end_ts"] and t > s0:
            gs = max(pres["last_seen"], s0)
            _flag(c, code, roll, "monitoring_gap", "MEDIUM", seg_start=gs, duration=min(t, e["end_ts"]) - gs,
                  detail="Extension silent (closed browser, disabled extension, or network drop)")

        # 2. Completed activity segments (may arrive late from the offline queue)
        rows = []
        for ev in body.events:
            if ev.kind not in KINDS or ev.end_ts is None:
                continue
            s, en = max(ev.start_ts, s0), min(ev.end_ts, limit)
            if en - s <= 0:
                continue
            dom, path = ev.domain.strip().lower(), ev.path.strip()
            hit = rules.classify(ev.kind, dom, path, sites, fo)
            rows.append((code, roll, ev.kind, dom, path, ev.title.strip(), s, en, 0 if hit else 1))
            if hit and en - s >= grace:
                _flag(c, code, roll, hit[0], hit[1], seg_start=s, duration=en - s, domain=dom, path=path, title=ev.title)
        c.executemany("INSERT INTO events(exam_code, roll_no, kind, domain, path, title, start_ts, end_ts, allowed) "
                      "VALUES (?,?,?,?,?,?,?,?,?)", rows)

        # 3. Queued segments that cover a gap mean it was only a network drop: downgrade it.
        if rows:
            for g in c.execute("SELECT id, seg_start, duration_s FROM flags WHERE exam_code=? AND roll_no=? "
                               "AND rule='monitoring_gap' AND level<>'LOW'", (code, roll)).fetchall():
                gs, ge = g["seg_start"], g["seg_start"] + g["duration_s"]
                if ge - gs <= 0:
                    continue
                cov = c.execute(f"SELECT COALESCE(SUM({db.LEAST}(end_ts, ?) - {db.GREATEST}(start_ts, ?)), 0) FROM events "
                                "WHERE exam_code=? AND roll_no=? AND end_ts>? AND start_ts<?",
                                (ge, gs, code, roll, gs, ge)).fetchone()[0]
                if cov / (ge - gs) >= 0.9:
                    c.execute("UPDATE flags SET level='LOW', detail=? WHERE id=?",
                              ("Network drop: activity during the gap was recorded and uploaded later", g["id"]))

        # 4. What the student is doing right now
        cur, allowed_now = body.current, True
        kind = dom = path = title = ""
        since = 0.0
        if cur and running and cur.kind in KINDS:
            kind, dom, path, title = cur.kind, cur.domain.strip().lower(), cur.path.strip(), cur.title.strip()
            since = max(cur.start_ts, s0)
            hit = rules.classify(kind, dom, path, sites, fo)
            allowed_now = not hit
            if hit and t - since >= grace:
                _flag(c, code, roll, hit[0], hit[1], seg_start=since, duration=t - since,
                      domain=dom, path=path, title=title)

        bad_tabs = []
        if running:
            for tb in body.open_tabs:
                d = tb.domain.strip().lower()
                if d not in rules.INTERNAL and not rules.is_allowed(d, tb.path, sites) and d not in bad_tabs:
                    bad_tabs.append(d)
            for d in bad_tabs[:20]:
                _flag(c, code, roll, "tab_open", "LOW", seg_start=0, domain=d)

        c.execute(
            "INSERT INTO presence(exam_code, roll_no, last_seen, kind, domain, path, title, since, allowed, bad_tabs) "
            "VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(exam_code, roll_no) DO UPDATE SET last_seen=excluded.last_seen, "
            "kind=excluded.kind, domain=excluded.domain, path=excluded.path, title=excluded.title, "
            "since=excluded.since, allowed=excluded.allowed, bad_tabs=excluded.bad_tabs",
            (code, roll, t, kind, dom, path[:300], title[:300], since, int(allowed_now), json.dumps(bad_tabs[:20])))
    return {**_exam_public(e, t), "stored": len(rows), "allowed_now": allowed_now}


@app.get("/bye", response_class=HTMLResponse)
def uninstalled(k: str = ""):
    if 10 <= len(k) <= 40:
        with db.conn() as c:
            p = c.execute("SELECT p.exam_code, p.roll_no, e.start_ts, e.end_ts FROM participants p "
                          "JOIN exams e ON e.code=p.exam_code WHERE p.uninstall_key=?", (k,)).fetchone()
            t = db.now()
            if p and p["start_ts"] - 1800 <= t <= p["end_ts"]:
                _flag(c, p["exam_code"], p["roll_no"], "extension_removed", "HIGH", seg_start=t,
                      detail="Chrome reported that the monitoring extension was uninstalled")
    return ("<!doctype html><meta charset=utf-8><title>Exam monitor removed</title>"
            "<body style='font:16px system-ui;max-width:560px;margin:15vh auto;padding:0 16px'>"
            "<h1>Exam monitor removed</h1><p>If an exam was in progress, your invigilator has been notified. "
            "Reinstall the extension and join again to continue.</p></body>")


# ================================================================ ADMIN AUTH
class LoginIn(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=200)


def admin(request: Request) -> str:
    tok = request.cookies.get(SESSION_COOKIE, "")
    if not tok:
        raise HTTPException(401, "Please sign in.")
    with db.conn() as c:
        row = c.execute("SELECT username, expires_ts FROM sessions WHERE token_hash=?",
                        (db.secret_hash("session", tok),)).fetchone()
    if not row or row["expires_ts"] < db.now():
        raise HTTPException(401, "Session expired. Please sign in again.")
    # CSRF guard: browsers cannot add custom headers to cross-site requests without CORS, which is off.
    if request.method != "GET" and request.headers.get("x-proctor") != "1":
        raise HTTPException(403, "Missing request header.")
    return row["username"]


@app.post("/api/auth/login")
def login(body: LoginIn, request: Request, response: Response):
    ip = _ip(request)
    if _limited("login-fail", ip, 8, 600, record=False):
        raise HTTPException(429, "Too many failed sign-ins. Wait ten minutes.")
    with db.conn() as c:
        row = c.execute("SELECT pw_hash FROM admins WHERE username=?", (body.username.strip(),)).fetchone()
        ok = db.check_password(body.password, row["pw_hash"] if row else db.hash_password("timing-dummy"))
        if not (row and ok):
            _limited("login-fail", ip, 8, 600)
            raise HTTPException(401, "Wrong username or password.")
        tok = secrets.token_urlsafe(32)
        c.execute("INSERT INTO sessions(token_hash, username, expires_ts) VALUES (?,?,?)",
                  (db.secret_hash("session", tok), body.username.strip(), db.now() + SESSION_TTL_S))
    response.set_cookie(SESSION_COOKIE, tok, max_age=SESSION_TTL_S, httponly=True,
                        secure=PRODUCTION, samesite="strict", path="/")
    return {"username": body.username.strip()}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response, user: str = Depends(admin)):
    with db.conn() as c:
        c.execute("DELETE FROM sessions WHERE token_hash=?",
                  (db.secret_hash("session", request.cookies.get(SESSION_COOKIE, "")),))
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@app.get("/api/auth/me")
def me(user: str = Depends(admin)):
    return {"username": user}


class PasswordIn(BaseModel):
    old_password: str = Field(max_length=200)
    new_password: str = Field(min_length=10, max_length=200)


@app.post("/api/auth/password")
def change_password(body: PasswordIn, user: str = Depends(admin)):
    with db.conn() as c:
        row = c.execute("SELECT pw_hash FROM admins WHERE username=?", (user,)).fetchone()
        if not db.check_password(body.old_password, row["pw_hash"]):
            raise HTTPException(400, "Current password is wrong.")
        c.execute("UPDATE admins SET pw_hash=? WHERE username=?", (db.hash_password(body.new_password), user))
    return {"ok": True}


# ================================================================ ADMIN: users
class UserIn(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(min_length=10, max_length=200)


@app.get("/api/admin/users")
def list_users(user: str = Depends(admin)):
    with db.conn() as c:
        return [dict(r) for r in c.execute("SELECT username, created_ts FROM admins ORDER BY username")]


@app.post("/api/admin/users")
def add_user(body: UserIn, user: str = Depends(admin)):
    if not USER_RE.match(body.username):
        raise HTTPException(400, "Username: 3-64 letters, digits, . _ @ -")
    with db.conn() as c:
        if c.execute("SELECT 1 FROM admins WHERE username=?", (body.username,)).fetchone():
            raise HTTPException(409, "That username already exists.")
        c.execute("INSERT INTO admins VALUES (?,?,?)", (body.username, db.hash_password(body.password), db.now()))
    return {"ok": True}


@app.delete("/api/admin/users/{username}")
def delete_user(username: str, user: str = Depends(admin)):
    if username == user:
        raise HTTPException(400, "You cannot remove your own account.")
    with db.conn() as c:
        c.execute("DELETE FROM admins WHERE username=?", (username,))
        c.execute("DELETE FROM sessions WHERE username=?", (username,))
    return {"ok": True}


# ================================================================ ADMIN: exams
class ExamIn(BaseModel):
    code: str = Field(max_length=32)
    name: str = Field(min_length=1, max_length=120)
    start_ts: float
    end_ts: float
    pin: str = Field(default="", max_length=12)
    allowed_sites: list[str] = Field(default=[], max_length=200)
    grace_s: int = Field(default=3, ge=0, le=120)
    flag_outside: bool = True
    roster: str = Field(default="", max_length=200_000)


def _parse_roster(text: str) -> list[list[str]]:
    out, seen = [], set()
    for line in text.splitlines():
        parts = [x.strip() for x in re.split(r"[,\t;]", line, maxsplit=1)]
        roll = parts[0].upper() if parts else ""
        if not roll or roll in ("ROLL", "ROLL_NO", "ROLL NO") or roll in seen:
            continue
        if not ROLL_RE.match(roll):
            raise HTTPException(400, f"Roster: invalid roll number '{roll[:40]}'.")
        seen.add(roll)
        out.append([roll, parts[1][:80] if len(parts) > 1 else ""])
    return out


def _validate_exam(body: ExamIn, need_pin: bool):
    if not CODE_RE.match(body.code):
        raise HTTPException(400, "Exam code: 2-32 letters, digits, _ or -.")
    if body.end_ts <= body.start_ts:
        raise HTTPException(400, "End time must be after start time.")
    if body.end_ts - body.start_ts > 12 * 3600:
        raise HTTPException(400, "Exams longer than 12 hours are not supported.")
    if (need_pin or body.pin) and not re.match(r"^[A-Za-z0-9]{4,12}$", body.pin):
        raise HTTPException(400, "PIN: 4-12 letters or digits.")
    sites, bad = [], []
    for s in body.allowed_sites:
        if not s.strip():
            continue
        n = rules.normalise_entry(s)
        (sites.append(n) if n else bad.append(s.strip()))
    if bad:
        raise HTTPException(400, f"These allowed-site entries are not valid: {', '.join(bad[:5])}")
    return sorted(set(sites)), _parse_roster(body.roster)


def _exam_admin(e):
    return {"code": e["code"], "name": e["name"], "start_ts": e["start_ts"], "end_ts": e["end_ts"],
            "allowed_sites": _sites(e), "grace_s": e["grace_s"], "flag_outside": bool(e["flag_outside"]),
            "roster": "\n".join(f"{r},{n}" if n else r for r, n in json.loads(e["roster"])),
            "roster_size": len(json.loads(e["roster"])), "created_by": e["created_by"]}


@app.get("/api/admin/exams")
def list_exams(user: str = Depends(admin)):
    t = db.now()
    with db.conn() as c:
        exams = c.execute("SELECT * FROM exams ORDER BY start_ts DESC").fetchall()
        joined = dict(c.execute("SELECT exam_code, COUNT(*) FROM participants GROUP BY exam_code").fetchall())
        online = dict(c.execute("SELECT exam_code, COUNT(*) FROM presence WHERE last_seen>=? GROUP BY exam_code",
                                (t - GAP_S,)).fetchall())
        high = dict(c.execute("SELECT exam_code, COUNT(*) FROM flags WHERE status='open' AND level='HIGH' "
                              "GROUP BY exam_code").fetchall())
    return [{**_exam_admin(e), "state": _state(e, t), "joined": joined.get(e["code"], 0),
             "online": online.get(e["code"], 0), "high_flags": high.get(e["code"], 0)} for e in exams]


@app.get("/api/admin/exams/{code}")
def get_exam(code: str, user: str = Depends(admin)):
    with db.conn() as c:
        return _exam_admin(_exam(c, code))


@app.post("/api/admin/exams")
def create_exam(body: ExamIn, user: str = Depends(admin)):
    sites, roster = _validate_exam(body, need_pin=True)
    code = body.code.upper()
    with db.conn() as c:
        if c.execute("SELECT 1 FROM exams WHERE code=?", (code,)).fetchone():
            raise HTTPException(409, "An exam with this code already exists.")
        c.execute("INSERT INTO exams(code, name, start_ts, end_ts, pin_hash, allowed_sites, grace_s, flag_outside, "
                  "roster, created_by, created_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                  (code, body.name.strip(), body.start_ts, body.end_ts, db.secret_hash("pin", code, body.pin),
                   json.dumps(sites), body.grace_s, int(body.flag_outside), json.dumps(roster), user, db.now()))
    return {"code": code}


@app.put("/api/admin/exams/{code}")
def update_exam(code: str, body: ExamIn, user: str = Depends(admin)):
    sites, roster = _validate_exam(body, need_pin=False)
    with db.conn() as c:
        e = _exam(c, code)
        pin_hash = db.secret_hash("pin", e["code"], body.pin) if body.pin else e["pin_hash"]
        c.execute("UPDATE exams SET name=?, start_ts=?, end_ts=?, pin_hash=?, allowed_sites=?, grace_s=?, "
                  "flag_outside=?, roster=? WHERE code=?",
                  (body.name.strip(), body.start_ts, body.end_ts, pin_hash, json.dumps(sites), body.grace_s,
                   int(body.flag_outside), json.dumps(roster), e["code"]))
        # Changing the allowlist mid-exam: live status is re-evaluated on each student's next report (<= 30 s).
    return {"code": e["code"]}


@app.delete("/api/admin/exams/{code}")
def delete_exam(code: str, user: str = Depends(admin)):
    with db.conn() as c:
        e = _exam(c, code)
        for tbl in ("participants", "presence", "events", "flags"):
            c.execute(f"DELETE FROM {tbl} WHERE exam_code=?", (e["code"],))
        c.execute("DELETE FROM exams WHERE code=?", (e["code"],))
    return {"ok": True}


# ================================================================ ADMIN: live monitoring
def _status(e, p, t):
    if p is None:
        return "not_joined"
    if t < e["start_ts"]:
        return "waiting"
    if t > e["end_ts"]:
        return "finished"
    if t - p["last_seen"] > GAP_S:
        return "offline"
    if not p["kind"]:
        return "waiting"
    if not p["allowed"]:
        return "violation"
    return "idle" if p["kind"] == "idle" else "ok"


@app.get("/api/admin/exams/{code}/live")
def live(code: str, user: str = Depends(admin)):
    t = db.now()
    with db.conn() as c:
        e = _exam(c, code)
        parts = {r["roll_no"]: r for r in c.execute(
            "SELECT roll_no, name, joined_ts FROM participants WHERE exam_code=?", (e["code"],))}
        pres = {r["roll_no"]: r for r in c.execute("SELECT * FROM presence WHERE exam_code=?", (e["code"],))}
        counts = defaultdict(lambda: {"HIGH": 0, "MEDIUM": 0, "LOW": 0})
        for r in c.execute("SELECT roll_no, level, COUNT(*) n FROM flags WHERE exam_code=? AND status<>'dismissed' "
                           "GROUP BY roll_no, level", (e["code"],)):
            counts[r["roll_no"]][r["level"]] = r["n"]
        flags = [dict(r) for r in c.execute(
            "SELECT * FROM flags WHERE exam_code=? ORDER BY updated_ts DESC LIMIT 400", (e["code"],))]
    roster = {r: n for r, n in json.loads(e["roster"])}
    students = []
    for roll in sorted(set(roster) | set(parts)):
        p, pr = parts.get(roll), pres.get(roll)
        st = _status(e, pr if p else None, t)
        students.append({
            "roll_no": roll, "name": (p["name"] if p and p["name"] else roster.get(roll, "")),
            "status": st, "joined_ts": p["joined_ts"] if p else None,
            "last_seen": pr["last_seen"] if pr else None,
            "kind": pr["kind"] if pr else "", "domain": pr["domain"] if pr else "",
            "path": pr["path"] if pr else "", "title": pr["title"] if pr else "",
            "since": pr["since"] if pr else None, "bad_tabs": json.loads(pr["bad_tabs"]) if pr else [],
            "flags": counts[roll]})
    for f in flags:
        f["label"] = rules.RULE_LABELS.get(f["rule"], f["rule"])
        f["name"] = parts[f["roll_no"]]["name"] if f["roll_no"] in parts else roster.get(f["roll_no"], "")
    return {"exam": {**_exam_admin(e), "state": _state(e, t)}, "server_time": t, "gap_s": GAP_S,
            "students": students, "flags": flags}


@app.get("/api/admin/exams/{code}/students/{roll}")
def student_detail(code: str, roll: str, user: str = Depends(admin)):
    with db.conn() as c:
        e = _exam(c, code)
        p = c.execute("SELECT roll_no, name, device_id, joined_ts FROM participants WHERE exam_code=? AND roll_no=?",
                      (e["code"], roll.upper())).fetchone()
        events = [dict(r) for r in c.execute(
            "SELECT kind, domain, path, title, start_ts, end_ts, allowed FROM events WHERE exam_code=? AND roll_no=? "
            "ORDER BY start_ts", (e["code"], roll.upper()))]
        flags = [dict(r) for r in c.execute(
            "SELECT * FROM flags WHERE exam_code=? AND roll_no=? ORDER BY seg_start", (e["code"], roll.upper()))]
    for f in flags:
        f["label"] = rules.RULE_LABELS.get(f["rule"], f["rule"])
    return {"participant": dict(p) if p else None, "events": events, "flags": flags}


class ReviewIn(BaseModel):
    status: str = Field(pattern="^(open|dismissed|confirmed)$")
    note: str = Field(default="", max_length=1000)


@app.post("/api/admin/flags/{flag_id}")
def review_flag(flag_id: int, body: ReviewIn, user: str = Depends(admin)):
    with db.conn() as c:
        n = c.execute("UPDATE flags SET status=?, note=?, reviewer=? WHERE id=?",
                      (body.status, body.note.strip(), user, flag_id)).rowcount
    if not n:
        raise HTTPException(404, "Flag not found.")
    return {"ok": True}


@app.get("/api/admin/exams/{code}/export.csv")
def export_flags(code: str, user: str = Depends(admin)):
    with db.conn() as c:
        e = _exam(c, code)
        names = dict(c.execute("SELECT roll_no, name FROM participants WHERE exam_code=?", (e["code"],)).fetchall())
        rows = c.execute("SELECT * FROM flags WHERE exam_code=? ORDER BY roll_no, seg_start", (e["code"],)).fetchall()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["roll_no", "name", "level", "rule", "description", "site", "path", "page_title", "started_utc",
                "duration_s", "detail", "status", "reviewer", "note"])
    for r in rows:
        started = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(r["seg_start"])) if r["seg_start"] else ""
        cells = [r["roll_no"], names.get(r["roll_no"], ""), r["level"], r["rule"],
                 rules.RULE_LABELS.get(r["rule"], ""), r["domain"], r["path"], r["title"], started,
                 r["duration_s"], r["detail"], r["status"], r["reviewer"], r["note"]]
        # Neutralise spreadsheet formula injection from page titles.
        w.writerow([("'" + x) if isinstance(x, str) and x[:1] in "=+-@" else x for x in cells])
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="flags-{e["code"]}.csv"'})


# ================================================================ dashboard pages
@app.get("/", include_in_schema=False)
def root():
    return RedirectResponse("/dashboard")


@app.get("/dashboard", include_in_schema=False)
def dashboard():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})

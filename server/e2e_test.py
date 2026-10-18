"""End-to-end test against a LOCAL server (it also reaches into the same database directly).

  cd server && source .dev.env
  uvicorn app:app --port 8000            # another terminal, same environment, NOT PROCTOR_ENV=production
                                         # (production cookies are HTTPS-only, so the test could not stay signed in)
  PROCTOR_TEST_USER=admin PROCTOR_TEST_PASSWORD=... python e2e_test.py

Creates and deletes its own exams (E2E, COLAB). Never point it at the live server.
"""
import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.request

import app
import db
import rules

S = os.environ.get("PROCTOR_TEST_SERVER", "http://localhost:8000")
USER, PW = os.environ.get("PROCTOR_TEST_USER", "admin"), os.environ.get("PROCTOR_TEST_PASSWORD", "")
if "localhost" not in S and "127.0.0.1" not in S:
    sys.exit("Refusing to run against a non-local server.")
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
ok = 0


def req(method, path, body=None, tok=None, admin=True, raw=False, opener=None):
    opener = opener or op
    h = {"Content-Type": "application/json"}
    if admin:
        h["X-Proctor"] = "1"
    if tok:
        h["Authorization"] = "Bearer " + tok
    r = urllib.request.Request(S + path, json.dumps(body).encode() if body is not None else None, h, method=method)
    try:
        with opener.open(r) as resp:
            d = resp.read()
            return resp.status, (d.decode() if raw else json.loads(d))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def db_rows(sql):
    with db.conn() as c:
        return c.execute(sql).fetchall()


def check(name, cond):
    global ok
    if not cond:
        sys.exit(f"FAIL: {name}")
    ok += 1


# ---------------------------------------------------------------- rules (no server needed)
n = rules.normalise_entry
check("rule: scheme/www/slash stripped", n("https://www.Colab.Research.Google.com/") == "colab.research.google.com")
check("rule: path case kept", n("https://colab.research.google.com/drive/1AbCdEf?usp=sharing#x") == "colab.research.google.com/drive/1AbCdEf")
check("rule: invalid rejected", [n(x) for x in ("com", "localhost", "bad entry", "http://")] == [None] * 4)
check("rule: site covers subdomains", rules.is_allowed("colab.research.google.com", "/drive/Z", ["research.google.com"]))
check("rule: sibling not covered", not rules.is_allowed("colab.research.google.com", "/", ["colab.google.com"]))
check("rule: path segment boundary", not rules.is_allowed("desmos.com", "/calculators", ["desmos.com/calculator"])
      and rules.is_allowed("desmos.com", "/calculator/abc", ["desmos.com/calculator"]))

# ---------------------------------------------------------------- auth + exams
check("login bad", req("POST", "/api/auth/login", {"username": USER, "password": "nope"})[0] == 401)
check("login", req("POST", "/api/auth/login", {"username": USER, "password": PW})[0] == 200)
check("csrf", req("POST", "/api/admin/exams", {}, admin=False)[0] == 403)
t0 = time.time() - 60
req("DELETE", "/api/admin/exams/E2E")
ex = {"code": "E2E", "name": "E2E", "start_ts": t0, "end_ts": t0 + 1800, "pin": "4821",
      "allowed_sites": ["https://www.exam.example.edu/", "desmos.com/calculator"], "grace_s": 3,
      "flag_outside": True, "roster": "ROLL,Name\nR1,Asha\nR2,Vik\nR9,Never"}
check("create", req("POST", "/api/admin/exams", ex)[0] == 200)
check("dup", req("POST", "/api/admin/exams", ex)[0] == 409)
J = lambda roll, pin="4821", dev="dev-aaaa-1111": req("POST", "/api/join", {"exam_code": "e2e", "roll_no": roll, "pin": pin, "device_id": dev, "consent": True}, admin=False)
check("bad pin", J("R1", "0000")[0] == 403)
check("not roster", J("X7")[0] == 403)
s, j = J("r1")
check("join", s == 200 and j["student_name"] == "Asha")
tok = j["token"]
T = time.time()
body = {"events": [{"kind": "tab", "domain": "sub.exam.example.edu", "path": "/q", "title": "Q1", "start_ts": T - 40, "end_ts": T - 20},
                   {"kind": "tab", "domain": "desmos.com", "path": "/scientific", "title": "D", "start_ts": T - 20, "end_ts": T - 10}],
        "current": {"kind": "tab", "domain": "chatgpt.com", "path": "/c/x", "title": "ChatGPT", "start_ts": T - 10},
        "open_tabs": [{"domain": "exam.example.edu", "path": "/"}, {"domain": "web.whatsapp.com", "path": "/"}]}
s, r = req("POST", "/api/ingest", body, tok=tok, admin=False)
check("ingest", s == 200 and r["stored"] == 2 and not r["allowed_now"])
body["events"] = []
body["current"]["title"] = "ChatGPT 2"
req("POST", "/api/ingest", body, tok=tok, admin=False)          # same visit again -> same flag, updated
s, L = req("GET", "/api/admin/exams/E2E/live")
st = {x["roll_no"]: x for x in L["students"]}
check("live status", st["R1"]["status"] == "violation" and st["R2"]["status"] == "not_joined" and st["R1"]["bad_tabs"] == ["web.whatsapp.com"])
fl = {(f["rule"], f["domain"]): f for f in L["flags"]}
check("flags", set(fl) == {("disallowed_site", "chatgpt.com"), ("disallowed_site", "desmos.com"), ("tab_open", "web.whatsapp.com")})
check("upsert dedupe", fl[("disallowed_site", "chatgpt.com")]["title"] == "ChatGPT 2")
check("counts", st["R1"]["flags"]["HIGH"] == 2)
fid = fl[("disallowed_site", "desmos.com")]["id"]
check("review", req("POST", f"/api/admin/flags/{fid}", {"status": "dismissed", "note": "ok"})[0] == 200)
s, d = req("GET", "/api/admin/exams/E2E/students/R1")
check("detail", len(d["events"]) == 2 and any(f["status"] == "dismissed" for f in d["flags"]))
s, csv = req("GET", "/api/admin/exams/E2E/export.csv", raw=True)
check("csv", "chatgpt.com" in csv)
with db.conn() as c:                                              # simulate 200 s of silence
    c.execute("UPDATE presence SET last_seen=? WHERE exam_code='E2E' AND roll_no='R1'", (time.time() - 200,))
app._mark_gaps()
T = time.time()
gap_level = lambda: [tuple(r) for r in db_rows("SELECT level FROM flags WHERE exam_code='E2E' AND rule='monitoring_gap'")]
# Visits that span the gap prove nothing (the extension may have been switched off): stays MEDIUM
req("POST", "/api/ingest", {"events": [{"kind": "tab", "domain": "exam.example.edu", "path": "/q", "title": "Q", "start_ts": T - 200, "end_ts": T - 1}],
                            "current": {"kind": "tab", "domain": "exam.example.edu", "path": "/q", "title": "Q", "start_ts": T - 1}}, tok=tok, admin=False)
check("gap NOT excused by visits alone", gap_level() == [("MEDIUM",)])
# Heartbeats every 30 s through the gap = the extension kept running offline: downgraded to LOW
req("POST", "/api/ingest", {"heartbeats": [T - 200 + 30 * i for i in range(7)]}, tok=tok, admin=False)
check("gap downgraded by offline heartbeats", gap_level() == [("LOW",)])
with db.conn() as c:
    k = c.execute("SELECT uninstall_key FROM participants WHERE exam_code='E2E' AND roll_no='R1'").fetchone()["uninstall_key"]
op.open(S + "/bye?k=" + k).read()
J("R1", dev="other-device-22")
J("R2", dev="other-device-22")
s, L = req("GET", "/api/admin/exams/E2E/live")
got = {(f["roll_no"], f["rule"]) for f in L["flags"]}
check("bye/device/shared", {("R1", "extension_removed"), ("R1", "device_changed"), ("R2", "shared_device"), ("R1", "shared_device")} <= got)
check("old token dead", req("POST", "/api/ingest", {}, tok=tok, admin=False)[0] == 401)
check("update", req("PUT", "/api/admin/exams/E2E", {**ex, "pin": "", "allowed_sites": ["chatgpt.com"]})[0] == 200)
check("list", any(e["code"] == "E2E" for e in req("GET", "/api/admin/exams")[1]))
check("add user", req("POST", "/api/admin/users", {"username": "inv2", "password": "longenough123"})[0] in (200, 409))
check("del user", req("DELETE", "/api/admin/users/inv2")[0] == 200)
check("delete exam", req("DELETE", "/api/admin/exams/E2E")[0] == 200)

# ---------------------------------------------------------------- allowlist preview + "allow this site"
s, d = req("POST", "/api/admin/sites/check", {"lines": ["colab.google.com", "", "https://colab.research.google.com/drive/1AbCdEf", "google.com", "bad one"],
                                               "test_url": "colab.research.google.com/drive/1AbCdEf"})
check("preview rows", [r.get("scope") for r in d["rows"]] == ["site", "part", "site", None] and "Gemini" in d["rows"][2]["warning"])
check("preview test link", d["test"]["allowed"])
s, d = req("POST", "/api/admin/sites/check", {"lines": ["colab.google.com"], "test_url": "https://colab.research.google.com/drive/XYZ"})
check("colab tip", d["tips"][0]["add"] == "colab.research.google.com" and not d["test"]["allowed"])
req("DELETE", "/api/admin/exams/COLAB")
check("create colab", req("POST", "/api/admin/exams", {"code": "COLAB", "name": "Colab test", "start_ts": t0, "end_ts": t0 + 3600, "pin": "4821",
      "allowed_sites": ["https://colab.research.google.com/drive/1AbCdEf"], "grace_s": 0, "flag_outside": True, "roster": ""})[0] == 200)
s, j = req("POST", "/api/join", {"exam_code": "COLAB", "roll_no": "S1", "pin": "4821", "device_id": "dev-colab-0001", "consent": True}, admin=False)
tok = j["token"]
T = time.time()
check("case kept in stored list", j["allowed_sites"] == ["colab.research.google.com/drive/1AbCdEf"])
s, r = req("POST", "/api/ingest", {"current": {"kind": "tab", "domain": "colab.research.google.com", "path": "/drive/1AbCdEf", "title": "nb", "start_ts": T - 5}}, tok=tok, admin=False)
check("pasted notebook allowed", r["allowed_now"])
s, r = req("POST", "/api/ingest", {"events": [{"kind": "tab", "domain": "colab.research.google.com", "path": "/drive/1AbCdEf", "title": "nb", "start_ts": T - 5, "end_ts": T - 2}],
                                   "current": {"kind": "tab", "domain": "colab.research.google.com", "path": "/drive/OTHER", "title": "other", "start_ts": T - 2},
                                   "open_tabs": [{"domain": "colab.research.google.com", "path": "/drive/X2"}]}, tok=tok, admin=False)
check("other notebook flagged", not r["allowed_now"])
s, L = req("GET", "/api/admin/exams/COLAB/live")
check("tile red", L["students"][0]["status"] == "violation")
check("allow needs csrf header", req("POST", "/api/admin/exams/COLAB/allow", {"site": "colab.research.google.com"}, admin=False)[0] == 403)
s, a = req("POST", "/api/admin/exams/COLAB/allow", {"site": "colab.research.google.com"})
check("allow site", s == 200 and "colab.research.google.com" in a["allowed_sites"] and a["dismissed"] >= 1)
s, L = req("GET", "/api/admin/exams/COLAB/live")
check("tile green at once", L["students"][0]["status"] == "ok" and L["students"][0]["bad_tabs"] == [])
check("its flags dismissed", all(f["status"] == "dismissed" for f in L["flags"] if f["rule"] in ("disallowed_site", "tab_open")))
s, r = req("POST", "/api/ingest", {"current": {"kind": "tab", "domain": "colab.research.google.com", "path": "/github/x/y/blob/main/a.ipynb", "title": "gh", "start_ts": time.time()}}, tok=tok, admin=False)
check("any notebook now allowed", r["allowed_now"] and "colab.research.google.com" in r["allowed_sites"])
check("allow invalid", req("POST", "/api/admin/exams/COLAB/allow", {"site": "not a site"})[0] == 400)
req("DELETE", "/api/admin/exams/COLAB")


# ---------------------------------------------------------------- roles: admins manage users, invigilators only their own exams
inv = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
I = lambda method, path, body=None, raw=False: req(method, path, body, raw=raw, opener=inv)
for code in ("ADMINX", "INV1", "INV2"):
    req("DELETE", f"/api/admin/exams/{code}")
req("DELETE", "/api/admin/users/inv_t1")
check("me: admin role", req("GET", "/api/auth/me")[1]["role"] == "admin")
check("admin adds invigilator, limit 1", req("POST", "/api/admin/users", {"username": "inv_t1", "password": "invigilator-pass-1", "role": "invigilator", "exam_quota": 1})[0] == 200)
exam = lambda code: {"code": code, "name": code, "start_ts": t0, "end_ts": t0 + 3600, "pin": "4821", "allowed_sites": ["exam.example.edu"], "grace_s": 0, "flag_outside": True, "roster": ""}
check("admin creates own exam", req("POST", "/api/admin/exams", exam("ADMINX"))[0] == 200)
check("invigilator signs in", I("POST", "/api/auth/login", {"username": "inv_t1", "password": "invigilator-pass-1"})[0] == 200)
s_, m = I("GET", "/api/auth/me")
check("me: invigilator, 0 of 1 used", m["role"] == "invigilator" and m["exam_quota"] == 1 and m["exams_used"] == 0)
check("invigilator cannot list users", I("GET", "/api/admin/users")[0] == 403)
check("invigilator cannot add users", I("POST", "/api/admin/users", {"username": "sneaky", "password": "longenough123", "role": "admin"})[0] == 403)
check("invigilator cannot change users", I("PUT", "/api/admin/users/inv_t1", {"role": "admin"})[0] == 403)
check("invigilator cannot remove users", I("DELETE", f"/api/admin/users/{USER}")[0] == 403)
check("invigilator creates an exam", I("POST", "/api/admin/exams", exam("INV1"))[0] == 200)
s_, e = I("POST", "/api/admin/exams", exam("INV2"))
check("limit reached: second exam refused", s_ == 403 and "limit of 1" in e["detail"])
check("invigilator sees only own exams", [x["code"] for x in I("GET", "/api/admin/exams")[1]] == ["INV1"])
for method, path in [("GET", "/api/admin/exams/ADMINX"), ("GET", "/api/admin/exams/ADMINX/live"), ("GET", "/api/admin/exams/ADMINX/students/X1"),
                     ("GET", "/api/admin/exams/ADMINX/export.csv"), ("DELETE", "/api/admin/exams/ADMINX")]:
    check(f"invigilator blocked: {method} {path.rsplit('/', 1)[-1]}", I(method, path)[0] == 404)
check("invigilator blocked: edit other's exam", I("PUT", "/api/admin/exams/ADMINX", exam("ADMINX"))[0] == 404)
check("invigilator blocked: allow site on other's exam", I("POST", "/api/admin/exams/ADMINX/allow", {"site": "x.com"})[0] == 404)
s_, j = req("POST", "/api/join", {"exam_code": "ADMINX", "roll_no": "X1", "pin": "4821", "device_id": "dev-role-0001", "consent": True}, admin=False)
req("POST", "/api/ingest", {"current": {"kind": "tab", "domain": "chatgpt.com", "path": "/", "title": "c", "start_ts": time.time() - 5}}, tok=j["token"], admin=False)
fid = req("GET", "/api/admin/exams/ADMINX/live")[1]["flags"][0]["id"]
check("invigilator blocked: review other's flag", I("POST", f"/api/admin/flags/{fid}", {"status": "dismissed"})[0] == 404)
check("invigilator can run own exam", I("GET", "/api/admin/exams/INV1/live")[0] == 200)
owners = {x["code"]: x["created_by"] for x in req("GET", "/api/admin/exams")[1]}
check("admin sees every exam with its owner", owners.get("INV1") == "inv_t1" and owners.get("ADMINX") == USER)
check("admin raises the limit", req("PUT", "/api/admin/users/inv_t1", {"role": "invigilator", "exam_quota": 2})[0] == 200)
check("raised limit applies at once", I("POST", "/api/admin/exams", exam("INV2"))[0] == 200)
users = {u["username"]: u for u in req("GET", "/api/admin/users")[1]}
check("users list shows role, limit, exams", users["inv_t1"]["role"] == "invigilator" and users["inv_t1"]["exam_quota"] == 2 and users["inv_t1"]["exams_used"] == 2)
check("admin cannot demote self", req("PUT", f"/api/admin/users/{USER}", {"role": "invigilator", "exam_quota": 5})[0] == 400)
check("admin cannot remove self", req("DELETE", f"/api/admin/users/{USER}")[0] == 400)
check("promote to admin", req("PUT", "/api/admin/users/inv_t1", {"role": "admin"})[0] == 200)
check("promotion applies at once", "ADMINX" in [x["code"] for x in I("GET", "/api/admin/exams")[1]] and I("GET", "/api/admin/users")[0] == 200)
req("PUT", "/api/admin/users/inv_t1", {"role": "invigilator", "exam_quota": 2})
check("admin resets a password", req("PUT", "/api/admin/users/inv_t1", {"role": "invigilator", "exam_quota": 2, "password": "brand-new-pass-9"})[0] == 200)
check("reset signs the user out", I("GET", "/api/auth/me")[0] == 401)
check("new password works", I("POST", "/api/auth/login", {"username": "inv_t1", "password": "brand-new-pass-9"})[0] == 200)
check("remove user", req("DELETE", "/api/admin/users/inv_t1")[0] == 200)
check("removed user is signed out", I("GET", "/api/auth/me")[0] == 401)
check("removed user's exams stay for admins", "INV1" in [x["code"] for x in req("GET", "/api/admin/exams")[1]])
for code in ("ADMINX", "INV1", "INV2"):
    req("DELETE", f"/api/admin/exams/{code}")

check("logout", req("POST", "/api/auth/logout")[0] == 200)
check("after logout", req("GET", "/api/admin/exams")[0] == 401)
print(f"ALL {ok} CHECKS PASSED ({'postgres' if db.PG else 'sqlite'})")

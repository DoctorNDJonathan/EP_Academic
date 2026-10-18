"""Stage a realistic class test on a LOCAL demo server, for handbook screenshots.

Run from proctorv3/server with the demo server's environment (see build.sh).
Keeps reporting like real extensions until killed, so nobody shows as offline.
Names and roll numbers are made up.
"""
import json
import sys
import time
import urllib.request
import http.cookiejar

import app
import db

S, PW = sys.argv[1], sys.argv[2]
admin_op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
inv_op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
op = admin_op


def req(path, body=None, tok=None):
    h = {"Content-Type": "application/json", "X-Proctor": "1"}
    if tok:
        h["Authorization"] = "Bearer " + tok
    r = urllib.request.Request(S + path, json.dumps(body).encode() if body is not None else None, h)
    with op.open(r) as resp:
        return json.loads(resp.read())


req("/api/auth/login", {"username": "admin", "password": PW})
op = inv_op                       # the class test belongs to invigilator priya.s, as in real use
req("/api/auth/login", {"username": "priya.s", "password": PW})
now = time.time()
FORM = "docs.google.com/forms/d/e/1FAIpQLSc7BA101Quiz2"
names = ["Aarav Shah", "Diya Menon", "Kabir Rao", "Ananya Iyer", "Rohan Das", "Meher Kapoor", "Ishaan Nair", "Saanvi Reddy",
         "Vihaan Joshi", "Aditi Kulkarni", "Arjun Bose", "Kavya Pillai", "Reyansh Gupta", "Tara Fernandes", "Dev Malhotra",
         "Nisha Thomas", "Aryan Mehta", "Zoya Khan", "Kian D'Souza", "Riya Banerjee", "Neel Chopra", "Pooja Hegde",
         "Samar Sethi", "Ira Varghese", "Yash Agarwal", "Mira Sinha", "Om Prakash", "Leela George", "Karan Bhatt", "Sana Mirza"]
roster = [(f"25PGDM{i:03d}", n) for i, n in enumerate(names, 1)]
start = now - 10 * 60
req("/api/admin/exams", {"code": "BA101-A-QUIZ2", "name": "BA101 Section A: Quiz 2", "start_ts": start, "end_ts": start + 30 * 60,
    "pin": "730516", "allowed_sites": [FORM, "accounts.google.com", "desmos.com/calculator"], "grace_s": 3, "flag_outside": True,
    "roster": "\n".join(f"{r},{n}" for r, n in roster)})
req("/api/admin/exams", {"code": "BA101-A-QUIZ1", "name": "BA101 Section A: Quiz 1", "start_ts": now - 86400 * 7, "end_ts": now - 86400 * 7 + 1800,
    "pin": "556677", "allowed_sites": [FORM, "accounts.google.com"], "grace_s": 3, "flag_outside": True, "roster": ""})
op = admin_op                     # other colleagues' exams: hidden from priya.s
req("/api/admin/exams", {"code": "FIN204-B-MIDTERM", "name": "FIN204 Section B: Midterm", "start_ts": now + 86400 * 2, "end_ts": now + 86400 * 2 + 5400,
    "pin": "112233", "allowed_sites": ["lms.example.edu"], "grace_s": 3, "flag_outside": True, "roster": ""})
req("/api/admin/exams", {"code": "OPS110-QUIZ1", "name": "OPS110: Quiz 1", "start_ts": now - 86400 * 3, "end_ts": now - 86400 * 3 + 1800,
    "pin": "445566", "allowed_sites": ["forms.office.com"], "grace_s": 3, "flag_outside": True, "roster": ""})

form = ("tab", "docs.google.com", "/forms/d/e/1FAIpQLSc7BA101Quiz2/viewform", "BA101 Quiz 2 - Google Forms")
desmos = ("tab", "desmos.com", "/calculator", "Desmos | Graphing Calculator")
gdoc = ("tab", "docs.google.com", "/document/d/1xNotesBA101/edit", "BA101 notes - Google Docs")
chat = ("tab", "chatgpt.com", "/", "ChatGPT")
seg = lambda k, d, p, t, a, b: {"kind": k, "domain": d, "path": p, "title": t, "start_ts": a, "end_ts": b}
cur = lambda k, d, p, t, a: {"kind": k, "domain": d, "path": p, "title": t, "start_ts": a}
op = inv_op
state = {}
for i, (roll, _) in enumerate(roster[:27]):                # 3 students never join
    tok = req("/api/join", {"exam_code": "BA101-A-QUIZ2", "roll_no": roll, "pin": "730516", "device_id": f"demo-dev-{i:04d}", "consent": True})["token"]
    t0 = start + 15 + 3 * i
    ev = [seg(*form, t0, t0 + 240)]
    current, tabs = cur(*form, t0 + 240), [{"domain": "docs.google.com", "path": form[2]}]
    if i % 4 == 1:
        ev.append(seg(*desmos, t0 + 240, t0 + 300)); current = cur(*form, t0 + 300)
    if i == 3:
        current = cur(*gdoc, now - 35)                       # same site, wrong page: flagged
    if i == 7:
        ev.append(seg(*chat, t0 + 260, t0 + 290)); current = cur(*form, t0 + 290)   # earlier visit, now back
    if i == 11:
        current = cur(*chat, now - 20)                       # on ChatGPT right now
    if i == 15:
        current = cur("outside", "(outside-browser)", "", "", now - 50)             # in another app
    if i == 19:
        tabs.append({"domain": "youtube.com", "path": "/"})                         # background tab
    req("/api/ingest", {"events": ev, "current": current, "open_tabs": tabs}, tok=tok)
    state[roll] = (tok, current, tabs)
with db.conn() as c:                                          # one student lost Wi-Fi 3 minutes ago
    c.execute("UPDATE presence SET last_seen=? WHERE exam_code='BA101-A-QUIZ2' AND roll_no='25PGDM024'", (now - 185,))
app._mark_gaps()
print("staged", flush=True)
while True:
    time.sleep(15)
    for roll, (tok, current, tabs) in state.items():
        if roll != "25PGDM024":
            req("/api/ingest", {"current": current, "open_tabs": tabs}, tok=tok)

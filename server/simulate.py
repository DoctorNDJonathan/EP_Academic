"""Load test + demo: N simulated students taking an exam through the real API.

  python simulate.py --server http://localhost:8000 --exam DEMO --pin 4821 --students 200 --minutes 5

Each student joins, then every few seconds reports its current tab exactly
like the extension does. About 10% wander off to disallowed sites or other
apps, and a few go silent, so the live dashboard has something to show.
Uses only the standard library.
"""
import argparse
import json
import random
import threading
import time
import urllib.error
import urllib.request

ALLOWED = [("exam.example.edu", "/test/42", "Midterm - Question 3"), ("desmos.com", "/calculator", "Desmos")]
BAD = [("chatgpt.com", "/", "ChatGPT"), ("google.com", "/search", "normal distribution - Google Search"),
       ("web.whatsapp.com", "/", "WhatsApp"), ("youtube.com", "/watch", "Stats lecture")]
stats = {"ok": 0, "err": 0, "lat": []}
lock = threading.Lock()


def call(server, path, body, token=None):
    req = urllib.request.Request(server + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json",
                                          **({"Authorization": f"Bearer {token}"} if token else {})})
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            out = json.loads(r.read())
        with lock:
            stats["ok"] += 1; stats["lat"].append(time.perf_counter() - t0)
        return out
    except (urllib.error.URLError, TimeoutError) as e:
        with lock:
            stats["err"] += 1
        if isinstance(e, urllib.error.HTTPError):
            print("HTTP", e.code, e.read()[:200])
        return None


def student(i, a, stop_at):
    roll = f"R{i:03d}"
    r = call(a.server, "/api/join", {"exam_code": a.exam, "roll_no": roll, "pin": a.pin,
                                     "device_id": f"sim-device-{i:04d}", "consent": True})
    if not r:
        return
    token, rnd = r["token"], random.Random(i)
    cheater, dropout = rnd.random() < 0.10, rnd.random() < 0.03
    queue, cur = [], None
    while time.time() < stop_at:
        if dropout and time.time() > stop_at - a.minutes * 30:
            return                                   # goes silent half-way -> monitoring gap
        if cheater and rnd.random() < 0.25:
            if rnd.random() < 0.3:
                obs = ("outside", "(outside-browser)", "", "")
            else:
                obs = ("tab", *rnd.choice(BAD))
        else:
            obs = ("tab", *rnd.choice(ALLOWED))
        t = r["server_time"] if cur is None else time.time()
        if cur is None or cur["domain"] != obs[1] or cur["kind"] != obs[0]:
            if cur:
                queue.append({**cur, "end_ts": t})
            cur = {"kind": obs[0], "domain": obs[1], "path": obs[2], "title": obs[3], "start_ts": t}
        tabs = [{"domain": d, "path": p} for d, p, _ in ALLOWED] + ([{"domain": "chatgpt.com", "path": "/"}] if cheater else [])
        if call(a.server, "/api/ingest", {"events": queue, "current": cur, "open_tabs": tabs}, token):
            queue = []
        time.sleep(rnd.uniform(3, 9))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--server", default="http://localhost:8000")
    p.add_argument("--exam", required=True)
    p.add_argument("--pin", required=True)
    p.add_argument("--students", type=int, default=200)
    p.add_argument("--minutes", type=float, default=3)
    a = p.parse_args()
    stop_at = time.time() + a.minutes * 60
    threads = [threading.Thread(target=student, args=(i, a, stop_at), daemon=True) for i in range(1, a.students + 1)]
    for t in threads:
        t.start(); time.sleep(0.02)
    while any(t.is_alive() for t in threads):
        time.sleep(10)
        with lock:
            lat = sorted(stats["lat"][-2000:]) or [0]
            print(f"requests ok={stats['ok']} err={stats['err']}  p50={lat[len(lat)//2]*1000:.0f}ms "
                  f"p95={lat[int(len(lat)*.95)]*1000:.0f}ms  students alive={sum(t.is_alive() for t in threads)}")


if __name__ == "__main__":
    main()

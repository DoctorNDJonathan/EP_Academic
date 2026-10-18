"""Screenshots for the handbook: the real dashboard (local demo server) and the real extension popup (stubbed chrome API).

  python shoot.py <img dir> <demo admin password> <popup stub url> <dashboard url>
"""
import base64, json, subprocess, sys, tempfile, time, urllib.request
import websocket

IMG, PW, POPUP, DASH = sys.argv[1:5]
USER = sys.argv[5] if len(sys.argv) > 5 else "admin"
chrome = subprocess.Popen(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--disable-gpu",
    "--hide-scrollbars", "--remote-debugging-port=9335", f"--user-data-dir={tempfile.mkdtemp()}", "--no-first-run", "about:blank"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(50):
    try:
        targets = json.load(urllib.request.urlopen("http://127.0.0.1:9335/json/list")); break
    except Exception:
        time.sleep(0.2)
ws = websocket.create_connection(next(t for t in targets if t["type"] == "page")["webSocketDebuggerUrl"], suppress_origin=True)
n = 0


def cdp(method, **params):
    global n
    n += 1
    ws.send(json.dumps({"id": n, "method": method, "params": params}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == n:
            if "error" in m:
                raise RuntimeError(m["error"])
            return m.get("result", {})


def js(expr):
    return cdp("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True).get("result", {}).get("value")


def size(w, h): cdp("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=2, mobile=False)
def go(url, wait=1.5): cdp("Page.navigate", url=url); time.sleep(wait)


def shot(name, clip=None):
    p = {"format": "png", "captureBeyondViewport": bool(clip)}
    if clip:
        p["clip"] = {**clip, "scale": 1}
    open(f"{IMG}/{name}.png", "wb").write(base64.b64decode(cdp("Page.captureScreenshot", **p)["data"]))
    print("saved", name)


def box(sel, pad=12, extra_h=0, top_sel=None):
    r = js(f"(() => {{ const b = document.querySelector({json.dumps(sel)}).getBoundingClientRect(); return [b.x, b.y + scrollY, b.width, b.height]; }})()")
    clip = {"x": max(0, r[0] - pad), "y": max(0, r[1] - pad), "width": r[2] + 2 * pad, "height": r[3] + 2 * pad + extra_h}
    if top_sel:
        t = js(f"document.querySelector({json.dumps(top_sel)}).getBoundingClientRect().y + scrollY")
        clip["height"] += clip["y"] - (t - pad); clip["y"] = t - pad
    return clip


cdp("Page.enable"); cdp("Runtime.enable"); cdp("Emulation.setTimezoneOverride", timezoneId="Asia/Kolkata")

# Extension popup, five states
size(340, 640)
for mode in ["join", "waiting", "ok", "bad", "done"]:
    go("about:blank", 0.2); go(f"{POPUP}#{mode}", 1.2)
    if mode == "join":
        js("""(() => { const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); };
              set('code', 'BA101-A-QUIZ2'); set('roll', '25PGDM004'); set('pin', '730516');
              const c = document.getElementById('consent'); c.checked = true; c.dispatchEvent(new Event('change')); })()""")
        time.sleep(0.3)
    shot(f"popup-{mode}", {"x": 0, "y": 0, "width": 340, "height": js("document.body.scrollHeight")})

# Dashboard
size(1280, 800)
go(f"{DASH}/dashboard", 1.5)
shot("dash-login", {"x": 390, "y": 180, "width": 500, "height": 440})
js(f"fetch('/api/auth/login', {{method:'POST', headers:{{'Content-Type':'application/json','X-Proctor':'1'}}, body: JSON.stringify({{username:{json.dumps(USER)}, password:{json.dumps(PW)}}})}}).then(r => r.status)")
cdp("Page.reload"); time.sleep(2)
go(f"{DASH}/dashboard#/exams", 2); shot("dash-exams", {"x": 0, "y": 0, "width": 1280, "height": 420})
go(f"{DASH}/dashboard#/exams/new", 1.5)
js("""(() => { const f = document.getElementById('examForm'); const set = (n, v) => { const e = f.querySelector(`[name=${n}]`); e.value = v; e.dispatchEvent(new Event('input')); };
      set('name', 'BA101 Section A: Quiz 2'); set('code', 'BA101-A-QUIZ2'); set('pin', '730516'); })()""")
time.sleep(0.4)
shot("dash-new-exam", box("#examForm", 12) | {"height": box("[name=sites]", 0)["y"] - box("#examForm", 12)["y"] - 30})
go(f"{DASH}/dashboard#/exams/BA101-A-QUIZ2/edit", 2.5)
js("document.querySelector('[name=sites]').scrollIntoView({block:'center'})"); time.sleep(0.5)
shot("dash-allowed-sites", box(".site-check", 16, top_sel="label:has([name=sites])"))
js("""(() => { const t = document.getElementById('testUrl'); t.value = 'https://docs.google.com/document/d/1xNotesBA101/edit'; t.dispatchEvent(new Event('input')); })()""")
time.sleep(1.2)
c = box(".site-check", 16); t = js("document.querySelector('.test-link').getBoundingClientRect().y + scrollY")
shot("dash-test-link", {"x": c["x"], "y": t - 16, "width": c["width"], "height": c["y"] + c["height"] - (t - 16)})
js("document.querySelector('[name=roster]').scrollIntoView({block:'center'})"); time.sleep(0.4)
shot("dash-roster", box("label:has([name=roster])", 16, extra_h=60))
go(f"{DASH}/dashboard#/exams/BA101-A-QUIZ2/live", 4); js("scrollTo(0, 0)"); time.sleep(0.3); shot("dash-live")
js("document.querySelector('[data-roll=\"25PGDM004\"]').click()"); time.sleep(2); shot("dash-drawer")
js("document.querySelector('[data-action=close-drawer]').click()"); time.sleep(0.3)
js("document.querySelector('[data-filter=not_joined]').click()"); time.sleep(0.5); shot("dash-filter", {"x": 0, "y": 0, "width": 1280, "height": 470})
go(f"{DASH}/dashboard#/account", 2); shot("dash-account", {"x": 0, "y": 0, "width": 1280, "height": 430})
ws.close(); chrome.terminate()

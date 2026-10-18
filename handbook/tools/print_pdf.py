"""Print handbook HTML files to A4 PDFs with a footer (title + page numbers).

  python print_pdf.py <src dir> <out dir> name1:"Footer title 1" name2:"Footer title 2" ...
"""
import base64, json, subprocess, sys, tempfile, time, urllib.request
import websocket

SRC, OUT, docs = sys.argv[1], sys.argv[2], [a.split(":", 1) for a in sys.argv[3:]]
chrome = subprocess.Popen(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--disable-gpu",
    "--remote-debugging-port=9336", f"--user-data-dir={tempfile.mkdtemp()}", "--no-first-run", "about:blank"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(50):
    try:
        targets = json.load(urllib.request.urlopen("http://127.0.0.1:9336/json/list")); break
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


cdp("Page.enable")
footer = ('<div style="font:8px -apple-system,Helvetica,Arial;color:#5c6878;width:100%;padding:0 16mm;display:flex;'
          'justify-content:space-between"><span>{t}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>')
for name, title in docs:
    cdp("Page.navigate", url=f"file://{SRC}/{name}.html"); time.sleep(1.5)
    pdf = cdp("Page.printToPDF", printBackground=True, preferCSSPageSize=True, displayHeaderFooter=True,
              headerTemplate="<span></span>", footerTemplate=footer.format(t=title))["data"]
    open(f"{OUT}/{name}.pdf", "wb").write(base64.b64decode(pdf))
    print("printed", name)
ws.close(); chrome.terminate()

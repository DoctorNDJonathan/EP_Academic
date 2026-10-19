// Exam Proctor: background service worker (Manifest V3).
//
// Only between the joined exam's start and end time, it reports:
//   - the site (host + path, no query string) and title of the active tab
//   - when the browser loses focus to another app ("(outside-browser)")
//   - when there is no keyboard/mouse input ("idle") or the screen is locked
//   - which other open tabs are on sites the exam does not allow
// It never records keystrokes, page content, screenshots, camera or microphone.
//
// If the exam has "block sites" on, it also stops Chrome opening any website that is not
// allowed, only during the exam window (declarativeNetRequest rules), shows its own
// "blocked" page instead, and reports each attempt.
//
// Every change is sent at once so invigilators see it live; a 30 s alarm acts
// as heartbeat. If the network drops, segments queue in chrome.storage and are
// sent on reconnect. All state lives in storage because Chrome can stop the
// service worker at any moment; every change goes through one serial queue.

import { SERVER, IDLE_AFTER_S } from "./config.js";

const TICK = "tick";
const OUTSIDE = "(outside-browser)";
const LOCKED = "(locked)";
const NEW_TAB = "new-tab";
const INTERNAL = new Set(["browser-internal", "local-file"]);
const BLOCKED_PAGE = "blocked-page"; // this extension's own "site blocked" page: always allowed
// Sign-in providers briefly pass through these pages while logging in; when the provider's sign-in
// page is allowed, these are let through too so blocking never breaks a login.
const SIGNIN_HOPS = {
  "accounts.google.com": ["accounts.youtube.com"],
  "login.microsoftonline.com": ["login.live.com", "login.microsoft.com"],
};
const SILENCE_S = 90; // no tick for this long = the extension was not running (browser closed, disabled, asleep)

// ---------- state helpers ----------
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn).catch((e) => console.warn("proctor:", e)));

const getState = async () => (await chrome.storage.local.get("state")).state || null;
const setState = (s) => chrome.storage.local.set({ state: s });
const nowServer = (s) => Date.now() / 1000 + (s?.offset || 0); // aligned to server clock

function parseUrl(url) {
  if (!url) return { domain: NEW_TAB, path: "" };
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:")
      return { domain: u.hostname.replace(/^www\./, "").toLowerCase(), path: u.pathname.slice(0, 300) };
    if (/^chrome(-search)?:$/.test(u.protocol) && /^(newtab|new-tab-page|local-ntp)$/.test(u.hostname))
      return { domain: NEW_TAB, path: "" };
    if (u.protocol === "file:") return { domain: "local-file", path: "" };
    if (u.protocol === "chrome-extension:" && u.hostname === chrome.runtime.id && u.pathname === "/blocked.html")
      return { domain: BLOCKED_PAGE, path: "" };
    return { domain: "browser-internal", path: `${u.protocol}//${u.hostname}`.slice(0, 100) };
  } catch {
    return { domain: "browser-internal", path: "" };
  }
}

// Mirror of server/rules.py (the server stays the authority).
function isAllowed(domain, path, entries) {
  if (domain === NEW_TAB || domain === BLOCKED_PAGE) return true;
  const p = (path || "").replace(/^\/+|\/+$/g, "");
  return (entries || []).some((e) => {
    const i = e.indexOf("/");
    const host = i < 0 ? e : e.slice(0, i);
    const prefix = i < 0 ? "" : e.slice(i + 1);
    return (domain === host || domain.endsWith("." + host)) && (!prefix || p === prefix || p.startsWith(prefix + "/"));
  });
}

function violates(cur, s) {
  if (!cur) return false;
  if (cur.kind === "outside" || cur.domain === LOCKED) return !!s.flag_outside;
  return !isAllowed(cur.domain, cur.path, s.allowed_sites);
}

const running = (s, t = nowServer(s)) => s && !s.finished && t >= s.start_ts && t <= s.end_ts;

// ---------- blocking (exams with "block sites" on) ----------
const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Rules for chrome.declarativeNetRequest: block every web page opened in a tab (priority 1), except
// the allowed sites (priority 2). Only top-level pages are affected, so allowed pages load normally.
function blockRules(entries) {
  const rules = [{ id: 1, priority: 1, action: { type: "block" },
                   condition: { regexFilter: "^https?://", resourceTypes: ["main_frame"] } }];
  let id = 2;
  const hosts = new Set();
  for (const e of entries || []) {
    const i = e.indexOf("/");
    const host = i < 0 ? e : e.slice(0, i), prefix = i < 0 ? "" : e.slice(i + 1);
    if (!prefix) hosts.add(host);
    else rules.push({ id: id++, priority: 2, action: { type: "allow" }, condition: {
      regexFilter: `^https?://([^/?#]*\\.)?${reEsc(host)}(:[0-9]+)?/${reEsc(prefix)}([/?#].*)?$`,
      isUrlFilterCaseSensitive: true, resourceTypes: ["main_frame"] } });
    for (const h of SIGNIN_HOPS[host] || []) hosts.add(h);
    if (host === "accounts.google.com")   // Google sign-in also hops through its country domains
      rules.push({ id: id++, priority: 2, action: { type: "allow" }, condition: {
        regexFilter: "^https://accounts\\.google\\.(com?\\.)?[a-z]{2,3}(:[0-9]+)?/", resourceTypes: ["main_frame"] } });
  }
  if (hosts.size) rules.push({ id: id++, priority: 2, action: { type: "allow" },
                               condition: { requestDomains: [...hosts], resourceTypes: ["main_frame"] } });
  return rules;
}

// Make Chrome's rules match the exam: on during a running exam with blocking, otherwise none.
// Rules survive browser restarts, so this also runs at start-up to clear rules from a finished exam.
async function syncBlocking() {
  const s = await getState();
  const want = s && s.block_sites && running(s) ? blockRules(s.allowed_sites) : [];
  const have = await chrome.declarativeNetRequest.getDynamicRules();
  if (JSON.stringify(have.map(({ id, priority, action, condition }) => ({ id, priority, action, condition }))) === JSON.stringify(want)) return;
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: have.map((r) => r.id), addRules: want });
}

// Chrome reports a blocked page as a navigation error. Show our page instead, and report the attempt.
async function onBlocked(tabId, url) {
  const s = await getState();
  if (!s || !s.block_sites || !running(s)) return;
  const { domain, path } = parseUrl(url);
  if (isAllowed(domain, path, s.allowed_sites)) return;     // blocked by something else, not by us
  s.blocked = [...(s.blocked || []), { domain, path, ts: nowServer(s) }].slice(-200);
  await setState(s);
  chrome.tabs.update(tabId, { url: chrome.runtime.getURL(`blocked.html#${encodeURIComponent(domain)}`) }).catch(() => {});
  chrome.notifications.create(`blocked-${Date.now()}`, {
    type: "basic", iconUrl: "icons/icon128.png", priority: 2, title: "Site blocked during this exam",
    message: `${domain} is not on the allowed list for ${s.name}. The attempt is reported to the invigilator.`,
  });
  await push();
}

// ---------- observe current activity ----------
async function observe() {
  const idle = await chrome.idle.queryState(IDLE_AFTER_S);
  if (idle === "locked") return { kind: "idle", domain: LOCKED, path: "", title: "" };

  const win = await chrome.windows.getLastFocused().catch(() => null);
  if (!win || !win.focused) return { kind: "outside", domain: OUTSIDE, path: "", title: "" };

  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  if (!tab) return { kind: "outside", domain: OUTSIDE, path: "", title: "" };

  return { kind: idle === "idle" ? "idle" : "tab", ...parseUrl(tab.url || tab.pendingUrl), title: (tab.title || "").slice(0, 200) };
}

async function openTabs() {
  const tabs = await chrome.tabs.query({});
  const seen = new Set();
  const out = [];
  for (const t of tabs) {
    const { domain, path } = parseUrl(t.url || t.pendingUrl);
    const key = domain + path;
    if (domain === NEW_TAB || seen.has(key)) continue;
    seen.add(key);
    out.push({ domain, path });
    if (out.length >= 150) break;
  }
  return out;
}

// Close the open segment if activity changed; open a new one inside the exam window.
// Returns true when the student moved somewhere else.
async function refresh() {
  const s = await getState();
  if (!s || s.finished) return false;
  const t = nowServer(s);
  const obs = running(s, t) ? await observe() : null;
  // After a silence, end the open visit at the last heartbeat: never stretch it over time nobody monitored.
  if (s.current && s.lastBeat && t - s.lastBeat > SILENCE_S) {
    if (s.lastBeat - s.current.start_ts >= 1) s.queue.push({ ...s.current, end_ts: Math.min(s.lastBeat, s.end_ts) });
    s.current = null;
    s.lastBeat = t; // monitoring resumes now
  }
  const cur = s.current;
  const changed = !obs || !cur || cur.kind !== obs.kind || cur.domain !== obs.domain || cur.path !== obs.path;

  if (cur && changed) {
    const end = Math.min(t, s.end_ts);
    if (end - cur.start_ts >= 1) s.queue.push({ ...cur, end_ts: end });
    s.current = null;
  } else if (cur && obs && cur.title !== obs.title) {
    cur.title = obs.title; // same page, new title: no new segment
  }
  if (obs && !s.current) s.current = { ...obs, start_ts: t };
  if (t > s.end_ts) s.finished = true;
  if (s.queue.length > 5000) s.queue = s.queue.slice(-5000);
  await setState(s);
  return changed && !!obs;
}

// ---------- talk to the server ----------
async function call(method, path, body, token) {
  const r = await fetch(`${SERVER}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.detail || `Server error ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

async function push() {
  const s = await getState();
  if (!s || !s.token) return;
  if (s.finished && s.queue.length === 0) return;
  const events = s.queue.slice(0, 300);
  const heartbeats = (s.heartbeats || []).slice(0, 600);
  const blocked = (s.blocked || []).slice(0, 200);
  try {
    const r = await call("POST", "/api/ingest", {
      events,
      heartbeats,
      blocked,
      current: running(s) ? s.current : null,
      open_tabs: running(s) ? await openTabs() : [],
    }, s.token);
    const latest = await getState(); // queue may have grown while uploading
    latest.queue = latest.queue.slice(events.length);
    latest.heartbeats = (latest.heartbeats || []).slice(heartbeats.length);
    latest.blocked = (latest.blocked || []).slice(blocked.length);
    latest.offset = r.server_time - Date.now() / 1000;
    // Invigilators can change the allowlist or extend the exam while it runs.
    Object.assign(latest, { allowed_sites: r.allowed_sites, grace_s: r.grace_s, flag_outside: r.flag_outside,
                            block_sites: !!r.block_sites, start_ts: r.start_ts, end_ts: r.end_ts, name: r.name });
    if (latest.finished && nowServer(latest) <= latest.end_ts) latest.finished = false;
    latest.lastUpload = Date.now();
    latest.lastError = null;
    await setState(latest);
  } catch (e) {
    const latest = await getState();
    if (!latest) return;
    latest.lastError = e.status === 401 ? "Session expired. Join the exam again."
      : e.status === 409 ? null : "Offline. Activity is saved and will be sent when you reconnect.";
    if (e.status === 409) { latest.queue = []; latest.heartbeats = []; latest.blocked = []; latest.finished = true; }
    await setState(latest);
  }
}

// ---------- student-facing feedback ----------
async function feedback() {
  const s = await getState();
  if (!running(s)) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  const bad = violates(s.current, s);
  await chrome.action.setBadgeBackgroundColor({ color: bad ? "#c62828" : "#2e7d32" });
  await chrome.action.setBadgeText({ text: bad ? "!" : "ON" });
  if (bad && s.warnedFor !== s.current.start_ts) {
    s.warnedFor = s.current.start_ts;
    await setState(s);
    const outside = s.current.kind === "outside" || s.current.domain === LOCKED;
    chrome.notifications.create(`warn-${Date.now()}`, {
      type: "basic", iconUrl: "icons/icon128.png", priority: 2,
      title: outside ? "You left the exam browser" : "This site is not allowed in this exam",
      message: outside
        ? `Return to your exam. Time in other apps is reported to the invigilator.`
        : `${s.current.domain} is not on the allowed list for ${s.name}. Go back now: this visit is reported.`,
    });
    // Re-report once the grace period has passed so the flag appears promptly.
    setTimeout(() => serial(async () => { await refresh(); await push(); }), ((s.grace_s || 0) + 1) * 1000);
  }
}

async function onActivity() {
  const moved = await refresh();
  if (moved) await push();
  await syncBlocking();
  await feedback();
}

// Every 30 s tick while the exam runs. Kept through network drops and sent later, these prove the
// extension was running during a gap (a disabled extension or a closed browser records none).
async function recordHeartbeat() {
  const s = await getState();
  if (!running(s)) return;
  const t = nowServer(s);
  s.heartbeats = [...(s.heartbeats || []), t].slice(-2000);
  s.lastBeat = t;
  await setState(s);
}

async function tick() {
  await refresh();          // first: it checks the silence since the previous heartbeat
  await recordHeartbeat();
  await push();
  await syncBlocking();     // switches blocking on at the start and off at the end
  await feedback();
  const s = await getState();
  if (!s) return;
  const t = Date.now() / 1000;
  if ((s.finished && s.queue.length === 0) || t > s.end_ts + 900) {
    await chrome.alarms.clear(TICK);
    chrome.runtime.setUninstallURL("");
    await chrome.action.setBadgeText({ text: "" });
  }
}

// ---------- joining ----------
async function deviceId() {
  const { device_id } = await chrome.storage.local.get("device_id");
  if (device_id) return device_id;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ device_id: id });
  return id;
}

async function join(examCode, rollNo, pin) {
  if (SERVER.includes("PLACEHOLDER"))
    throw new Error("This copy of the extension has no server address. Load the dist/extension folder made by build_extension.py instead.");
  const existing = await getState();
  if (existing && !existing.finished && existing.exam_code !== examCode.trim().toUpperCase())
    throw new Error("You have already joined another exam. It must finish first.");
  const r = await call("POST", "/api/join", {
    exam_code: examCode, roll_no: rollNo, pin, device_id: await deviceId(), consent: true,
  });
  await setState({
    exam_code: r.code, name: r.name, roll_no: r.roll_no, student_name: r.student_name,
    token: r.token, start_ts: r.start_ts, end_ts: r.end_ts,
    allowed_sites: r.allowed_sites, grace_s: r.grace_s, flag_outside: r.flag_outside, block_sites: !!r.block_sites,
    offset: r.server_time - Date.now() / 1000,
    current: null, queue: [], heartbeats: [], blocked: [], lastBeat: null, finished: false, joinedAt: Date.now(),
  });
  chrome.runtime.setUninstallURL(`${SERVER}/bye?k=${encodeURIComponent(r.uninstall_key)}`);
  chrome.idle.setDetectionInterval(IDLE_AFTER_S);
  await chrome.alarms.create(TICK, { periodInMinutes: 0.5 }); // every 30 s
  await refresh();
  await recordHeartbeat();
  await push();
  await syncBlocking();
  await feedback();
  return r;
}

async function ensureAlarm() {
  chrome.idle.setDetectionInterval(IDLE_AFTER_S);
  await syncBlocking();     // e.g. clear rules left from an exam that ended while Chrome was closed
  const s = await getState();
  if (s && Date.now() / 1000 < s.end_ts + 900 && !(await chrome.alarms.get(TICK)))
    await chrome.alarms.create(TICK, { periodInMinutes: 0.5 });
}

// ---------- event wiring (top level, so Chrome can wake the worker) ----------
chrome.tabs.onActivated.addListener(() => serial(onActivity));
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (tab.active && (info.url || info.title || info.status === "complete")) serial(onActivity);
});
chrome.tabs.onCreated.addListener(() => serial(onActivity));
chrome.windows.onFocusChanged.addListener(() => serial(onActivity));
chrome.idle.onStateChanged.addListener(() => serial(onActivity));
chrome.alarms.onAlarm.addListener((a) => a.name === TICK && serial(tick));
chrome.webNavigation.onErrorOccurred.addListener((d) => {
  if (d.frameId === 0 && d.error === "net::ERR_BLOCKED_BY_CLIENT") serial(() => onBlocked(d.tabId, d.url));
});
chrome.runtime.onStartup.addListener(() => serial(ensureAlarm));
chrome.runtime.onInstalled.addListener(() => serial(ensureAlarm));

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "join") {
    const run = chain.then(() => join(msg.examCode, msg.rollNo, msg.pin));
    chain = run.catch(() => {});
    run.then(
      async () => reply({ ok: true, state: await getState() }),
      (e) => reply({ ok: false, error: e instanceof TypeError ? `Cannot reach the exam server (${new URL(SERVER).host}). Check your network.` : e.message })
    );
    return true;
  }
  if (msg.type === "status") {
    getState().then((state) => reply({
      ok: true, state, now: Date.now() / 1000,
      allowedNow: state ? !violates(state.current, state) : true,
    }));
    return true;
  }
  if (msg.type === "reset") {
    getState().then(async (s) => {
      const longOver = s && Date.now() / 1000 > s.end_ts + 900;
      if (s && !longOver && !(s.finished && s.queue.length === 0))
        return reply({ ok: false, error: "The exam is still running or data is still uploading." });
      await chrome.storage.local.remove("state");
      await syncBlocking();
      chrome.runtime.setUninstallURL("");
      reply({ ok: true });
    });
    return true;
  }
});

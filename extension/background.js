// Exam Proctor: background service worker (Manifest V3).
//
// Only between the joined exam's start and end time, it reports:
//   - the site (host + path, no query string) and title of the active tab
//   - when the browser loses focus to another app ("(outside-browser)")
//   - when there is no keyboard/mouse input ("idle") or the screen is locked
//   - which other open tabs are on sites the exam does not allow
// It never records keystrokes, page content, screenshots, camera or microphone.
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
    return { domain: "browser-internal", path: `${u.protocol}//${u.hostname}`.slice(0, 100) };
  } catch {
    return { domain: "browser-internal", path: "" };
  }
}

// Mirror of server/rules.py (the server stays the authority).
function isAllowed(domain, path, entries) {
  if (domain === NEW_TAB) return true;
  const p = (path || "").replace(/^\/+/, "");
  return (entries || []).some((e) => {
    const i = e.indexOf("/");
    const host = i < 0 ? e : e.slice(0, i);
    const prefix = i < 0 ? "" : e.slice(i + 1);
    return (domain === host || domain.endsWith("." + host)) && (!prefix || p.startsWith(prefix));
  });
}

function violates(cur, s) {
  if (!cur) return false;
  if (cur.kind === "outside" || cur.domain === LOCKED) return !!s.flag_outside;
  return !isAllowed(cur.domain, cur.path, s.allowed_sites);
}

const running = (s, t = nowServer(s)) => s && !s.finished && t >= s.start_ts && t <= s.end_ts;

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
  try {
    const r = await call("POST", "/api/ingest", {
      events,
      current: running(s) ? s.current : null,
      open_tabs: running(s) ? await openTabs() : [],
    }, s.token);
    const latest = await getState(); // queue may have grown while uploading
    latest.queue = latest.queue.slice(events.length);
    latest.offset = r.server_time - Date.now() / 1000;
    // Invigilators can change the allowlist or extend the exam while it runs.
    Object.assign(latest, { allowed_sites: r.allowed_sites, grace_s: r.grace_s, flag_outside: r.flag_outside,
                            start_ts: r.start_ts, end_ts: r.end_ts, name: r.name });
    if (latest.finished && nowServer(latest) <= latest.end_ts) latest.finished = false;
    latest.lastUpload = Date.now();
    latest.lastError = null;
    await setState(latest);
  } catch (e) {
    const latest = await getState();
    if (!latest) return;
    latest.lastError = e.status === 401 ? "Session expired. Join the exam again."
      : e.status === 409 ? null : "Offline. Activity is saved and will be sent when you reconnect.";
    if (e.status === 409) { latest.queue = []; latest.finished = true; }
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
  await feedback();
}

async function tick() {
  await refresh();
  await push();
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
    allowed_sites: r.allowed_sites, grace_s: r.grace_s, flag_outside: r.flag_outside,
    offset: r.server_time - Date.now() / 1000,
    current: null, queue: [], finished: false, joinedAt: Date.now(),
  });
  chrome.runtime.setUninstallURL(`${SERVER}/bye?k=${encodeURIComponent(r.uninstall_key)}`);
  chrome.idle.setDetectionInterval(IDLE_AFTER_S);
  await chrome.alarms.create(TICK, { periodInMinutes: 0.5 }); // every 30 s
  await refresh();
  await push();
  await feedback();
  return r;
}

async function ensureAlarm() {
  chrome.idle.setDetectionInterval(IDLE_AFTER_S);
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
      chrome.runtime.setUninstallURL("");
      reply({ ok: true });
    });
    return true;
  }
});

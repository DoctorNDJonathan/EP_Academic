// Extension logic test: drives the real extension/background.js with a fake Chrome, clock and server.
//   node tests/extension_test.mjs        (from the proctorv3 folder; needs Node 18+)
// Checks heartbeats through a network drop, that a silence (extension off, browser closed) is never
// covered by stretching the previous visit, and site blocking: which pages Chrome's rules let through,
// when the rules are on, the "blocked" page and the reported attempts.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "proctor-ext-"));
writeFileSync(join(dir, "bg.mjs"), readFileSync(join(here, "../extension/background.js"), "utf8").replace('from "./config.js"', 'from "./config.mjs"'));
writeFileSync(join(dir, "config.mjs"), 'export const SERVER = "https://example.test";\nexport const IDLE_AFTER_S = 60;\n');

// ---- fake Chrome, clock and server
let now = Date.parse("2026-10-01T10:00:00Z"); Date.now = () => now;
const store = {}, listeners = {}; const on = (k) => ({ addListener: (f) => (listeners[k] = f) });
let online = true, tab = { url: "https://exam.example.edu/q1", title: "Q1" }; const posts = [], tabUpdates = [];
let dynamicRules = [];
globalThis.chrome = {
  storage: { local: { get: async (k) => (typeof k === "string" ? { [k]: store[k] } : {}), set: async (o) => Object.assign(store, structuredClone(o)), remove: async (k) => delete store[k] } },
  idle: { queryState: async () => "active", setDetectionInterval() {}, onStateChanged: on("idle") },
  windows: { getLastFocused: async () => ({ id: 1, focused: true }), onFocusChanged: on("focus") },
  tabs: { query: async () => [{ ...tab, active: true }], onActivated: on("act"), onUpdated: on("upd"), onCreated: on("cre"),
          update: async (id, p) => { tabUpdates.push({ id, ...p }); tab = { url: p.url, title: "Site blocked" }; } },
  alarms: { create: async () => {}, get: async () => true, clear: async () => {}, onAlarm: on("alarm") },
  runtime: { id: "extid", getURL: (p) => `chrome-extension://extid/${p}`, onStartup: on("start"), onInstalled: on("inst"), onMessage: on("msg"), setUninstallURL() {} },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  notifications: { create() {} },
  declarativeNetRequest: {
    getDynamicRules: async () => structuredClone(dynamicRules),
    updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }) => {
      dynamicRules = dynamicRules.filter((r) => !removeRuleIds.includes(r.id)).concat(structuredClone(addRules));
    },
  },
  webNavigation: { onErrorOccurred: on("navErr") },
};
let cfg = { code: "E1", name: "E", start_ts: now / 1000 - 60, end_ts: now / 1000 + 7200, allowed_sites: ["exam.example.edu"], grace_s: 3, flag_outside: true, block_sites: false };
globalThis.fetch = async (url, init) => {
  if (!online) throw new TypeError("Failed to fetch");
  const body = JSON.parse(init.body); posts.push({ url, body, at: now / 1000 });
  const base = { ...cfg, server_time: now / 1000 };
  const r = url.endsWith("/api/join") ? { ...base, roll_no: "R1", student_name: "", token: "tok", uninstall_key: "k" } : { ...base, stored: 0, allowed_now: true };
  return { ok: true, status: 200, json: async () => r };
};

// What Chrome would do with a top-level page, given the extension's rules (highest priority wins).
function chromeDecides(url) {
  const host = new URL(url).hostname;
  const hits = dynamicRules.filter(({ condition: c }) => (c.resourceTypes || []).includes("main_frame")
    && (!c.regexFilter || new RegExp(c.regexFilter, c.isUrlFilterCaseSensitive ? "" : "i").test(url))
    && (!c.requestDomains || c.requestDomains.some((d) => host === d || host.endsWith("." + d))));
  if (!hits.length) return "load";
  const top = hits.sort((a, b) => b.priority - a.priority)[0];
  return top.action.type === "block" ? "BLOCK" : "load";
}

await import(join(dir, "bg.mjs"));
const settle = () => new Promise((r) => setTimeout(r, 30));
const ask = (msg) => new Promise((res) => listeners.msg(msg, {}, res));
const tick = async () => { listeners.alarm({ name: "tick" }); await settle(); };
const adv = (s) => (now += s * 1000);
let pass = 0; const check = (n, c) => { if (!c) { console.log("FAIL", n); process.exit(1); } pass++; };
const t0 = now / 1000;

// ---------------------------------------------------------------- heartbeats and silences
check("join", (await ask({ type: "join", examCode: "E1", rollNo: "R1", pin: "1" })).ok);
for (let i = 0; i < 4; i++) { adv(30); await tick(); }                       // 2 min online
check("heartbeats sent online", posts.at(-1).body.heartbeats.length >= 1 && store.state.heartbeats.length === 0);
check("no blocking rules when the exam has blocking off", dynamicRules.length === 0);

// A) Network drop for 3 min: ticks continue offline, heartbeats queue, then are sent on reconnect
online = false; for (let i = 0; i < 6; i++) { adv(30); await tick(); }
check("offline heartbeats queued", store.state.heartbeats.length === 6);
online = true; adv(30); await tick();
const sent = posts.at(-1).body.heartbeats; const gaps = sent.slice(1).map((h, i) => h - sent[i]);
check("queued heartbeats delivered, 30 s apart", sent.length === 7 && Math.max(...gaps) <= 31 && store.state.heartbeats.length === 0);
check("visit not split by a network drop", store.state.current.start_ts === t0);

// B) Extension/browser off for 5 min (no ticks), back on the same tab: visit must be cut at the last heartbeat
const lastBeat = store.state.lastBeat; adv(300); await tick();
const cut = posts.at(-1).body.events.at(-1);
check("visit ended at last heartbeat", cut && cut.end_ts === lastBeat && cut.start_ts === t0);
check("new visit starts after the silence", store.state.current.start_ts === now / 1000);
check("no heartbeats invented for the silence", posts.at(-1).body.heartbeats.every((h) => h > lastBeat + 290));

// ---------------------------------------------------------------- C) an exam with blocking on
delete store.state;
cfg = { code: "E2", name: "Quiz", start_ts: now / 1000 + 120, end_ts: now / 1000 + 1920, grace_s: 3, flag_outside: true, block_sites: true,
        allowed_sites: ["accounts.google.com", "desmos.com/calculator", "docs.google.com/forms/d/e/ABC"] };
tab = { url: "https://docs.google.com/forms/d/e/ABC/viewform", title: "Quiz" };
check("join exam with blocking", (await ask({ type: "join", examCode: "E2", rollNo: "R1", pin: "1" })).ok);
check("nothing blocked before the start", dynamicRules.length === 0);
adv(150); await tick();
check("blocking switched on at the start", dynamicRules.length > 1);
check("every rule pattern is valid", dynamicRules.every((r) => !r.condition.regexFilter || new RegExp(r.condition.regexFilter)));
const expect = {
  load: ["https://docs.google.com/forms/d/e/ABC/viewform?usp=sf_link", "https://docs.google.com/forms/d/e/ABC/formResponse",
         "https://accounts.google.com/v3/signin/identifier", "https://accounts.youtube.com/accounts/SetSID", "https://accounts.google.co.in/accounts/SetSID", "https://accounts.google.com.au/x", "https://accounts.google.de/x",
         "https://www.desmos.com/calculator", "https://www.desmos.com/calculator/abc123"],
  BLOCK: ["https://docs.google.com/forms/d/e/OTHER/viewform", "https://docs.google.com/document/d/1x/edit", "https://www.desmos.com/scientific",
          "https://www.desmos.com/calculators", "https://chatgpt.com/", "http://example.com/", "https://www.google.com/search?q=answer",
          "https://evil.com/docs.google.com/forms/d/e/ABC", "https://docs.google.com.evil.com/forms/d/e/ABC/viewform",
          "https://accounts.google.com.evil.com/", "https://accounts.google.evil.com/", "https://accounts.google.co.in.evil.com/", "https://docs.google.com/forms/d/e/abc/viewform"],
};
for (const [want, urls] of Object.entries(expect))
  for (const u of urls) check(`${want === "load" ? "opens" : "blocked"}: ${u}`, chromeDecides(u) === want);

// A blocked attempt: Chrome reports a navigation error; the student lands on our page; the attempt is reported
listeners.navErr({ frameId: 0, tabId: 7, error: "net::ERR_BLOCKED_BY_CLIENT", url: "https://chatgpt.com/c/123" }); await settle();
check("student sent to the blocked page", tabUpdates.at(-1)?.url === "chrome-extension://extid/blocked.html#chatgpt.com");
check("attempt reported to the server", posts.at(-1).body.blocked.some((b) => b.domain === "chatgpt.com" && b.path === "/c/123"));
check("reported attempts cleared after sending", (store.state.blocked || []).length === 0);
listeners.navErr({ frameId: 0, tabId: 7, error: "net::ERR_BLOCKED_BY_CLIENT", url: "https://www.desmos.com/calculator" }); await settle();
check("pages blocked by something else are not reported", !posts.at(-1).body.blocked?.some((b) => b.domain === "desmos.com"));
listeners.navErr({ frameId: 3, tabId: 7, error: "net::ERR_BLOCKED_BY_CLIENT", url: "https://ads.example/" }); await settle();
check("blocked frames inside pages are ignored", !posts.some((p) => p.body.blocked?.some((b) => b.domain === "ads.example")));
listeners.upd(7, { url: tab.url }, { ...tab, active: true }); await settle();
check("the blocked page is not a violation", store.state.current.domain === "blocked-page" && posts.at(-1).body.current.domain === "blocked-page");

// The invigilator allows a site mid-exam: rules follow on the next report
cfg = { ...cfg, allowed_sites: [...cfg.allowed_sites, "chatgpt.com"] };
adv(30); await tick();
check("site allowed mid-exam now opens", chromeDecides("https://chatgpt.com/") === "load");

// The end of the exam, and a browser restart with rules left behind
adv(1800); await tick();
check("blocking switched off at the end", dynamicRules.length === 0);
dynamicRules = [{ id: 1, priority: 1, action: { type: "block" }, condition: { regexFilter: "^https?://", resourceTypes: ["main_frame"] } }];
listeners.start(); await settle();
check("rules left from an ended exam are cleared at start-up", dynamicRules.length === 0);
console.log(`ALL ${pass} EXTENSION CHECKS PASSED`);

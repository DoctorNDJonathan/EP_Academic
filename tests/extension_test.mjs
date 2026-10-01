// Extension logic test: drives the real extension/background.js with a fake Chrome, clock and server.
//   node tests/extension_test.mjs        (from the proctorv3 folder; needs Node 18+)
// Checks heartbeats through a network drop, and that a silence (extension off, browser closed)
// is never covered by stretching the previous visit.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "proctor-ext-"));
writeFileSync(join(dir, "bg.mjs"), readFileSync(join(here, "../extension/background.js"), "utf8").replace('from "./config.js"', 'from "./config.mjs"'));
writeFileSync(join(dir, "config.mjs"), 'export const SERVER = "https://example.test";\nexport const IDLE_AFTER_S = 60;\n');
// Minimal fake Chrome + fake clock + fake server, then drive the real background.js.
let now = Date.parse("2026-10-01T10:00:00Z"); Date.now = () => now;
const store = {}, listeners = {}; const on = (k) => ({ addListener: (f) => (listeners[k] = f) });
let online = true, tab = { url: "https://exam.example.edu/q1", title: "Q1" }; const posts = [];
globalThis.chrome = {
  storage: { local: { get: async (k) => (typeof k === "string" ? { [k]: store[k] } : {}), set: async (o) => Object.assign(store, structuredClone(o)), remove: async (k) => delete store[k] } },
  idle: { queryState: async () => "active", setDetectionInterval() {}, onStateChanged: on("idle") },
  windows: { getLastFocused: async () => ({ id: 1, focused: true }), onFocusChanged: on("focus") },
  tabs: { query: async (q) => [{ ...tab, active: true }], onActivated: on("act"), onUpdated: on("upd"), onCreated: on("cre") },
  alarms: { create: async () => {}, get: async () => true, clear: async () => {}, onAlarm: on("alarm") },
  runtime: { onStartup: on("start"), onInstalled: on("inst"), onMessage: on("msg"), setUninstallURL() {} },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  notifications: { create() {} },
};
const t0 = now / 1000;
globalThis.fetch = async (url, init) => {
  if (!online) throw new TypeError("Failed to fetch");
  const body = JSON.parse(init.body); posts.push({ url, body, at: now / 1000 });
  const base = { code: "E1", name: "E", start_ts: t0 - 60, end_ts: t0 + 7200, server_time: now / 1000, allowed_sites: ["exam.example.edu"], grace_s: 3, flag_outside: true };
  const r = url.endsWith("/api/join") ? { ...base, roll_no: "R1", student_name: "", token: "tok", uninstall_key: "k" } : { ...base, stored: 0, allowed_now: true };
  return { ok: true, status: 200, json: async () => r };
};
await import(join(dir, "bg.mjs"));
const ask = (msg) => new Promise((res) => listeners.msg(msg, {}, res));
const tick = async () => { listeners.alarm({ name: "tick" }); await new Promise((r) => setTimeout(r, 20)); };
const adv = (s) => (now += s * 1000);
let pass = 0; const check = (n, c) => { if (!c) { console.log("FAIL", n); process.exit(1); } pass++; };

check("join", (await ask({ type: "join", examCode: "E1", rollNo: "R1", pin: "1" })).ok);
for (let i = 0; i < 4; i++) { adv(30); await tick(); }                       // 2 min online
check("heartbeats sent online", posts.at(-1).body.heartbeats.length >= 1 && store.state.heartbeats.length === 0);

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
console.log(`ALL ${pass} EXTENSION CHECKS PASSED`);

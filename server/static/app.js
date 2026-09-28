"use strict";
// Exam Proctor dashboard. Plain JS, no build step; strict CSP (no inline scripts or styles).
// Everything a student's browser sends (titles, domains) is escaped with esc() before rendering.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const fmtTime = (ts) => ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
const fmtWhen = (ts) => new Date(ts * 1000).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtHM = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function fmtDur(s) {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}
const toLocalInput = (ts) => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromLocalInput = (v) => new Date(v).getTime() / 1000;

let me = null;
let pollTimer = null;
let live = null;              // last /live payload
let drawerRoll = null;
const ui = { filter: "all", q: "", feedLevel: "hm", seen: new Set(), code: null };

// ---------------------------------------------------------------- api
async function api(method, path, body) {
  const r = await fetch(path, {
    method, credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Proctor": "1" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && !path.startsWith("/api/auth/login")) { showLogin(); throw new Error("Please sign in."); }
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) {
    const d = data && data.detail;
    throw new Error(Array.isArray(d) ? d.map((x) => `${x.loc?.slice(-1)[0]}: ${x.msg}`).join("; ") : d || `Error ${r.status}`);
  }
  return data;
}

function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------- auth
function showLogin() {
  stopPolling();
  me = null;
  $("#shell").hidden = true;
  $("#drawer").hidden = true;
  $("#login").hidden = false;
  $("#loginForm [name=username]").focus();
}

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $("#loginErr").textContent = "";
  try {
    await api("POST", "/api/auth/login", { username: f.get("username"), password: f.get("password") });
    e.target.reset();
    boot();
  } catch (err) { $("#loginErr").textContent = err.message; }
});

async function boot() {
  try { me = await api("GET", "/api/auth/me"); } catch { return; }
  $("#login").hidden = true;
  $("#shell").hidden = false;
  $("#whoami").textContent = me.username;
  route();
}

// ---------------------------------------------------------------- router
window.addEventListener("hashchange", () => me && route());

function route() {
  stopPolling();
  closeDrawer();
  document.title = "Exam Proctor";
  const h = location.hash.replace(/^#\/?/, "").split("/");
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === (h[0] || "exams")));
  if (h[0] === "admins") return viewAdmins();
  if (h[0] === "exams" && h[1] === "new") return viewExamForm(null);
  if (h[0] === "exams" && h[1] && h[2] === "edit") return viewExamForm(decodeURIComponent(h[1]));
  if (h[0] === "exams" && h[1] && h[2] === "live") return viewLive(decodeURIComponent(h[1]));
  return viewExams();
}

function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

// ---------------------------------------------------------------- exams list
async function viewExams() {
  const v = $("#view");
  v.innerHTML = `<div class="page-head"><h1>Exams</h1><div class="spacer"></div>
    <a class="btn primary" href="#/exams/new">+ New exam</a></div><div class="card" id="examList"><div class="empty">Loading…</div></div>`;
  const load = async () => {
    const exams = await api("GET", "/api/admin/exams");
    const box = $("#examList");
    if (!box) return;
    if (!exams.length) { box.innerHTML = `<div class="empty">No exams yet. Create one to get an exam code and PIN for students.</div>`; return; }
    box.innerHTML = `<table><thead><tr><th>Exam</th><th class="hide-sm">When</th><th>Status</th>
      <th class="num">Joined</th><th class="num hide-sm">Online</th><th class="num">High flags</th><th></th></tr></thead><tbody>
      ${exams.map((e) => `<tr class="click" data-href="#/exams/${encodeURIComponent(e.code)}/live">
        <td><strong>${esc(e.name)}</strong><div class="muted mono">${esc(e.code)}</div></td>
        <td class="hide-sm">${esc(fmtWhen(e.start_ts))} – ${esc(fmtHM(e.end_ts))}</td>
        <td><span class="pill ${esc(e.state)}">${esc(e.state)}</span></td>
        <td class="num">${e.joined}${e.roster_size ? ` / ${e.roster_size}` : ""}</td>
        <td class="num hide-sm">${e.state === "running" ? e.online : "–"}</td>
        <td class="num">${e.high_flags ? `<span class="cnt HIGH">${e.high_flags}</span>` : "0"}</td>
        <td><a class="btn sm" href="#/exams/${encodeURIComponent(e.code)}/edit">Edit</a></td></tr>`).join("")}
      </tbody></table>`;
  };
  await load().catch((e) => toast(e.message));
  pollTimer = setInterval(() => load().catch(() => {}), 10000);
}

document.addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-href]");
  if (row && !e.target.closest("a,button")) location.hash = row.dataset.href;
});

// ---------------------------------------------------------------- exam form
async function viewExamForm(code) {
  const v = $("#view");
  let ex = null;
  if (code) {
    try { ex = await api("GET", `/api/admin/exams/${encodeURIComponent(code)}`); }
    catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  }
  const start = ex ? ex.start_ts : Math.ceil(Date.now() / 1000 / 900) * 900 + 900;
  const end = ex ? ex.end_ts : start + 3600;
  v.innerHTML = `
    <div class="page-head"><a class="btn ghost" href="${ex ? `#/exams/${encodeURIComponent(ex.code)}/live` : "#/exams"}">← Back</a>
      <h1>${ex ? `Edit ${esc(ex.name)}` : "New exam"}</h1></div>
    <form class="card form" id="examForm" autocomplete="off">
      <label>Exam name<input name="name" required maxlength="120" value="${esc(ex?.name)}" placeholder="Statistics midterm, Section B"></label>
      <label>Exam code<input name="code" required maxlength="32" pattern="[A-Za-z0-9_\\-]{2,32}" value="${esc(ex?.code)}" ${ex ? "readonly" : ""} placeholder="STATS-MID-B">
        <div class="hint">Students type this in the extension. Letters, digits, - and _.</div></label>
      <label>Starts<input name="start" type="datetime-local" required value="${toLocalInput(start)}"></label>
      <label>Ends<input name="end" type="datetime-local" required value="${toLocalInput(end)}">
        <div class="hint">You can extend a running exam; extensions pick up the change within 30 seconds.</div></label>
      <label>Exam PIN<input name="pin" maxlength="12" pattern="[A-Za-z0-9]{4,12}" ${ex ? "" : "required"} placeholder="${ex ? "Leave blank to keep the current PIN" : "4–12 letters or digits"}">
        <div class="hint">Announce it when the exam starts so only students in the room/call can join.</div></label>
      <label>Grace period (seconds)<input name="grace_s" type="number" min="0" max="120" value="${ex?.grace_s ?? 3}">
        <div class="hint">A visit shorter than this is not flagged (covers redirects and accidental clicks).</div></label>
      <label class="full">Allowed sites (one per line)
        <textarea name="sites" rows="7" spellcheck="false" placeholder="exam.university.edu&#10;accounts.google.com&#10;docs.google.com/forms/d/e/1FAIpQLSf…&#10;desmos.com">${esc((ex?.allowed_sites || []).join("\n"))}</textarea>
        <div class="hint">Write a <strong>site</strong> to allow every page on it, including its subdomains: <span class="mono">colab.research.google.com</span> allows every Colab notebook. Add a <strong>path</strong> to allow only part of a site: <span class="mono">docs.google.com/forms/d/e/ABC</span> allows that one form, not all of Google Docs. You can paste links straight from the address bar. Any site not listed is flagged.</div></label>
      <div class="full site-check">
        <div id="sitePreview" class="site-preview" aria-live="polite"></div>
        <label class="test-link">Test a link <input id="testUrl" type="url" placeholder="Paste any link to check it, e.g. https://colab.research.google.com/drive/…" autocomplete="off"></label>
        <div id="testResult" class="test-result" aria-live="polite"></div>
      </div>
      <label class="check full"><input type="checkbox" name="flag_outside" ${ex?.flag_outside ?? true ? "checked" : ""}>
        <span>Flag when a student leaves Chrome for another app or window (Word, WhatsApp desktop, another browser, etc.), or locks the screen.</span></label>
      <label class="full">Class roster (optional)
        <textarea name="roster" rows="6" spellcheck="false" placeholder="ROLL,Name&#10;21BM001,Asha Rao&#10;21BM002,Vikram Shah">${esc(ex?.roster || "")}</textarea>
        <div class="hint">One student per line: roll number, then name (comma or tab separated; you can paste from a spreadsheet). With a roster, only these roll numbers can join, and the live view shows who has not joined yet.</div></label>
      <div class="form-actions full">
        <button class="btn primary" type="submit">${ex ? "Save changes" : "Create exam"}</button>
        <a class="btn" href="${ex ? `#/exams/${encodeURIComponent(ex.code)}/live` : "#/exams"}">Cancel</a>
        <div class="spacer"></div>
        ${ex ? `<button class="btn danger" type="button" data-action="delete-exam" data-code="${esc(ex.code)}">Delete exam</button>` : ""}
      </div>
      <p class="error full" id="formErr" role="alert"></p>
    </form>`;
  const sitesBox = $("#examForm [name=sites]");
  const refreshSites = debounce(() => previewSites(sitesBox, $("#testUrl").value), 250);
  sitesBox.addEventListener("input", refreshSites);
  $("#testUrl").addEventListener("input", refreshSites);
  previewSites(sitesBox, "");
  $("#examForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = {
      code: String(f.get("code")).trim().toUpperCase(), name: String(f.get("name")).trim(),
      start_ts: fromLocalInput(f.get("start")), end_ts: fromLocalInput(f.get("end")),
      pin: String(f.get("pin") || "").trim(), grace_s: Number(f.get("grace_s") || 0),
      flag_outside: f.get("flag_outside") === "on",
      allowed_sites: String(f.get("sites")).split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
      roster: String(f.get("roster") || ""),
    };
    if (!body.allowed_sites.length && !confirm("No allowed sites: every website will be flagged. Continue?")) return;
    try {
      const r = ex ? await api("PUT", `/api/admin/exams/${encodeURIComponent(ex.code)}`, body)
                   : await api("POST", "/api/admin/exams", body);
      toast(ex ? "Saved." : `Exam ${r.code} created. Share the code; announce the PIN at the start.`, 5000);
      location.hash = `#/exams/${encodeURIComponent(r.code)}/live`;
    } catch (err) { $("#formErr").textContent = err.message; }
  });
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// Explains, as you type, how each allowed-site line will be applied (rules live on the server).
async function previewSites(box, testUrl) {
  const lines = box.value.split(/\r?\n/);
  let d;
  try { d = await api("POST", "/api/admin/sites/check", { lines, test_url: testUrl || "" }); } catch { return; }
  const out = $("#sitePreview");
  if (!out) return;
  const rows = d.rows.map((r, i) => {
    if (!r.valid) return `<li class="bad">✗ <span class="mono">${esc(r.input)}</span>: not a valid site address</li>`;
    const where = r.scope === "site"
      ? `<strong>${esc(r.host)}</strong>: whole site, every page, including subdomains`
      : `<strong>${esc(r.host)}</strong>: only pages under <span class="mono">/${esc(r.path)}</span>
         <button type="button" class="btn sm" data-action="widen-site" data-index="${i}" data-host="${esc(r.host)}">Allow whole site instead</button>`;
    return `<li class="${r.warning ? "warn" : "ok"}">${r.scope === "site" ? "✓" : "◐"} ${where}${r.warning ? `<div class="why">⚠ ${esc(r.warning)} Consider a narrower entry.</div>` : ""}</li>`;
  });
  const tips = d.tips.map((t) => `<li class="tip">Tip: ${esc(t.why)}
      ${t.offer ? `<button type="button" class="btn sm" data-action="add-site" data-site="${esc(t.add)}">Add ${esc(t.add)}</button>` : ""}</li>`);
  out.innerHTML = rows.length || tips.length ? `<ul>${rows.join("")}${tips.join("")}</ul>` : `<p class="muted">No allowed sites yet: every website will be flagged.</p>`;
  const tr = $("#testResult");
  if (!d.test) { tr.innerHTML = ""; return; }
  tr.innerHTML = d.test.allowed
    ? `<span class="ok">✓ Allowed</span>: matches <span class="mono">${esc(d.test.by)}</span>`
    : `<span class="bad">✗ Would be flagged</span>: <span class="mono">${esc(d.test.host + d.test.path)}</span> is not covered by any line above.
       ${d.test.host ? `<button type="button" class="btn sm" data-action="add-site" data-site="${esc(d.test.host)}">Allow ${esc(d.test.host)}</button>` : ""}`;
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-action=widen-site],[data-action=add-site]");
  if (!b) return;
  const box = $("#examForm [name=sites]");
  if (!box) return;
  const lines = box.value.split(/\r?\n/).filter((l) => l.trim());
  if (b.dataset.action === "widen-site") {
    // Preview rows are in the same order as the non-empty lines.
    lines[Number(b.dataset.index)] = b.dataset.host;
    box.value = lines.filter((l, i, arr) => arr.indexOf(l) === i).join("\n");
  } else {
    box.value = [...lines, b.dataset.site].join("\n");
  }
  previewSites(box, $("#testUrl").value);
});

// ---------------------------------------------------------------- live monitor
const STATUS_LABEL = { ok: "On allowed site", idle: "Idle", violation: "Not allowed", offline: "Offline",
  waiting: "Joined, waiting", not_joined: "Not joined", finished: "Finished" };
const FILTERS = [["all", "All"], ["violation", "Violating now"], ["offline", "Offline"], ["flagged", "Has high flags"], ["not_joined", "Not joined"]];

async function viewLive(code) {
  ui.code = code; ui.seen = new Set(); live = null;
  const v = $("#view");
  v.innerHTML = `
    <div class="page-head">
      <a class="btn ghost" href="#/exams">←</a>
      <div><h1 id="lvName">Loading…</h1><div class="muted"><span class="mono" id="lvCode"></span> · <span id="lvWhen"></span></div></div>
      <span class="pill" id="lvState"></span><strong id="lvClock" class="num"></strong>
      <div class="spacer"></div>
      <a class="btn" href="/api/admin/exams/${encodeURIComponent(code)}/export.csv">Export flags (CSV)</a>
      <a class="btn" href="#/exams/${encodeURIComponent(code)}/edit">Edit exam &amp; allowed sites</a>
    </div>
    <div class="kpis" id="kpis"></div>
    <div class="live">
      <section>
        <div class="toolbar">
          ${FILTERS.map(([k, l]) => `<button class="chip ${k === "all" ? "on" : ""}" data-filter="${k}">${l}</button>`).join("")}
          <div class="spacer"></div>
          <input type="search" id="q" placeholder="Search roll no. or name" aria-label="Search students">
        </div>
        <div class="grid" id="grid"></div>
      </section>
      <section class="card feed">
        <div class="feed-head"><h2>Flags</h2>
          <select id="feedLevel" aria-label="Which flags to show">
            <option value="hm">High &amp; medium</option><option value="h">High only</option><option value="all">All, incl. dismissed</option>
          </select></div>
        <div class="feed-list" id="feed"></div>
      </section>
    </div>`;
  ui.filter = "all"; ui.q = "";
  $("#q").addEventListener("input", (e) => { ui.q = e.target.value.trim().toLowerCase(); renderGrid(); });
  $("#feedLevel").value = ui.feedLevel;
  $("#feedLevel").addEventListener("change", (e) => { ui.feedLevel = e.target.value; renderFeed(); });
  await loadLive(true);
  pollTimer = setInterval(() => { if (!document.hidden) loadLive(false); }, 3000);
}

async function loadLive(first) {
  try {
    live = await api("GET", `/api/admin/exams/${encodeURIComponent(ui.code)}/live`);
  } catch (e) {
    if (first) $("#view").innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const newHigh = [];
  for (const f of live.flags) {
    f._new = !first && !ui.seen.has(f.id);
    if (f._new && f.level === "HIGH") newHigh.push(f);
    ui.seen.add(f.id);
  }
  renderHeader(); renderKpis(); renderGrid(); renderFeed();
  if (newHigh.length) {
    const f = newHigh[0];
    toast(`⚠ ${f.roll_no}${f.name ? ` (${f.name})` : ""}: ${flagWhat(f)}${newHigh.length > 1 ? ` (+${newHigh.length - 1} more)` : ""}`, 6000);
  }
  if (drawerRoll) loadDrawer(drawerRoll, false);
}

function renderHeader() {
  const e = live.exam, t = live.server_time;
  $("#lvName").textContent = e.name;
  $("#lvCode").textContent = e.code;
  $("#lvWhen").textContent = `${fmtWhen(e.start_ts)} – ${fmtHM(e.end_ts)}`;
  const st = $("#lvState");
  st.className = `pill ${e.state}`;
  st.textContent = e.state;
  $("#lvClock").textContent = e.state === "running" ? `${fmtDur(e.end_ts - t)} left`
    : e.state === "scheduled" ? `starts in ${fmtDur(e.start_ts - t)}` : "";
  const counts = live.students.filter((s) => s.status === "violation").length;
  document.title = `${counts ? `(${counts}) ` : ""}${e.name} · Exam Proctor`;
}

function renderKpis() {
  const S = live.students, n = (st) => S.filter((s) => s.status === st).length;
  const joined = S.filter((s) => s.status !== "not_joined").length;
  const rosterN = live.exam.roster_size;
  const openHigh = live.flags.filter((f) => f.level === "HIGH" && f.status === "open").length;
  const k = [
    ["", `${joined}${rosterN ? ` / ${rosterN}` : ""}`, "Joined"],
    ["", live.exam.state === "running" ? S.filter((s) => ["ok", "idle", "violation"].includes(s.status)).length : "–", "Online now"],
    [n("violation") ? "bad" : "", n("violation"), "On a site that is not allowed"],
    [n("offline") ? "warn" : "", n("offline"), "Offline (no contact 90s+)"],
    [openHigh ? "bad" : "", openHigh, "Open high flags"],
  ];
  $("#kpis").innerHTML = k.map(([c, v, l]) => `<div class="card kpi ${c}"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join("");
}

function whereText(s) {
  const t = live.server_time;
  if (s.status === "not_joined") return "Has not joined";
  if (s.status === "offline") return `Last contact ${fmtDur(t - s.last_seen)} ago`;
  if (s.status === "waiting") return live.exam.state === "scheduled" ? "Joined, exam not started" : "Joined, no activity yet";
  if (s.status === "finished") return "Exam over";
  const dur = s.since ? ` · ${fmtDur(t - s.since)}` : "";
  if (s.kind === "outside") return `Another app / window${dur}`;
  if (s.domain === "(locked)") return `Screen locked${dur}`;
  return `${s.domain}${s.status === "violation" ? s.path : ""}${dur}`;
}

function renderGrid() {
  const order = { violation: 0, offline: 1, idle: 2, ok: 3, waiting: 4, finished: 5, not_joined: 6 };
  let S = live.students.slice();
  if (ui.filter === "flagged") S = S.filter((s) => s.flags.HIGH > 0);
  else if (ui.filter !== "all") S = S.filter((s) => s.status === ui.filter);
  if (ui.q) S = S.filter((s) => s.roll_no.toLowerCase().includes(ui.q) || s.name.toLowerCase().includes(ui.q));
  S.sort((a, b) => order[a.status] - order[b.status] || b.flags.HIGH - a.flags.HIGH || a.roll_no.localeCompare(b.roll_no));
  document.querySelectorAll("[data-filter]").forEach((c) => c.classList.toggle("on", c.dataset.filter === ui.filter));
  $("#grid").innerHTML = S.length ? S.map((s) => `
    <button class="tile ${s.status}" data-roll="${esc(s.roll_no)}" title="${esc(s.title)}">
      <div class="top"><span class="roll">${esc(s.roll_no)}</span>
        <span class="badges">${["HIGH", "MEDIUM"].filter((l) => s.flags[l]).map((l) => `<span class="cnt ${l}" title="${l.toLowerCase()} flags">${s.flags[l]}</span>`).join("")}</span></div>
      <div class="name">${esc(s.name || "—")}</div>
      <div><span class="pill ${s.status}">${esc(STATUS_LABEL[s.status])}</span></div>
      <div class="where">${esc(whereText(s))}</div>
      ${s.bad_tabs.length && ["ok", "idle", "violation"].includes(s.status) ? `<div class="where">Other tabs open: ${esc(s.bad_tabs.slice(0, 3).join(", "))}${s.bad_tabs.length > 3 ? "…" : ""}</div>` : ""}
    </button>`).join("") : `<div class="empty">No students match.</div>`;
}

function flagWhat(f) {
  const dur = f.duration_s ? ` for ${fmtDur(f.duration_s)}` : "";
  switch (f.rule) {
    case "disallowed_site": case "disallowed_page": return `${f.domain}${f.path}${dur}`;
    case "left_browser": return `Other app / window${dur}`;
    case "screen_locked": return `Screen locked${dur}`;
    case "tab_open": return `Tab open: ${f.domain}`;
    case "monitoring_gap": return `Silent${dur}`;
    default: return f.label;
  }
}

function renderFeed() {
  let F = live.flags;
  if (ui.feedLevel === "h") F = F.filter((f) => f.level === "HIGH" && f.status !== "dismissed");
  else if (ui.feedLevel === "hm") F = F.filter((f) => f.level !== "LOW" && f.status !== "dismissed");
  $("#feed").innerHTML = F.length ? F.map((f) => `
    <div class="flag ${f._new ? "new" : ""} ${esc(f.status)}" data-roll="${esc(f.roll_no)}">
      <div class="row1"><strong>${esc(f.roll_no)}${f.name ? ` <span class="muted">${esc(f.name)}</span>` : ""}</strong>
        <span class="pill ${esc(f.level)}">${esc(f.level.toLowerCase())}</span></div>
      <div class="what">${esc(flagWhat(f))}</div>
      <div class="meta">${esc(f.label)} · ${esc(fmtTime(f.seg_start || f.created_ts))}${f.title ? ` · “${esc(f.title.slice(0, 80))}”` : ""}${f.status !== "open" ? ` · ${esc(f.status)} by ${esc(f.reviewer)}` : ""}</div>
    </div>`).join("") : `<div class="empty">No flags${live.exam.state === "running" ? " yet" : ""}.</div>`;
}

document.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-filter]");
  if (chip) { ui.filter = chip.dataset.filter; renderGrid(); return; }
  const t = e.target.closest("[data-roll]");
  if (t && live) openDrawer(t.dataset.roll);
});

// ---------------------------------------------------------------- student drawer
function openDrawer(roll) {
  drawerRoll = roll;
  $("#drawer").hidden = false;
  $("#dBody").innerHTML = `<div class="muted">Loading…</div>`;
  loadDrawer(roll, true);
}
function closeDrawer() { drawerRoll = null; $("#drawer").hidden = true; }
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && drawerRoll) closeDrawer(); });

async function loadDrawer(roll, first) {
  let d;
  try { d = await api("GET", `/api/admin/exams/${encodeURIComponent(ui.code)}/students/${encodeURIComponent(roll)}`); }
  catch (e) { if (first) $("#dBody").innerHTML = `<div class="error">${esc(e.message)}</div>`; return; }
  if (drawerRoll !== roll) return;
  const s = live.students.find((x) => x.roll_no === roll) || { roll_no: roll, name: "", status: "not_joined", bad_tabs: [] };
  const ex = live.exam;
  $("#dTitle").textContent = s.name ? `${roll} · ${s.name}` : roll;
  $("#dSub").innerHTML = `<span class="pill ${esc(s.status)}">${esc(STATUS_LABEL[s.status])}</span> ${esc(whereText(s))}` +
    (d.participant ? ` · joined ${esc(fmtTime(d.participant.joined_ts))}` : "");
  const body = $("#dBody");
  const keep = body.scrollTop;
  const flagsOpen = d.flags.filter((f) => f.status !== "dismissed").length;
  body.innerHTML = `
    <section><h3>Timeline</h3><div class="timeline" id="tl"></div>
      <div class="axis"><span>${esc(fmtHM(ex.start_ts))}</span><span>${esc(fmtHM(ex.end_ts))}</span></div>
      <div class="legend"><span><i class="l-ok"></i>Allowed</span><span><i class="l-bad"></i>Not allowed / other app</span><span><i class="l-idle"></i>Idle</span><span><i class="l-none"></i>No data</span></div>
    </section>
    ${s.bad_tabs.length ? `<section><h3>Other tabs open that are not allowed</h3><div class="mono">${s.bad_tabs.map(esc).join("<br>")}</div></section>` : ""}
    <section><h3>Flags (${flagsOpen} not dismissed)</h3>
      ${d.flags.length ? d.flags.map((f) => `
        <div class="card flag ${esc(f.status)}">
          <div class="row1"><strong>${esc(f.label)}</strong><span class="pill ${esc(f.level)}">${esc(f.level.toLowerCase())}</span></div>
          <div class="what">${esc(flagWhat(f))}${f.title ? ` · “${esc(f.title)}”` : ""}</div>
          <div class="meta">${f.seg_start ? esc(fmtTime(f.seg_start)) : "During exam"}${f.detail ? ` · ${esc(f.detail)}` : ""}
            ${f.status !== "open" ? ` · <strong>${esc(f.status)}</strong> by ${esc(f.reviewer)}${f.note ? `: ${esc(f.note)}` : ""}` : ""}</div>
          <div class="review">
            ${f.status !== "confirmed" ? `<button class="btn sm danger" data-review="confirmed" data-id="${f.id}">Confirm</button>` : ""}
            ${f.status !== "dismissed" ? `<button class="btn sm" data-review="dismissed" data-id="${f.id}">Dismiss</button>` : ""}
            ${f.status !== "open" ? `<button class="btn sm ghost" data-review="open" data-id="${f.id}">Reopen</button>` : ""}
            ${["disallowed_site", "tab_open"].includes(f.rule) && f.status === "open" && f.domain
              ? `<button class="btn sm" data-allow-site="${esc(f.domain)}" title="Add this site to the exam's allowed list">Allow ${esc(f.domain)}</button>` : ""}
          </div>
        </div>`).join("") : `<div class="muted">No flags.</div>`}
    </section>
    <section><h3>Activity log</h3>
      ${d.events.length ? `<table class="events"><tbody>${d.events.slice().reverse().slice(0, 300).map((ev) => `
        <tr class="${ev.allowed ? "" : "bad"}"><td class="num">${esc(fmtTime(ev.start_ts))}</td><td class="num">${esc(fmtDur(ev.end_ts - ev.start_ts))}</td>
        <td>${ev.kind === "outside" ? "Other app / window" : esc(ev.domain + (ev.path || ""))}${ev.kind === "idle" ? " (idle)" : ""}<div class="muted">${esc(ev.title)}</div></td></tr>`).join("")}</tbody></table>`
        : `<div class="muted">No completed activity yet (the current page appears once the student moves on).</div>`}
    </section>`;
  body.scrollTop = keep;
  // Timeline bars: positioned with CSSOM (allowed by the CSP, unlike inline style attributes).
  const tl = $("#tl"), span = ex.end_ts - ex.start_ts;
  const segs = d.events.slice();
  if (s.since && ["ok", "idle", "violation"].includes(s.status))
    segs.push({ start_ts: s.since, end_ts: live.server_time, allowed: s.status !== "violation", kind: s.kind });
  for (const ev of segs) {
    const el = document.createElement("span");
    el.className = !ev.allowed ? "bad" : ev.kind === "idle" ? "idle" : "";
    el.style.left = `${Math.max(0, (ev.start_ts - ex.start_ts) / span) * 100}%`;
    el.style.width = `${Math.max(0.15, ((Math.min(ev.end_ts, ex.end_ts) - Math.max(ev.start_ts, ex.start_ts)) / span) * 100)}%`;
    tl.appendChild(el);
  }
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-review]");
  if (!b) return;
  const status = b.dataset.review;
  let note = "";
  if (status !== "open") {
    note = prompt(status === "confirmed" ? "Note for the record (optional):" : "Why dismiss? (optional, e.g. 'allowed by invigilator')", "");
    if (note === null) return;
  }
  try {
    await api("POST", `/api/admin/flags/${b.dataset.id}`, { status, note });
    await loadLive(false);
  } catch (err) { toast(err.message); }
});

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-allow-site]");
  if (!b || !ui.code) return;
  const site = b.dataset.allowSite;
  if (!confirm(`Allow ${site} for the rest of this exam?\n\nEvery page on ${site} and its subdomains becomes allowed for all students, and open flags for it are dismissed. Students' extensions update within 30 seconds.`)) return;
  try {
    const r = await api("POST", `/api/admin/exams/${encodeURIComponent(ui.code)}/allow`, { site, dismiss: true });
    toast(`${r.added} is now allowed. ${r.dismissed} flag(s) dismissed.`, 5000);
    await loadLive(false);
  } catch (err) { toast(err.message); }
});

// ---------------------------------------------------------------- admins
async function viewAdmins() {
  const v = $("#view");
  v.innerHTML = `<div class="page-head"><h1>Admins</h1></div>
    <div class="live">
      <div class="card" id="adminList"><div class="empty">Loading…</div></div>
      <div>
        <form class="card form" id="addAdmin" autocomplete="off">
          <h2 class="full">Add an invigilator / admin</h2>
          <label class="full">Username<input name="username" required minlength="3" maxlength="64"></label>
          <label class="full">Temporary password<input name="password" type="password" required minlength="10" autocomplete="new-password">
            <div class="hint">At least 10 characters. Ask them to change it after signing in.</div></label>
          <div class="form-actions full"><button class="btn primary">Add</button></div>
          <p class="error full" id="addErr"></p>
        </form>
        <br>
        <form class="card form" id="pwForm">
          <h2 class="full">Change my password</h2>
          <label class="full">Current password<input name="old" type="password" required autocomplete="current-password"></label>
          <label class="full">New password<input name="new" type="password" required minlength="10" autocomplete="new-password"></label>
          <div class="form-actions full"><button class="btn primary">Change password</button></div>
          <p class="error full" id="pwErr"></p>
        </form>
      </div>
    </div>`;
  const load = async () => {
    const users = await api("GET", "/api/admin/users");
    $("#adminList").innerHTML = `<table><thead><tr><th>Username</th><th>Added</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td><strong>${esc(u.username)}</strong>${u.username === me.username ? ' <span class="muted">(you)</span>' : ""}</td>
        <td class="muted">${esc(new Date(u.created_ts * 1000).toLocaleDateString())}</td>
        <td>${u.username !== me.username ? `<button class="btn sm danger" data-action="del-user" data-user="${esc(u.username)}">Remove</button>` : ""}</td></tr>`).join("")}
      </tbody></table>`;
  };
  load().catch((e) => toast(e.message));
  $("#addAdmin").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api("POST", "/api/admin/users", { username: f.get("username").trim(), password: f.get("password") });
      e.target.reset(); $("#addErr").textContent = ""; toast("Admin added."); load();
    } catch (err) { $("#addErr").textContent = err.message; }
  });
  $("#pwForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api("POST", "/api/auth/password", { old_password: f.get("old"), new_password: f.get("new") });
      e.target.reset(); $("#pwErr").textContent = ""; toast("Password changed.");
    } catch (err) { $("#pwErr").textContent = err.message; }
  });
}

// ---------------------------------------------------------------- global actions
document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-action]");
  if (!a) return;
  const act = a.dataset.action;
  try {
    if (act === "logout") { await api("POST", "/api/auth/logout"); showLogin(); }
    else if (act === "close-drawer") closeDrawer();
    else if (act === "del-user" && confirm(`Remove admin ${a.dataset.user}?`)) {
      await api("DELETE", `/api/admin/users/${encodeURIComponent(a.dataset.user)}`); route();
    } else if (act === "delete-exam") {
      const code = a.dataset.code;
      if (prompt(`This permanently deletes exam ${code} and all its activity and flags.\nType the exam code to confirm:`) !== code) return;
      await api("DELETE", `/api/admin/exams/${encodeURIComponent(code)}`);
      toast("Exam deleted."); location.hash = "#/exams";
    }
  } catch (err) { toast(err.message); }
});

boot().then(() => { if (!me) showLogin(); });

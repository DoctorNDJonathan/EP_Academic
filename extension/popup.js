const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const clock = (ts) => new Date(ts * 1000).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const hm = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function validate() {
  $("joinBtn").disabled = !($("code").value.trim() && $("roll").value.trim() && $("pin").value.trim() && $("consent").checked);
}
["code", "roll", "pin"].forEach((id) => $(id).addEventListener("input", validate));
$("consent").addEventListener("change", validate);

$("joinBtn").addEventListener("click", async () => {
  $("joinBtn").disabled = true;
  $("err").textContent = "";
  const r = await send({ type: "join", examCode: $("code").value.trim(), rollNo: $("roll").value.trim(), pin: $("pin").value.trim() });
  if (r.ok) refresh();
  else { $("err").textContent = r.error; validate(); }
});

$("resetBtn").addEventListener("click", async () => {
  const r = await send({ type: "reset" });
  if (r.ok) refresh();
  else $("err2").textContent = r.error;
});

function render(s, now, allowedNow) {
  $("joinView").hidden = !!s;
  $("statusView").hidden = !s;
  if (!s) return;
  const t = now + (s.offset || 0);
  const state = s.finished || t > s.end_ts ? "finished" : t < s.start_ts ? "scheduled" : "running";
  $("statusLine").className = "status " + state;
  $("statusText").textContent = {
    scheduled: `Joined. Monitoring starts at ${hm(s.start_ts)}`,
    running: `Monitoring until ${hm(s.end_ts)}`,
    finished: "Exam finished. Monitoring stopped.",
  }[state];
  const b = $("banner");
  b.hidden = state !== "running";
  b.className = "banner " + (allowedNow ? "ok" : "bad");
  b.textContent = allowedNow ? "You are on an allowed site." : "You are NOT on an allowed site. This is being reported.";
  $("examName").textContent = s.name;
  $("student").textContent = s.student_name ? `${s.roll_no} (${s.student_name})` : s.roll_no;
  $("examTime").textContent = `${clock(s.start_ts)} to ${hm(s.end_ts)}`;
  $("conn").textContent = s.lastError || (s.lastUpload ? `Connected, last sent ${hm(s.lastUpload / 1000)}` : "Connecting…")
    + (s.queue.length ? ` (${s.queue.length} waiting)` : "");
  const ul = $("sites");
  ul.replaceChildren(...(s.allowed_sites?.length ? s.allowed_sites : ["(none: only the new-tab page)"]).map((x) => {
    const li = document.createElement("li");
    li.textContent = x;
    return li;
  }));
  $("resetBtn").hidden = state !== "finished";
}

async function refresh() {
  const r = await send({ type: "status" });
  render(r.state, r.now, r.allowedNow);
}
refresh();
setInterval(refresh, 2000);

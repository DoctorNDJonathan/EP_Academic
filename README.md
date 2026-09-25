# Exam Proctor v3: allowlist proctoring with a live dashboard

Each exam has its own list of allowed sites. If a student opens any other
site, page or app during the exam, they are flagged within seconds. Invigilators
watch every student live on a dashboard that requires a login.

```
Chrome extension ──HTTPS──► FastAPI (one process) ──► Postgres (Supabase) or SQLite (laptop)
 (each student)              ├─ /api/join, /api/ingest    students, secret token
                             ├─ /dashboard, /api/admin/*  invigilators, login
                             └─ offline watcher           every 20 s
```

Tested with 200 simulated students at ~34 requests/s (about 5× the real load):
0 errors, p95 latency 7 ms on a laptop.

## How it works

| Student does… | What happens |
|---|---|
| Joins with exam code + roll no. + PIN | Gets a secret session token. If you uploaded a roster, only listed roll numbers can join. |
| Stays on allowed sites | Tile is green on the dashboard. Badge on the extension icon shows **ON**. |
| Opens a site not on the list | Reported immediately. After the grace period (default 3 s) a **HIGH** flag appears live. The student gets a Chrome notification and a red **!** badge. |
| Switches to another app (Word, WhatsApp, another browser) | **HIGH** `left_browser` flag (can be switched off per exam). |
| Keeps a non-allowed site open in a background tab | **LOW** `tab_open` flag, and the site is listed on their tile. |
| Opens chrome://extensions or other browser pages | **MEDIUM** flag. |
| Closes Chrome, disables the extension, or loses network | Shows as **Offline** after 90 s, and gets a **MEDIUM** `monitoring_gap` flag. If queued activity arrives later and covers the gap, the flag is downgraded to LOW (network drop). |
| Uninstalls the extension | Chrome calls `/bye`, which raises a **HIGH** `extension_removed` flag. |
| Rejoins from another browser, or shares a browser | **MEDIUM** `device_changed` / `shared_device` flag. |

You can change the allowlist, end time or grace period **during** the exam.
Extensions pick up the change within 30 seconds.

### Allowed-site syntax (one per line)

```
exam.university.edu                   the host and all its subdomains
university.edu                        covers exam.university.edu, lms.university.edu, ...
docs.google.com/forms/d/e/1FAIpQL…    only pages whose path starts with this
desmos.com/calculator                 Desmos calculator only, not the rest of desmos.com
accounts.google.com                   include any sign-in pages your exam redirects through
```

The new-tab page is always allowed. Search terms and query strings are
never sent, only the host and path.

### Dashboard

- **Exams:** create or edit an exam: name, code, start/end, PIN, allowed sites, grace period, "flag other apps", optional roster (paste from a spreadsheet).
- **Live monitor:** refreshes every 3 s. It shows KPI tiles (joined, online, violating now, offline, open high flags), a student grid sorted with violators first, filters and search, and a live flag feed with a pop-up toast for each new HIGH flag.
- **Student drawer:** click a tile to see a colour-coded timeline, all flags with **Confirm / Dismiss / Reopen** (with a note and reviewer name), and the full activity log.
- **Export:** a CSV of all flags per exam, for the misconduct committee.
- **Admins:** add or remove invigilator accounts and change your password.

## Try it on your laptop

```bash
cd server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export PROCTOR_SECRET=$(python3 -c "import secrets;print(secrets.token_hex(32))")
python manage.py create-admin admin          # prompts for a password
uvicorn app:app --port 8000
```

Open http://localhost:8000/dashboard, sign in, and create an exam.

**Load the extension:** run `python build_extension.py --server http://localhost:8000 --dev`
in this folder. Open `chrome://extensions`, turn on Developer mode, choose
**Load unpacked**, and pick `dist/extension`. Click the icon, then join with the exam code,
any roll number and the PIN.

**Simulate a class:** `python server/simulate.py --exam CODE --pin PIN --students 200 --minutes 5`

## Security

- Admin passwords are hashed with scrypt. Sessions use an HttpOnly, SameSite=Strict cookie (Secure in production) that expires after 12 h.
- Every admin write must carry the `X-Proctor: 1` header, which blocks CSRF.
- Sign-in allows 8 failures per IP per 10 min. Joining allows 10 wrong PINs or roll numbers per IP per 5 min. Correct joins are never limited, so a whole lab behind one NAT can join.
- PINs, student tokens and session tokens are stored only as HMAC hashes.
- The dashboard has a strict Content-Security-Policy, and all text from students is escaped. The CSV export neutralises spreadsheet formulas.
- API docs are turned off when `PROCTOR_ENV=production`.

## Deploying (free)

Full step-by-step guide: **`deploy/DEPLOY.md`**.
- **Render** (free web service, config in `render.yaml`) runs the app.
- **Supabase** (free Postgres) stores the data.
- You get an address like `https://exam-proctor.onrender.com`; anyone, at any institution, can use it.

1. Create a Supabase project and copy its *Session pooler* connection string.
2. Push this folder to a private GitHub repo. In Render, choose **New → Blueprint**, then paste the connection string as `DATABASE_URL`.
3. From your Mac: `DATABASE_URL='...' python server/manage.py create-admin you`
4. `python build_extension.py --server https://exam-proctor.onrender.com`, then publish the zip on the Chrome Web Store as **Unlisted**.
5. Rehearse with `server/simulate.py` against the live URL before the first real exam.

Without `DATABASE_URL`, the server uses a local SQLite file. That's how it runs on a laptop,
or on your own VM (`deploy/DEPLOY-VM.md`).

## Known limitations (be upfront with students and faculty)

- A phone or second computer is invisible to any browser extension.
- Other browsers are not monitored. Switching to one shows up as "left browser".
- Incognito windows are not seen unless the student allows the extension in incognito. Time there shows as "left browser". To close this gap, managed Chromebooks or a Chrome policy that disables incognito help.
- Students can remove or disable the extension. That is detected (removal or offline flag) but not prevented. On institution-managed devices you can force-install it with the `ExtensionInstallForcelist` policy.
- A determined student could run a modified extension. The system deters and flags; it does not guarantee.
- Flags are prompts for human review, never findings of misconduct.

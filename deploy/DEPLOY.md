# Deploying Exam Proctor v3 for free: Supabase + Render

```
Students (anywhere)                                   Invigilators (anywhere)
 Chrome + extension ──HTTPS──►  Render (free web service)  ◄── browser → /dashboard (login)
                                 exam-proctor.onrender.com
                                          │
                                          ▼
                                 Supabase Postgres (free)
```

- **Render** runs the app: the API for the extension and the dashboard. It gives you a free HTTPS address like `https://exam-proctor.onrender.com`, so you don't need your own domain or server.
- **Supabase** stores the data in Postgres.
- Neither is tied to one institution. Anyone can use your deployment; students just need the exam code and PIN you give them.

**Cost:** US$0 for hosting. The Chrome Web Store charges a one-time US$5 developer fee.
**Time:** about 45 minutes. Store review usually takes a few days but can take 2–3
weeks, so **submit the extension at least 3 weeks before the first real exam**.

> Prefer your own server? `DEPLOY-VM.md` covers a self-hosted Linux VM instead of Parts 1–2.

---

## Part 1: Create the database (Supabase)

1. Sign up at <https://supabase.com> and click **New project**.
2. Fill in:
   - **Name:** `exam-proctor`
   - **Database password:** click *Generate*, and save it in your password manager. You'll need it once, in step 4.
   - **Region:** Southeast Asia (Singapore). It must match the Render region in Part 2; being in the same data centre keeps it fast.
3. Wait about 2 minutes for the project to start.
4. Click **Connect** (top of the project page). Under **Session pooler**, copy the URI. It looks like:
   ```
   postgresql://postgres.abcdefghijkl:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
   ```
   Replace `[YOUR-PASSWORD]` with the database password. This full string is your **DATABASE_URL**. Keep it secret: it gives full access to the data.
   - Use the **Session pooler** string. The "Direct connection" string needs IPv6, which Render doesn't support.
   - If the password contains symbols like `@ : / ? #`, generate a new one with letters and digits only, or URL-encode it.

You don't need to create any tables. The app creates them on first start and switches on
row-level security, so Supabase's public API can't read them. (If Supabase's
*Security Advisor* still lists anything, it's safe to ignore; the app doesn't use that API.)

## Part 2: Deploy the app (Render)

### 2a. Put the code on GitHub

Render deploys from a Git repository. The `proctorv3` folder is already a Git
repository with everything committed. Secrets, databases and builds are excluded
by `.gitignore`.

1. Create a **private** repository at <https://github.com/new>, named for example `exam-proctor`. Don't add a README.
2. Push the code from the `proctorv3` folder on your Mac:
   ```bash
   git remote add origin https://github.com/YOUR_USERNAME/exam-proctor.git
   git push -u origin main
   ```

### 2b. Create the Render service

1. Sign up at <https://render.com> using **Sign in with GitHub**, and give it access to the `exam-proctor` repo.
2. Go to **New → Blueprint**, pick the repo, and Render reads `render.yaml`.
3. When it asks for **DATABASE_URL**, paste the Supabase string from Part 1. `PROCTOR_SECRET` is generated automatically.
4. Click **Apply**. The first build takes 2–4 minutes.
5. Open `https://exam-proctor.onrender.com/api/health` (use your service's actual name). You should see `{"ok":true,...}`.

### 2c. Create your admin login

Render's free plan has no server shell, so run this **on your Mac**. It writes
straight into Supabase, and you choose the password:

```bash
cd proctorv3/server
source .venv/bin/activate
pip install -r requirements.txt
DATABASE_URL='paste-the-supabase-string' python manage.py create-admin YOUR_NAME
```

Now sign in at `https://exam-proctor.onrender.com/dashboard`. Add other
invigilators from the dashboard's **Admins** page.

## Part 3: Publish the extension

### 3a. Build it for your server

On your Mac, in the `proctorv3` folder:

```bash
python3 build_extension.py --server https://exam-proctor.onrender.com
```

This creates `dist/extension/` (for testing) and `dist/exam-proctor-3.0.0.zip` (for the store).

**Test before submitting:**
1. Remove the old localhost copy in `chrome://extensions`.
2. Load `dist/extension` with **Load unpacked**.
3. Create a practice exam in the dashboard and join it.
4. Visit a site that isn't allowed, and watch the tile turn red on the dashboard from your phone.

### 3b. Developer account (one time)

1. Go to <https://chrome.google.com/webstore/devconsole>. Sign in with a Google account the project can keep long-term; a dedicated one is better than a personal Gmail.
2. Pay the one-time **US$5** fee and verify the contact email.

### 3c. Privacy policy

The store requires one for extensions that handle browsing activity. Start from
`../proctorv2/store/privacy-policy.md` and make these changes:
- it sends the **host and path** (never the query string), the page title, and other open tabs that aren't allowed
- roll numbers and names are visible to signed-in invigilators
- data is stored with Supabase (Singapore) and deleted after 90 days

Publish it on GitHub Pages, Google Sites or any web page, and keep the URL.

### 3d. Submit

In the Developer Dashboard, choose **Add new item** and upload `dist/exam-proctor-3.0.0.zip`. Then:

- **Store listing:** base it on `../proctorv2/store/listing.md`, plus 1280×800 screenshots. Category: *Education*.
- **Privacy practices tab.** Single purpose: *"Checks that a student stays on the websites their instructor allows during an online exam they have joined, and reports other sites to the invigilator."* Permission justifications:

  | Permission | Justification |
  |---|---|
  | `tabs` | Read the address and title of the active tab, and of other open tabs, to check them against the exam's allowed sites. |
  | `idle` | Detect when the screen is locked or the student is inactive during the exam. |
  | `alarms` | Send a status update every 30 seconds while an exam is running. |
  | `storage` | Keep the exam session and queue activity during network drops. |
  | `notifications` | Warn the student immediately when they open a site the exam does not allow. |
  | Host permission (your Render address) | Send exam activity to the exam server. |

- **Data usage:** tick *Web history* and *Personally identifiable information* (roll number), and certify there's no sale or unrelated use.
- **Visibility:** choose **Unlisted**. Anyone with the link can install it, from any institution. (*Private* would restrict it to one Google Workspace domain.)

Submit for review. If it's rejected, the email names the item to fix; fix it and resubmit.

### 3e. Getting it to students

- **Personal laptops:** share the store link, with short instructions: install, then click the icon and join with the code and PIN.
- **Managed Chromebooks or Chrome** (any institution using Google Admin): go to **Devices → Chrome → Apps & extensions**, add the extension ID, and set it to **Force install**. Students can't remove or disable it. You can also block incognito and other browsers there.

### Updating later

Raise `"version"` in `extension/manifest.json`, rebuild, and upload the new zip under
**Package**. Chrome updates students automatically after review. Don't publish an
update in the week before an exam.

---

## Part 4: Rehearse on the real deployment (do this once)

The free Render plan has a small CPU share. My load tests ran on a laptop, so
confirm your deployment keeps up **before** a real exam:

1. In the dashboard, create exam `LOADTEST`: PIN `4821`, starting now, 1 hour long, allowed sites `exam.example.edu` and `desmos.com/calculator`.
2. On your Mac:
   ```bash
   cd proctorv3/server
   python simulate.py --server https://exam-proctor.onrender.com --exam LOADTEST --pin 4821 --students 200 --minutes 5
   ```
3. Watch the live view while it runs. The script prints the response times:
   - **p95 under ~1 s with `err=0`:** you're fine.
   - **Errors or multi-second times:** in Render, set the service's instance type to **Starter** (US$7/month: more CPU, and it never sleeps), then re-run.

   The simulator makes about 3× more requests than real students, so this is a conservative test.
4. Delete the `LOADTEST` exam afterwards.

## Part 5: Running an exam

Everything happens in the dashboard, from any browser, anywhere.

**A week before:**
- Create a *practice* exam (same allowed sites, 30 minutes) so every student installs the extension and tests joining.
- Paste the roster so you can see who hasn't joined.

**The day before:** create the real exam:
- the code, which you give to students in advance
- the start and end time, set in your own local time
- a PIN, which you keep private
- the allowed sites, including any sign-in pages the exam uses, like `accounts.google.com`
- the roster

**15 minutes before:** open the dashboard. This also wakes the free Render service,
which sleeps after 15 idle minutes and takes about a minute to wake. Open the exam's live view.

**At the start:** announce the PIN. Watch **Joined X / Y**, and use the **Not joined** filter to chase students.

**During the exam:**
- Red tiles are students on a site that isn't allowed right now, and each new high flag pops up.
- Click a tile for the timeline and visit history.
- If a site should have been allowed, edit the exam, add it, and **Dismiss** the resulting flags. Students update within 30 seconds.
- To give extra time, edit the end time.

**After the exam:** wait 15 minutes for delayed uploads. Review each flag (**Confirm** or **Dismiss**, with a note), then **Export flags (CSV)**.

---

## Free-tier limits to know

| Service | Limit | What to do |
|---|---|---|
| Render free | Sleeps after 15 min with no traffic; first request takes ~1 min | Open the dashboard 15 min before each exam. Joined students' extensions keep it awake during the exam. |
| Render free | 750 hours/month, small CPU | Enough for one service. Rehearse (Part 4); upgrade to Starter if needed. |
| Render free | Restarts on each deploy | **Never push code changes during an exam.** Data is safe in Supabase, and extensions queue and resend. |
| Supabase free | Project **pauses after 7 days with no activity** | Before an exam after a quiet week, open the Supabase dashboard and click **Restore** if it's paused (takes a few minutes). |
| Supabase free | 500 MB database | About 10 MB per 200-student, 3-hour exam. Purge old exams (below). |
| Supabase free | No downloadable backups | Export each exam's flags CSV after review. For full backups, see below. |

## Maintenance (all from your Mac)

**Delete data older than 90 days:**

```bash
DATABASE_URL='...' python manage.py purge --older-than-days 90
```

**Full backup.** Needs `pg_dump`; install it once with `brew install libpq`:

```bash
pg_dump 'SUPABASE_SESSION_POOLER_URL' -Fc -f proctor-backup-$(date +%F).dump
```

**Forgotten admin password:**

```bash
DATABASE_URL='...' python manage.py reset-password NAME
```

**Update the app:** `git push`, and Render redeploys automatically. Not during an exam.

**Logs:** Render dashboard → your service → **Logs**.

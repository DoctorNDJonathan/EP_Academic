# Alternative: self-hosting on your own Linux VM

Use this instead of Render + Supabase (see `DEPLOY.md`) if your institution wants the data on its
own server. Data is stored in a SQLite file on the VM. Leave `DATABASE_URL` unset.
After Stage 6, continue with **Part 3 onwards in `DEPLOY.md`** (extension, store, exam day).

**Where you'll end up:**
- the server running at a public HTTPS address, for example `https://proctor.youruni.edu`
- the dashboard at `https://proctor.youruni.edu/dashboard`, which invigilators sign into from any laptop, anywhere
- the extension on the Chrome Web Store, which students install with one click

**Time:** about 1.5 hours for the server. Chrome Web Store review usually takes a few
days, but can take up to 2–3 weeks, so **submit at least 3 weeks before the first exam**.

```
Students (home, anywhere)                    Invigilators (anywhere)
 Chrome + extension ──HTTPS──┐          ┌── browser → /dashboard (login)
                             ▼          ▼
                 https://proctor.youruni.edu  (Caddy → FastAPI → SQLite)
```

---

## Stage 1: Get a server and a domain name

You need an **Ubuntu 24.04 machine** with a public IP address, and a **domain name**
pointing to it. 1 vCPU and 1 GB RAM is enough for 200 students.

**Route A (recommended): ask IT.** Request:
- a small Ubuntu VM
- a subdomain such as `proctor.youruni.edu` pointing to it
- ports 80 and 443 open to the internet
- SSH access for you

**Route B (free, self-managed): Oracle Cloud Always Free plus DuckDNS.**
1. Create an Oracle Cloud account. For the **home region**, choose India South
   (Hyderabad) or India West (Mumbai), so data stays in India. You can't change it later.
2. Create an "Always Free-eligible" Ubuntu 24.04 VM and add your SSH public key.
3. In the VM subnet's **Security List**, add ingress rules for TCP ports 80 and 443.
4. Create a free subdomain at duckdns.org (for example `myproctor.duckdns.org`)
   and point it to the VM's public IP.

Oracle can reclaim idle free VMs. Keep backups off the server (Stage 6), and check
the VM before every exam.

## Stage 2: Prepare the server

```bash
ssh ubuntu@YOUR_SERVER_IP
```

On the server:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y python3-venv
sudo useradd --system --create-home --home-dir /opt/proctor --shell /bin/bash proctor
sudo mkdir -p /opt/proctor/data /opt/proctor/backups
sudo chown -R proctor:proctor /opt/proctor
sudo timedatectl set-timezone Asia/Kolkata
```

**Oracle images only:** open the VM's own firewall.

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

**Install Caddy** (HTTPS). Current steps are at <https://caddyserver.com/docs/install>:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

## Stage 3: Copy the project and install it

From **your Mac**, in the `Chrome_Proctoring_System` folder:

```bash
rsync -av --exclude .venv --exclude '*.db*' --exclude .dev.env --exclude dist --exclude __pycache__ proctorv3/ ubuntu@YOUR_SERVER_IP:/tmp/proctorv3/
```

On the **server**:

```bash
sudo cp -r /tmp/proctorv3/server /tmp/proctorv3/deploy /opt/proctor/
sudo chown -R proctor:proctor /opt/proctor
sudo -u proctor bash -c "cd /opt/proctor/server && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
```

**Create the settings file:**

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"     # copy the output
sudo cp /opt/proctor/deploy/proctor.env.example /etc/proctor.env
sudo nano /etc/proctor.env                                     # paste it after PROCTOR_SECRET=
sudo chown root:proctor /etc/proctor.env && sudo chmod 640 /etc/proctor.env
```

**Create your admin login** (you choose the password):

```bash
sudo -iu proctor bash -c 'cd /opt/proctor/server && set -a && . /etc/proctor.env && set +a && .venv/bin/python manage.py create-admin YOUR_NAME'
```

## Stage 4: Start the server as a service

```bash
sudo cp /opt/proctor/deploy/proctor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now proctor
sudo systemctl status proctor              # should say "active (running)"
curl http://127.0.0.1:8000/api/health      # should print {"ok":true,...}
```

## Stage 5: Turn on HTTPS

```bash
sudo cp /opt/proctor/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile             # replace proctor.example.edu with your domain
sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy
sudo systemctl reload caddy
```

Caddy gets a free certificate automatically. **To check, use your phone on mobile
data** (not campus Wi-Fi):
- `https://YOUR_DOMAIN/api/health` should show `{"ok":true,...}` with a padlock.
- `https://YOUR_DOMAIN/dashboard` should show the sign-in page. Sign in with the admin you created.

**Optional:** to allow the dashboard only from campus or VPN addresses, uncomment the
`@adminOutside` block in the Caddyfile and put in your campus IP range. The student
endpoints stay public.

## Stage 6: Backups

```bash
sudo -u proctor crontab -e
```

Add these two lines. The first backs up nightly at 02:30; the second deletes data
from exams older than 90 days, monthly.

```
30 2 * * * cd /opt/proctor/server && set -a && . /etc/proctor.env && set +a && .venv/bin/python ../deploy/backup.py >> /opt/proctor/backups/backup.log 2>&1
0 3 1 * * cd /opt/proctor/server && set -a && . /etc/proctor.env && set +a && .venv/bin/python manage.py purge --older-than-days 90
```

Copy the backups off the server now and then:
`scp -r ubuntu@YOUR_SERVER_IP:/opt/proctor/backups ./proctor-backups`

---

Next: **`DEPLOY.md` → Part 3: Publish the extension.** Use your VM's domain as the server address.

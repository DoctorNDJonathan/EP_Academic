"""Per-exam allowlist and flag rules.

Allowlist entries (one per line in the dashboard):
    colab.research.google.com        the whole site: every page, plus all its subdomains
    *.university.edu                 same idea, written explicitly (covers exam.university.edu, ...)
    docs.google.com/forms/d/e/1FAI   only part of a site: pages under this path
    https://www.example.com/quiz/    scheme, "www.", "?query" and "#fragment" are ignored

Hosts are case-insensitive; paths are case-sensitive (Google Drive / Colab IDs
contain capitals), and a path matches whole segments: "desmos.com/calculator"
allows /calculator and /calculator/abc, not /calculators.

The extension mirrors is_allowed() in background.js so students see a live
warning, but the server is always the authority.
"""
import re
from urllib.parse import urlsplit

# Pseudo-domains sent by the extension.
OUTSIDE = "(outside-browser)"
LOCKED = "(locked)"
NEW_TAB = "new-tab"              # the empty new-tab page is always allowed
INTERNAL = {"browser-internal", "local-file"}

_HOST_RE = re.compile(r"^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$")

# Tips shown in the exam editor: (entry host, related entry to suggest, why).
RELATED = [
    ("colab.google.com", "colab.research.google.com", "Colab notebooks open on colab.research.google.com, not colab.google.com."),
    ("colab.research.google.com", "accounts.google.com", "Needed if a student has to sign in to Google to open a notebook."),
    ("docs.google.com", "accounts.google.com", "Needed if a student has to sign in to Google to open the form or document."),
    ("forms.gle", "docs.google.com", "forms.gle short links redirect to docs.google.com/forms/...: add the full form address from the address bar."),
    ("forms.office.com", "login.microsoftonline.com", "Needed if students sign in with a Microsoft account."),
    ("forms.microsoft.com", "login.microsoftonline.com", "Needed if students sign in with a Microsoft account."),
]
# Entries that quietly allow far more than intended.
BROAD = {
    "google.com": "every Google site, including Search, Gemini, Docs, Drive and Gmail",
    "microsoft.com": "every Microsoft site, including Bing and Copilot",
    "office.com": "all of Microsoft 365, including Copilot, Word and OneDrive",
    "live.com": "Outlook, OneDrive and other Microsoft consumer services",
    "github.com": "all of GitHub, including code search and Copilot",
}


def normalise_entry(e: str) -> str | None:
    """Canonical form: lower-case host, optionally followed by /path (case kept)."""
    e = e.strip()
    e = re.sub(r"^[A-Za-z][A-Za-z0-9+.-]*://", "", e)
    e = e.split("?")[0].split("#")[0]
    host, sep, path = e.partition("/")
    host = host.lower().split(":")[0].removeprefix("*.").removeprefix("www.")
    path = path.strip("/")
    if not _HOST_RE.match(host) or re.search(r"\s", path):
        return None
    return f"{host}/{path}" if path else host


def is_allowed(domain: str, path: str, entries: list[str]) -> bool:
    if domain == NEW_TAB:
        return True
    p = (path or "").strip("/")
    for e in entries:
        host, _, prefix = e.partition("/")
        if domain == host or domain.endswith("." + host):
            if not prefix or p == prefix or p.startswith(prefix + "/"):
                return True
    return False


def describe(lines: list[str], test_url: str = "") -> dict:
    """Explain how an allowlist will be applied, for the exam editor preview."""
    rows, entries = [], []
    for raw in lines:
        if not raw.strip():
            continue
        n = normalise_entry(raw)
        row = {"input": raw.strip(), "entry": n, "valid": bool(n)}
        if n:
            entries.append(n)
            host, _, prefix = n.partition("/")
            row.update(host=host, path=prefix, scope="part" if prefix else "site",
                       warning=f"Allows {BROAD[host]}." if host in BROAD and not prefix else "")
        rows.append(row)
    tips, seen = [], set()
    for trig, sugg, why in RELATED:
        s_host, _, s_path = sugg.partition("/")
        if any(e.partition("/")[0] == trig for e in entries) and not is_allowed(s_host, s_path, entries) and sugg not in seen:
            seen.add(sugg)
            tips.append({"add": sugg, "why": why, "offer": trig != "forms.gle"})
    out = {"rows": rows, "tips": tips}
    if test_url.strip():
        u = test_url.strip()
        parts = urlsplit(u if "://" in u else "https://" + u)
        host = (parts.hostname or "").removeprefix("www.")
        match = next((e for e in entries if is_allowed(host, parts.path, [e])), None)
        out["test"] = {"host": host, "path": parts.path, "allowed": bool(match), "by": match or ""}
    return out


def classify(kind: str, domain: str, path: str, entries: list[str], flag_outside: bool):
    """Return (rule, level) if this activity breaks the exam's rules, else None."""
    if kind == "outside":
        return ("left_browser", "HIGH") if flag_outside else None
    if domain == LOCKED:
        return ("screen_locked", "MEDIUM") if flag_outside else None
    if is_allowed(domain, path, entries):
        return None
    if domain in INTERNAL:
        return ("disallowed_page", "MEDIUM")
    return ("disallowed_site", "HIGH")


RULE_LABELS = {
    "disallowed_site": "Visited a site that is not allowed",
    "disallowed_page": "Opened a browser page (settings, extensions, file)",
    "left_browser": "Switched to another app or window",
    "screen_locked": "Screen locked or computer asleep",
    "tab_open": "Has a tab open on a site that is not allowed",
    "monitoring_gap": "No contact from the extension",
    "extension_removed": "Removed the extension during the exam",
    "device_changed": "Rejoined from a different browser",
    "shared_device": "Same browser used for another roll number",
}

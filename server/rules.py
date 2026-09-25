"""Per-exam allowlist and flag rules.

Allowlist entries (one per line in the dashboard):
    exam.university.edu              that host and all its subdomains
    *.university.edu                 same thing, written explicitly
    docs.google.com/forms/d/e/1FAI   only pages whose path starts with this prefix
    https://www.example.com/quiz/    scheme and "www." are ignored

The extension mirrors is_allowed() in background.js so students see a live
warning, but the server is always the authority.
"""
import re

# Pseudo-domains sent by the extension.
OUTSIDE = "(outside-browser)"
LOCKED = "(locked)"
NEW_TAB = "new-tab"              # the empty new-tab page is always allowed
INTERNAL = {"browser-internal", "local-file"}

_ENTRY_RE = re.compile(r"^[a-z0-9.-]+(/[^\s]*)?$")


def normalise_entry(e: str) -> str | None:
    e = e.strip().lower()
    e = re.sub(r"^[a-z]+://", "", e)
    e = e.removeprefix("*.").removeprefix("www.")
    e = e.split("?")[0].split("#")[0].rstrip("/")
    return e if e and _ENTRY_RE.match(e) else None


def is_allowed(domain: str, path: str, entries: list[str]) -> bool:
    if domain == NEW_TAB:
        return True
    p = (path or "").lstrip("/")
    for e in entries:
        host, _, prefix = e.partition("/")
        if domain == host or domain.endswith("." + host):
            if not prefix or p.startswith(prefix):
                return True
    return False


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

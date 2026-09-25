"""Build the extension for a specific server, ready to upload to the Chrome Web Store.

  python build_extension.py --server https://proctor.example.edu
  python build_extension.py --server http://localhost:8000 --dev     # local testing only

Output:
  dist/extension/                        load this with "Load unpacked" to test
  dist/exam-proctor-<ver>.zip   upload this to the Chrome Web Store
"""
import argparse
import json
import shutil
import zipfile
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
SRC, DIST = ROOT / "extension", ROOT / "dist"
PLACEHOLDER = "SERVER_HOST_PLACEHOLDER"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--server", required=True, help="e.g. https://proctor.example.edu")
    p.add_argument("--dev", action="store_true", help="allow http://localhost for testing")
    a = p.parse_args()

    u = urlparse(a.server.rstrip("/"))
    local = u.hostname in ("localhost", "127.0.0.1")
    if u.scheme != "https" and not (a.dev and local):
        raise SystemExit("Use an https:// address. Plain http is only allowed with --dev on localhost.")
    if u.path not in ("", "/") or not u.hostname:
        raise SystemExit("Give only the scheme and host, e.g. https://proctor.example.edu")
    origin = f"{u.scheme}://{u.netloc}"

    out = DIST / "extension"
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(SRC, out)

    cfg = (out / "config.js").read_text()
    (out / "config.js").write_text(cfg.replace(f"https://{PLACEHOLDER}", origin))
    manifest = json.loads((out / "manifest.json").read_text())
    manifest["host_permissions"] = [f"{origin}/*"]
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    zip_path = DIST / f"exam-proctor-{manifest['version']}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(out.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(out))       # manifest.json at the top level of the zip
    print(f"Built for {origin}\n  test folder: {out}\n  store upload: {zip_path}")
    if a.dev:
        print("  DEV BUILD: do not upload this one to the store.")


if __name__ == "__main__":
    main()

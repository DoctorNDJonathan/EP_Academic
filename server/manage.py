"""Server-side admin tasks (run on the server, in server/, with PROCTOR_SECRET set).

  python manage.py create-admin <username>        prompts for a password
  python manage.py reset-password <username>
  python manage.py list-admins
  python manage.py purge --older-than-days 90     delete finished exams' data (retention)

Everything else (exams, allowlists, rosters, reviewing flags, more admins) is
done in the web dashboard.
"""
import argparse
import getpass
import sys

import db


def _prompt(text: str) -> str:
    try:
        return getpass.getpass(text, echo_char="*")   # Python 3.14+: show one * per character typed
    except TypeError:
        return getpass.getpass(text)


def _ask_password() -> str:
    pw = _prompt("Password (10+ characters): ")
    if len(pw) < 10:
        sys.exit("Password too short.")
    if pw != pw.strip():
        sys.exit("Password starts or ends with a space. Type it again without the space.")
    if pw != _prompt("Repeat password: "):
        sys.exit("Passwords do not match.")
    print(f"Password accepted ({len(pw)} characters).")
    return pw


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("create-admin"); a.add_argument("username")
    r = sub.add_parser("reset-password"); r.add_argument("username")
    sub.add_parser("list-admins")
    g = sub.add_parser("purge"); g.add_argument("--older-than-days", type=int, required=True)
    args = p.parse_args()
    db.init()

    with db.conn() as c:
        if args.cmd == "create-admin":
            if c.execute("SELECT 1 FROM admins WHERE username=?", (args.username,)).fetchone():
                sys.exit("That admin already exists. Use reset-password.")
            c.execute("INSERT INTO admins VALUES (?,?,?)", (args.username, db.hash_password(_ask_password()), db.now()))
            print(f"Admin '{args.username}' created. Sign in at /dashboard.")
        elif args.cmd == "reset-password":
            n = c.execute("UPDATE admins SET pw_hash=? WHERE username=?",
                          (db.hash_password(_ask_password()), args.username)).rowcount
            c.execute("DELETE FROM sessions WHERE username=?", (args.username,))
            print("Password reset." if n else "No such admin.")
        elif args.cmd == "list-admins":
            for row in c.execute("SELECT username FROM admins ORDER BY username"):
                print(row["username"])
        elif args.cmd == "purge":
            cutoff = db.now() - args.older_than_days * 86400
            codes = [r["code"] for r in c.execute("SELECT code FROM exams WHERE end_ts<?", (cutoff,))]
            for code in codes:
                for tbl in ("participants", "presence", "events", "flags"):
                    c.execute(f"DELETE FROM {tbl} WHERE exam_code=?", (code,))
                c.execute("DELETE FROM exams WHERE code=?", (code,))
            print(f"Purged {len(codes)} exam(s): {', '.join(codes) or '-'}")


if __name__ == "__main__":
    main()

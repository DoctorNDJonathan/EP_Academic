# Faculty handbook

| File | For | Pages |
|---|---|---|
| `faculty-handbook.pdf` | Colleagues running class tests: accounts, planning, creating a test, test day, reviewing flags, troubleshooting, allowed-site recipes, email templates | 11 |
| `student-guide.pdf` | Students (colleagues forward it with their test code) | 4 |
| `quick-checklist.pdf` | Colleagues: one page per test, before / during / after | 1 |

Sources are in `src/` (HTML + `manual.css` + screenshots in `src/img/`).

To rebuild after a change to the dashboard or the extension (needs Google Chrome):

    zsh handbook/tools/build.sh              # new screenshots from a throwaway local demo, then PDFs
    zsh handbook/tools/build.sh --pdf-only   # text changes only

The demo (`tools/stage_demo.py`) uses made-up students and a random password, and never touches the live server.

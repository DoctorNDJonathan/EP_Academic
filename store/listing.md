# Chrome Web Store listing: text to paste

Developer Dashboard → your item. Copy each block into the matching field.

## Package

Upload `dist/exam-proctor-3.0.0.zip` (built with `python3 build_extension.py --server https://exam-proctor-rhbo.onrender.com`).

## Store listing tab

**Name** (taken from the manifest): Exam Proctor

**Summary** (max 132 characters):
> Keeps you on the sites your instructor allows during an online exam you join. Active only between the exam's start and end.

**Description:**
> Exam Proctor supports the integrity of online exams. Your instructor chooses which websites are allowed for each exam (for example the exam portal and a calculator). Visits to any other site are flagged for review.
>
> How it works
> 1. Your instructor gives you an exam code. At the start of the exam, they announce a PIN.
> 2. Click the extension icon, read the notice, enter the code, your roll number and the PIN, and give consent.
> 3. The popup lists the allowed sites. A green "ON" badge means monitoring is active.
> 4. If you open a site that is not allowed, you get a warning straight away, so you can go back.
> 5. Monitoring stops automatically when the exam ends.
>
> What is checked, only during the exam you joined: the address (host and path, never search terms) and title of your active tab, other open tabs on sites that are not allowed, and when you switch to another app or stop using the keyboard and mouse.
>
> What is never recorded: keystrokes, page content, form entries, search terms, passwords, screenshots, your screen, camera, microphone, location, or anything outside the exam window.
>
> Invigilators review every flag. No decision is made automatically.

**Category:** Education
**Language:** English
**Store icon:** `store/store-icon-128.png` (128×128, artwork in the central 96×96 with transparent padding, as the store recommends)
**Small promo tile (440×280, required):** `store/promo-small-440x280.png`
**Marquee (1400×560):** optional, skip
**Screenshots (1280×800, full bleed):** `store/screenshot-1-join.png`, `store/screenshot-2-monitoring.png`, `store/screenshot-3-warning.png`
**Official URL / Homepage URL:** `https://exam-proctor-rhbo.onrender.com/privacy` (or leave blank)
**Support URL:** optional (an email link or your homepage)

## Privacy practices tab

**Single purpose:**
> During an online exam the student has joined, check that the student stays on the websites the instructor allows, and report other sites and apps to the exam's invigilators.

**Permission justifications:**

| Permission | Justification (paste) |
|---|---|
| `tabs` | Reads the address (host and path, no query string) and title of the active tab, and the addresses of other open tabs, during a joined exam only. These are compared with the exam's list of allowed websites. |
| `idle` | Detects when the screen is locked or there is no keyboard or mouse input during the exam, so inactivity can be distinguished from use of another site. No input content is recorded. |
| `alarms` | Runs a 30-second timer during the exam to send status updates, so invigilators can see that the extension is still active. |
| `storage` | Keeps the exam session and any unsent activity on the device, so nothing is lost if the network drops or Chrome restarts the extension. |
| `notifications` | Warns the student immediately when they open a website that the exam does not allow, so they can return to the exam. |
| Host permission (`https://exam-proctor-rhbo.onrender.com/*`) | Sends exam activity only to the exam server. No other site is contacted. |

**Are you using remote code?** No, I am not using remote code. (All JavaScript is in the package.)

**Data usage: what the extension collects** (tick these):
- [x] Personally identifiable information: roll number entered when joining
- [x] Web history: host, path and title of pages visited during the exam only
- [x] User activity: whether there is keyboard or mouse input and whether Chrome is focused, not what is typed or clicked

(Leave the other categories unticked.)

**Certifications** (tick all three):
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** `https://exam-proctor-rhbo.onrender.com/privacy`

## Distribution tab

- **Payments:** Free of charge
- **Visibility:** **Unlisted** (anyone with the link can install it; it doesn't appear in search)
- **Regions:** All regions (or only the countries your students are in)

## Tips for review

- The reviewer can't join an exam without a code and PIN. If they ask for test access, create an exam `REVIEW1` that runs for 14 days (the maximum), with allowed site `wikipedia.org`, and put its code and PIN in the **Test instructions** field (Privacy practices tab, at the bottom).
- Rejections usually cite a specific policy. Fix that item and resubmit. The most common is a permission justification that doesn't match what the code does, and the ones above do.

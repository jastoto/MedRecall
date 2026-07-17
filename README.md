# MedRecall (web app)

A web app for recording doctor calls and in-person visits, transcribing them, and
saving the transcript as a Word (.docx) document — named by you, filed under the
doctor it's for, saved to your iPhone or Google Drive. No Mac, no App Store, no cost.

You install it by opening it in Safari on your iPhone and tapping "Add to Home
Screen" — it then behaves like an app icon, opens full-screen, and works offline
for everything except transcription and Google Drive.

## Recreating the repo from scratch

This is a full, self-contained package — every file the app needs, not just
the ones that changed since last time. If your existing GitHub repo is in a
confusing state (mismatched files from several rounds of updates, a stray
missing file, etc.), the simplest fix is to delete the repo and recreate it
from this package rather than trying to patch the old one:

1. Delete the old repo (or rename it) and create a fresh one.
2. Upload every file in this package (rename the two `.txt` files back to
   `.js` first — see "A note on uploading the .js files" below).
3. If you'd already set up Google Drive, put your real Client ID back into
   `config.js` (the placeholder one-liner is easy to re-paste — see
   "Optional: enabling the Google Drive save option").
4. Re-enable GitHub Pages for the new repo, same as the first time.

One thing worth knowing: your doctor list, visit history, and app lock
settings live in the browser (on your phone), not in these files — so
recreating the repo doesn't touch any of that. If you were using a different
repo name/URL before, your phone will treat the new address as a brand new
site with empty data; use **Restore from a backup file** in Settings (or your
Drive auto-backup, if that was on) to bring your visits back.

The app icon in this package is a simple placeholder (blue background, mic
glyph) — happy to swap in something custom if you'd like a different look.

## How this differs from a native app

Building an actual App Store-style iOS app requires Xcode, which only runs on
macOS. Since you're on Windows, this is a **web app** instead — it runs entirely
in Safari, and there's no build step or Mac required at any point. The trade-offs:

- **Transcription** runs a real Whisper AI model (OpenAI's open-source speech
  recognition model, via the transformers.js library) directly in the browser
  using WebAssembly. It's meaningfully more accurate than Safari's built-in
  dictation, especially with medical terminology, and audio never leaves your
  phone. It transcribes in the background in ~12-second pieces *while you're
  still recording*, so by the time you tap Stop, only the last few seconds are
  left to process — you'll see the transcript build up live on the Record
  screen. The first use downloads a one-time ~40MB model (cached afterward, so
  it's instant on future visits and works offline). It currently uses the
  "tiny" Whisper model for speed; if you'd rather trade some speed for more
  accuracy, open `app.js`, find `WHISPER_MODEL`, and change it to
  `"Xenova/whisper-base.en"`.
- **Phone calls**: same as any approach — put the call on speakerphone and record
  through the microphone, since no app (native or web) can tap directly into the
  live call audio on iOS.
- **Saving locally**: the browser can't write directly into the Files app the way
  a native app can. Instead, tapping Save opens the iOS share sheet, where you
  choose "Save to Files" (or AirDrop, Mail, etc.) — one extra tap versus a native
  app, but ends up in the same place.
- **History**: your doctor list and visit transcripts are stored in the browser
  (not iCloud-synced) — they'll persist across visits to the app, but clearing
  Safari's site data would remove them. Each saved visit lets you regenerate and
  re-download the .docx at any time from the History tab.

## Getting it onto your iPhone

The simplest way to host this so Safari can open it over HTTPS is GitHub Pages,
using the same GitHub repo you already created.

1. Copy all the files in this `MedRecallWeb` folder into your GitHub repo (replace
   whatever's there from the earlier attempt, or use a fresh repo — either is fine).
2. Push it:
   ```
   git remote add origin https://github.com/yourname/your-repo.git
   git push -u origin main
   ```
   (If you already added a remote for this repo, skip straight to `git push`.)
3. On GitHub.com, go to your repo → **Settings** → **Pages**.
4. Under "Build and deployment", set **Source** to "Deploy from a branch", branch
   `main`, folder `/ (root)`. Save.
5. GitHub will give you a URL like `https://yourname.github.io/your-repo/` — it
   takes a minute or two to go live the first time.
6. On your iPhone, open that URL in **Safari** (must be Safari, not Chrome, for
   "Add to Home Screen" to work as a full app).
7. Tap the Share button → **Add to Home Screen** → Add.
8. Open MedRecall from the home screen icon you just created. Grant the
   microphone and speech recognition permission prompts when asked.

That's it for local-only use — Doctors, Recording, and History all work at this
point.

## Optional: enabling the Google Drive save option

Skip this section entirely if you're fine saving locally. If you want the
"Google Drive" option in the save sheet to work:

1. Go to https://console.cloud.google.com, create a project (or use an existing
   one).
2. Enable the **Google Drive API** for that project (APIs & Services → Library).
3. Under **APIs & Services → Credentials → Create Credentials → OAuth client ID**,
   choose type **Web application**.
4. Under "Authorized JavaScript origins," add your GitHub Pages URL, e.g.
   `https://yourname.github.io` (no trailing slash, no path).
5. Create it, then copy the **Client ID** (looks like
   `123456789-abc.apps.googleusercontent.com`).
6. Open `config.js` in this folder and replace
   `REPLACE_WITH_YOUR_GOOGLE_OAUTH_WEB_CLIENT_ID` with that Client ID.
7. Commit and push the change, wait for GitHub Pages to redeploy, then reload the
   app on your phone.
8. In the app's Settings tab, tap "Sign in with Google" once. After that, "Google
   Drive" becomes available as a save destination.

### Saving into your own "MedRecall" folder (with a subfolder per doctor)

If you already have a folder called **MedRecall** at the top level of your
Drive (not inside another folder), MedRecall will find it and save into it,
instead of scattering files in Drive's root. If no such folder exists yet,
it creates one for you the first time it needs to save something.

Inside that folder, every doctor gets their own subfolder — the first time
you save a visit for "Dr. Smith" to Drive, MedRecall creates (or reuses, if
it already exists) a `MedRecall/Dr. Smith` folder and puts the .docx there.
Later visits for the same doctor go straight into that same folder. The
`MedRecall Backup.json` auto-backup file (see below) stays directly in the
top-level MedRecall folder, not inside any doctor's subfolder, since it
covers everyone. Removing a doctor from MedRecall's Doctors tab does not
delete their Drive subfolder or its files — it only stops you from picking
them for new visits going forward.

To do that lookup, the app requests the broader `drive` scope (full Drive
access) rather than the narrower `drive.file` scope it used before — Google
only lets an app see files/folders it didn't create itself if it's granted
that fuller permission. Because of the wider scope, Google will very likely
show a **"Google hasn't verified this app"** warning on the sign-in screen.
That's expected for a personal project like this one — click **Advanced**,
then **Go to (your app name) (unsafe)** to continue. It's safe here because
you're both the developer and the only user of this app.

If you had already signed in before this change, tap **Sign out** and then
**Sign in with Google** again in Settings once, so Google can prompt you for
the new permission. Note that the sign-in is per-session; if you close
Safari for a while you may need to reconnect next time you save to Drive.

## Repeated phrases in the transcript ("Good morning" x 47, etc.)

Whisper (especially the small, on-device model MedRecall uses) has a known
quirk: if a stretch of the recording has a short burst of speech followed by
a long patch of near-silence — someone says "Good morning" and then there's
dead air while people get settled — it can get stuck and repeat that phrase
over and over to fill the gap. This isn't a bug in your recording; it's how
the model behaves on quiet audio.

Three things now work together to prevent it: MedRecall skips transcribing
any 12-second chunk that's essentially silent to begin with, asks the model
to penalize repeated phrases during generation, and — as a backstop no
matter what — scans each chunk's text (and the finished transcript overall)
for any phrase that repeats 3 or more times back-to-back and collapses it
down to a single instance. Legitimate repeats (saying "no, no" once, or
mentioning "blood pressure" more than once across a visit) are left alone —
only strict, immediate, 3+ repeats get collapsed.

If you still see a repeat slip through, it's easy to fix by hand: tap
**Edit** on the visit in History and delete the extra copies from the
transcript before it goes to Word/PDF/Drive.

## Slow first transcription?

The very first recording you transcribe after installing (or after an update)
downloads the Whisper model — you'll see a progress bar and status text on the
Transcribing screen. On a decent WiFi connection this takes well under a
minute; after that it's cached in the browser and every future transcription
skips straight to processing.

## Back up your data

Your doctor list and visit transcripts are stored only in this browser
(localStorage) — nothing is synced anywhere unless you save individual visits
to Google Drive. That means clearing Safari's site data, switching phones, or
an iOS storage cleanup could wipe them out.

In the Settings tab:
- **Download Backup** saves a `.json` file with your full doctor list and
  visit history (transcripts included, not just file names). Keep a copy
  somewhere off the phone — email it to yourself, save it to Drive, etc.
- **Download All Visits as Word Docs (.zip)** bundles every saved visit into
  one .docx-per-visit zip file, for a human-readable copy of everything.
- **Restore from a backup file** reads a previously downloaded `.json` backup
  back in. It merges rather than replaces — anything already on the phone is
  left alone, and only doctors/visits not already present get added, so it's
  safe to restore onto a phone that already has some data.

Worth doing every so often, and definitely before switching phones.

### Automatic backup to Google Drive

If you've connected Google Drive (Settings → Google Drive → Sign in with
Google), a second option appears: **Auto-backup doctors & visits to Drive**.
Turn it on and MedRecall keeps a single file, `MedRecall Backup.json`, inside
your Drive's **MedRecall** folder updated automatically — a few seconds after
you add/edit/delete a doctor or visit, it pushes the latest doctor list and
visit history to that file (overwriting the previous contents, not creating a
new file each time).

This is a one-way push, not two-way sync — it protects you if you lose the
phone or clear site data, but restoring from it still means downloading that
file from Drive and using **Restore from a backup file** in Settings. If
Drive sync fails (e.g. you're offline, or your Drive sign-in expired), the
status line under the toggle says so, and it retries automatically the next
time something changes.

## Editing a saved visit

Tap **Edit** on any visit in History to change the doctor, visit type,
reason, file name, or the transcript itself — handy for fixing a
transcription mistake you didn't catch at the time. Saving updates the
record inside MedRecall; if you'd already saved the Word document somewhere
(Files, Drive), that existing file isn't touched automatically — tap
**Download .docx** afterward to get a corrected copy to replace it with.

## Face ID / Touch ID app lock (with PIN fallback)

In Settings, **Enable Face ID Lock** sets up a lock screen in front of the
whole app, using your iPhone's built-in biometric authentication (via the
WebAuthn platform authenticator API — no separate account or password
involved). Once enabled:

- The lock screen appears every time you open the app, and again any time
  you switch away and come back (App Switcher, phone lock, another app).
- Tapping **Unlock** triggers the same Face ID/Touch ID prompt you're used
  to elsewhere on your phone.
- **Turn Off** in Settings removes the lock entirely.

Also in Settings, under **Backup PIN**, you can set a 4-8 digit PIN as a
fallback. On the lock screen, tap **Use PIN instead** if Face ID ever fails
or isn't available, and enter your PIN to get in. The PIN is never stored in
plain text — only a salted SHA-256 hash of it is kept in the browser. Use
**Remove PIN** in Settings to take it away again.

Worth understanding: this is a screen lock, not encryption. It stops a
casual glance at your phone from showing medical notes, but the underlying
data in the browser isn't scrambled by this feature — someone with deep
enough access to the browser's storage isn't blocked by it. Treat it as a
privacy screen, not a vault.

**Locked out?** If Face ID ever fails and you don't have a PIN set, the lock
screen has a small **"Trouble unlocking? Turn off app lock"** link at the
bottom. Tapping it (after a confirmation) turns the lock off entirely —
your doctors and visits are untouched, only the lock itself is removed. You
can set Face ID (and a PIN) back up afterward in Settings.

## Choosing a doctor before you record

The Record tab now asks you to pick a doctor first, before visit type —
the Record button stays grayed out until you've chosen one. If the doctor
you need isn't in the list yet, tap **+ Add doctor** right there to add them
without leaving the Record tab.

Whoever you pick carries through automatically: the Save screen at the end
comes pre-filled with that same doctor (you can still change it there if
you picked the wrong one), and the filename suggestion, Word doc content,
and Drive subfolder all use it. After you save, the doctor selection resets
back to "Choose a doctor…" so the next recording starts fresh rather than
defaulting to whoever you saw last — if the discard button is used instead,
though, your doctor choice stays put so you can immediately retry the same
recording.

## A few things worth knowing

- **Recording consent:** rules on recording conversations vary by state and
  country (some require everyone on the call to consent). It's worth letting your
  doctor's office know you're recording, particularly for phone calls. This isn't
  legal advice — check your local law if you're unsure.
- **Editing the transcript:** speech recognition is good but not perfect,
  especially with medical terminology — you get a chance to fix it up before
  saving.
- **Pause/Resume:** tap Pause if the visit gets interrupted (nurse steps in,
  a phone call comes through, etc.) — recording stops cleanly and picks back
  up from where you left off when you tap Resume, with no dead air in the
  transcript.
- **Search & filter:** the History tab has a search box (matches doctor,
  title, or anything in the transcript) and an "All Doctors" dropdown to
  narrow the list to one provider — both apply together and update live as
  you type.
- **Reason for visit:** an optional field in the save sheet (with suggestions
  like "Annual Physical," "Follow-up," "New Symptom" — or type your own) that
  shows up in History, is searchable, and gets its own line in the generated
  Word document.
- **Keeping the screen awake:** while recording, MedRecall asks iOS to keep
  the screen on, so the phone doesn't auto-lock partway through a visit and
  kill the recording. This doesn't stop a manual press of the power button,
  and it does use more battery for the length of the recording — worth
  keeping the phone plugged in for longer visits. If a recording does get
  interrupted (phone manually locked, low battery, etc.), MedRecall detects
  that the microphone was cut off as soon as you return to the app and
  automatically finishes processing whatever was captured, rather than
  leaving the Stop button unresponsive.
- **Browser support:** built for Safari on iOS. The Whisper transcription and
  recording features rely on WebAssembly and MediaRecorder, both of which also
  work fine in Chrome or Edge on desktop, if you ever want to try it there too.
- **PDF export:** every saved visit has a **Download .pdf** button alongside
  **Download .docx**, if you'd rather have a PDF copy.
- **Copy transcript:** a **Copy Text** button (in History, and on the review
  screen right after recording) copies the transcript straight to your
  clipboard — handy for pasting into a message or another app without
  exporting a file first.
- **Delete confirmation:** deleting a doctor or a visit now asks you to
  confirm first, since both actions can't be undone.

## Project structure

All files live at the top level — no subfolders:

```
index.html         App shell + all screens (single page)
manifest.json       PWA metadata (name, icon, "Add to Home Screen" behavior)
service-worker.js   Caches the app shell so it opens instantly / offline
styles.css          All styling
app.js              App logic: recording, transcription, save flow, storage
docx-builder.js     Builds the .docx file client-side (tested — produces a
                     real Word-openable file, verified with python-docx)
pdf-builder.js       Builds the .pdf file client-side (via jsPDF)
config.js            Where you put your Google OAuth Client ID (optional)
icon-192.png         App icon (small)
icon-512.png         App icon (large)
README.md
```

Note: the .docx-building library (JSZip) and the Whisper AI library
(transformers.js) both load from a CDN at `<script>` tags in `index.html`,
the same way the Google Sign-In script does — they aren't local files, so
there's nothing to upload for those.

### A note on uploading the .js files

Some Windows setups block dragging `.js` files out of a downloaded zip, since
Windows treats script files as higher-risk downloads. If that happens to you:
don't fight it locally — instead, create each `.js` file directly on GitHub's
website and paste the contents in:

1. On your repo page, click **Add file → Create new file**.
2. Type the exact filename (e.g. `app.js`) in the name field.
3. Paste in the file's contents (ask whoever gave you this project for the
   text, or copy it from this project before zipping).
4. Scroll down and click **Commit changes**.

Repeat for each `.js` file. This never touches your local filesystem with a
`.js` file at all, so Windows has nothing to block.

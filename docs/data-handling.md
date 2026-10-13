# What Astha stores, and how a user gets it back or removes it

This describes what the code in this repository does. It is the technical basis for the privacy
policy and store declarations, not a substitute for them: the operator's identity and contact,
the legal basis, provider retention and backup handling are owner decisions listed at the end.

## Where data lives

| Data | Where | Notes |
| --- | --- | --- |
| Name, phone number, PIN hash and salt, voice language, speaking mode | Server database (`users`) | The PIN is stored only as a scrypt hash. A guest account has no phone number. |
| Approved object memories, room notes | Server database and this browser | The browser keeps the newest 80 memories and 30 rooms for the signed-in profile under `astha.local.v2.<account id>`, unencrypted. |
| Activity log, agent task history, personal notes | Server database | Agent tasks record the spoken goal, the plan and the result. |
| Face and voice templates | This browser only (`astha.owner.v2.<account id>.*`) | The app never uploads them. The `face_descriptor` column exists for older clients and is cleared by "Forget my face and voice". |
| Interface language, theme, text size, voice choices | This browser | Not personal records; kept when an account is deleted. |
| Personal setup answers: how much the user relies on vision, language, feedback style, devices used, modes, text size, colours, speaking speed, vibration | Server database (one reserved row in `knowledge_docs`, category `astha_preferences`) and this browser (`astha.accessibility.v2`) | The vision answer is information about a disability. It is optional ("Prefer not to say" is the default), is used only to present the app, is included in the export, is removed with the account, is never used as search context, and is cleared from the phone on sign-out. |
| Wi-Fi camera pairing code and pictures | Memory of this app only | The code is never written to storage and is discarded when the camera is disconnected or the app closes. Pictures go from the camera to the phone; they reach the online AI only under the normal online-processing consent. The camera stores and logs nothing. |
| Names of installed apps (Android) | Not stored | Looked up on the phone only when the user says "open the … app", to find the one named. Never uploaded. |
| Text read from other apps (Android, only if the user turned it on) | Not stored | Read on request, spoken, and discarded. Password fields are never read. Nothing is observed in the background. |
| Speech sent to the phone's recognizer (Android app) | The recognizer's provider, usually Google | Outside this server. Not used in Privacy mode. |
| Personal provider key (retired) | Not stored | The app no longer accepts a personal key. A key left by an older version (`astha.gemini`) is deleted from the browser at start-up. |
| Camera or screen frames, prompts, speech text | Sent to the configured provider only after session consent | Not stored by this server. Provider retention is outside this code. |

Request monitoring keeps counters by route and status only. It holds no account identity,
request body, image, audio or phone number; see [operations.md](operations.md).

## Retention on the server

Each account keeps only its newest rows. The limit is applied after every write, so nothing is
kept beyond what the app can still show or search.

| Records | Kept per account |
| --- | --- |
| Object memories | newest 500 |
| Rooms | newest 100 |
| Activity log entries | newest 200 |
| Agent tasks | newest 50 |
| Personal notes | newest 200 |

The limits are in `server/retention.js`. Clearing the activity log also clears agent task history.

## Download

"Download my data" in Your preferences, or saying "download my data", produces one JSON file:

- `account`: the reply of `GET /api/account/export` — profile, memories, rooms, activity,
  agent tasks and personal notes belonging to the signed-in account. The PIN hash and salt
  are never included.
- `this_phone`: the notes, face and voice templates and preferences held in this browser.

A browser saves `astha-my-data.json`. The installed app has no download manager, so it copies
the text to the clipboard, or places it in the reading box when the clipboard is unavailable.
If the account cannot be reached, the file contains only the phone's data and Astha says so.

## Delete

- **One memory, one room, all memories and rooms, the activity log**: the existing controls.
  A deletion made offline is queued and retried; it is reported as pending until the server
  confirms it.
- **Face and voice**: "Forget my face and voice" removes the templates and the owner lock from
  this browser and clears any account copy.
- **The whole account**: "Delete my account" opens a confirmation panel and speaks the warning.
  A registered account must enter its PIN; a guest account confirms without one. The server
  removes the account and every record it owns in one statement, and every session issued for
  that account stops working. The browser then removes that profile's notes, templates,
  personal provider key and unscoped records left by older versions. A wrong PIN, too many
  attempts or an unreachable server delete nothing. The request shares the sign-in attempt limit.

Deletion is immediate in the live database. It does not reach database backups, provider
systems or copies a user has already downloaded.

## Guest accounts

The app starts as a guest so nobody has to type before using it. A guest has no phone number
and no PIN its owner knows.

- "Create account or log in" registers the current guest in place: the account ID and every
  record stay the same.
- Signing in to an existing account from a guest that was never used removes that empty
  guest. A guest that holds records is never removed implicitly.
- Sign out is offered only to registered accounts. A guest is pointed to registration or to
  account deletion, because signing out would leave its records where no one can reach them.

### Why the setup answers are in `knowledge_docs`

The Supabase schema is checked column by column at start-up and a schema change needs a
reviewed migration. Until one is authorized, the setup answers use one reserved row per
account in the existing notes table. The server validates every value against a fixed
list, excludes the row from note listing, deletion, retention pruning and retrieval, and
refuses to create it through the notes API. A dedicated table or column is the cleaner
long-term home and is listed below as an owner decision.

## Decisions that remain with the owner

- The published Bangla and English privacy policy, the operator's identity and a contact for
  data requests, and the Play and App Store data declarations.
- Retention at Maira, Gemini, Microsoft speech and the browser's speech service, and what the
  consent text may promise about them.
- Database backup retention and how a deletion is honoured when a backup is restored.
- The rows of the former shared guest identity, which stay quarantined and unreachable.
- A retention rule for guest accounts that hold records and are never registered. It needs a
  last-used timestamp, which is a schema change.
- Merging a used guest's records into an existing account at sign-in.

- Whether to move the personal setup answers into their own table with a reviewed migration.
- Whether ASTHA's own spoken output may use the online Bangla voice without the broader
  online-processing consent. Today it may not, so a device without a Bangla voice speaks
  English until the user allows online processing.
- Whether asking how much a user relies on vision needs explicit wording or consent under
  the laws that apply to the deployment. This document is not legal advice.

## বাংলা সারসংক্ষেপ

- আস্থা আপনার নাম, ফোন নম্বর, পাসকোডের হ্যাশ, অনুমোদিত জিনিসের স্মৃতি, ঘরের নোট, কার্যক্রমের
  তালিকা ও ব্যক্তিগত নোট সার্ভারে রাখে। মুখ ও কণ্ঠের নমুনা শুধু এই ফোনের ব্রাউজারে থাকে।
- প্রতিটি অ্যাকাউন্টে শুধু সাম্প্রতিক রেকর্ড রাখা হয়: ৫০০টি স্মৃতি, ১০০টি ঘর, ২০০টি কার্যক্রম,
  ৫০টি এজেন্টের কাজ ও ২০০টি ব্যক্তিগত নোট।
- “আমার তথ্য ডাউনলোড” চাপলে বা বললে আপনার সব তথ্য একটি ফাইলে পাওয়া যায়। পাসকোডের হ্যাশ এতে থাকে না।
- “আমার মুখ ও কণ্ঠ ভুলে যাও” নমুনাগুলো এই ফোন থেকে মুছে দেয়।
- “আমার অ্যাকাউন্ট মুছুন” অ্যাকাউন্ট ও এর সব রেকর্ড স্থায়ীভাবে মুছে দেয়। নিবন্ধিত অ্যাকাউন্টে
  পাসকোড দিতে হয়। ভুল পাসকোড দিলে বা সংযোগ না থাকলে কিছুই মোছা হয় না।
- অতিথি অ্যাকাউন্টে ফোন নম্বর বা জানা পাসকোড থাকে না। নোট রাখতে চাইলে “অ্যাকাউন্ট তৈরি বা প্রবেশ”
  থেকে অ্যাকাউন্ট তৈরি করুন; আপনার আগের নোট একই অ্যাকাউন্টে থেকে যাবে।
- ক্যামেরা বা স্ক্রিনের ছবি শুধু আপনার অনুমতির পর অনলাইন সেবায় পাঠানো হয় এবং এই সার্ভারে সংরক্ষিত হয় না।

# Automatic object observations

This is an optional extension to ASTHA's existing object memory. It starts **off for each account on each device**. In Memories, enable **Automatically remember important objects**, or say **“Enable automatic memory”** / **“স্বয়ংক্রিয় স্মৃতি চালু করো”**. Disable it with the same control or **“Turn off automatic memory”** / **“স্বয়ংক্রিয় স্মৃতি বন্ধ করো”**.

While a real phone or paired Pi camera is active in the foreground, ASTHA can save possible sightings of **laptops, phones, glasses, wallets and ID cards**. Other selected portable objects, such as keys or a charger, are offered for individual yes/no approval. Offers wait until the current task and speech finish, avoid reading mode and existing dialogues, and expire. Unknown objects, people, faces, text and identifiers are excluded.

The feature reuses existing local detector checks and the user's existing Describe, Identify and visual question requests. It starts no camera, model download, background recording or recurring cloud request. Local saving works without online permission; account synchronization and online vision retain ASTHA's existing session consent.

Local saves require three high-score, overlapping detector boxes across at least 400 milliseconds. CLIP similarity and heuristic relabeling do not qualify. Wallets, glasses and ID cards require clear structured observations from an already requested online image analysis when a suitable local detector result is unavailable. These gates reduce false records but **do not prove recognition accuracy**. They have regression coverage; real-world recognition still needs device and object validation.

Saved notes say **possible sighting**, preserve the capture time and image position, and state that the physical location is unconfirmed. They never assert a room, surface, ownership or that the user placed the object. No JPEG, ID-card text or numbers are retained by this feature. Existing manually confirmed notes are preserved. Recall remains historical and does not assert an object is still present.

Stop, privacy mode, account changes, source changes, a hidden page and revoked online consent invalidate relevant pending work. Turning the preference off cancels pending offers. Deleting an object memory suppresses automatic recreation for the current session. Clearing all memories turns automatic memory off; it must be enabled again before new observations are saved. Account export includes the current device's automatic-memory preference, and account deletion removes it.

Capture timestamps use the existing `memories.created_at` column through an optional, validated `observed_at` API field. No schema migration, credentials, database grants or new dependency is needed. Existing clients that omit the field keep their current behavior.

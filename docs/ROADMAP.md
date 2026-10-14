# Roadmap

This repo deliberately ships a narrow Round 1 so the core loop -- see, remember, speak -- is
solid before adding scope. What is built, and what comes next.

## Round 1 (this repo)

- Scene and text understanding: point the camera at a board or book, or say "Astha, read this",
  and get a concise spoken explanation in Bangla or English.
- Personal visual memory as *approved* object events ("glasses seen on the bedside table at
  10:05"), answered later with last-seen location, time, and confidence -- never a claim that the
  object is still there.
- Short, safety-conscious Bangla / Bangla-English voice interaction, with a fuzzy intent matcher
  (English, Bangla script, and romanised Bangla) rather than a fixed phrase list.
- Advisory-only obstacle and stair warnings -- explicitly never presented as a replacement for a
  cane or mobility training.
- Astha's eye on a shared computer screen: names the foreground app, finds a button's position,
  confirms when a pop-up has closed, reads what is written, and explains what is on screen:
  slides, documents, designs, web pages or code.
- Continuous reading of any text in view (a board, a page, a slide, a tablet or a screen).
- On Android: announcing new messages and sending the reply the user confirms, also with the
  phone locked (see the [release review](voice-first-release-review.md)).

## Next

- Diagram explanation, full book reading and tutoring.
- Approved familiar-person alerts ("Your mother has entered") -- opt-in per person, on-device
  matching only.
- Home-layout and daily-routine memory beyond single object events.
- Medicine, document, key, and wallet tracking as a dedicated flow (not just generic memory).
- User-selected description detail for congenital versus acquired blindness (how much spatial
  detail to volunteer unprompted).
- Emergency contacts and caregiver setup, including the fall-detection alert path.
- Optional custom or familiar voice packs, beyond the current male/female neural voice choice.
- A real desktop agent for "Astha on your screen" that can act (click, type) rather than only
  narrate and guide by keyboard -- today's screen-sharing view is the interaction design for this,
  not the final mechanism.

## Hardware direction

The phone is the primary brain for the foreseeable future. A Raspberry Pi Zero 2 W or a small
wearable camera is a *future* sensor/communication bridge -- it streams frames and receives
speech, while the heavier vision-language reasoning stays on the phone or in the cloud. Custom
hardware is explicitly not a prerequisite for Astha to be useful.

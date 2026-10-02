# Cook Mode — Hands-Free Recipes

**SIT774 Web Technologies & Development — Task 10.3HD**
Lorrisha Franklin · s226438341 · T2 2026

A working prototype of the *Cook Mode* feature proposed in Task 7.3HD: a
hands-free, voice-guided way to follow a recipe. It reads each step aloud and
responds to spoken commands (**“next”, “back”, “repeat”, “set a 10 minute
timer”, “exit”**) so you never touch the screen with messy hands — while
remaining fully usable by **touch and keyboard** if voice is unavailable.

---

## 1. Run it

It is a static front end — no build step and no backend required.

```bash
# from this folder
python -m http.server 8777
# then open http://127.0.0.1:8777/index.html
```

> **Use `localhost`/HTTPS, not `file://`.** The Service Worker, microphone and
> Wake Lock only run in a *secure context*.
>
> **Voice commands need Chrome or Edge** (the `SpeechRecognition` API).
> Everywhere else the app automatically runs in touch mode — nothing breaks.

To publish: push to a GitHub repo and enable **GitHub Pages** (Settings →
Pages → deploy from branch). The site is served over HTTPS, so every feature
works.

---

## 2. What’s in the project

| File | Responsibility |
|------|----------------|
| `index.html` | The normal recipe page **and** the Cook Mode overlay markup (one `role="dialog"`). |
| `css/styles.css` | Layout, AA-contrast colours, light/dark, ≥44 px targets, voice-state colours. |
| `js/recipes.js` | Recipe data (steps + per-step ingredient hints). Cacheable for offline. |
| `js/app.js` | **The engine** — rendering, the voice state machine, timers, Wake Lock, IndexedDB, Service Worker registration. |
| `sw.js` | Service Worker: pre-caches the app shell, serves cache-first for offline use. |
| `manifest.webmanifest` | Installable-PWA metadata. |

---

## 3. How each feature was built (tutorial)

Everything below is in `js/app.js` unless noted. Section numbers match the
comment banners in that file.

### 3.1 Reading a step aloud — SpeechSynthesis
`speak(text)` creates a `SpeechSynthesisUtterance` and calls
`speechSynthesis.speak()`. **The key trick:** before speaking we *stop*
recognition, and only *restart listening* in the utterance’s `onend`
callback. This stops the microphone from hearing the app’s own voice and
looping.

```js
function speak(text, { thenListen = true } = {}) {
  setVoiceState("speaking");
  stopRecognition();                 // mic off while we talk
  const u = new SpeechSynthesisUtterance(text);
  u.onend = () => { if (thenListen) startListening(); };
  speechSynthesis.speak(u);
}
```

### 3.2 Listening for a command — SpeechRecognition
Detected with `window.SpeechRecognition || window.webkitSpeechRecognition`.
Configured with `continuous = false` (one phrase at a time) and
`maxAlternatives = 3` so the intent matcher can try several guesses. In
`onend`, listening restarts itself — this is the loop that keeps Cook Mode
hands-free.

### 3.3 The voice state machine
`idle → listening → recognised → acting → speaking → listening …`
Tracked in `state.voiceState` and shown by the coloured **listening pill**
(grey = idle, pulsing green = listening, orange = speaking). Keeping the state
explicit is what prevents the mic/synthesis feedback loop.

### 3.4 Understanding commands — intent matching with synonyms
`matchIntent(phrase)` turns free speech into a command:
* a regex pulls a number out of **“set a 10 minute timer”**;
* `step (\d+)` handles **“go to step 3”**;
* otherwise each intent is matched against a list of **synonyms**
  (`next` ← “next”, “continue”, “go on”, “forward” …).

Unmatched speech shows a friendly *“Didn’t catch that…”* hint — the **no-match
state**.

### 3.5 Three-channel feedback
Every action updates **(1) the screen** (step text + progress bar),
**(2) speech** (spoken confirmation) and **(3) assistive tech** via
`aria-live` regions (`aria-live="polite"` on the step, `assertive` on the
status line). This satisfies Nielsen’s *visibility of system status*.

### 3.6 Timers
`startTimer(minutes)` runs a 1-second `setInterval`, renders `mm:ss`, and on
completion speaks the alert and fires a `Notification` (if permitted). Voice,
chip and keyboard (`T`) all call the same function.

### 3.7 Keeping the screen on — Screen Wake Lock
`navigator.wakeLock.request("screen")` on entry; released on exit; re-acquired
on `visibilitychange` when the tab becomes visible again.

### 3.8 Resume where you left off — IndexedDB
On every step change, `saveProgress(stepIndex)` writes
`{recipeId, stepIndex, updatedAt}`. On load, `maybeShowResume()` reads it back
and offers a **Resume** banner. All DB calls are wrapped in `try/catch` so
private-mode failures never break the page.

### 3.9 Works offline — Service Worker + Cache
`sw.js` pre-caches the app shell on `install` and serves **cache-first** with a
network fallback, so the recipe keeps working if the connection drops at the
stove.

### 3.10 The fallback-first design (the important bit)
Voice is a **layer on top of** a complete tap/keyboard UI:
* the command **chips are real buttons** *and* the on-screen hints;
* **keyboard**: `→` next, `←` back, `R` repeat, `T` timer, `Esc` exit;
* if recognition is unsupported or the mic is denied, consent offers
  **“Not now — use touch”** and the exact same view runs silently.

This single decision resolves the browser-support gap, the noisy-kitchen case,
the mic-denied case and the WCAG accessibility requirement at once.

---

## 4. Accessibility, performance, privacy

* **Accessibility** — semantic HTML, `role="dialog"`/`aria-modal`, `aria-live`
  regions, visible focus rings, full keyboard support, ≥44 px targets, AA
  contrast, and voice that is *never required*.
* **Performance** — on-device recognition (no per-command network latency),
  cache-first Service Worker, tiny payload (no audio streamed).
* **Privacy** — just-in-time mic consent with a visible listening state; **no
  audio is sent to or stored on any server**; secure context only.

---

## 5. Links (for the submission)

* **Source code (GitHub):** _<add your repo URL>_
* **Narrated walkthrough (Panopto, ≤10 min):** _<add your Panopto URL>_
* **AI prompt log (≥10 prompts):** _<add your ChatGPT/Claude share URL>_

## References
See the submission PDF for the full, consistently-styled reference list
(Web Speech API, Screen Wake Lock API, Service Worker API, IndexedDB, WCAG 2.1,
Nielsen’s heuristics, Can I Use).

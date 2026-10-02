/* ============================================================================
 * app.js — the Cook Mode engine (SIT774 Task 10.3HD)
 *
 * Cook Mode turns a normal recipe page into a hands-free, voice-guided
 * experience. It is built as a thin layer ON TOP OF a fully working
 * tap/keyboard interface, so if voice is unavailable, denied, or noisy, the
 * page still works perfectly (the central design trade-off from Task 7.3HD).
 *
 * Web platform features used:
 *   - Web Speech API — SpeechSynthesis (read steps aloud) + SpeechRecognition
 *     (voice commands). Feature-detected; recognition is Chromium/Edge only.
 *   - Screen Wake Lock API — keeps the screen awake while cooking.
 *   - Service Worker + Cache — offline load of the app shell and recipe.
 *   - IndexedDB — remembers which step you were on, to resume later.
 *   - Notifications API — alerts when a timer finishes.
 *
 * Voice state machine:  idle → listening → recognised → acting → speaking → …
 * The microphone is paused while the app is speaking so it never hears itself.
 * ========================================================================== */

(() => {
  "use strict";

  /* ----------------------------- DOM references ---------------------------- */
  const $ = (id) => document.getElementById(id);
  const recipe = RECIPES[CURRENT_RECIPE_ID];

  const els = {
    enter: $("enterCookMode"),
    cookMode: $("cookMode"),
    consent: $("consent"),
    enableVoice: $("enableVoice"),
    notNow: $("notNow"),
    unsupportedNote: $("unsupportedNote"),
    cookView: $("cookView"),
    stepText: $("cmStepText"),
    stepIngredients: $("cmStepIngredients"),
    progressNow: $("progressNow"),
    progressTotal: $("progressTotal"),
    progressBar: $("progressBar"),
    listenPill: $("listenPill"),
    listenLabel: $("listenLabel"),
    statusLine: $("statusLine"),
    timerWrap: $("timerWrap"),
    timerDisplay: $("timerDisplay"),
    cancelTimer: $("cancelTimer"),
    chips: document.querySelectorAll(".chip"),
    resumeBanner: $("resumeBanner"),
    resumeText: $("resumeText"),
    resumeBtn: $("resumeBtn"),
    resumeDismiss: $("resumeDismiss"),
    ingredientList: $("ingredientList"),
    methodList: $("methodList")
  };

  /* ------------------------------ App state -------------------------------- */
  const state = {
    stepIndex: 0,
    voiceEnabled: false,       // did the user turn on voice?
    voiceState: "idle",        // idle | listening | speaking
    recognising: false,
    wakeLock: null,
    recognition: null,
    pendingExit: false,        // waiting for spoken "yes" to confirm exit
    timer: { id: null, remaining: 0, tickId: null }
  };

  // Feature detection (used for graceful degradation).
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canRecognise = !!SR;
  const canSynthesise = "speechSynthesis" in window;

  /* ====================================================================== *
   *  1. RENDER THE NORMAL RECIPE PAGE
   * ====================================================================== */
  function renderRecipe() {
    $("recipeTitle").textContent = recipe.title;
    $("recipeSummary").textContent = recipe.summary;
    $("factServes").textContent = "Serves " + recipe.serves;
    $("factTime").textContent = recipe.time;
    $("factSteps").textContent = recipe.steps.length + " steps";
    els.progressTotal.textContent = recipe.steps.length;

    els.ingredientList.innerHTML = recipe.ingredients
      .map((i) => `<li>${escapeHtml(i)}</li>`).join("");

    els.methodList.innerHTML = recipe.steps
      .map((s) => `<li>${escapeHtml(s.text)}</li>`).join("");
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ====================================================================== *
   *  2. INDEXEDDB — remember the current step so cooking can be resumed
   * ====================================================================== */
  const DB = { name: "cookmode", store: "progress", version: 1 };

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) return reject(new Error("no-idb"));
      const req = indexedDB.open(DB.name, DB.version);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB.store)) {
          db.createObjectStore(DB.store, { keyPath: "recipeId" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveProgress(stepIndex) {
    try {
      const db = await openDb();
      const tx = db.transaction(DB.store, "readwrite");
      tx.objectStore(DB.store).put({
        recipeId: recipe.id, stepIndex, updatedAt: Date.now()
      });
    } catch (_) { /* storage may be unavailable (private mode) — ignore */ }
  }

  async function loadProgress() {
    try {
      const db = await openDb();
      return await new Promise((resolve) => {
        const req = db.transaction(DB.store, "readonly")
          .objectStore(DB.store).get(recipe.id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (_) { return null; }
  }

  async function clearProgress() {
    try {
      const db = await openDb();
      db.transaction(DB.store, "readwrite").objectStore(DB.store).delete(recipe.id);
    } catch (_) { /* ignore */ }
  }

  // Offer to resume if a saved position exists and it's not step 1.
  async function maybeShowResume() {
    const saved = await loadProgress();
    if (saved && saved.stepIndex > 0) {
      els.resumeText.textContent = `You were on step ${saved.stepIndex + 1} of ${recipe.steps.length}.`;
      els.resumeBanner.hidden = false;
      els.resumeBtn.onclick = () => { els.resumeBanner.hidden = true; openCookMode(saved.stepIndex); };
      els.resumeDismiss.onclick = () => { els.resumeBanner.hidden = true; clearProgress(); };
    }
  }

  /* ====================================================================== *
   *  3. SERVICE WORKER — offline app shell
   * ====================================================================== */
  function registerServiceWorker() {
    if ("serviceWorker" in navigator) {
      // Registration is best-effort; failure must not break the page.
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  /* ====================================================================== *
   *  4. SCREEN WAKE LOCK — keep the screen on while cooking
   * ====================================================================== */
  async function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
      state.wakeLock = await navigator.wakeLock.request("screen");
    } catch (_) { /* denied / not allowed — not fatal */ }
  }
  async function releaseWakeLock() {
    try { await state.wakeLock?.release(); } catch (_) {}
    state.wakeLock = null;
  }
  // Re-acquire the lock if the tab was hidden and comes back.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !els.cookMode.hidden && !state.wakeLock) {
      requestWakeLock();
    }
  });

  /* ====================================================================== *
   *  5. SPEECH SYNTHESIS — read a step (or any message) aloud
   * ====================================================================== */
  function speak(text, { thenListen = true } = {}) {
    if (!state.voiceEnabled || !canSynthesise) {
      if (thenListen) startListening();   // in touch mode we just keep listening off
      return;
    }
    // Pause recognition so the mic never hears our own voice (prevents loops).
    setVoiceState("speaking");
    stopRecognition();
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0; u.pitch = 1.0;
      u.onend = () => { if (thenListen) startListening(); else setVoiceState("idle"); };
      u.onerror = () => { if (thenListen) startListening(); };
      window.speechSynthesis.speak(u);
    } catch (_) {
      if (thenListen) startListening();
    }
  }

  /* ====================================================================== *
   *  6. SPEECH RECOGNITION — listen for one command, then stop
   * ====================================================================== */
  function buildRecognition() {
    const rec = new SR();
    rec.lang = "en-AU";
    rec.interimResults = false;
    rec.maxAlternatives = 3;
    rec.continuous = false;        // one phrase at a time keeps the state machine simple

    rec.onstart = () => { state.recognising = true; setVoiceState("listening"); };
    rec.onresult = (e) => {
      // Collect all alternatives and try to match an intent from any of them.
      const heard = [];
      for (const result of e.results) {
        for (const alt of result) heard.push(alt.transcript.trim().toLowerCase());
      }
      handleTranscript(heard);
    };
    rec.onerror = (e) => {
      // "no-speech"/"aborted" are normal; just show idle and let the loop continue.
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        // Permission was revoked mid-session — fall back to touch.
        state.voiceEnabled = false;
        setListenLabel("Touch mode");
      }
      state.recognising = false;
    };
    rec.onend = () => {
      state.recognising = false;
      // Auto-restart listening unless we are speaking or the view is closed.
      if (state.voiceEnabled && state.voiceState === "listening" && !els.cookMode.hidden) {
        // small timeout avoids a tight restart loop in some browsers
        setTimeout(() => { if (state.voiceState === "listening") startListening(); }, 250);
      }
    };
    return rec;
  }

  function startListening() {
    if (!state.voiceEnabled || !canRecognise) { setVoiceState("idle"); return; }
    if (state.recognising) return;
    setVoiceState("listening");
    try { state.recognition.start(); } catch (_) { /* already started */ }
  }

  function stopRecognition() {
    if (state.recognition && state.recognising) {
      try { state.recognition.stop(); } catch (_) {}
    }
  }

  /* ====================================================================== *
   *  7. INTENT MATCHER — map what was heard to a command (with synonyms)
   * ====================================================================== */
  const INTENTS = [
    { cmd: "next",   words: ["next", "next step", "continue", "go on", "forward", "after"] },
    { cmd: "back",   words: ["back", "previous", "go back", "last step", "before"] },
    { cmd: "repeat", words: ["repeat", "again", "say again", "repeat that", "what"] },
    { cmd: "exit",   words: ["exit", "quit", "close", "stop cooking", "i'm done", "im done", "finish"] }
  ];

  function matchIntent(phrase) {
    // Timer first, because it carries a number: "set a 10 minute timer".
    const timer = phrase.match(/(\d+)\s*(?:minute|minutes|min|mins)/);
    if (/\btimer\b/.test(phrase) || timer) {
      const mins = timer ? parseInt(timer[1], 10) : 5;
      return { cmd: "timer", minutes: Math.min(Math.max(mins, 1), 180) };
    }
    // "go to step 3"
    const goto = phrase.match(/step\s*(\d+)/);
    if (goto) return { cmd: "goto", step: parseInt(goto[1], 10) };

    for (const intent of INTENTS) {
      if (intent.words.some((w) => phrase === w || phrase.includes(w))) {
        return { cmd: intent.cmd };
      }
    }
    return null;
  }

  function handleTranscript(phrases) {
    // Confirmation handling: if we asked "say yes to exit", check for yes/no.
    if (state.pendingExit) {
      if (phrases.some((p) => /\b(yes|yep|confirm|exit)\b/.test(p))) return doExit();
      if (phrases.some((p) => /\b(no|cancel|keep|stay)\b/.test(p))) {
        state.pendingExit = false;
        return announce("Staying in Cook Mode.", { speak: true });
      }
    }
    for (const p of phrases) {
      const intent = matchIntent(p);
      if (intent) { runCommand(intent, p); return; }
    }
    // Nothing matched — show the "no-match" state briefly.
    announce("Didn’t catch that. Try “next”, “back”, “repeat” or “timer”.", { speak: false });
  }

  /* ====================================================================== *
   *  8. COMMANDS — the "acting" part of the state machine
   * ====================================================================== */
  function runCommand(intent, rawPhrase) {
    setVoiceState("recognised");
    switch (intent.cmd) {
      case "next":   return nextStep();
      case "back":   return prevStep();
      case "repeat": return readStep(true);
      case "goto":   return gotoStep((intent.step || 1) - 1);
      case "timer":  return startTimer(intent.minutes || 5);
      case "exit":   return confirmExit();
      default:       return announce("Unknown command.");
    }
  }

  function nextStep() {
    if (state.stepIndex >= recipe.steps.length - 1) {
      announce("That was the last step. Enjoy your meal!", { speak: true });
      clearProgress();
      return;
    }
    gotoStep(state.stepIndex + 1);
  }
  function prevStep() {
    if (state.stepIndex <= 0) { announce("You’re on the first step.", { speak: true }); return; }
    gotoStep(state.stepIndex - 1);
  }
  function gotoStep(index) {
    state.stepIndex = Math.min(Math.max(index, 0), recipe.steps.length - 1);
    saveProgress(state.stepIndex);
    readStep(false);
  }

  // Render + announce the current step. speakOnly controls whether we re-read it.
  function readStep(isRepeat) {
    const step = recipe.steps[state.stepIndex];
    const n = state.stepIndex + 1;

    els.stepText.textContent = step.text;
    els.progressNow.textContent = n;
    els.progressBar.style.width = (n / recipe.steps.length * 100) + "%";

    if (step.needs && step.needs.length) {
      els.stepIngredients.textContent = "You’ll need: " + step.needs.join(", ");
      els.stepIngredients.hidden = false;
    } else {
      els.stepIngredients.hidden = true;
    }

    const spoken = `Step ${n}. ${step.text}`;
    setStatus(isRepeat ? "Repeating step " + n : "Step " + n + " of " + recipe.steps.length);
    speak(spoken, { thenListen: true });
  }

  /* ====================================================================== *
   *  9. TIMERS — "set a 10 minute timer"
   * ====================================================================== */
  function startTimer(minutes) {
    cancelTimer(false);
    state.timer.remaining = minutes * 60;
    els.timerWrap.hidden = false;
    renderTimer();
    announce(`Timer set for ${minutes} minute${minutes === 1 ? "" : "s"}.`, { speak: true });

    state.timer.tickId = setInterval(() => {
      state.timer.remaining -= 1;
      renderTimer();
      if (state.timer.remaining <= 0) finishTimer(minutes);
    }, 1000);
  }

  function renderTimer() {
    const r = Math.max(state.timer.remaining, 0);
    const mm = String(Math.floor(r / 60)).padStart(2, "0");
    const ss = String(r % 60).padStart(2, "0");
    els.timerDisplay.textContent = `${mm}:${ss}`;
  }

  function finishTimer(minutes) {
    cancelTimer(false);
    const msg = `Your ${minutes} minute timer is done.`;
    announce(msg, { speak: true });
    // Notification (if the user granted permission earlier).
    if ("Notification" in window && Notification.permission === "granted") {
      try { new Notification("Cook Mode", { body: msg }); } catch (_) {}
    }
  }

  function cancelTimer(announceIt = true) {
    if (state.timer.tickId) clearInterval(state.timer.tickId);
    state.timer.tickId = null;
    state.timer.remaining = 0;
    els.timerWrap.hidden = true;
    if (announceIt) announce("Timer cancelled.", { speak: true });
  }

  /* ====================================================================== *
   *  10. EXIT (destructive → confirm by voice, instant by tap/keyboard)
   * ====================================================================== */
  function confirmExit() {
    // Spoken confirmation only matters in voice mode; tap/keyboard exits now.
    if (state.voiceEnabled) {
      state.pendingExit = true;
      announce("Say “yes” to exit Cook Mode, or “no” to stay.", { speak: true });
    } else {
      doExit();
    }
  }

  function doExit() {
    state.pendingExit = false;
    stopRecognition();
    if (canSynthesise) window.speechSynthesis.cancel();
    cancelTimer(false);
    releaseWakeLock();
    els.cookMode.hidden = true;
    document.body.classList.remove("no-scroll");
    els.enter.focus();            // return focus to the trigger (accessibility)
  }

  /* ====================================================================== *
   *  11. UI STATE HELPERS (visual + spoken + assistive = 3-channel feedback)
   * ====================================================================== */
  function setVoiceState(s) {
    state.voiceState = s;
    els.listenPill.classList.remove("state-idle", "state-listening", "state-speaking", "state-recognised");
    els.listenPill.classList.add("state-" + s);
    if (!state.voiceEnabled) { setListenLabel("Touch mode"); return; }
    setListenLabel({
      idle: "Ready", listening: "Listening…", speaking: "Speaking…", recognised: "Got it"
    }[s] || "Ready");
  }
  function setListenLabel(t) { els.listenLabel.textContent = t; }
  function setStatus(t) { els.statusLine.textContent = t; }

  // announce(): status line (+ optional speech). Used for feedback messages.
  function announce(text, { speak: alsoSpeak = false } = {}) {
    setStatus(text);
    if (alsoSpeak) speak(text, { thenListen: true });
  }

  /* ====================================================================== *
   *  12. OPENING COOK MODE (just-in-time consent, then the active view)
   * ====================================================================== */
  function openCookMode(startAt = 0) {
    state.stepIndex = startAt;
    els.cookMode.hidden = false;
    document.body.classList.add("no-scroll");
    els.cookView.hidden = true;
    els.consent.hidden = false;

    // If recognition is unsupported, explain and steer to touch mode.
    els.unsupportedNote.hidden = canRecognise;
    requestWakeLock();
    els.enableVoice.focus();
  }

  async function enterVoiceMode() {
    els.consent.hidden = true;
    els.cookView.hidden = false;

    if (canRecognise) {
      state.voiceEnabled = true;
      state.recognition = buildRecognition();
      // Ask for notification permission so timer alerts can fire (optional).
      if ("Notification" in window && Notification.permission === "default") {
        try { Notification.requestPermission(); } catch (_) {}
      }
    } else {
      state.voiceEnabled = false; // graceful fallback
    }
    setVoiceState(state.voiceEnabled ? "idle" : "idle");
    readStep(false);              // shows + (in voice mode) speaks step 1, then listens
  }

  function enterTouchMode() {
    els.consent.hidden = true;
    els.cookView.hidden = false;
    state.voiceEnabled = false;
    setVoiceState("idle");
    setListenLabel("Touch mode");
    readStep(false);
  }

  /* ====================================================================== *
   *  13. INPUT WIRING — tap chips + keyboard shortcuts (always available)
   * ====================================================================== */
  function wireControls() {
    els.enter.addEventListener("click", () => openCookMode(0));
    els.enableVoice.addEventListener("click", enterVoiceMode);
    els.notNow.addEventListener("click", enterTouchMode);
    els.cancelTimer.addEventListener("click", () => cancelTimer(true));

    // Chips double as tap controls. They map to the same command handler.
    els.chips.forEach((chip) => {
      chip.addEventListener("click", () => {
        const cmd = chip.dataset.cmd;
        if (cmd === "timer") return startTimer(5);
        if (cmd === "exit")  return doExit();           // tap exit is instant
        runCommand({ cmd });
      });
    });

    // Keyboard shortcuts (accessibility + desktop convenience).
    document.addEventListener("keydown", (e) => {
      if (els.cookMode.hidden || !els.cookView.hidden === false) { /* noop */ }
      if (els.cookMode.hidden) return;
      switch (e.key) {
        case "ArrowRight": e.preventDefault(); nextStep(); break;
        case "ArrowLeft":  e.preventDefault(); prevStep(); break;
        case "r": case "R": readStep(true); break;
        case "t": case "T": startTimer(5); break;
        case "Escape":     e.preventDefault(); doExit(); break;
      }
    });
  }

  /* ------------------------------- Boot ----------------------------------- */
  function init() {
    renderRecipe();
    wireControls();
    registerServiceWorker();
    maybeShowResume();
  }

  document.addEventListener("DOMContentLoaded", init);
})();

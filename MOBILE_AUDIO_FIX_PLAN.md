# Mobile Audio Fix Plan — xox-clone

Planning document. **No site source files were modified.** Investigated on 2026-08-02 against:

- `/Users/paulbridges/Desktop/xoxo/xox-clone/assets/index-DjTFcfxW.js` (984,860 bytes, minified single-line ESM)
- `/Users/paulbridges/Desktop/xoxo/xox-clone/index.html` (6,730 bytes)
- `/Users/paulbridges/Desktop/xoxo/xox-clone/assets/connect4.js` (47,141 bytes — **contains zero audio code**; only dispatches `xox-players` / `xox-step`. No changes needed here.)

---

## 0. Executive summary — one root cause explains BOTH bugs

**WebKit does not grant user activation on `touchstart`. Only `touchend` (plus `click`, `mousedown`, `keydown`, `pointerup`) counts.** This is documented by Apple in [The User Activation API (WebKit blog)](https://webkit.org/blog/13862/the-user-activation-api/):

> WebKit treats these as activation-triggering events: `keydown` (excluding Escape), `mousedown`, `pointerdown` (mouse only), `pointerup` (non-mouse), and `touchend`. **`touchstart` is NOT included.**

Independently confirmed in the wild by [miniaudio#759 "Safari on iOS17 does not play audio after first touch"](https://github.com/mackron/miniaudio/issues/759):

> "Removing `touchstart` from `miniaudio.unlock_event_types` makes it work, as the criteria for autoplay is met only when the first finger is removed from the screen."

Both audio systems in this project (a) attempt their unlock on **`touchstart`**, and (b) **latch a "already tried" boolean unconditionally**, so the doomed `touchstart` attempt burns the one and only retry. On iOS the later `mousedown`/`click` (which *would* have activation) arrives to find the latch already closed. Result: permanently silent, no error, forever. Exactly the reported symptoms.

Corrected details vs. the original bug report:

| Claim in report | Actual code |
|---|---|
| "Nothing ever calls `.resume()`" | **False.** There *is* a resume path in the `Sr`/`Li` constructor. It is gated behind `this.pendingInput`, which is initialised `!0` (true) and set to `!1` after the **first** gesture regardless of outcome. |
| Class is `Li` | `Li` is an alias: `const Sr = class Sr {...}; g(Sr,"_instance"); let Li=Sr;` — patch strings must use `Sr` inside the class body. |
| `xe()` bails on `state==="suspended"` | Correct, and it also bails silently on Safari's 4th state `"interrupted"` (because `"interrupted" !== "suspended"` is true → it *proceeds*, scheduling sounds into a dead context). Both need handling. |
| Playwright test proved the music fix | Playwright's default AudioContext state is **`"running"`** ([playwright#33590](https://github.com/microsoft/playwright/issues/33590)) and headless Chromium defaults to `--autoplay-policy=no-user-gesture-required`. The old test **could not have detected either bug**. See §4. |

### Before touching code: rule out two non-bugs

Have the user confirm on the actual device, because both produce "no sound, no error":

1. **Ringer / silent switch.** On iOS Safari, silent mode mutes *both* Web Audio and HTML5 `<audio>`; there is no web API to detect it or opt out ([Why iOS Silent Mode Breaks Web Audio](https://joodi.medium.com/why-i-os-silent-mode-breaks-audio-in-web-apps-aedcbeef7bca)). `AudioContext.resume()` does not bypass it.
2. **Low Power Mode**, which blocks media autoplay outright.

---

## 1. Confirmed current state of the code

### 1a. Web Audio engine (SFX) — bundle offset ≈ 504,600

```js
const Sr = class Sr {
  constructor(){
    g(this,"pendingInput",!0);                          // <-- initialised TRUE
    g(this,"onStateChange",()=>{ … this.ready = this.context.state==="running" … });
    g(this,"visibilityChange",()=>{
      !document.hidden && this.context.state!=="running" && (this.context.suspend(), this.pendingInput=!0)
    });
    this.ticker=new aO,
    this.context=new AudioContext,                      // created during preload, NOT in a gesture
    document.addEventListener("visibilitychange",this.visibilityChange),
    this._muted=!1,
    this.master=this.context.createGain(), this.master.gain.value=1,
    this.master.connect(this.context.destination),
    ["mousedown","keydown","touchstart"].forEach(e=>document.addEventListener(e,()=>{
      this.context.state==="suspended" && this.pendingInput && (
        this.context.resume().catch(e=>{console.error(e)}),
        this.pendingInput=!1                            // <-- THE BUG: latch burned by touchstart
      )
    })),
    this.context.onstatechange=this.onStateChange, this.onStateChange(),
    this.library=new JL, this.subtitles=new iO, this.music=new nO(this)
  }
  static get instance(){ return Sr._instance||(Sr._instance=new Sr), Sr._instance }
  static createBundle(){ return new rO(Sr.instance) }
  static play(e,t={}){ … if(!s.library.has(e)) return console.warn(…),null; … }
  static pause(){ Sr.instance.context.suspend() }
  static resume(){ Sr.instance.context.resume() }
  setMute(e){ this._muted=e, Sr.instance.master.gain.value = e?0:1 }
};
g(Sr,"_instance"); let Li=Sr;
```

Failure sequence on iOS, tap #1:

1. `touchstart` (document, bubble) → `state==="suspended"` ✔, `pendingInput` ✔ → `resume()` called **with no user activation**. Safari does not reject; the promise resolves and the state simply stays `suspended`, so the `.catch(console.error)` never even logs. `pendingInput = false`.
2. ~50 ms later iOS synthesises `mousedown` (which *does* carry activation) → handler runs → `pendingInput` is already `false` → **no-op**.
3. Every subsequent tap: same no-op. Context stays `suspended` for the whole session.

Secondary problems in the same block:

- Listeners are **bubble-phase, non-capture** on `document`. The bundle ships Vue's `.stop` modifier machinery (`c6={stop:r=>r.stopPropagation(),…}`), so a component can silently hide gestures from these listeners.
- No `webkitAudioContext` fallback (only matters < iOS 14.5 — low priority).
- No silent-buffer primer. Howler's default unlock plays a 1-sample buffer on the unlock gesture ([howler.js](https://github.com/goldfire/howler.js/)); it is cheap insurance on older iOS.
- `visibilityChange` calls `context.suspend()` whenever the page becomes visible and state isn't `running` — which converts Safari's `"interrupted"` state (after a phone call / backgrounding) into `"suspended"` and then relies on the now-burned latch. See [howler.js#928 "Handle audio context state of interrupted"](https://github.com/goldfire/howler.js/pull/928) and [web-audio-api#2585](https://github.com/WebAudio/web-audio-api/issues/2585).

### 1b. The SFX trigger `xe()` — bundle offset ≈ 506,428 (verified unique)

```js
function xe(r){
  if(r.startsWith("MUSIC_"))return null;
  if(!(Li.instance.context.state!=="suspended"))return null;
  const t=r.startsWith("MUSIC_")?.5:1;                 // dead ternary — MUSIC_ already returned
  return Li.play(r,{volume:t})
}
```

31 call sites in the bundle, 0 in `connect4.js`. Note `xe("MUSIC_vs")`, `xe("MUSIC_start")`, `xe("MUSIC_win"/"MUSIC_lose"/"MUSIC_draw")` are all **dead by design** (early return) — do not "fix" those; the separate `index.html` player owns music now. `$l()` (bare `return;` first statement) and its partner `zl()` are likewise the deliberately-disabled legacy engine music path — leave them alone.

Assets are all present and correct: `assets/game_audio-Ve9oyfJI.mp3` (4.6 MB sprite) + `assets/game_audio-sd2rnhTe.json`.

### 1c. HTML5 music player — `index.html` lines 42–137

Current shape (post-previous-fix):

```js
var audio = null, started = false;
function ensureAudio(){ if(!audio){ audio = new Audio(); audio.muted = muted; } return audio; }
function playTrack(src, opts){
  var a = ensureAudio();
  a.onended=null; a.pause();
  a.src = src;
  a.loop = !!opts.loop;
  a.volume = opts.volume != null ? opts.volume : 1;
  a.currentTime = 0;                          // (a) risky, (b) pointless after src assign
  var p = a.play(); if(p) p.catch(…);
}
function start(){ if(!started){ started = true; ensureAudio(); playNext(); } }
window.addEventListener('keydown',   start, true);
window.addEventListener('mousedown', start, true);
window.addEventListener('touchstart',start, true);   // <-- fires FIRST on iOS, has no activation
```

Four independent iOS problems here, in order of severity:

1. **Same latch bug.** `touchstart` fires before `mousedown`/`click`, sets `started = true`, `new Audio()` + `play()` → `NotAllowedError`, and no later gesture ever retries. **This is why the "reuse one element" fix didn't help — the problem was never element reuse; it's that the single attempt happens on the one event iOS refuses to honour.**
2. **`.src` swapping loses permission on modern iOS.** Reusing one element is *not* sufficient: "After audio ends, changing the audio src/source in iOS/Safari 17.2.1 does not allow automatic playback, whereas it worked on iOS 17.1.2." Apple's own guidance is the inverse of what this code does — have the element **already in the DOM** and set `src` + `play()` inside the gesture ([iOS-Specific Considerations](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/Using_HTML5_Audio_Video/Device-SpecificConsiderations/Device-SpecificConsiderations.html)). Track switches here happen **long after** any gesture (`xox-vs`, `xox-game` are fired by the state machine), so a src swap at that moment has no activation to lean on.
3. **`new Audio()` is detached from the DOM.** Safari "may delay or fail to attach `play()` … if the element is not added to the DOM before playback is requested."
4. **`a.volume = 0.4` is a silent no-op on iOS.** `volume` is not settable on iOS and always reads `1` ([Apple docs](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/Using_HTML5_Audio_Video/Device-SpecificConsiderations/Device-SpecificConsiderations.html), [mdn/browser-compat-data#13554](https://github.com/mdn/browser-compat-data/issues/13554)). Only `muted` works. So `song2.mp3` and `song3.mp3` play at **full** volume on iPhone. If that's too loud, re-encode those two mp3s ~8 dB quieter — there is no JS fix that doesn't route through Web Audio (which would then be subject to the silent switch).

Minor: `a.currentTime = 0` right after `a.src = …` is redundant (a new `src` restarts at 0) and WebKit has historically thrown `InvalidStateError` when seeking at `readyState === HAVE_NOTHING`. If it throws, `playTrack` aborts **before** `a.play()`. Delete it or wrap in `try/catch`.

Also note: **iOS never preloads** (`preload` is ignored). `song3.mp3` is 5.5 MB and `song-loading.mp3` 3.0 MB, so the download only begins at `play()` — expect multi-second silence on cellular even once the bug is fixed. One-element-per-track (Fix 3) means each element's fetch starts at the *first gesture*, which materially improves this.

---

## 2. Fixes

All bundle edits are exact-string find/replace. **Every `old` string below was verified to occur exactly once** in `assets/index-DjTFcfxW.js` as of this writing (re-verify before editing; offsets drift).

### Fix 1 — Web Audio unlock: retry on every gesture, include `touchend`, capture phase, silent-buffer primer

**File:** `assets/index-DjTFcfxW.js`

**Find** (1 occurrence):
```
["mousedown","keydown","touchstart"].forEach(e=>document.addEventListener(e,()=>{this.context.state==="suspended"&&this.pendingInput&&(this.context.resume().catch(e=>{console.error(e)}),this.pendingInput=!1)}))
```

**Replace with:**
```
["touchend","pointerup","click","mousedown","keydown","touchstart"].forEach(e=>document.addEventListener(e,()=>{const t=this.context;if(t.state==="running"||t.state==="closed")return;t.resume().catch(()=>{});try{const s=t.createBufferSource();s.buffer=t.createBuffer(1,1,22050),s.connect(t.destination),s.start(0)}catch{}},{capture:!0,passive:!0}))
```

What changed and why each part matters:

- **`touchend` / `pointerup` / `click` added** — the only touch events WebKit accepts as activation.
- **`pendingInput` latch removed from the handler.** The handler now runs on *every* gesture until `state === "running"`. This is the single most important change: it is impossible to know synchronously whether `resume()` will take effect (Safari resolves the promise without changing state), so the only correct strategy is *keep trying until the state says otherwise*. `touchstart` is kept in the list because it costs nothing and helps Android/desktop; it can no longer poison the retry.
- **`state === "running"` instead of `state === "suspended"`** — also retries out of Safari's `"interrupted"` state (post-phone-call / post-backgrounding).
- **`{capture:true}`** — Vue `.stop` modifiers and component handlers can no longer hide gestures from the unlock.
- **`{passive:true}`** — the handler never calls `preventDefault`, so this avoids scroll-blocking listener warnings and jank. (Note the CSS already uses `touch-action:none` on the app surface.)
- **Silent 1-sample buffer primer** — the classic Howler/`ios-unlock` insurance; a no-op where unnecessary, wrapped in `try{}catch{}` so it can never throw inside a listener.
- `pendingInput` the *field* is left in place (still declared, still written by `visibilityChange`) so nothing else breaks; it is simply no longer consulted.

### Fix 2 — `xe()`: stop no-oping silently, opportunistically resume, handle `"interrupted"`

**File:** `assets/index-DjTFcfxW.js`

**Find** (1 occurrence):
```
function xe(r){if(r.startsWith("MUSIC_"))return null;if(!(Li.instance.context.state!=="suspended"))return null;const t=r.startsWith("MUSIC_")?.5:1;return Li.play(r,{volume:t})}
```

**Replace with:**
```
function xe(r){if(r.startsWith("MUSIC_"))return null;const e=Li.instance.context;return e.state!=="running"?(e.state!=="closed"&&e.resume().catch(()=>{}),null):Li.play(r,{volume:1})}
```

- Keeps the early return when the context isn't running. **This guard must stay** — `Li.play()` schedules `AudioBufferSourceNode`s on the context clock, so calling it while suspended would queue up every missed SFX and fire them as one burst the instant the context resumes.
- `state !== "running"` now also excludes `"interrupted"`, which the old `!== "suspended"` test wrongly let through.
- Adds a best-effort `resume()` on the way out. Many `xe()` call sites *are* inside gesture handlers (`UI_cta`, `UI_custom-select`, `UI_click-validation`, …), so this gives a second, independent unlock path straight from a real click.
- Dead ternary collapsed to `1` (the `MUSIC_` branch is unreachable — it returned two statements earlier).

### Fix 3 — `index.html`: one pre-created, pre-primed DOM `<audio>` element per track; never swap `src`; retry until confirmed

**File:** `index.html`. Replace the **entire first `<script>` IIFE in `<body>` (lines 42–137)** with the following. This is a rewrite rather than a patch because the element-per-track change touches every function.

```html
<script>
  // Mobile-safe music playlist.
  //
  // Three iOS Safari constraints drive this design:
  //  1. WebKit grants user activation on touchend/click/mousedown/keydown --
  //     NEVER on touchstart. So we must (a) listen to touchend, and (b) never
  //     latch "already tried" until playback is actually CONFIRMED, because the
  //     first attempt may be a touchstart that cannot possibly succeed.
  //  2. Reassigning .src on an already-unlocked element loses autoplay
  //     permission on iOS >= 17.2. So we use ONE ELEMENT PER TRACK and never
  //     touch .src after setup.
  //  3. Elements must live in the DOM, and every element that will ever be
  //     played needs to be primed (muted play/pause) inside the unlock gesture.
  //
  // Also: .volume is a no-op on iOS (always 1). Only .muted works.
  (function () {
    var TRACKS = {
      intro:   { src: './assets/song2.mp3',        loop: true,  volume: 0.4 },
      loading: { src: './assets/song-loading.mp3', loop: true,  volume: 1 },
      vs:      { src: './assets/song-vs.mp3',      loop: false, volume: 1 },
      game:    { src: './assets/song3.mp3',        loop: false, volume: 0.4 }
    };
    var ORDER = ['intro', 'loading'];   // auto-advance chain on first gesture

    var els = {};       // name -> HTMLAudioElement (in DOM, src set, never reassigned)
    var host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';

    Object.keys(TRACKS).forEach(function (name) {
      var t = TRACKS[name];
      var el = document.createElement('audio');
      el.src = t.src;                 // set ONCE, at parse time, never again
      el.loop = t.loop;
      el.preload = 'none';            // iOS ignores this anyway
      el.setAttribute('playsinline', '');
      el.volume = t.volume;           // desktop only; ignored on iOS
      host.appendChild(el);
      els[name] = el;
    });
    (document.body || document.documentElement).appendChild(host);

    var primed = false;       // muted play/pause done for every element
    var unlocked = false;     // CONFIRMED audible playback -- only then stop retrying
    var muted = false;
    var paused = false;
    var wanted = null;        // track name the app wants playing right now
    var orderIdx = -1;
    var lastError = null;

    function primeAll() {
      if (primed) return;
      primed = true;
      Object.keys(els).forEach(function (n) {
        var el = els[n];
        try {
          el.muted = true;
          var p = el.play();
          if (p && p.then) p.then(function () { el.pause(); }, function () {});
          else el.pause();
        } catch (e) { /* ignore */ }
      });
    }

    function apply() {
      Object.keys(els).forEach(function (n) {
        var el = els[n];
        if (n === wanted) return;
        if (!el.paused) { try { el.pause(); } catch (e) {} }
      });
      if (!wanted || paused) return;
      var el = els[wanted];
      el.muted = muted;
      el.volume = TRACKS[wanted].volume;   // no-op on iOS
      var p;
      try { p = el.play(); } catch (e) { lastError = e && e.name; return; }
      if (p && p.then) {
        p.then(function () {
          unlocked = true;
          detachUnlockListeners();
        }, function (err) {
          lastError = err && err.name;     // NotAllowedError on iOS w/o activation
        });
      } else if (!el.paused) {
        unlocked = true;
        detachUnlockListeners();
      }
    }

    function playTrack(name) {
      wanted = name;
      paused = false;
      primeAll();
      apply();
    }

    // ---- unlock: retry on EVERY gesture until confirmed --------------------
    var UNLOCK_EVENTS = ['touchend', 'pointerup', 'click', 'mousedown', 'keydown', 'touchstart'];
    function onGesture() {
      if (unlocked) return;
      primeAll();
      if (wanted === null) { orderIdx = 0; wanted = ORDER[0]; wireAdvance(); }
      apply();
    }
    function detachUnlockListeners() {
      UNLOCK_EVENTS.forEach(function (t) {
        window.removeEventListener(t, onGesture, true);
      });
    }
    UNLOCK_EVENTS.forEach(function (t) {
      // capture phase so the game's own handlers cannot stopPropagation these
      window.addEventListener(t, onGesture, { capture: true, passive: true });
    });

    function wireAdvance() {
      els[ORDER[ORDER.length - 1]].onended = null;
      ORDER.forEach(function (n, i) {
        els[n].onended = els[n].loop ? null : function () {
          if (i + 1 < ORDER.length) { orderIdx = i + 1; playTrack(ORDER[i + 1]); }
        };
      });
    }

    // ---- app events -------------------------------------------------------
    window.addEventListener('xox-mute', function (e) {
      muted = !!e.detail;
      Object.keys(els).forEach(function (n) { els[n].muted = muted; });
    });
    window.addEventListener('xox-pause', function (e) {
      paused = !!e.detail;
      if (paused) { Object.keys(els).forEach(function (n) { try { els[n].pause(); } catch (x) {} }); }
      else apply();
    });
    window.addEventListener('xox-letsgo', function () {
      if (wanted === 'loading' || wanted === 'vs' || wanted === 'game') return;
      playTrack('loading');
    });
    window.addEventListener('xox-vs', function () { playTrack('vs'); });
    var gameLastStart = 0;
    window.addEventListener('xox-game', function () {
      var now = Date.now();
      if (now - gameLastStart < 1500) return;   // ignore duplicate triggers
      gameLastStart = now;
      try { els.game.currentTime = 0; } catch (e) {}   // WebKit can throw at HAVE_NOTHING
      playTrack('game');
    });

    // ---- diagnostics (see section 4) --------------------------------------
    window.__xoxMusic = {
      els: els,
      state: function () {
        var out = { wanted: wanted, unlocked: unlocked, primed: primed, muted: muted, paused: paused, lastError: lastError, tracks: {} };
        Object.keys(els).forEach(function (n) {
          var el = els[n];
          out.tracks[n] = { paused: el.paused, t: +el.currentTime.toFixed(2), rs: el.readyState, err: el.error && el.error.code, muted: el.muted };
        });
        return out;
      }
    };
  })();
</script>
```

Behaviour changes worth calling out for review:

- The `intro → loading` auto-advance is preserved via `wireAdvance()`, but since both are `loop:true` the `onended` chain is inert exactly as it is today (matching current behaviour: `song2` loops until `LET'S GO`).
- `xox-letsgo` now guards against going *backwards* from `vs`/`game`, matching the old `if (current >= 1) return;` intent more robustly.
- Track switches (`xox-vs`, `xox-game`) no longer need any activation at all, because every element was already unlocked during priming and its `src` never changes.
- `unlocked` is set **only** on a resolved `play()` promise (or an observably non-paused element), and the unlock listeners stay attached until then.
- **Bandwidth caveat:** `primeAll()` calls `play()` on all four elements, which starts four fetches totalling ~12 MB. Each is paused within a microsecond and `preload='none'` means Safari stops buffering a paused element, so in practice only a small prefix of each is fetched — but verify this on a throttled connection (T5 / Playwright `--network` throttling or DevTools "Slow 3G"). If it proves costly, narrow priming to `['intro','loading','vs','game']` minus tracks that are reachable only much later, and re-prime `game` on the `xox-vs` event (which is itself only ~one screen ahead) — but never defer priming past the last event that can still coincide with a gesture.

### Fix 4 (optional, recommended) — debug hook for the Web Audio engine

Needed for device debugging (§4.3) because the minified engine is otherwise unreachable from the console.

**Find** (1 occurrence): `g(Sr,"_instance");let Li=Sr;`
**Replace with:** `g(Sr,"_instance");let Li=Sr;window.__xoxAudio=Sr;`

### Fix 5 (optional) — stop `visibilityChange` fighting the `"interrupted"` state

**Find** (1 occurrence):
```
g(this,"visibilityChange",()=>{!document.hidden&&this.context.state!=="running"&&(this.context.suspend(),this.pendingInput=!0)})
```
**Replace with:**
```
g(this,"visibilityChange",()=>{!document.hidden&&this.context.state!=="running"&&(this.context.resume().catch(()=>{}),this.pendingInput=!0)})
```
Try to resume on return-to-foreground rather than forcing a suspend. Low risk, but ship it *after* Fixes 1–3 are confirmed so it does not confound the diagnosis.

### Explicitly NOT changing

- `$l()` / `zl()` — deliberately-dead legacy engine music. Leave the bare `return;`.
- `xe("MUSIC_*")` call sites — intentionally dead; music is owned by `index.html`.
- `connect4.js` — no audio code at all.
- Creating the `AudioContext` lazily inside a gesture — this is the textbook fix, but here the context is constructed during asset preload via `hO()` → `Li.createBundle()` → `Sr.instance`, and deferring it in minified code risks the sprite-decode path. **Hold this as the escalation** if Fixes 1+2 still fail on device (§5).

---

## 3. Suggested order of work

1. Apply **Fix 4** (debug hook) and the `window.__xoxMusic` diagnostics from Fix 3 first, plus the §4.3 overlay. Get *observability on the real device* before anything else — this is the actual blocker, since the last fix shipped blind.
2. Apply **Fix 1** and **Fix 2** (bundle, SFX).
3. Apply **Fix 3** (`index.html`, music).
4. Syntax-check, run the Playwright suite (§4.1–4.2), then verify on the real iPhone (§4.3).
5. Only then consider **Fix 5** and the §5 escalations.

After each bundle edit:
```bash
cd /Users/paulbridges/Desktop/xoxo/xox-clone
node --input-type=module --check < assets/index-DjTFcfxW.js && echo "bundle OK"
node --check assets/connect4.js && echo "connect4 OK"
```
Also sanity-check that each replacement landed exactly once:
```bash
grep -c 'touchend","pointerup","click","mousedown","keydown","touchstart"' assets/index-DjTFcfxW.js   # expect 1
grep -c 'e.state!=="running"?(e.state!=="closed"' assets/index-DjTFcfxW.js                            # expect 1
```
And for `index.html`, since it is not a module:
```bash
node -e 'require("fs").readFileSync("index.html","utf8")' # trivial; instead extract the script and:
# python3 - <<'P'
# import re,subprocess
# h=open('index.html').read()
# s=re.findall(r'<script>(.*?)</script>', h, re.S)[1]   # the music IIFE
# open('/tmp/music.js','w').write(s)
# P
node --check /private/tmp/claude-501/*/scratchpad/music.js
```

---

## 4. Verification

### 4.1 Make Playwright actually able to fail

**The previous headless-Chrome test was incapable of detecting either bug.** Playwright starts `AudioContext` in state `"running"` ([playwright#33590](https://github.com/microsoft/playwright/issues/33590)) and headless Chromium's default autoplay policy is `no-user-gesture-required`. Everything passes vacuously.

Launch with the real policy:

```js
const browser = await chromium.launch({
  args: ['--autoplay-policy=user-gesture-required']
});
const ctx = await browser.newContext({
  ...devices['iPhone 14'],        // hasTouch:true, isMobile:true, iOS UA
  // devices[] under chromium still uses Blink; see limits in 4.4
});
```

With this flag: a fresh `AudioContext` starts `suspended`, `resume()` without activation leaves it suspended, and `HTMLMediaElement.play()` rejects with `NotAllowedError`. That is enough to exercise the retry logic.

### 4.2 Concrete test cases

Serve the site (`/Users/paulbridges/Desktop/xoxo/serve.mjs` already exists) and assert:

**T1 — untrusted `touchstart` must NOT burn the retry (this is the regression test for both bugs).**
```js
await page.evaluate(() => {
  const t = new Touch({ identifier: 1, target: document.body, clientX: 50, clientY: 50 });
  document.body.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [t], targetTouches: [t], changedTouches: [t] }));
});
// synthetic == isTrusted:false == no activation, i.e. a faithful stand-in for iOS touchstart
expect(await page.evaluate(() => window.__xoxAudio.instance.context.state)).not.toBe('running');
expect((await page.evaluate(() => window.__xoxMusic.state())).unlocked).toBe(false);
// and crucially, the listeners must still be armed -> T2 must then succeed
```
Against today's code T1 leaves the app permanently dead; against the fixed code it is merely a no-op.

**T2 — a real trusted tap unlocks everything.**
```js
await page.touchscreen.tap(200, 400);   // CDP-dispatched: trusted touchstart + touchend
await expect.poll(() => page.evaluate(() => window.__xoxAudio.instance.context.state)).toBe('running');
await expect.poll(() => page.evaluate(() => window.__xoxMusic.state().unlocked)).toBe(true);
await expect.poll(() => page.evaluate(() => window.__xoxMusic.state().tracks.intro.paused)).toBe(false);
```
T1 immediately followed by T2 in the same page is the whole point: it proves the latch bug is gone.

**T3 — `xe()` produces sound once running.** Instrument rather than listen:
```js
await page.addInitScript(() => {
  window.__started = [];
  const P = AudioBufferSourceNode.prototype, s = P.start;
  P.start = function (...a) { window.__started.push(performance.now()); return s.apply(this, a); };
});
// after T2, click a UI button that calls xe("UI_cta")
expect((await page.evaluate(() => window.__started.length))).toBeGreaterThan(0);
```
Also assert `page.on('console')` never logs `AudioEngine: No audio source with id` (that would mean the sprite bundle failed to load, a different bug).

**T4 — track switches need no fresh gesture.** After T2, `await page.evaluate(() => window.dispatchEvent(new Event('xox-vs')))` from a `setTimeout` (outside any activation), then poll `__xoxMusic.state().tracks.vs.paused === false` and `lastError === null`. Under `--autoplay-policy=user-gesture-required` this test **fails against the current `.src`-swap code** and passes with one-element-per-track.

**T5 — priming.** After T2, `__xoxMusic.state().primed === true` and every entry in `.tracks` has `readyState > 0` (proves each element began loading at the unlock gesture, not at switch time).

**T6 — mute/pause still work.** Dispatch `xox-mute` with `detail:true` / `false` and `xox-pause`, assert `.muted` / `.paused` across all four elements. Guards against Fix 3 regressing existing behaviour.

**T7 — no console errors, no unhandled rejections.** `page.on('pageerror')` and `page.on('console','error')` must be clean; the old code's `playlist blocked:` warning must be absent after T2.

### 4.3 Real-device verification (the part that actually matters)

Ship a temporary on-page overlay behind `?audiodebug=1`, because you cannot read the iPhone console without a tethered Mac:

```js
if (location.search.indexOf('audiodebug=1') >= 0) {
  var d = document.createElement('pre');
  d.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#000c;color:#0f0;font:10px monospace;padding:4px;max-width:100vw;white-space:pre-wrap';
  document.body.appendChild(d);
  setInterval(function () {
    var a = window.__xoxAudio && window.__xoxAudio.instance;
    d.textContent = 'ctx=' + (a ? a.context.state : 'n/a')
      + ' ready=' + (a ? a.ready : '?')
      + ' act=' + (navigator.userActivation ? navigator.userActivation.isActive + '/' + navigator.userActivation.hasBeenActive : 'n/a')
      + '\n' + JSON.stringify(window.__xoxMusic.state(), null, 1);
  }, 400);
}
```

`navigator.userActivation` is available in Safari 16.4+ ([WebKit blog](https://webkit.org/blog/13862/the-user-activation-api/)) and will directly show you whether a gesture is being recognised.

On the device, in order:
1. Confirm **ringer switch off silent** and **Low Power Mode off**.
2. Load `?audiodebug=1`. Before any tap: expect `ctx=suspended`, `unlocked=false`.
3. **Tap and hold, then release.** `ctx` must flip to `running` on release and `tracks.intro.paused` to `false`. If it flips on press instead, iOS granted activation on `mousedown` — fine either way.
4. **Scroll-drag and release without a clean tap** — a `touchend` from a drag may not grant activation. The fix must survive this (still `unlocked=false`, then unlock on the next clean tap). Do not treat step 4 failing as a regression; treat step 3 failing as one.
5. Walk the full flow: `LET'S GO` → loading → VS → game, watching `lastError` stay `null`. Any `NotAllowedError` at a switch means Fix 3's priming did not cover that element.
6. Background Safari, take a call or wait, return, tap → `ctx` should recover from `interrupted`/`suspended` to `running`.

Tethered Safari Web Inspector (Mac Safari → Develop → *iPhone* → page) is still the gold standard if a Mac + cable is available — the overlay is the fallback.

### 4.4 Limits of the headless verification — do not over-trust green tests

Chromium (even with `--autoplay-policy=user-gesture-required` and `devices['iPhone 14']`) **cannot** reproduce:

- **WebKit's touchend-only activation rule.** Blink grants activation on `touchstart`/`pointerdown`. T1's synthetic-untrusted-event trick models "a gesture with no activation", not "iOS specifically refuses touchstart". A pass means *the code no longer depends on a single first attempt* — the strongest thing a Blink test can say.
- **The iOS ≥ 17.2 `.src`-swap permission regression.** T4 approximates it via the autoplay flag; the real iOS behaviour is a separate, undocumented code path.
- **iOS audio-session behaviour**: the ringer/silent switch, Low Power Mode, and reported cases where a running `AudioContext` and an HTML5 `<audio>` element interfere with each other on iOS ([wavesurfer#2210](https://github.com/katspaugh/wavesurfer.js/issues/2210), [Apple forum 740276](https://developer.apple.com/forums/thread/740276)).
- **`preload` being ignored and `volume` being read-only** on iOS. Chromium honours both, so the "song3 is too loud / takes 6 s to start" class of issue is invisible headlessly.
- **Real audio output.** Nothing here proves a waveform reached a speaker. `--mute-audio` is in Playwright's default Chromium args; the tests above deliberately assert on API state (`context.state`, `el.paused`, `AudioBufferSourceNode.start` calls) rather than on sound.

Playwright's WebKit channel (`npx playwright install webkit`) is a closer engine and *would* exercise the real `UserGestureIndicator` logic — worth adding as a second suite — but it is a desktop WebKit build with relaxed media policy and no iOS audio session, so it is a partial upgrade, not a substitute for the device. Note: only Chromium builds are currently installed in `~/Library/Caches/ms-playwright`.

---

## 5. If it still fails on device — escalation ladder

In order, cheapest first:

1. **Read the overlay.** `ctx=suspended` + `act=false/false` → gestures aren't reaching the listener at all (look for an overlay element or something swallowing events). `ctx=suspended` + `act=true/true` → activation exists but `resume()` is being refused: go to step 3. `ctx=running` but silent → silent switch, or the master gain / `setMute` path, or the sprite bundle never loaded (check for the `AudioEngine: No audio source with id` warning).
2. **Add an explicit "TAP TO START" gate.** The most reliable pattern on iOS is a real full-screen button whose `click` handler does the unlock. This removes all ambiguity about whether a gesture qualified, at the cost of one extra tap.
3. **Create the `AudioContext` lazily inside the first qualifying gesture.** This is the one thing the current architecture cannot do, and it is the known-good fix for contexts that refuse to leave `suspended`/`interrupted` ([web-audio-api#790](https://github.com/WebAudio/web-audio-api/issues/790), [Matt Montag](https://www.mattmontag.com/web/unlock-web-audio-in-safari-for-ios-and-macos)). Implementation sketch: make `Sr.instance` not construct the context eagerly — instead have the `hO()` preload path defer `Li.createBundle()` until after the first unlock gesture. Higher risk in minified code; needs its own plan.
4. **Suspect Web Audio ↔ HTML5 `<audio>` interference.** Test by temporarily disabling one system: load with music disabled and see whether SFX work, and vice versa. If they are mutually exclusive on iOS, the fix is to consolidate — either route the music through the existing Web Audio engine (loses the silent-switch exemption, if any) or move SFX to pre-primed `<audio>` elements like Fix 3.
5. **Accept and communicate the silent switch.** If the overlay says `ctx=running`, `paused=false`, `currentTime` advancing, and there is still no sound, it is the hardware mute switch or system volume. Add a one-line hint in the UI ("No sound? Check your ringer switch") rather than more code.

---

## Sources

- [The User Activation API — WebKit blog](https://webkit.org/blog/13862/the-user-activation-api/) — authoritative list of activation-triggering events; confirms `touchstart` is excluded
- [miniaudio #759 — Safari on iOS17 does not play audio after first touch](https://github.com/mackron/miniaudio/issues/759) — real-world confirmation of the touchend requirement
- [Unlock JavaScript Web Audio in Safari and Chrome — Matt Montag](https://www.mattmontag.com/web/unlock-web-audio-in-safari-for-ios-and-macos)
- [Context stuck in suspended state on iOS — web-audio-api #790](https://github.com/WebAudio/web-audio-api/issues/790)
- [AudioContext stuck on "interrupted" in Safari — web-audio-api #2585](https://github.com/WebAudio/web-audio-api/issues/2585)
- [Handle audio context state of interrupted — howler.js #928](https://github.com/goldfire/howler.js/pull/928)
- [howler.js](https://github.com/goldfire/howler.js/) — silent 1-sample buffer unlock technique
- [How to auto-play audio in Safari with JavaScript — Curtis Robinson](https://curtisrobinson.medium.com/how-to-auto-play-audio-in-safari-with-javascript-21d50b0a2765) — per-file priming (play/pause on first touch)
- [Skirting the iOS/Safari audio auto-play policy for UI sound effects — Ross Wintle](https://rosswintle.uk/2019/01/skirting-the-ios-safari-audio-auto-play-policy-for-ui-sound-effects/) — muted-play priming, DOM presence, `muted` works / `volume` doesn't
- [iOS-Specific Considerations — Apple](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/Using_HTML5_Audio_Video/Device-SpecificConsiderations/Device-SpecificConsiderations.html) — `volume` not settable, `preload` ignored, element in DOM + set `src` then `play()`
- [api.HTMLMediaElement.volume not supported on iOS Safari — mdn/browser-compat-data #13554](https://github.com/mdn/browser-compat-data/issues/13554)
- [Why iOS Silent Mode Breaks Audio in Web Apps](https://joodi.medium.com/why-i-os-silent-mode-breaks-audio-in-web-apps-aedcbeef7bca) — silent switch mutes both Web Audio and `<audio>`; no web API workaround
- [Enabling Autoplay in Safari's Low Power Mode — Rafal Lesniak](https://lesniakrafal.com/enabling-autoplay-in-safaris-low/)
- [Add option to disable AudioContext autoplay — playwright #33590](https://github.com/microsoft/playwright/issues/33590) — Playwright's AudioContext starts `running` by default
- [Autoplay policy in Chrome](https://developer.chrome.com/blog/autoplay) / [Autoplay guide — MDN](https://developer.mozilla.org/en-US/docs/Web/Media/Autoplay_guide)
- [MediaElementWebAudio choppy playback in iOS Safari — wavesurfer.js #2210](https://github.com/katspaugh/wavesurfer.js/issues/2210), [AudioContext.createMediaElementSource broken in iOS 17 — Apple forum](https://developer.apple.com/forums/thread/740276) — Web Audio ↔ HTML5 audio interference on iOS
- [Playwright emulation docs](https://github.com/microsoft/playwright/blob/main/docs/src/emulation.md) — device emulation caveats

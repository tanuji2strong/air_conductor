# Air Conductor — Developer Context

## 1. Project Overview

空氣指揮家 (Air Conductor) is a browser-based conducting simulator. The user loads a MIDI file; the app plays it back via a Tone.js polyphonic synth. The user controls playback tempo by waving their right hand (faster swings = faster tempo), controls volume with their left index fingertip height, and can cut off or sustain notes with left-hand gestures detected by a MediaPipe webcam pipeline. The UI is fully bilingual (Chinese/English). There is no server component. Everything runs in a single HTML page.

**Tech stack**: MediaPipe Tasks Vision (PoseLandmarker + HandLandmarker), Tone.js (PolySynth + Volume node), vanilla JS (no framework), CSS custom properties for theming and font scaling.

---

## 2. File Structure

| File | Role |
|---|---|
| `index.html` | Page shell, all overlay markup, CDN `<script>` tags, two inline scripts for pre-paint state restoration (font size + language) |
| `style.css` | All visual styles; theme and font-size tokens via CSS custom properties; large-font overrides via `html[data-fontsize="large"]` attribute selectors |
| `app.js` | All application logic: i18n strings, MIDI parsing, audio scheduling, gesture detection, beat detection, HUD canvas rendering, camera pipeline |

### CDN dependencies (in load order)

1. **Google Fonts** — Cormorant Garamond (header, overlays, on-canvas text) + DM Mono (UI, HUD)
2. **MediaPipe Tasks Vision `@0.10.35`** — loaded as an ES module; exports `FilesetResolver`, `PoseLandmarker`, `HandLandmarker` assigned to `window` by a second inline `<script type="module">` so that `app.js` (a plain script) can access them as globals.
3. **Tone.js** — loaded from `https://unpkg.com/tone` (no version pin). Provides `Tone.PolySynth`, `Tone.Synth`, `Tone.Volume`, `Tone.now()`, `Tone.start()`.

**Version mismatch risk**: the HTML module import is pinned to `@mediapipe/tasks-vision@0.10.35`, but `startCamera()` loads WASM via `FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm')` — using `@latest`. A WASM/JS version divergence will cause a runtime failure.

---

## 3. Runtime Architecture — Three rAF Loops

The app runs three independent `requestAnimationFrame` loops, all decoupled.

### `schedulerLoop()` — started unconditionally at page load
```
schedulerLoop → scheduler.update() → _scheduleBeat() → Tone.js synth
             → elProgressFill.style.width
```
- Calls `scheduler.update()` every frame. `update()` pushes audio-scheduled beats into Tone.js up to 150 ms ahead, and fires the `onBeatScheduled` callback with the beat's `performance.now()` time and beat number.
- Updates the footer progress bar.
- `scheduler` is null before the first MIDI load; the call is null-guarded.

### `hudLoop()` — started unconditionally at page load
```
hudLoop → drawMetronomeHUD() → #hudCanvas
```
- Calls `drawMetronomeHUD()` only when `_hudDirty` is true, or when animation is in progress: `scheduler?.playing`, or a flare within the last 200 ms.
- Owns `#hudCanvas` exclusively. Never touches `#canvasEl`.
- `_hudDirty` is set by any state change affecting the HUD (gesture transitions, etc.).

### `detect()` (inside `startCamera()`) — started on first MIDI file load
```
detect → poseLandmarker.detectForVideo (every frame)
       → handLandmarker.detectForVideo (every 3rd frame)
       → gesture logic
       → draw camera + overlays → #canvasEl
```
- `startCamera()` is called from the file-upload handler when `cameraStarted === false`. The flag prevents re-entry; the camera runs for the lifetime of the page once started.
- PoseLandmarker runs every frame; HandLandmarker runs on every third frame (`handFrameCounter % 3 === 0`), caching the last result in the closure variable `lastHandResult`.

---

## 4. MIDI Parsing — `MidiAnalyzer`

`new MidiAnalyzer(arrayBuffer)` parses a Standard MIDI File in the constructor.

**What it extracts:**
- `tpb` — ticks per beat, from the SMF header (default 480 if unreadable)
- `tempoUs` — microseconds per beat from the first `0xFF 0x51` meta event (default 500 000 = 120 BPM)
- `timeSig` — `[numerator, denominator]` from the first `0xFF 0x58` meta event (default `[4,4]`)
- `events` — sorted array of `{absTick, type, channel, note, velocity}` for `note_on` and `note_off` events; `program_change` events are also collected but unused at playback
- `totalTicks` — maximum `absTick` seen across all events
- `get initialBpm()` — `60_000_000 / tempoUs`

**What it ignores:** control change (0xB), poly aftertouch (0xA), pitch bend (0xE), channel aftertouch (0xD), SysEx, all meta events beyond tempo and time signature. Percussion channel 9 events are parsed but filtered out at playback time in `AutoScheduler._play()`.

**After parse, in the file-upload handler:**
- Compound metre mapping applied: `{6:2, 9:3, 12:4}` beats → numerator replacement.
- If the resulting time signature is not in `[[2,4],[3,4],[4,4]]`, it is forced to `[4,4]`.

---

## 5. Audio Pipeline — `AutoScheduler`

### Signal chain (always)
```
Tone.PolySynth instrument  ──┐
                              ├──→ Tone.Volume (fermataGain) → Tone.Destination
Tone.PolySynth fermataSustainSynth ──┘
```
`fermataGain` is a module-level `Tone.Volume | null`, initialised `null`. On each file load the old `fermataGain` and `instrument` are `.dispose()`d and new ones are created. `fermataSustainSynth` is also disposed and recreated each load.

### Main instrument (`instrument`)
```js
Tone.PolySynth(Tone.Synth, {
  oscillator: { type: 'fattriangle', count: 3, spread: 20 },
  envelope:   { attack: 0.01, decay: 0.0, sustain: 1.0, release: 0.3 },
  volume: -12
})
```
Fast organ-like attack; three detuned triangle waves for warmth. Connected to `fermataGain`.

### Fermata sustain synth (`fermataSustainSynth`)
```js
Tone.PolySynth(Tone.Synth, {
  oscillator: { type: 'fattriangle', count: 3, spread: 20 },
  envelope:   { attack: 0.15, decay: 0.0, sustain: 1.0, release: 0.4 },
  volume: -20
})
```
Slow attack (150 ms) so the main instrument's transient passes before this synth becomes audible. Low volume (-20 dB) keeps it under the main playback. Used exclusively by the fermata gesture. Also connected to `fermataGain`.

### `AutoScheduler` scheduling
- **Lookahead**: 150 ms (`_AHEAD = 0.15`). `update()` runs in `schedulerLoop` each rAF frame and calls `_scheduleBeat()` for every beat within the next 150 ms.
- **Beat granularity**: one beat = one tick-range `[currentTick, currentTick + tpb)`. All MIDI events in that range are scheduled proportionally within `beatS` seconds.
- **Note playback**: `triggerAttackRelease(noteName, 0.35, when, (velocity/127) * 0.9 * gainScale)`. Duration is always 0.35 s.
- **Beat snapshots**: `beatSnapshots` is an array of `{notes: string[], at: number}` where `at` is the audio time of the beat. Populated in `_scheduleBeat()` for beats that have any notes. Trimmed to retain only the last two beats worth. Used by the fermata to identify which notes to sustain.
- **`lastChord`**: a `Map<noteName, audioTime>` still updated in `_play()` and cleared on `reset()`, but no longer read by the fermata (which uses `beatSnapshots`). Effectively dead state.
- **AudioContext unlock**: `Tone.start()` is awaited in `startCountdown()` and in all gesture-based resume paths.
- **Tempo control**: `setSpeed(factor)` sets `beatS = (60 / bpm) / factor`.
- **`pauseOnly()`**: stops score advancement without calling `_stopAll()` or `releaseAll()`. Lets currently-sounding notes decay naturally into the fermata sustain synth.
- **Song end**: when `currentTick >= totalTicks`, `playing = false` and `onSongEnd` fires via `setTimeout(onSongEnd, 2000)`.
- **Mute**: `scheduler.muted = true` suppresses note playback without pausing transport.

---

## 6. Gesture System

All gestures run inside `detect()`. PoseLandmarker landmarks are in normalised `[0,1]` coordinates from the **subject's perspective** (not the mirrored display). Smaller `y` = higher on screen.

### Gesture 1 — Tempo conducting (right hand, PoseLandmarker)

| | |
|---|---|
| **Landmark** | `lm[20]` — subject's right index fingertip |
| **Every frame** | Position pushed to `handState.right.poseBuf` (max 8 entries); `handSpeed()` computed; `detectBeat()` called |
| **Effect** | Detected ictus → `smoothedBpm` updated → `scheduler.setSpeed(smoothedBpm / bpm0)` |

### Gesture 2 — Volume control (left hand, PoseLandmarker)

| | |
|---|---|
| **Landmarks** | `lm[19]` left index fingertip, `lm[11]` left shoulder, `lm[23]` left hip |
| **Every frame** | If all three visible (visibility > 0.3): `lFinger.y < lShoulder.y` → `gainScale += 0.01`; `lFinger.y > lHip.y` → `gainScale -= 0.01`; otherwise hold |
| **Range** | `GAIN_MIN = 0.1` to `GAIN_MAX = 2.0`, propagated to `scheduler.gainScale` each frame |
| **Effect** | Scales velocity coefficient in `_play()`: `(velocity/127) * 0.9 * gainScale` |

### Gesture 3 — Fist cut-off (left hand, HandLandmarker)

| | |
|---|---|
| **Hand** | Subject's left hand — identified by `handedness[i][0].categoryName === 'Left'` |
| **Test** | `isRightFist(lm)` (name is a legacy artefact): all four fingertips closer to wrist (`lm[0]`) than their MCP knuckles: `d(lm[0],lm[8])<d(lm[0],lm[5])` · `d(lm[0],lm[12])<d(lm[0],lm[9])` · `d(lm[0],lm[16])<d(lm[0],lm[13])` · `d(lm[0],lm[20])<d(lm[0],lm[17])` |
| **Hold** | `fistSinceMs` timer; fires after **300 ms** (`FIST_HOLD_MS`) |
| **Enter effect** | `scheduler.pause()`, `scheduler._stopAll()` (→ `releaseAll()`), `autoPaused = true`, `fistPaused = true` |
| **Exit condition** | Fist test fails (hand opens) |
| **Exit effect** | Waits **800 ms** (`FIST_COOLDOWN`) via `fistResumeCooldownMs`, then `Tone.start()` → `scheduler.resume(0.1)`, `fistPaused = false`, `autoPaused = false` |
| **Isolation** | `fistPaused = true` blocks the fermata pinch path |
| **On-canvas text** | `STRINGS[currentLang].cutoff` centred, red `rgba(224,82,82,0.88)` with shadow |

### Gesture 4 — Fermata pinch (left hand, HandLandmarker)

| | |
|---|---|
| **Hand** | Subject's left hand (`leftLm`) |
| **Test** | `isPinch(lm)`: `d(lm[4],lm[8]) / d(lm[0],lm[9]) < 0.25` — thumb tip to index tip distance divided by wrist-to-middle-MCP hand size |
| **Hold** | `pinchSinceMs` timer; fires after **20 ms** |
| **Guard** | `!fistPaused && fistSinceMs === 0 && scheduler.playing` |
| **Enter effect** | `fermataPaused = true`, `scheduler.pauseOnly()`. Filter `beatSnapshots` for the most recent beat whose audio time has already fired (`at <= Tone.now()`). Capture those note names as `fermataActiveNotes`. Start `fermataAttackTimer` (150 ms setTimeout): if it fires, call `fermataSustainSynth.triggerAttack(fermataActiveNotes, Tone.now(), 0.5)`. |
| **Exit (timer still pending)** | Cancel `fermataAttackTimer`; resume immediately without release — no synth note was ever started |
| **Exit (timer already fired)** | `fermataSustainSynth.triggerRelease(fermataActiveNotes, Tone.now())`; wait 450 ms then `scheduler.resume(0.1)`; safety `releaseAll()` after 500 ms |
| **State** | `fermataPaused`, `pinchSinceMs`, `fermataAttackTimer`, `fermataSustainSynth` (module globals); `fermataActiveNotes` (closure local inside `startCamera()`) |
| **On-canvas text** | `STRINGS[currentLang].fermata` centred, blue `rgba(80,160,255,0.88)` |

---

## 7. Beat Detection

### `handSpeed(state)` → norm/ms

Reads the last `VELO_WINDOW = 3` entries from `state.poseBuf` (ring buffer, max `POS_BUF_SIZE = 8` entries of `{x, y, t}`). For each consecutive pair where `dt > 0 && dt < 100`: accumulates `sqrt(dx² + dy²) / dt`. Returns the mean, or `0` if fewer than two valid pairs.

**Units**: normalised PoseLandmarker coordinates (0–1 range) per millisecond.

**Jump filter** (applied before pushing to `poseBuf`): if Manhattan distance `|Δx| + |Δy| > 0.25`, the buffer is cleared. Discards teleporting landmarks.

### Threshold formula

```
cachedHighThr = 0.003 × 0.22^((sens − 1) / 4)
```

| `sens` (slider) | threshold |
|---|---|
| 1 (default) | 0.003000 |
| 5 | ≈ 0.000659 |
| 10 | ≈ 0.000114 |

Higher slider value → lower threshold → easier to trigger. Updated by `onSensChange()`.

### `detectBeat(speed, frameT, state)` — FSM

**State variables per hand**: `state.wasAboveHigh` (bool), `state.wasAboveHighTimestamp` (ms), `state.peakSpeed` (norm/ms). Module globals: `lastBeatMs`, `lastIctusMs`, `smoothedBpm`, `bpmBuffer`, `avgBpm`.

1. **Rise**: `speed > cachedHighThr` → set `wasAboveHigh = true`, record timestamp, track `peakSpeed`.
2. **Ictus**: `wasAboveHigh && speed < peakSpeed × 0.55` (descent to 55% of peak).
3. **Debounce gate**: skip if `frameT − lastBeatMs < MIN_BEAT_MS` (200 ms).
4. **Window gate**: skip if `frameT − wasAboveHighTimestamp ≥ 600 ms`.
5. **BPM update** (if both gates pass):
   - `intervalMs = frameT − lastIctusMs`
   - Valid range: `200 ms ≤ intervalMs ≤ 3000 ms` (20–300 BPM)
   - `rawBpm = 60000 / intervalMs`
   - Clamped: `max(bpm0×0.4, min(bpm0×2.5, rawBpm))`
   - Smoothed: if `smoothedBpm === 0` → assign directly; else `smoothedBpm = 0.65×smoothedBpm + 0.35×clamped`
   - `scheduler.setSpeed(smoothedBpm / bpm0)`
   - `bpmBuffer`: rolling buffer, max 6 values → `avgBpm = mean(bpmBuffer)`
   - Update `lastIctusMs = frameT`
6. **Reset**: `wasAboveHigh = false`, `peakSpeed = 0`.

Only the **right-hand** index tip (`lm[20]`) drives beat detection. Left-hand `lm[19]` is tracked for trail, speed bar, and volume control only.

---

## 8. Hand Tracking

### PoseLandmarker

| Property | Value |
|---|---|
| Model | `pose_landmarker_lite` float16 v1, from `storage.googleapis.com/mediapipe-models/...` |
| Running mode | `VIDEO` |
| `numPoses` | 1 |
| Confidence thresholds | 0.5 (detection, presence, tracking) |
| Delegate | GPU, falls back to CPU on `createFromOptions` throw |
| Frequency | Every frame |

Landmark indices used (subject's perspective):

| Index | Landmark | Used for |
|---|---|---|
| `lm[11]` | Left shoulder | Volume control upper bound |
| `lm[19]` | Left index fingertip | Left-hand trail/dot, volume control |
| `lm[20]` | Right index fingertip | Right-hand trail/dot, beat detection |
| `lm[23]` | Left hip | Volume control lower bound |

> `WRIST_IDX = {left: 19, right: 20}` — named "wrist" but indices 19/20 are index fingertips (wrists are 15/16). Legacy naming artefact.

### HandLandmarker

| Property | Value |
|---|---|
| Model | `hand_landmarker` float16 v1, from `storage.googleapis.com/mediapipe-models/...` |
| Running mode | `VIDEO` |
| `numHands` | 2 |
| Confidence thresholds | 0.5 (detection, presence, tracking) |
| Delegate | GPU, falls back to CPU |
| Frequency | Every 3rd frame (`handFrameCounter % 3 === 0`) |

Handedness is from the **subject's perspective**. Right-hand landmarks from HandLandmarker are not used; beat conduction uses PoseLandmarker `lm[20]`.

HandLandmarker landmark indices used (left hand only):

| Index | Landmark | Used for |
|---|---|---|
| `lm[0]` | Wrist | Fist test anchor; pinch hand-size anchor |
| `lm[4]` | Thumb tip | Pinch distance |
| `lm[5]` | Index MCP | Fist test |
| `lm[8]` | Index tip | Fist test; pinch distance |
| `lm[9]` | Middle MCP | Fist test; pinch hand-size |
| `lm[12]` | Middle tip | Fist test |
| `lm[13]` | Ring MCP | Fist test |
| `lm[16]` | Ring tip | Fist test |
| `lm[17]` | Pinky MCP | Fist test |
| `lm[20]` | Pinky tip | Fist test |

### Throttle and stale-result behaviour

`handLandmarker.detectForVideo()` is called only when `handFrameCounter % 3 === 0`. The result is cached in `lastHandResult`; all gesture logic runs every frame against that cache. Effective detection rate: ~20 fps at 60 fps display. No staleness counter — if the left hand is lost, the stale result persists until the next detection frame.

---

## 9. HUD Canvas — `drawMetronomeHUD()`

Draws entirely on `#hudCanvas` (absolute overlay, `pointer-events: none`, `z-index: 5`). Never touches `#canvasEl`.

Canvas dimensions are managed by a `ResizeObserver` on `elHudCanvas` via `resizeHudCanvas()`. On each resize it sets `elHudCanvas.width/height = Math.round(clientWidth/Height * devicePixelRatio)` and marks `_hudDirty = true`. `drawMetronomeHUD()` scales the canvas context by DPR (`ctx.scale(dpr, dpr)`) and works in logical pixels throughout.

### Layout

```
scale = Math.min(W / 1280, 0.75)   // W = canvas.width / dpr
```

All internal dimension constants (HUD_W, HUD_H, radii, font sizes, offsets) are multiplied by `scale`. The HUD backdrop is centred horizontally, 8×scale px from the top.

| Element | Normal size | Large-font size |
|---|---|---|
| Backdrop W | 220×scale | 300×scale |
| Backdrop H | 150×scale | 190×scale |
| Arc radius | 52×scale | 68×scale |
| Beat number font | 38×scale px | 62×scale px |
| Dynamics bar W | 6×scale | 8×scale |

"Large" mode is detected each frame via `document.documentElement.getAttribute('data-fontsize') === 'large'` (stored locally as `elder`).

### Anticipation arc

A full-circle ring acts as a progress sweep. `bp` (beat progress 0→1) is computed from `_prevBeatMs` and `_nextBeatMs` (set by the `onBeatScheduled` callback); zeroed when `_total ≤ 50 ms` or `_prevBeatMs === 0`. The arc sweeps clockwise from 12 o'clock. Beat 1: full alpha; other beats: half alpha. `urgency = max(0, (bp − 0.70) / 0.30)` brightens the beat number as the beat approaches.

**Flare ring**: triggered when `performance.now() >= _nextFlareAtMs && _flareMs < _nextFlareAtMs`. Expands outward and fades over 160 ms. Beat-1 flares are brighter.

### BPM panels (upper-right of backdrop)

| Label | Value |
|---|---|
| `SCORE` | `bpm0.toFixed(0) + ' BPM'` — the MIDI file's original BPM (label is stale; this is not a score) |
| `LIVE` | `smoothedBpm.toFixed(0) + ' BPM'` — current gesture-detected BPM (EWMA, α=0.35) |
| `AVG` | `avgBpm.toFixed(0) + ' BPM'` — mean of last 6 raw ictus intervals |

### Time signature

Displayed at the bottom centre of the backdrop. Reads `currentTS[0] + '/' + currentTS[1]`.

### Dynamics bar

Vertical fill on the left edge of the backdrop. Fraction = `(gainScale − GAIN_MIN) / (GAIN_MAX − GAIN_MIN)`. A horizontal tick mark is drawn at the `gainScale = 1.0` position.

---

## 10. Camera Canvas — `detect()` Draw Pass

Each frame, `#canvasEl` is rendered as follows (draw order):

1. **Flip and draw video**: `ctx.translate(W,0); ctx.scale(-1,1); ctx.drawImage(video,...)` — mirrors the video so the user sees a mirror image.
2. **Trails** (both hands): 18-segment polyline. `TRAIL_STYLES` is an 18-element array of `rgba(176,184,196, α)` ramping from low to high alpha. Segment line width ramps toward the current position.
3. **Wrist dot** (both hands): filled circle, colour `#50d89a` (green), radius large-font=11 px / normal=6 px, with glow shadow.
4. **Left-hand skeleton** (only when `leftLm` from HandLandmarker is available): five finger chains `[0,1,2,3,4]`, `[0,5,6,7,8]`, `[0,9,10,11,12]`, `[0,13,14,15,16]`, `[0,17,18,19,20]` in `rgba(176,184,196,0.6)`, 1.5 px; 21 dots at each landmark in `rgba(176,184,196,0.85)`.
5. **Speed bars**: 60×5 px bar above each wrist dot. Fill = `min(speed / cachedHighThr, 1) × 60`. Amber (`#ff9040`) if `speed ≥ cachedHighThr`, else silver. Threshold tick at the right edge.
6. **Reference lines** (left hand only, when `lFinger.visibility > 0.3`): full-width horizontal lines at shoulder (`rgba(176,184,196,0.4)`) and hip (`rgba(176,184,196,0.2)`).
7. **Status text overlay**: centred on canvas.
   - `fistPaused` → `STRINGS[currentLang].cutoff` (red `rgba(224,82,82,0.88)`)
   - `fermataPaused` → `STRINGS[currentLang].fermata` (blue `rgba(80,160,255,0.88)`)
   - Font: bold Cormorant Garamond, large-font=52 px / normal=36 px.

---

## 11. App Flow — Overlays and State

```
page load → #uploadOverlay visible (z:20)
         → user picks MIDI file
         → parse MIDI + create synths + await Tone.start()
         → start camera (once, first load only)
             ├── camera OK  → #startOverlay visible (z:19)
             └── camera err → alert + #startOverlay visible (music still works)
         → subsequent loads: #startOverlay visible immediately (camera already running)
         → user clicks #startOverlay
         → #countdownOverlay visible (z:18)  [5 → 1 → ♩, ~5.1 s]
         → countdown finishes → Tone.start() → scheduler.start(0.25)
         → playing (no overlay)
         → song end → showSongEnd() after 2 s delay
         → #songEndOverlay visible (z:22)
             ├── 再播一次 / Play Again → restartGame() → #startOverlay
             └── 載入新曲 / New Song   → fileInput.value='' → #uploadOverlay
```

**`_resetPlayState()`** is called on restart and song-end. It zeroes all gesture timers (`fistSinceMs`, `fistResumeCooldownMs`, `pinchSinceMs`), all BPM state (`smoothedBpm`, `lastIctusMs`, `bpmBuffer`, `avgBpm`), resets `gainScale = 1.0`, clears both `handState` buffers and trails, and resets all pause flags.

**`#beatFlash`** — a full-inset `div` styled in CSS is present in the HTML but never referenced by `app.js`. Dead markup.

---

## 12. Internationalisation (i18n)

All user-visible strings are stored in a module-level `STRINGS` object with `zh` and `en` keys. `setLang(lang)` applies a language switch by:

- Setting `data-lang` on `<html>` and `document.documentElement.lang`
- Writing to `localStorage` under `airConductor_lang`
- Updating all `[data-i18n]` (textContent), `[data-i18n-html]` (innerHTML), and `[data-i18n-title]` (title) elements
- Updating the active state of `[data-lang-btn]` buttons

The current language is restored before first paint by an inline `<script>` in `<head>`. `currentLang` is a module-level variable read by gesture drawing code when rendering status text (cut-off, fermata labels).

---

## 13. Font Size Control

Three buttons (`小/中/大` or `S/M/L`) set `data-fontsize` to `small`, `medium`, or `large` on `<html>`. Stored in `localStorage` under `airConductor_fontSize`. Applied before first paint by the inline head script.

CSS scales `--fs-label`, `--fs-body`, `--fs-val` by `1.0×`, `1.2×`, `1.5×`. The `html[data-fontsize="large"]` ruleset also enlarges buttons, sliders, overlays, and the progress bar.

`data-fontsize="large"` also controls HUD and canvas drawing sizes (checked as `document.documentElement.getAttribute('data-fontsize') === 'large'` inside `drawMetronomeHUD()` and `detect()`). Larger font size increases: backdrop dimensions, arc radius, beat number font, wrist dot radius, flare expansion radius, all label fonts.

**No behavioural changes.** All gesture thresholds, timing constants, and audio routing are identical across font sizes.

---

## 14. Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` | `togglePause()` (calls `preventDefault`) |
| `R` / `r` | `restartGame()` — only if `analyzer !== null` |
| `M` / `m` | Toggle `scheduler.muted` |
| `+` / `=` | Decrement sensitivity slider by 1 (lower threshold → more sensitive) |
| `-` / `_` | Increment sensitivity slider by 1 (higher threshold → less sensitive) |
| `L` / `l` | `toggleTheme()` |

Note: `+` makes detection *easier* (more sensitive), `-` makes it harder — counterintuitive relative to the label direction.

---

## 15. How to Run

No build step. Open `index.html` in a browser with a webcam. The app requires:
- A browser that supports `getUserMedia` (desktop Chrome or Edge recommended)
- Camera permission granted
- Internet access for CDN resources (MediaPipe WASM, Tone.js)

On first load, click "載入 MIDI / Load MIDI" to select a `.mid` file. The synths initialise immediately (no sample download). Camera and MediaPipe models load in parallel. Once the start overlay appears, click it to begin the 5-second countdown.

---

## 16. Known Issues and Quirks

**`isRightFist` applied to `leftLm`.** The function name is a legacy artefact. The geometry is hand-symmetric so the fist test result is correct, but the name is misleading.

**`WRIST_IDX` contains fingertip indices.** `WRIST_IDX = {left:19, right:20}` are index fingertips (wrists are 15/16 in PoseLandmarker). Legacy naming artefact.

**`SCORE` HUD label shows file BPM.** The top-right HUD panel is labelled `SCORE` but displays `bpm0` — the MIDI file's original BPM.

**`#beatFlash` is dead markup.** The div and its CSS are never referenced by `app.js`.

**`lastChord` is dead state.** Still set in `AutoScheduler._play()` and cleared on `reset()`, but the fermata no longer reads it — it uses `beatSnapshots` instead.

**`autoPaused` is set but never read in conditionals.** Set to `true` on fist enter, `false` on fist resume, and cleared in `_resetPlayState()`, but no downstream logic branches on it. Effectively dead.

**MediaPipe WASM version mismatch.** JS bundle pinned to `@0.10.35`; WASM loaded from `@latest`. Divergence will cause a runtime failure.

**Camera can only start once.** `cameraStarted` prevents re-entry into `startCamera()`. A camera failure after the first MIDI load is unrecoverable without a page reload.

**Tone.js CDN is unversioned.** `https://unpkg.com/tone` resolves to the latest release. A breaking Tone.js update will silently break the app.

**Time signature forced to simple metre.** Compound numerators 6/9/12 are mapped to 2/3/4. Any other unsupported time signature is forced to 4/4.

**HandLandmarker detects on every 3rd frame with no staleness timeout.** If the left hand is lost, stale gesture results persist until the next detection frame. A rapid fist or pinch that is un-detected between frames may not clear cleanly.

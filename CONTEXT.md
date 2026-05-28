# Air Conductor — Developer Context

## 1. Project Overview

空氣指揮家 (Air Conductor) is a browser-based conducting simulator. The user loads a MIDI file; the app plays it back via a Tone.js piano sampler. The user controls playback tempo by waving their right hand (faster swings = faster tempo), controls volume with their left index fingertip height, and can pause, resume, cut off, or sustain notes with hand gestures detected by a MediaPipe webcam pipeline. There is no server component. Everything runs in a single HTML page.

**Tech stack**: MediaPipe Tasks Vision (PoseLandmarker + HandLandmarker), Tone.js (sampler + audio scheduling), vanilla JS (no framework), CSS custom properties for theming.

---

## 2. File Structure

| File | Role |
|---|---|
| `index.html` | Page shell, all overlay markup, CDN `<script>` tags, two inline scripts for pre-paint state restoration |
| `style.css` | All visual styles; theme and font-size tokens via CSS custom properties; Elder Mode overrides via `html[data-elder]` attribute selectors |
| `app.js` | All application logic: MIDI parsing, audio scheduling, gesture detection, beat detection, HUD canvas rendering, camera pipeline |

### CDN dependencies (in load order)

1. **Google Fonts** — Cormorant Garamond (header, overlays, on-canvas text) + DM Mono (UI, HUD)
2. **MediaPipe Tasks Vision `@0.10.35`** — loaded as an ES module, exports `FilesetResolver`, `PoseLandmarker`, `HandLandmarker` assigned to `window` by a second inline `<script type="module">` so that `app.js` (a plain script) can access them as globals.
3. **Tone.js** — loaded from `https://unpkg.com/tone` (no version pin). Provides `Tone.Sampler`, `Tone.Volume`, `Tone.now()`, `Tone.start()`, `Tone.loaded()`.

**Version mismatch**: the HTML module import is pinned to `@mediapipe/tasks-vision@0.10.35`, but inside `startCamera()` the WASM bundle is loaded via `FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm')` — using `@latest` for the wasm, not `@0.10.35`. If the two versions diverge the runtime will fail.

---

## 3. Runtime Architecture — Three rAF Loops

The app runs three independent `requestAnimationFrame` loops. They are fully decoupled; none waits on another.

### `schedulerLoop()` — started unconditionally at page load
```
schedulerLoop → scheduler.update() → _scheduleBeat() → Tone.js
             → elProgressFill.style.width
```
- Calls `scheduler.update()` every frame. `update()` pushes audio-scheduled beats into Tone.js up to 150 ms ahead, and calls the `onBeatScheduled` callback with the beat's `performance.now()` time and beat number.
- Updates the footer progress bar.
- `scheduler` is null before the first MIDI load; the call is null-guarded.

### `hudLoop()` — started unconditionally at page load
```
hudLoop → drawMetronomeHUD() → #hudCanvas
```
- Calls `drawMetronomeHUD()` only when `_hudDirty` is true, or when animation is in progress: `scheduler?.playing`, a flare within the last 200 ms, or `crossPauseSinceMs > 0`.
- Owns the `#hudCanvas` overlay exclusively. Never touches `#canvasEl`.
- `_hudDirty` is set to `true` by any state change that affects the HUD (gesture transitions, elder mode toggle, etc.).

### `detect()` (inside `startCamera()`) — started on first MIDI file load
```
detect → poseLandmarker.detectForVideo (every frame)
       → handLandmarker.detectForVideo (every 3rd frame)
       → gesture logic
       → draw camera + overlays → #canvasEl
```
- `startCamera()` is called from the file-upload handler if `cameraStarted === false`. The `cameraStarted` flag prevents re-entry; the camera runs for the lifetime of the page once started.
- Runs PoseLandmarker every frame and HandLandmarker on every third frame (`handFrameCounter % 3 === 0`), caching the last hand result in the closure variable `lastHandResult`.

---

## 4. MIDI Parsing — `MidiAnalyzer`

`new MidiAnalyzer(arrayBuffer)` parses a Standard MIDI File in the constructor.

**What it extracts:**
- `tpb` — ticks per beat, from the SMF header (default 480 if unreadable)
- `tempoUs` — microseconds per beat from the first `0xFF 0x51` meta event (default 500 000 = 120 BPM)
- `timeSig` — `[numerator, denominator]` from the first `0xFF 0x58` meta event (default `[4,4]`)
- `events` — sorted array of `{absTick, type, channel, note, velocity}` objects for `note_on` and `note_off` events; `program_change` events are also collected but unused by the scheduler
- `totalTicks` — maximum `absTick` seen across all events
- `get initialBpm()` — `60_000_000 / tempoUs`

**What it ignores:** control change (0xB), poly aftertouch (0xA), pitch bend (0xE), channel aftertouch (0xD), SysEx, all meta events beyond tempo and time signature. Percussion channel 9 events are parsed into the array but filtered out at playback time in `AutoScheduler._play()`.

**After parse, in the file-upload handler:**
- Compound meter mapping applied: `{6:2, 9:3, 12:4}` beats → numerator replacement.
- If the resulting time signature is not in `[[2,4],[3,4],[4,4]]`, it is forced to `[4,4]`.

---

## 5. Audio Pipeline — `AutoScheduler`

### Signal chain (always)
```
Tone.Sampler (instrument) → Tone.Volume (fermataGain) → Tone.Destination
```
`fermataGain` is a module-level variable (`Tone.Volume | null`, initialised `null`). On each file load the old `fermataGain` is `.dispose()`d and a new `Tone.Volume(0).toDestination()` is created. The sampler is always connected to the current `fermataGain` before playback starts.

### Sampler
A `Tone.Sampler` is created on every file load with the full Salamander Grand Piano sample set from `https://tonejs.github.io/audio/salamander/`. Sample URLs cover A0–C8 in chromatic intervals. `release: 1`. The previous sampler is `.disconnect()`d from `fermataGain` but not `.dispose()`d — its audio nodes are orphaned until GC.

`await Tone.loaded()` blocks the upload handler until all sample buffers are fetched. The start overlay is not shown until this resolves.

There is no fallback synthesiser. If the Salamander CDN is unreachable, the app hangs at `await Tone.loaded()` with no user-visible error.

### `AutoScheduler` scheduling
- **Lookahead**: 150 ms (`_AHEAD = 0.15`). `update()` runs in `schedulerLoop` each rAF frame and calls `_scheduleBeat()` for every beat whose scheduled audio time falls within the next 150 ms.
- **Beat granularity**: one beat = one tick-range `[currentTick, currentTick + tpb)`. All MIDI events in that range are scheduled proportionally within `beatS` seconds.
- **Note playback**: `triggerAttackRelease(noteName, 1.5, when, (velocity/127) * 0.9 * gainScale)`. Duration is always 1.5 s regardless of MIDI note-off.
- **AudioContext unlock**: `Tone.start()` is awaited in `startCountdown()` (after the user clicks the start overlay) and in all gesture-based resume paths. This satisfies browser autoplay policy.
- **Tempo control**: `setSpeed(factor)` sets `beatS = (60 / bpm0) / factor`, where `bpm0` is the file's original BPM. `factor` is `smoothedBpm / bpm0` from the beat detector.
- **Chord tracking**: `lastChord` is a `Map<noteName, audioTime>`. Set in `_play()`. Accumulates across the entire song; cleared only on `reset()`. Used by the fermata pinch to identify which notes to re-trigger.
- **Song end**: when `currentTick >= totalTicks`, `playing` is set to `false` and `onSongEnd` fires via `setTimeout(onSongEnd, 2000)`.
- **Mute**: `scheduler.muted = true` prevents note playback without pausing transport.

---

## 6. Gesture System

All five gestures run inside `detect()`. PoseLandmarker landmarks are in normalized `[0,1]` coordinates from the **subject's perspective** (not the mirrored display). Smaller `y` = higher on screen.

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

### Gesture 3 — Cross-pause (both hands above eyes, PoseLandmarker)

| | |
|---|---|
| **Landmarks** | `lm[3]` left eye outer, `lm[4]` right eye inner; `known.left.lm` = lm[19], `known.right.lm` = lm[20] |
| **Condition** | `wl.y < lm[3].y && wr.y < lm[4].y` — both index fingertips above their respective eye landmarks |
| **Hold** | `crossPauseSinceMs` timer; fires after **150 ms** of continuous gesture |
| **Enter effect** | `scheduler.pause()`, `autoPaused = true` |
| **Guards** | Only when `scheduler.playing && !isPaused && !autoPaused && !countdownActive` |
| **Exit condition** | Both wrists below both eyes; only when `autoPaused && !isPaused && !fistPaused` |
| **Exit effect** | `Tone.start()`, `scheduler.resume(0.1)`, `autoPaused = false` |
| **HUD ring** | `crossPauseSinceMs > 0` draws a progress ring below the backdrop in `drawMetronomeHUD()`; fills over 400 ms |
| **On-canvas text** | `'停止'` centred, light grey — drawn when `autoPaused && !fermataPaused` |

### Gesture 4 — Fist cut-off (left hand, HandLandmarker)

| | |
|---|---|
| **Hand** | Subject's left hand — identified by `handedness[i][0].categoryName === 'Left'` |
| **Test** | `isRightFist(lm)` (name is a legacy artefact): all four fingers curled — each fingertip closer to wrist (`lm[0]`) than its MCP knuckle: `d(lm[0],lm[8])<d(lm[0],lm[5])` · `d(lm[0],lm[12])<d(lm[0],lm[9])` · `d(lm[0],lm[16])<d(lm[0],lm[13])` · `d(lm[0],lm[20])<d(lm[0],lm[17])` |
| **Hold** | `fistSinceMs` timer; fires after **300 ms** (`FIST_HOLD_MS`) |
| **Enter effect** | `scheduler.pause()`, `scheduler._stopAll()` (→ `inst.releaseAll()`), `autoPaused = true`, `fistPaused = true` |
| **Exit condition** | Fist test fails (hand opens) |
| **Exit effect** | Waits **800 ms** (`FIST_COOLDOWN`) via `fistResumeCooldownMs`, then `Tone.start()` → `scheduler.resume(0.1)`, `fistPaused = false`, `autoPaused = false` |
| **Isolation** | `fistPaused = true` blocks the cross-pause resume path and the pinch fermata block |
| **On-canvas text** | `'✕ 截止'` centred, red `rgba(224,82,82,0.88)` with shadow |

### Gesture 5 — Fermata pinch (left hand, HandLandmarker)

| | |
|---|---|
| **Hand** | Subject's left hand (`leftLm`) |
| **Test** | `isPinch(lm)`: `d(lm[4],lm[8]) / d(lm[0],lm[9]) < 0.25` — thumb tip to index tip distance divided by wrist-to-middle-MCP hand size |
| **Hold** | `pinchSinceMs` timer; fires after **20 ms** |
| **Guard** | `!fistPaused && fistSinceMs === 0 && leftLm` — blocked when fist confirmed and while fist is forming |
| **Enter effect** | `fermataPaused = true`, `scheduler.pause()`. Compute `NOTE_SUSTAIN = max(0.6, scheduler.beatS * 1.2)`. Filter `scheduler.lastChord` for notes where `when <= Tone.now() && Tone.now() - when < NOTE_SUSTAIN`. If notes found: set `fermataGain.volume.value = -40` (instant mute), call `triggerAttack(notes, Tone.now()+0.02, 0.01)` (quiet retrigger), then `fermataGain.volume.rampTo(0, 0.08)` (80 ms fade-in to mask attack). `fermataSynth = true`. |
| **Exit effect** | `fermataPaused = false`, `pinchSinceMs = 0`. If `fermataSynth`: `fermataGain.volume.rampTo(-40, 0.05)` (50 ms fade-out), then after 60 ms setTimeout: `triggerRelease(capturedNotes, Tone.now())`, reset `fermataGain.volume.value = 0`, `Tone.start().then(() => scheduler.resume(0.1))`. Captured notes are spread into `_rel` before the closure to prevent mutation. If no `fermataSynth`: `Tone.start().then(() => scheduler.resume(0.1))` directly. |
| **State split** | `fermataPaused`, `pinchSinceMs` are module globals. `fermataSynth` (`true \| null`) and `fermataActiveNotes` (`string[] \| null`) are `startCamera()` closure locals. `fermataGain` is a module-level `Tone.Volume \| null`. |
| **On-canvas text** | `'𝄐 延音'` centred, blue `rgba(80,160,255,0.88)` — drawn when `fermataPaused` (overdrawn on top of `'停止'` if both are active) |

---

## 7. Beat Detection

### `handSpeed(state)` → norm/ms

Reads the last `VELO_WINDOW = 3` entries from `state.poseBuf` (a ring buffer, max `POS_BUF_SIZE = 8` entries of `{x, y, t}`). For each consecutive pair, if `dt > 0 && dt < 100`: adds `sqrt(dx² + dy²) / dt` to an accumulator. Returns the mean, or `0` if fewer than two valid pairs.

**Units**: normalized PoseLandmarker coordinates (0–1 range) per millisecond.

**Jump filter** (applied before pushing to `poseBuf`): if the Manhattan distance from the previous sample `|Δx| + |Δy| > 0.25`, the buffer is cleared instead of appending. This discards teleporting landmarks.

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

1. **Rise**: `speed > cachedHighThr` → set `wasAboveHigh = true`, record `wasAboveHighTimestamp`, track `peakSpeed`.
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

Landmark indices used by the app (subject's perspective):

| Index | Landmark | Used for |
|---|---|---|
| `lm[3]` | Left eye outer | Cross-pause eye reference |
| `lm[4]` | Right eye inner | Cross-pause eye reference |
| `lm[11]` | Left shoulder | Volume control upper bound |
| `lm[19]` | Left index fingertip | Left-hand trail/dot, volume control, cross-pause wrist proxy |
| `lm[20]` | Right index fingertip | Right-hand trail/dot, beat detection, cross-pause wrist proxy |
| `lm[23]` | Left hip | Volume control lower bound |

> `WRIST_IDX = {left: 19, right: 20}` — the variable is named "wrist" but indices 19/20 are index fingertips, not wrists (wrists are 15/16). The name is a legacy artefact.

### HandLandmarker

| Property | Value |
|---|---|
| Model | `hand_landmarker` float16 v1, from `storage.googleapis.com/mediapipe-models/...` |
| Running mode | `VIDEO` |
| `numHands` | 2 |
| Confidence thresholds | 0.5 (detection, presence, tracking) |
| Delegate | GPU, falls back to CPU |
| Frequency | Every 3rd frame (`handFrameCounter % 3 === 0`) |

Handedness is from the **subject's perspective** — `'Left'` means the person's actual left hand. Right-hand landmarks from HandLandmarker are not used; beat conduction uses PoseLandmarker `lm[20]`.

HandLandmarker landmark indices used:

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

`handLandmarker.detectForVideo()` is called only when `handFrameCounter % 3 === 0`. The result is stored in the closure variable `lastHandResult`; all downstream gesture logic runs every frame against the last cached result. Effective detection rate: ~20 fps at 60 fps display. If the left hand is lost, the stale cached result persists until the next detection frame — there is no staleness counter or timeout.

---

## 9. HUD Canvas — `drawMetronomeHUD()`

Draws entirely on `#hudCanvas` (absolute overlay, `pointer-events: none`, `z-index: 5`). Never touches `#canvasEl`. Canvas dimensions are set once in `startCamera()` to match `video.videoWidth / videoHeight` (fallback 1280×720); `elHudCanvas.width/height` is set to the same values.

### Layout

```
scale = Math.min(hudCanvas.width / 1280, 0.75)
```

All internal dimension constants (HUD_W, HUD_H, radii, font sizes, offsets) are multiplied by `scale`. The HUD backdrop is centred horizontally, 8×scale px from the top.

| Element | Normal size | Elder size |
|---|---|---|
| Backdrop W | 220×scale | 300×scale |
| Backdrop H | 150×scale | 190×scale |
| Arc radius | 52×scale | 68×scale |
| Beat number font | 38×scale px | 62×scale px |
| Dynamics bar W | 6×scale | 8×scale |

### Anticipation arc

A full-circle ring acts as a progress sweep. `bp` (beat progress 0→1) is computed from `_prevBeatMs` and `_nextBeatMs` (set by the `onBeatScheduled` callback); it is zeroed when `_total ≤ 50 ms` or `_prevBeatMs === 0`. The arc sweeps clockwise from 12 o'clock. Beat 1: full alpha; other beats: half alpha. `urgency = max(0, (bp − 0.70) / 0.30)` brightens the beat number as the beat approaches.

**Flare ring**: triggered when `performance.now() >= _nextFlareAtMs && _flareMs < _nextFlareAtMs`. Expands outward and fades over 160 ms. Beat-1 flares are brighter.

### BPM panels (upper-right of backdrop)

Three rows, smallest to largest font, from top to bottom:

| Label | Value | Notes |
|---|---|---|
| `SCORE` | `bpm0.toFixed(0) + ' BPM'` | Stale label — displays the MIDI file's original BPM, not a score |
| `LIVE` | `smoothedBpm.toFixed(0) + ' BPM'` | Current gesture-detected BPM (EWMA, α=0.35) |
| `AVG` | `avgBpm.toFixed(0) + ' BPM'` | Mean of last 6 raw ictus intervals |

### Dynamics bar

Vertical fill on the left edge of the backdrop. Fraction = `(gainScale − GAIN_MIN) / (GAIN_MAX − GAIN_MIN)`. A horizontal tick mark is drawn at the `gainScale = 1.0` position.

### Cross-pause ring

Drawn below the backdrop when `crossPauseSinceMs > 0`. Fills over 400 ms. Indicates gesture hold progress to the user.

---

## 10. Camera Canvas — `detect()` Draw Pass

Each frame, `#canvasEl` is rendered as follows (order = draw order):

1. **Flip and draw video**: `ctx.save(); ctx.translate(W,0); ctx.scale(-1,1); ctx.drawImage(video,0,0,W,H); ctx.restore()` — mirrors the video so it feels like a mirror.
2. **Trails** (both hands): 18-segment polyline. `TRAIL_STYLES` is a 18-element array of `rgba(176,184,196, α)` where `α` ramps from `1/18×0.7` to `18/18×0.7` — older segments are more transparent. Segment line width ramps up toward the current position.
3. **Wrist dot** (both hands): filled circle, colour `#50d89a` (green), radius elder=11 px / normal=6 px, with a matching glow shadow.
4. **Left-hand skeleton** (only when `leftLm` from HandLandmarker is available): five finger chains `[0,1,2,3,4]`, `[0,5,6,7,8]`, `[0,9,10,11,12]`, `[0,13,14,15,16]`, `[0,17,18,19,20]` drawn in `rgba(176,184,196,0.6)`, 1.5 px; 21 dots at each landmark in `rgba(176,184,196,0.85)`.
5. **Speed bars**: 60×5 px bar above each wrist dot. Fill = `min(speed / cachedHighThr, 1) × 60`. Fill colour: amber `#ff9040` if `speed ≥ cachedHighThr`, else silver `#b0b8c4`. A vertical threshold tick at the right edge.
6. **Reference lines** (left hand only, when `lFinger.visibility > 0.3`): full-width horizontal lines at `lm[11].y×H` (shoulder, `rgba(176,184,196,0.4)`) and `lm[23].y×H` (hip, `rgba(176,184,196,0.2)`).
7. **Status text overlay**: centred on canvas. Precedence: `fistPaused` → `'✕ 截止'` (red); else `autoPaused && !fermataPaused` → `'停止'` (grey); `fermataPaused` is drawn independently and overlaps `'停止'` if both are true → `'𝄐 延音'` (blue). Font: bold Cormorant Garamond, elder=52 px / normal=36 px.

---

## 11. App Flow — Overlays and State

```
page load → #uploadOverlay visible (z:20)
         → user picks MIDI file
         → parse + load samples (await Tone.loaded)
         → start camera (once)
         → #startOverlay visible (z:19)    [click to begin countdown]
         → user clicks #startOverlay
         → #countdownOverlay visible (z:18) [10 → 1 → ♩, ~10.5 s]
         → countdown finishes → Tone.start() → scheduler.start(0.25)
         → playing (no overlay)
         → song end → showSongEnd() after 2 s delay
         → #songEndOverlay visible (z:22)
             ├── 再播一次 → restartGame() → #startOverlay
             └── 載入新曲 → #uploadOverlay
```

**`_resetPlayState()`** is called on restart and song-end. It zeroes all gesture timers (`fistSinceMs`, `fistResumeCooldownMs`, `pinchSinceMs`, `crossPauseSinceMs`), all BPM state (`smoothedBpm`, `lastIctusMs`, `bpmBuffer`, `avgBpm`), resets `gainScale = 1.0`, clears both `handState` buffers and trails, and resets all pause flags.

**`#beatFlash`** — a full-inset `div` with `opacity:0` is present in the HTML and styled in CSS (including an elder-mode variant with `transition: 0.3s`), but no JavaScript in `app.js` references it. It is dead markup.

---

## 12. Elder Mode

Toggled by the "長者模式" button (`toggleElderMode()`). State is stored in `localStorage` under `airConductor_elder` and applied before first paint by an inline `<script>` in `<head>` that sets `data-elder` on `<html>` if the key exists.

### CSS changes (`html[data-elder]`)

- **Font scale custom properties**: `--fs-label: 1.05rem`, `--fs-body: 1.2rem`, `--fs-val: 1.3rem`, `--fs-score: 5.5rem`
- **Header**: padding 18 px, theme/pause buttons 52×52 px, elder/upload buttons larger font and padding
- **Sensitivity slider**: track height 8 px, thumb 30×30 px (both WebKit and Firefox)
- **Beat flash**: transition `0.3 s ease-out` (vs `0.1 s`)
- **Upload overlay**: heading 2.6 rem, body 1 rem, button 0.9 rem
- **Countdown**: number 14 rem (vs 9 rem)
- **Start overlay**: icon 7 rem, heading 2.8 rem, body 1 rem
- **Song-end overlay**: heading 2.6 rem, buttons 0.9 rem with more padding
- **Footer**: progress bar 8 px tall
- **Help dropdown**: 380 px wide, body line-height 2.5

### Canvas changes

`drawMetronomeHUD()` calls `isElderMode()` each frame and branches on it. Elder mode increases: backdrop dimensions, arc radius and line width, beat number font size, wrist dot radius (11 vs 6 px), dynamics bar width, flare expansion radius (20×scale vs 14×scale), all label font sizes.

**No behavioural changes.** All gesture thresholds, timing constants, audio routing, and detection logic are identical in both modes. Elder Mode is purely cosmetic sizing.

---

## 13. Font Size Control

Three buttons (`小/中/大`) set `data-fontsize` to `small`, `medium`, or `large` on `<html>`. Stored in `localStorage` under `airConductor_fontSize`. Applied before first paint by the same inline head script as Elder Mode.

CSS scales `--fs-label`, `--fs-body`, `--fs-val` by `1.0×`, `1.2×`, `1.5×` respectively. Font size control affects only text that uses these custom properties (help dropdown, sensitivity value, footer filename). It does not affect canvas drawing.

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

Note: `+` makes detection *easier* (more sensitive), `-` makes it harder. This is counterintuitive relative to label direction.

---

## 15. Known Issues and Quirks

**`isRightFist` applied to `leftLm`.** `isRightFist(leftLm)` — function name is a legacy artefact. The geometry is hand-symmetric so the result is correct, but the name is misleading.

**`WRIST_IDX` contains fingertip indices.** `WRIST_IDX = {left:19, right:20}` are index fingertips (wrists are 15/16 in PoseLandmarker). The variable name is a legacy artefact.

**`SCORE` HUD label shows file BPM.** The top-right HUD panel is labelled `SCORE` but displays `bpm0` — the MIDI file's initial BPM. The label is stale.

**`#beatFlash` is dead markup.** The div and its CSS (including an elder-mode variant) are never touched by `app.js`.

**MediaPipe WASM version mismatch.** The JS bundle is pinned to `@0.10.35` in the HTML `<script>` import, but `FilesetResolver.forVisionTasks()` in `startCamera()` loads WASM from `@latest`. A WASM/JS version divergence will cause a runtime failure.

**Sampler not disposed on re-load.** Each file load calls `.disconnect()` on the old sampler but not `.dispose()`. Audio nodes are orphaned until GC. Multiple loads in one session accumulate briefly-orphaned objects.

**Camera can only start once.** `cameraStarted` prevents re-entry into `startCamera()`. A camera failure after the first MIDI load is unrecoverable without a page reload.

**No resolution negotiation.** `getUserMedia({video:{facingMode:'user'}})` requests no width/height. Canvas is sized from `video.videoWidth/Height`, falling back to 1280×720. Actual resolution is entirely device/browser-determined.

**Time signature forced to simple metre.** Compound numerators 6/9/12 are mapped to 2/3/4. Any other unsupported time signature is forced to 4/4.

**Tone.js CDN is unversioned.** `https://unpkg.com/tone` resolves to the latest Tone.js release. A breaking Tone.js update will silently break the app.

**No touch or mobile support.** The app requires a desktop webcam. Mobile browsers may redirect `getUserMedia` to the front camera at reduced resolution.

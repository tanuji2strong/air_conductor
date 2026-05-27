# Air Conductor — Developer Context

## 1. Project Overview

空氣指揮家 (Air Conductor) is a browser-based conducting simulator. The user loads a MIDI file, which plays back automatically via Tone.js. The user controls playback speed by waving their right hand (faster waves = faster tempo), controls volume with their left index finger height, and can pause/resume or stop with gestures. The app uses MediaPipe Tasks Vision for real-time pose and hand landmark detection via the webcam, with no server-side component.

---

## 2. Architecture

### File structure and roles

| File | Role |
|---|---|
| `index.html` | Shell, overlay markup, CDN script tags, font size and elder-mode init inline scripts |
| `style.css` | All visual styles; theme tokens via CSS custom properties; elder mode and font-size overrides via HTML attribute selectors |
| `app.js` | All application logic: MIDI parsing, audio scheduling, gesture detection, beat detection, HUD rendering, camera pipeline |

### The three independent rAF loops

All three loops are started unconditionally at page load and run forever, fully decoupled from each other.

**`schedulerLoop()`**
- Calls `scheduler.update()` every frame, which advances the audio lookahead window and calls `_scheduleBeat()` for upcoming beats.
- Updates `elProgressFill` width.
- Owns: audio timing, song progress bar.
- Runs even before a MIDI file is loaded (scheduler is null-guarded).

**`hudLoop()`**
- Calls `drawMetronomeHUD()` when `_hudDirty` is true or when animation is needed (scheduler playing, flare within 200ms, cross-pause ring filling, fist-paused state).
- Owns: the `#hudCanvas` overlay — beat number, BPM panels, dynamics bar, anticipation arc, flare ring, cross-pause ring, CUT-OFF label.
- Never draws to the camera canvas.

**`detect()` (inside `startCamera()`)**
- Runs PoseLandmarker every frame; runs HandLandmarker every 3rd frame (throttled).
- Owns: camera frame draw, wrist trail and dot rendering, left-hand skeleton, shoulder/hip reference lines, pose gesture logic (cross-pause), fist cut-off, fermata pinch, beat detection via `detectBeat()`.
- Does not start until the first MIDI file is loaded and `startCamera()` is called. Once started, runs for the lifetime of the page (`cameraStarted` flag prevents re-entry).

---

## 3. Audio Pipeline

1. **Tone.js** (`https://unpkg.com/tone`) is the sole audio library. There is no `AudioContext` created directly by the app and no fallback synthesiser.
2. **Sampler**: On each file load, a `Tone.Sampler` is created with the full Salamander Grand Piano sample set loaded from `https://tonejs.github.io/audio/salamander/`. The sampler is connected to `Tone.Destination` immediately.
3. **Loading**: `await Tone.loaded()` blocks the file-load handler until all sample buffers are fetched. The start overlay is not shown until loading completes.
4. **AudioContext unlock**: `await Tone.start()` is called in `startCountdown()` (after the user has clicked the start overlay) and in all gesture resume paths. This satisfies the browser autoplay policy.
5. **Scheduling**: `AutoScheduler.update()` runs every rAF tick via `schedulerLoop`. It calls `_scheduleBeat()` for each upcoming beat within a 0.15-second lookahead window. Notes are scheduled via `this.inst.triggerAttackRelease(noteName, 1.5, when, velocity)`. The Tone.js audio clock (`Tone.now()`) is used for all scheduling; `performance.now()` is used only for gesture timing.
6. **Chord tracking**: `AutoScheduler.lastChord` is a `Set<string>` that is cleared at the start of each `_scheduleBeat()` call and populated with every note name that fires a `note_on` in that beat window. This is used by the fermata pinch gesture to recreate the last chord as oscillators.
7. **Stop**: `AutoScheduler._stopAll()` calls `this.inst.releaseAll()`, which triggers the release envelope on all active sampler voices.
8. **Song end**: `_scheduleBeat()` sets `playing = false` when `currentTick >= totalTicks`. `showSongEnd()` fires 2 seconds later via `setTimeout`.
9. **Note name format**: `_midiName(n)` produces scientific pitch notation with sharps only: `"C4"`, `"D#4"`, `"A#3"` etc. Compatible with Tone.js input.

---

## 4. Gesture System

All PoseLandmarker coordinates are in normalized [0, 1] space from the **subject's perspective** (not the mirrored display). `wl.y < el.y` means the wrist is above the eye in the image (smaller y = higher on screen).

### Beat conducting — right hand (PoseLandmarker)
- **Hand**: subject's right hand
- **Landmark**: `lm[16]` (right wrist, PoseLandmarker pose landmarks)
- **Mechanism**: `handSpeed()` + `detectBeat()` called every frame; see Section 5.
- **Effect**: adjusts `scheduler.speedFactor` via `scheduler.setSpeed(smoothedBpm / bpm0)`.

### Volume control — left index finger (PoseLandmarker)
- **Hand**: subject's left hand
- **Landmarks**: `lm[19]` (left index fingertip), `lm[11]` (left shoulder), `lm[23]` (left hip)
- **Mechanism**: if `lFinger.y < lShoulder.y` → `gainScale += GAIN_RATE` (0.01/frame); if `lFinger.y > lHip.y` → `gainScale -= GAIN_RATE`. Otherwise gainScale holds. Clamped to `[GAIN_MIN, GAIN_MAX]` = `[0.1, 2.0]`. Propagated to `scheduler.gainScale` each frame.
- **Effect**: scales note velocity at playback time inside `AutoScheduler._play()`.

### Cross-pause — both hands above eyes (PoseLandmarker)
- **Landmarks**: `lm[3]` (left eye), `lm[4]` (right eye), `known.left.lm` (left wrist via lm[15]), `known.right.lm` (right wrist via lm[16])
- **Condition**: `wl.y < el.y && wr.y < er.y` — both wrists above their respective eyes
- **Hold timer**: `crossPauseSinceMs`; fires after 150ms of continuous gesture
- **Effect**: sets `autoPaused = true`, `crossPaused = true`, calls `scheduler.pause()`
- **Guards**: only active when `scheduler.playing && !isPaused && !autoPaused && !countdownActive`
- **Resume**: both wrists below both eyes (`wl.y > el.y && wr.y > er.y`); only when `autoPaused && !isPaused && !fistPaused`
- **On-canvas indicator**: `'停止'` drawn centred on the camera canvas when `autoPaused && !fermataPaused`

### Fist cut-off — left hand (HandLandmarker)
- **Hand**: subject's left hand (`handedness[i][0].categoryName === 'Left'` → `leftLm`)
- **Fist test** (`isRightFist(lm)` — name is a legacy artifact): for each of the four fingers (index, middle, ring, pinky), checks that the fingertip is closer to the wrist than the MCP knuckle using Euclidean distance in normalized coordinates: `d(lm[0], lm[8]) < d(lm[0], lm[5])` etc. All four conditions must be true.
- **Hold timer**: `fistSinceMs`; fires after `FIST_HOLD_MS` = 300ms
- **Effect**: calls `scheduler.pause()`, `scheduler._stopAll()` (triggers `releaseAll()` on the sampler), sets `autoPaused = true`, `fistPaused = true`
- **Resume**: hand opens (fist test fails), then waits `FIST_COOLDOWN` = 800ms via `fistResumeCooldownMs` before calling `Tone.start()` then `scheduler.resume(0.1)`. Sets `fistPaused = false`, `autoPaused = false`.
- **Isolation**: `fistPaused = true` blocks both the cross-pause resume path and the pinch fermata block.
- **HUD**: `'✕ CUT-OFF'` label drawn below the beat number when `fistPaused` is true.

### Fermata pinch — left hand (HandLandmarker)
- **Hand**: subject's left hand (`leftLm`)
- **Pinch test** (`isPinch(lm)`): normalised thumb-tip to index-tip distance < 0.25. Scale-invariant: raw distance `d(lm[4], lm[8])` divided by hand size `d(lm[0], lm[9])` (wrist to middle MCP).
- **Hold timer**: `pinchSinceMs`; fires after 150ms of continuous gesture
- **Guard**: only active when `!fistPaused && fistSinceMs === 0 && leftLm` — blocked both when a fist is confirmed (`fistPaused`) and while a fist is forming (`fistSinceMs > 0`).
- **Effect on enter**:
  1. Sets `fermataPaused = true`
  2. Calls `scheduler.pause()` (stops the scheduler tick and calls `releaseAll()` on the sampler — notes decay naturally over the 1-second release envelope)
  3. Iterates `scheduler.lastChord` (the Set of note names from the most-recently scheduled beat); for each note, creates a `Tone.Oscillator` (sine wave), fades it in from −40 dB to −12 dB over 0.2s, and pushes it into `fermataOscillators[]`. This sustains the chord indefinitely while the pinch is held.
- **Effect on release**:
  1. Sets `fermataPaused = false`, resets `pinchSinceMs = 0`
  2. For each oscillator in `fermataOscillators`: ramps volume to −60 dB over 0.2s, then `stop()` + `dispose()` after 250ms in a `setTimeout`
  3. Clears `fermataOscillators = []`
  4. Chains `Tone.start().then(() => scheduler.resume(0.1))`
- **On-canvas indicator**: `'𝄐 延音'` drawn centred in blue (`rgba(80,160,255,0.88)`) when `fermataPaused` is true.
- **State**: `fermataPaused` and `pinchSinceMs` are globals; `fermataOscillators` and `fermataNote` (dead) are `startCamera()` closure variables.

---

## 5. Beat Detection

### `handSpeed(state)`
- Input: `state.poseBuf` — a ring buffer of `{x, y, t}` samples (max `POS_BUF_SIZE` = 8 entries), where x/y are raw normalized pose coordinates (0–1) and t is `performance.now()` in milliseconds.
- Computes average speed over the last `VELO_WINDOW` = 3 samples.
- For each consecutive pair: `speed = sqrt(dx² + dy²) / dt`
- Output unit: **normalized-coordinates per millisecond** (norm/ms).

### `cachedHighThr` at default sensitivity
- Formula: `0.003 * Math.pow(0.22, (sens - 1) / 4)`
- At `sens = 1` (default): `0.003`. At `sens = 10`: `0.003 * 0.22^(9/4) ≈ 0.000114`.
- Higher slider value = lower threshold = more sensitive.

### `detectBeat(speed, frameT, state)`
1. **Rise phase**: when `speed > cachedHighThr`, sets `state.wasAboveHigh = true` and tracks `state.peakSpeed`.
2. **Ictus detection**: when `wasAboveHigh && speed < peakSpeed * 0.55` (descent to 55% of peak).
3. **Debounce**: only fires if `frameT - lastBeatMs >= MIN_BEAT_MS` (200ms minimum between beats).
4. **Window**: only fires if the rise phase lasted less than 600ms.
5. **BPM update**: interval is `frameT - lastIctusMs`. Valid range: 200ms–3000ms (20–300 BPM). Raw BPM clamped to `[bpm0 * 0.4, bpm0 * 2.5]`, then smoothed: `smoothedBpm = 0.30 * smoothedBpm + 0.70 * clamped`. Also maintained: `bpmBuffer` (last 6 values) → `avgBpm`.

---

## 6. Hand Tracking

### PoseLandmarker
- **Model**: `pose_landmarker_lite` (float16, version 1) from Google Cloud Storage
- **Config**: `runningMode: 'VIDEO'`, `numPoses: 1`, all confidence thresholds 0.5
- **Delegate**: GPU with CPU fallback
- **Runs**: every frame inside `detect()`

### HandLandmarker
- **Model**: `hand_landmarker` (float16, version 1) from Google Cloud Storage
- **Config**: `runningMode: 'VIDEO'`, `numHands: 2`, all confidence thresholds 0.5
- **Delegate**: GPU with CPU fallback
- **Responsible for**: left hand fist detection and fermata pinch detection (via `leftLm`); right hand (`rightLm`) is detected but currently unused
- **Handedness convention**: Tasks Vision API reports handedness from the **subject's perspective** — `'Left'` is the person's actual left hand

### Throttle strategy
- Global counter `handFrameCounter` incremented each `detect()` call.
- `handLandmarker.detectForVideo()` called only when `handFrameCounter % 3 === 0`.
- Result cached in closure variable `lastHandResult`. All downstream logic runs every frame against the cached result.
- Effective hand detection rate: ~20fps at 60fps display.

### No re-detection / mode switching
- HandLandmarker runs exclusively in `VIDEO` mode for the lifetime of the page. There is no `IMAGE` mode fallback, no `handMissedFrames` counter, and no `setOptions()` calls. If the left hand is lost, the cached `lastHandResult` from the last successful detection persists until the next detection frame.

---

## 7. Known Limitations and Dead Code

**`flashOverlay()` is dead code.** Defined but has zero call sites. Beat flashes do not fire.

**`finishGame()` is dead code.** Defined but never called. `showSongEnd()` is the actual song-end handler.

**`_currentBeatNum` is always 1.** Declared and reset to 1 but never written by the scheduler callback (only `_nextBeatNum` is updated). Never read in the HUD.

**`crossPaused` flag is set but never branched on.** Set alongside `autoPaused` during cross-pause; the actual gate is `autoPaused && !fistPaused`. Carries no independent effect.

**`fermataNote` is dead code.** Declared in the `startCamera()` closure and set to `null` in both the enter and release blocks, but never read or used for anything meaningful. Leftover from the previous single-note sustain implementation.

**`fermataOscillators` leaks on song reset.** `_resetPlayState()` sets `fermataPaused = false` but does not stop or dispose any oscillators currently in the closure-scoped `fermataOscillators` array. If the song ends or is restarted while a fermata pinch is active, those oscillators continue running until the page is unloaded.

**Help dropdown documents incorrect gestures.** `index.html` states "右手握拳 → 截止" (right-hand fist) and "右手捏指 → 延音" (right-hand pinch). The actual implementation uses the **left** hand for both gestures.

**`isRightFist` is applied to `leftLm`.** The function is named `isRightFist` but called as `isRightFist(leftLm)`. The geometry is symmetric so the check is correct, but the name is a misleading legacy artifact.

**`_fb410` DOM probe is a stub.** `document.getElementById('fileBpm')` checks for a `#fileBpm` element that does not exist in `index.html`. Silent no-op from a removed sidebar element.

**`autoCtx` comment in schedulerLoop** refers to a non-existent `autoCtx`. The comment block mentions audio scheduling independence from MediaPipe but references removed implementation details.

**Cross-pause resume does not guard against `fermataPaused`.** The resume gesture (`autoPaused && !isPaused && !fistPaused`) will fire even when `fermataPaused` is true, causing the scheduler to resume while fermata oscillators are still playing.

**Camera resolution may be silently downscaled.** `getUserMedia({video:{width:1280,height:720}})` is a hint, not a guarantee. The canvas is fixed at 1280×720.

**Time signature support is limited.** Compound meters (6, 9, 12 beats) are mapped to simple equivalents. Any time signature not in `[[2,4],[3,4],[4,4]]` is forced to 4/4.

**`startCamera()` can only be called once per page load.** The `cameraStarted` flag prevents re-entry. Camera failures after init are unrecoverable without a page reload.

---

## 8. What Was Intentionally Removed

**`audioCtx` / Web Audio API direct usage.** All `AudioContext` creation, `audioCtx.resume()` calls, and `OscillatorNode`/`GainNode` scheduling replaced by Tone.js. The only remaining raw Web Audio usage is the `Tone.Oscillator` created for the fermata sustain.

**`makeFallbackInstrument()`.** The triangle-wave synth fallback is gone. Tone.js Sampler is the sole instrument. If the Salamander CDN is unavailable, there is no audio — no user-visible fallback indicator.

**`Soundfont.instrument()` background load.** The two-phase loading (fallback plays immediately, Soundfont swaps in later) is replaced by a single blocking `await Tone.loaded()`. The UI does not show a start overlay until samples are fully downloaded.

**`AutoScheduler._nodes` node-pruning.** The array of scheduled `BufferSourceNode`/`OscillatorNode` references and the per-frame pruning loop are gone. Tone.js manages its own voice lifecycle.

**`AutoScheduler.lastNote` (single note).** Replaced by `AutoScheduler.lastChord` (a `Set`), which captures all note-on events in the most recently scheduled beat window for polyphonic fermata sustain.

**HandLandmarker re-detection mode switching.** The `handVideoMode` boolean, `handMissedFrames` counter, `HAND_REDETECT_FRAMES` constant, and both `setOptions()` calls (switching between `'VIDEO'` and `'IMAGE'` modes) are removed. HandLandmarker now runs in `VIDEO` mode unconditionally.

**Right-hand pinch/fermata (original).** An earlier version used a right-hand pinch gesture for fermata. Removed because the fast conducting motion of the right hand caused false positives. The gesture was redesigned for the **left** hand using `isPinch()` inside `startCamera()`.

**MediaPipe Holistic.** Replaced by Tasks Vision API in a previous revision.

**Sidebar panel.** Replaced by the floating HUD canvas.

---

## 9. Future Development Notes

**`fermataNote` should be removed.** It is declared and nulled but never read. Removing it would clarify that `fermataOscillators` and `scheduler.lastChord` together fully own the fermata state.

**`fermataOscillators` should be cleaned up in `_resetPlayState()`.** Currently, restarting or ending the song while a fermata is active leaks running oscillators. The fix: iterate `fermataOscillators`, stop and dispose each, then reset the array to `[]`.

**Cross-pause resume should guard against `fermataPaused`.** Add `&& !fermataPaused` to the `if(autoPaused && !isPaused && !fistPaused && scheduler)` check, or lower-hands gesture should not resume the scheduler while fermata oscillators are still fading out.

**`flashOverlay()` and `finishGame()` should either be wired up or deleted.** Dead functions are a maintenance hazard.

**Sensitivity slider direction is counterintuitive.** Dragging right (higher value) makes detection easier (lower threshold), which is correct behaviour but may surprise users expecting higher value = harder. The slider range 1–10 maps to decreasing threshold via `0.003 * Math.pow(0.22, (sens-1)/4)`.

**Help dropdown text is wrong.** Should be updated to say "左手握拳 → 截止" and "左手捏指 → 延音" to match the actual left-hand implementation.

**`isRightFist` name is misleading.** Should be renamed to `isHandClosed` or `isFist`.

**BPM smoothing is aggressive.** `SMOOTHING = 0.30` gives 70% weight to each new raw interval. If a "lock-in" mode is desired, `bpmBuffer` and `avgBpm` are already computed and could drive `scheduler.setSpeed()` instead of `smoothedBpm`.

**No touch/mobile support.** The app requires a webcam and operates at 1280×720. `getUserMedia` on mobile may silently switch to the front camera at a lower resolution.

**Tone.js Sampler CDN dependency.** Samples load from `tonejs.github.io/audio/salamander/`. If unavailable, there is no audio and no user-visible error beyond the load hang at `await Tone.loaded()`.

**`_fb410` stub should be deleted.** `document.getElementById('fileBpm')` probes for a non-existent element on every file load.

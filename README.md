# Air Conductor — 空氣指揮家

**A browser-native gesture-based music conducting simulator.** Load any MIDI file and conduct it in real time using only your webcam — no installation, no plugins.

[![Live Demo](https://img.shields.io/badge/Live%20Demo-air--conductor.vercel.app-blue)](https://air-conductor.vercel.app)
[![Demo Video](https://img.shields.io/badge/Demo-YouTube-red)](https://www.youtube.com/watch?v=h5MHFWs-HSU)

---

## What It Does

Your right-hand gestures control the tempo of a MIDI playback in real time. Your left hand controls volume. Two discrete gestures — a fist and a pinch — let you cut off or sustain the music, just like a real conductor.

| Gesture | Hand | Effect |
|---|---|---|
| Swing speed | Right index fingertip | Tempo (faster swing → faster music) |
| Fingertip height | Left index fingertip | Volume (above shoulder → louder, below hip → softer) |
| Closed fist | Left hand | Cut-off (stops all notes immediately) |
| Pinch (thumb + index) | Left hand | Fermata (sustains current chord) |

---

## How It Works

- **Tempo detection** — An EWMA (α = 0.35) smoothed beat-per-minute estimator tracks the velocity of the right index fingertip. A finite-state machine identifies each downbeat (ictus) using a rise-and-fall velocity profile, fires at 55% of peak speed, and adapts playback speed in real time.
- **Decoupled loops** — Audio scheduling (`requestAnimationFrame` + Tone.js lookahead) and vision inference (MediaPipe) run in two independent loops so inference latency cannot perturb beat timing.
- **Gesture recognition** — MediaPipe PoseLandmarker tracks body landmarks for tempo and volume; MediaPipe HandLandmarker classifies hand posture for fist and pinch gestures every 3rd frame.
- **Synthesis** — Tone.js `PolySynth` with detuned triangle oscillators for warmth. A separate sustain synth with 150 ms attack handles fermata chord sustain without transient overlap.

## Tech Stack

| | |
|---|---|
| Pose + hand tracking | MediaPipe Tasks Vision (PoseLandmarker + HandLandmarker) |
| Audio synthesis | Tone.js PolySynth, Web Audio API |
| MIDI parsing | Custom parser (no library) |
| Frontend | Vanilla JS, CSS custom properties — no framework, no build step |

---

## Evaluation

Quantitative performance was measured across three metronome-grounded tempo conditions. Each session used an external metronome as ground truth; ictus events were logged via the browser console.

| Condition | n | Mean BPM | MAE (BPM) |
|---|---|---|---|
| 72 BPM | 177 | 94.7 | 24.0 |
| 110 BPM | 344 | 123.6 | 14.9 |
| 160 BPM | 288 | 159.8 | 16.3 |

**Gesture detection latency** (pooled, n = 809): mean **110 ms**, 95th percentile **208 ms** — well below the 300 ms perceptibility threshold for trained musicians.

**Vision loop**: mean **31.6 fps** on a ThinkPad X390 running Chrome.

---

## Accessibility

- **Font-size control** — three tiers (S / M / L); the largest tier enlarges all UI elements and HUD graphics for elder users
- **Bilingual interface** — Traditional Chinese and English, switchable at any time without reloading
- **Zero install** — runs in any desktop browser with a webcam; no app store, no account

---

## Run Locally

No build step required.

```bash
git clone https://github.com/tanuji2strong/air_conductor.git
cd air_conductor
python3 -m http.server 8080
# open http://localhost:8080 in Chrome
```

Load any `.mid` file using the upload button. Camera and MediaPipe models load automatically.

---

## Evaluation Data

Raw per-session ictus logs are in [`bpms/`](bpms/). Each JSON file records smoothed BPM, raw BPM, detection latency, FPS samples, and gesture events for one conducting session.

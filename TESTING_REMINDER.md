# Air Conductor — Testing Reminder

## What is this project?
A browser-native gesture conducting simulator (webcam only, no install).
The user waves their right hand to control tempo, left hand height for volume,
left fist to cut off, left pinch for fermata. Runs at localhost:8080.
Live demo: https://air-conductor.vercel.app/

## What are we trying to do?
Submit the paper `aslizhuanti.tex` to a journal.
The paper was missing any evaluation. We added:
- A heuristic accessibility evaluation section (already written in the tex)
- A quantitative technical evaluation section (NEEDS real numbers from the test below)

The numbers go into a new subsection in §IV of the paper.
Without them, the paper is a system description with no evidence.

## What has already been done (do not redo)
- Removed co-author Keh-Ning Chang from the tex
- Expanded §II-A related work (added Frid 2019 ADMI review, Handmate MIDI, VirtualConductor)
- Added §V-F heuristic accessibility evaluation subsection
- Added references rw19–rw22
- Instrumented `app.js` with eval logging (no visible change to the app)

## What still needs to be done
1. Run the test below (~20 min)
2. Paste the console output to Claude
3. Claude writes the quantitative evaluation subsection in the tex
4. Paper is ready for journal submission

---

## How to run locally

```bash
cd /home/jonathantanuji/air_conductor
python3 -m http.server 8080
```

Open `http://localhost:8080` in **Chrome** (best MediaPipe support).

---

## The Test (do this exactly once)

### Setup
- Open DevTools: `F12` → Console tab
- Complete the onboarding tutorial normally each time you load a song

### Step 1 — Tempo test (~15 min)
Load 3 different MIDI files, one at a time. For each song, just **conduct with your right hand** trying to stay in sync with the music. You don't need to be perfect — just conduct naturally.

| Run | Pick a MIDI that feels... |
|-----|--------------------------|
| 1   | Slow (ballad, adagio)    |
| 2   | Medium (march, pop)      |
| 3   | Fast (allegro, dance)    |

No metronome needed. No pinching or fisting during this part.

### Step 2 — Gesture test (~2 min)
After the 3 songs, spend 2 minutes doing these deliberately:
- **Left fist**: clench, hold until the cut-off fires on screen, open. Repeat ~10 times.
- **Left pinch**: pinch thumb+index, hold briefly, release. Repeat ~10 times.

### Step 3 — Get results
Type in the console:
```javascript
acSummary()
```

Copy the entire output. It looks like:
```
=== Air Conductor Evaluation Summary ===
Ictuses detected : 87
Tempo RMSE       : 8.3 BPM  (n=84)
Detection latency: mean 42 ms  max 118 ms
Vision loop FPS  : mean 58.2  (3 samples)
Fist cut-offs    : 8   Fermata pinches: 9
Volume raises    : 12   Volume lowers : 10
```

Optionally also run `acExport()` to download the full JSON log.

---

## What to tell Claude in the new session

Just say:
> "Read TESTING_REMINDER.md and help me finish the paper. Here are my test results: [paste acSummary() output]"

Claude will write the quantitative evaluation subsection and the paper is done.

---

## File reference

| File | Purpose |
|------|---------|
| `aslizhuanti.tex` | The paper (edit this) |
| `app.js` | The app (instrumented, do not remove logging until paper is submitted) |
| `paperac.pdf` | Old compiled PDF (ignore, tex is the source of truth) |

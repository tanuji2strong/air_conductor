'use strict';

// ═══════════════════════════════════════════
//  I18N STRINGS
// ═══════════════════════════════════════════
const STRINGS = {
  zh: {
    title:              '空氣指揮家',
    helpBtn:            '說明 ▾',
    helpBtnOpen:        '說明 ▴',
    fsSmall:            '小',
    fsMedium:           '中',
    fsLarge:            '大',
    uploadBtn:          '載入 MIDI',
    helpRightTitle:     '右手 — 指揮節拍',
    helpRightBody:      '揮動右手設定速度。揮得越快，音樂越快；越慢，音樂越慢。停止揮動，維持最後速度。',
    helpLeftTitle:      '左手 — 控制音量',
    helpLeftBody:       '食指舉高過肩膀 → 音量增加<br>食指降至腰部以下 → 音量減少<br>手停在中間 → 音量維持',
    helpGestureTitle:   '手勢',
    helpGestureBody:    '左手握拳 → 截止（立即停止）<br>左手捏指 → 延音（音符自然延長）',
    helpSensTitle:      '靈敏度',
    helpSensBody:       '調整偵測手臂動作所需的速度',
    helpShortcutTitle:  '鍵盤快捷鍵',
    helpShortcutBody:   '<kbd>Space</kbd> 暫停 / 繼續<br><kbd>R</kbd> 重新開始歌曲<br><kbd>M</kbd> 靜音 / 取消靜音<br><kbd>+</kbd> / <kbd>−</kbd> 調整靈敏度<br><kbd>L</kbd> 切換亮色模式',
    startTitle:         '點擊開始',
    startBody:          '點擊畫面，開始 5 秒倒數<br>準備好跟上節拍！',
    countdownSub:       '準備好跟上節拍！',
    cameraLoadingText:  '正在啟動相機…',
    uploadOverlayTitle: '空氣指揮家',
    uploadOverlayBody:  '載入 MIDI 檔案——音樂會自動播放。',
    uploadOverlayBtn:   '載入 MIDI 檔案',
    songEndTitle:       '演奏結束',
    playAgain:          '再播一次',
    loadNew:            '載入新曲',
    cutoff:             '✕ 截止',
    fermata:            '𝄐 延音',
    pauseTitle:         '暫停',
    resumeTitle:        '繼續',
    themeTitle:         '切換亮色／暗色模式',
  },
  en: {
    title:              'Air Conductor',
    helpBtn:            'Help ▾',
    helpBtnOpen:        'Help ▴',
    fsSmall:            'S',
    fsMedium:           'M',
    fsLarge:            'L',
    uploadBtn:          'Load MIDI',
    helpRightTitle:     'Right Hand — Beat',
    helpRightBody:      'Wave your right hand to set the tempo. Faster waves speed up the music; slower waves slow it down. Stop waving to hold the last tempo.',
    helpLeftTitle:      'Left Hand — Volume',
    helpLeftBody:       'Raise index finger above shoulder → Volume up<br>Lower index finger below hip → Volume down<br>Hold in between → Volume holds',
    helpGestureTitle:   'Gestures',
    helpGestureBody:    'Left fist → Cut-off (stop immediately)<br>Left pinch → Fermata (notes sustain naturally)',
    helpSensTitle:      'Sensitivity',
    helpSensBody:       'Adjust the arm speed required to detect a beat',
    helpShortcutTitle:  'Keyboard Shortcuts',
    helpShortcutBody:   '<kbd>Space</kbd> Pause / Resume<br><kbd>R</kbd> Restart song<br><kbd>M</kbd> Mute / Unmute<br><kbd>+</kbd> / <kbd>−</kbd> Adjust sensitivity<br><kbd>L</kbd> Toggle light mode',
    startTitle:         'Click to Start',
    startBody:          'Click the screen to begin a 5-second countdown<br>Get ready to follow the beat!',
    countdownSub:       'Get ready to follow the beat!',
    cameraLoadingText:  'Initialising camera…',
    uploadOverlayTitle: 'Air Conductor',
    uploadOverlayBody:  'Load a MIDI file — music plays automatically.',
    uploadOverlayBtn:   'Load MIDI File',
    songEndTitle:       'Performance Complete',
    playAgain:          'Play Again',
    loadNew:            'New Song',
    cutoff:             '✕ Cut-off',
    fermata:            '𝄐 Fermata',
    pauseTitle:         'Pause',
    resumeTitle:        'Resume',
    themeTitle:         'Toggle light / dark mode',
  }
};

let currentLang = localStorage.getItem('airConductor_lang') || 'zh';

function setLang(lang) {
  currentLang = lang;
  document.documentElement.setAttribute('data-lang', lang);
  document.documentElement.lang = lang === 'zh' ? 'zh-TW' : 'en';
  localStorage.setItem('airConductor_lang', lang);
  document.title = STRINGS[lang].title;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = STRINGS[lang][el.dataset.i18n] || '';
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = STRINGS[lang][el.dataset.i18nHtml] || '';
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = STRINGS[lang][el.dataset.i18nTitle] || '';
  });
  document.querySelectorAll('[data-lang-btn]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.langBtn === lang);
  });
  const pb = document.getElementById('pauseBtn');
  if (pb) pb.title = isPaused ? STRINGS[lang].resumeTitle : STRINGS[lang].pauseTitle;
  const helpBtn = document.getElementById('helpBtn');
  const helpDropdown = document.getElementById('helpDropdown');
  if (helpBtn && helpDropdown) {
    helpBtn.textContent = helpDropdown.classList.contains('open')
      ? STRINGS[lang].helpBtnOpen
      : STRINGS[lang].helpBtn;
  }
}


// ═══════════════════════════════════════════
//  MIDI ANALYZER
// ═══════════════════════════════════════════
class MidiAnalyzer {
  constructor(arrayBuffer) {
    this.tpb=480; this.timeSig=[4,4]; this.tempoUs=500_000;
    this.events=[]; this.totalTicks=0; this._tsSet=false; this._tempoSet=false;
    this._parse(arrayBuffer);
  }
  get initialBpm() { return 60_000_000/this.tempoUs; }
  _parse(buf) {
    const dv=new DataView(buf); let p=0;
    const r8  =()=>{if(p>=dv.byteLength)throw new Error('EOF');return dv.getUint8(p++);};
    const r16 =()=>{if(p+2>dv.byteLength)throw new Error('EOF');const v=dv.getUint16(p);p+=2;return v;};
    const r32 =()=>{if(p+4>dv.byteLength)throw new Error('EOF');const v=dv.getUint32(p);p+=4;return v;};
    const rVLQ=()=>{let v=0,b,guard=0;do{b=r8();v=(v<<7)|(b&0x7f);if(++guard>4)break;}while(b&0x80);return v;};
    const all=[];
    try{
      p+=4;p+=4; r16();const numTracks=r16(); this.tpb=r16();
      for(let t=0;t<numTracks;t++){
        try{
          p+=4; const tLen=r32();
          const tEnd=Math.min(p+tLen,dv.byteLength);
          let abs=0,rs=0;
          while(p<tEnd){
            try{
              abs+=rVLQ();
              if(p>=tEnd)break;
              let sb=dv.getUint8(p);
              if(sb&0x80){rs=sb;p++;}else{sb=rs;}
              if(!rs){p++;continue;}
              const hi=sb>>4,lo=sb&0x0f;
              if(sb===0xff){const mt=r8(),ml=rVLQ(),ms=p;p+=ml;
                if(mt===0x51&&ml>=3&&!this._tempoSet){this.tempoUs=(dv.getUint8(ms)<<16)|(dv.getUint8(ms+1)<<8)|dv.getUint8(ms+2);this._tempoSet=true;}
                else if(mt===0x58&&ml>=2&&!this._tsSet){this.timeSig=[dv.getUint8(ms),Math.pow(2,dv.getUint8(ms+1))];this._tsSet=true;}
                else if(mt===0x2f){break;}
              }else if(sb===0xf0||sb===0xf7){p+=rVLQ();}
              else if(hi===0x9){const n=r8(),v=r8();all.push({absTick:abs,type:v>0?'note_on':'note_off',channel:lo,note:n,velocity:v});this.totalTicks=Math.max(this.totalTicks,abs);}
              else if(hi===0x8){const n=r8(),v=r8();all.push({absTick:abs,type:'note_off',channel:lo,note:n,velocity:v});this.totalTicks=Math.max(this.totalTicks,abs);}
              else if(hi===0xc){all.push({absTick:abs,type:'program_change',channel:lo,program:r8()});}
              else if(hi===0xb||hi===0xa||hi===0xe){r8();r8();}
              else if(hi===0xd){r8();}
              else{p++;}
            }catch(e){break;}
          }
          p=tEnd;
        }catch(e){break;}
      }
    }catch(e){console.warn('MIDI parse stopped early:',e.message);}
    all.sort((a,b)=>a.absTick-b.absTick);
    this.events=all;
  }
}


// ═══════════════════════════════════════════
//  AUTO SCHEDULER
// ═══════════════════════════════════════════
class AutoScheduler {
  constructor(analyzer,instrument,onBeatScheduled,onSongEnd){
    this.a=analyzer; this.inst=instrument;
    this.onBeatScheduled=onBeatScheduled; this.onSongEnd=onSongEnd||null;
    this.bpm=analyzer.initialBpm; this.beatS=60/this.bpm;
    this.ts=[4,4]; this.playing=false; this.muted=false;
    this._AHEAD=0.15; this.gainScale=1.0; this.lastChord=new Map();
    this.beatSnapshots=[];
    this.currentTick=0; this.eventIndex=0;
    this.nextBeatAudioTime=0; this._beatNum=1; this._songEndScheduled=false;
  }
  setTS(ts){this.ts=ts;}
  start(delayS=0.35){
    this.playing=true;
    this.nextBeatAudioTime=Tone.now()+delayS;
  }
  pause(){this.playing=false;this._stopAll();}
  pauseOnly(){
    // Stops the scheduler from advancing through the score
    // but intentionally does NOT call _stopAll() or
    // releaseAll(). This lets currently-sounding sampler
    // notes continue their natural decay into the sustain synth.
    this.playing = false;
  }
  resume(delayS=0.08){
    this.nextBeatAudioTime=Tone.now()+delayS;
    this.playing=true;
  }
  setSpeed(factor){
    this.beatS=(60/this.bpm)/factor;
  }
  reset(){this.playing=false;this.currentTick=0;this.eventIndex=0;this._beatNum=1;this._songEndScheduled=false;this._stopAll();this.lastChord=new Map();this.beatSnapshots=[];}
  _stopAll(){if(this.inst)this.inst.releaseAll();}
  _midiName(n){return['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][n%12]+(Math.floor(n/12)-1);}
  _play(ev,when){
    if(this.muted||ev.channel===9||!this.inst)return;
    if(ev.type==='note_on'&&ev.velocity>0){
      const noteName=this._midiName(ev.note);
      this.inst.triggerAttackRelease(noteName,0.35,when,(ev.velocity/127)*0.9*this.gainScale);
      this.lastChord.set(noteName, when);
    }
  }
  update(){
    if(!this.playing)return;
    const now=Tone.now();
    while(this.nextBeatAudioTime<now+this._AHEAD){
      this._scheduleBeat(this.nextBeatAudioTime);
      if(!this.playing)break;
      const msAhead=(this.nextBeatAudioTime-now)*1000;
      this.onBeatScheduled(performance.now()+msAhead, this._beatNum);
      this._beatNum=(this._beatNum%this.ts[0])+1;
      this.nextBeatAudioTime+=this.beatS;
    }
  }
  _scheduleBeat(startTime){
    const s=this.currentTick,e=s+this.a.tpb,evs=this.a.events;
    while(this.eventIndex<evs.length&&evs[this.eventIndex].absTick<s)this.eventIndex++;
    let i=this.eventIndex;
    const beatNotes=[];
    while(i<evs.length&&evs[i].absTick<e){
      const ev=evs[i],frac=(ev.absTick-s)/this.a.tpb;
      this._play(ev,startTime+frac*this.beatS);
      if(ev.type==='note_on'&&ev.velocity>0&&ev.channel!==9)
        beatNotes.push(this._midiName(ev.note));
      i++;
    }
    if(beatNotes.length>0){
      this.beatSnapshots.push({notes:beatNotes,at:startTime});
      const cutoff=Tone.now()-this.beatS*2;
      this.beatSnapshots=this.beatSnapshots.filter(s=>s.at>cutoff);
    }
    this.currentTick=e;
    if(this.currentTick>=this.a.totalTicks&&!this._songEndScheduled){
      this._songEndScheduled=true;
      this.playing=false;
      if(this.onSongEnd)setTimeout(()=>this.onSongEnd(),2000);
    }
  }
  get progress(){return this.a.totalTicks?this.currentTick/this.a.totalTicks:0;}
}


// ═══════════════════════════════════════════
//  APP STATE
// ═══════════════════════════════════════════
let analyzer=null,scheduler=null,instrument=null;
let currentTS=[4,4],bpm0=120;
let cameraStarted=false;
let _prevBeatMs=0,_nextBeatMs=0,_nextBeatNum=1;
let _flareMs=0,_nextFlareAtMs=0,_flareBeatNum=0;
let isPaused=false;
let cachedSens=1,_hudDirty=true;
let cachedHighThr=0.003*Math.pow(0.22,(1-1)/4);

// Beat detection state — per-hand
const POS_BUF_SIZE = 8;
const VELO_WINDOW  = 3;
const MIN_BEAT_MS  = 200;
const handState = {
  left:  { poseBuf: [], wasAboveHigh: false, wasAboveHighTimestamp: 0, peakSpeed: 0, trail: [] },
  right: { poseBuf: [], wasAboveHigh: false, wasAboveHighTimestamp: 0, peakSpeed: 0, trail: [] }
};
let lastBeatMs = 0;
let autoPaused = false;
let countdownActive = false;
let smoothedBpm = 0;
let lastIctusMs = 0;
const SMOOTHING = 0.65;
const BPM_BUFFER_SIZE = 6;
let bpmBuffer = [];
let avgBpm = 0;
let gainScale = 1.0;
const GAIN_RATE = 0.01;
const GAIN_MIN = 0.1;
const GAIN_MAX = 2;
let fistPaused = false, fistSinceMs = 0, fistResumeCooldownMs = 0;
let pinchSinceMs = 0, fermataPaused = false;
let fermataGain = null;
let fermataSustainSynth = null;
let fermataAttackTimer = null;
const FIST_HOLD_MS = 300;
const FIST_COOLDOWN = 800;
let handFrameCounter = 0;

// Cached DOM references — queried once, reused in rAF loops
const elProgressFill=document.getElementById('progressFill');
const elHudCanvas   =document.getElementById('hudCanvas');
const elCamCanvas   =document.getElementById('canvasEl');


// ═══════════════════════════════════════════
//  THEME TOGGLE
// ═══════════════════════════════════════════
function toggleTheme(){
  const html=document.documentElement;
  const light=html.dataset.theme==='light';
  html.dataset.theme=light?'dark':'light';
  document.getElementById('themeBtn').textContent=light?'☀':'☾';
}
function isLight(){return document.documentElement.dataset.theme==='light';}

function toggleHelp(){
  const d=document.getElementById('helpDropdown');
  const b=document.getElementById('helpBtn');
  const open=d.classList.toggle('open');
  b.textContent=open?STRINGS[currentLang].helpBtnOpen:STRINGS[currentLang].helpBtn;
}
document.addEventListener('click',e=>{
  const wrap=document.getElementById('helpWrap');
  if(wrap&&!wrap.contains(e.target)){
    const d=document.getElementById('helpDropdown');
    const b=document.getElementById('helpBtn');
    if(d)d.classList.remove('open');
    if(b)b.textContent=STRINGS[currentLang].helpBtn;
  }
});


// ═══════════════════════════════════════════
//  SENSITIVITY
// ═══════════════════════════════════════════
function onSensChange(val){
  cachedSens=Number(val);
  cachedHighThr=0.003*Math.pow(0.22,(cachedSens-1)/4);
  document.getElementById('sensVal').textContent=Number(val);
}


// ═══════════════════════════════════════════
//  BEAT DETECTION — per-hand
// ═══════════════════════════════════════════
function handSpeed(state) {
  const buf=state.poseBuf, len=buf.length;
  if(len<2)return 0;
  const start=Math.max(0,len-VELO_WINDOW);
  let sum=0,n=0;
  for(let i=start+1;i<len;i++){
    const dt=buf[i].t-buf[i-1].t;
    if(dt>0&&dt<100){
      const dx=buf[i].x-buf[i-1].x;
      const dy=buf[i].y-buf[i-1].y;
      sum+=Math.sqrt(dx*dx+dy*dy)/dt;n++;
    }
  }
  return n?sum/n:0;
}

function detectBeat(speed, frameT, state) {
  const highThr=cachedHighThr;
  if(speed>highThr){
    if(!state.wasAboveHigh){
      state.wasAboveHigh=true;
      state.wasAboveHighTimestamp=frameT;
      state.peakSpeed=speed;
    }else if(speed>state.peakSpeed){
      state.peakSpeed=speed;
    }
  }
  if(state.wasAboveHigh&&speed<state.peakSpeed*0.55){
    const elapsed=frameT-lastBeatMs;
    const withinWindow=(frameT-state.wasAboveHighTimestamp)<600;
    if(elapsed>=MIN_BEAT_MS&&withinWindow){
      lastBeatMs=frameT;
      const intervalMs=frameT-lastIctusMs;
      if(intervalMs>200&&intervalMs<3000){
        const rawBpm=60000/intervalMs;
        const clamped=Math.min(Math.max(rawBpm,bpm0*0.4),bpm0*2.5);
        if(smoothedBpm===0){
          smoothedBpm=clamped;
        }else{
          smoothedBpm=SMOOTHING*smoothedBpm+(1-SMOOTHING)*clamped;
        }
        if(scheduler)scheduler.setSpeed(smoothedBpm/bpm0);
        bpmBuffer.push(clamped);
        if(bpmBuffer.length>BPM_BUFFER_SIZE)bpmBuffer.shift();
        avgBpm=bpmBuffer.reduce((a,b)=>a+b,0)/bpmBuffer.length;
      }
      lastIctusMs=frameT;
    }
    state.wasAboveHigh=false;
    state.peakSpeed=0;
  }
}


function isRightFist(lm){
  function d(a,b){
    const dx=a.x-b.x, dy=a.y-b.y;
    return Math.sqrt(dx*dx+dy*dy);
  }
  return d(lm[0],lm[8])  < d(lm[0],lm[5])  &&
         d(lm[0],lm[12]) < d(lm[0],lm[9])  &&
         d(lm[0],lm[16]) < d(lm[0],lm[13]) &&
         d(lm[0],lm[20]) < d(lm[0],lm[17]);
}


// ═══════════════════════════════════════════
//  PAUSE / RESUME
// ═══════════════════════════════════════════
async function togglePause(){
  if(!scheduler)return;
  isPaused=!isPaused;
  _hudDirty=true;
  const btn=document.getElementById('pauseBtn');
  if(isPaused){
    scheduler.pause();
    if(btn){btn.textContent='▶';btn.title=STRINGS[currentLang].resumeTitle;}
  }else{
    await Tone.start();
    scheduler.resume(0.1);
    if(btn){btn.textContent='⏸';btn.title=STRINGS[currentLang].pauseTitle;}
  }
}



// ═══════════════════════════════════════════
//  INDEPENDENT SCHEDULER TICK LOOP
//  Runs via rAF regardless of MediaPipe status.
//  This is the main fix — audio scheduling must
//  not depend on the pose detection pipeline.
// ═══════════════════════════════════════════
function schedulerLoop(){
  if(scheduler){
    scheduler.update();
    if(scheduler.a){
      elProgressFill.style.width=(scheduler.progress*100)+'%';
    }

  }
  requestAnimationFrame(schedulerLoop);
}
requestAnimationFrame(schedulerLoop);



// ═══════════════════════════════════════════
//  COUNTDOWN → START
// ═══════════════════════════════════════════
async function startCountdown(){
  const ov=document.getElementById('countdownOverlay');
  const nm=document.getElementById('countdownNum');
  ov.style.display='flex';
  countdownActive=true;
  for(let i=5;i>=1;i--){nm.textContent=i;await new Promise(r=>setTimeout(r,900));}
  nm.textContent='♩';await new Promise(r=>setTimeout(r,600));
  ov.style.display='none';
  countdownActive=false;
  await Tone.start();
  scheduler.start(0.25);
  const pb=document.getElementById('pauseBtn');
  if(pb){pb.disabled=false;pb.textContent='⏸';pb.title=STRINGS[currentLang].pauseTitle;}
}


// ═══════════════════════════════════════════
//  GAME FLOW
// ═══════════════════════════════════════════
function waitForStartClick(){
  document.getElementById('startOverlay').style.display='flex';
}
function onStartOverlayClick(){
  document.getElementById('startOverlay').style.display='none';
  startCountdown();
}
function _resetPlayState(){
  handState.left ={poseBuf:[],wasAboveHigh:false,wasAboveHighTimestamp:0,peakSpeed:0,trail:[]};
  handState.right={poseBuf:[],wasAboveHigh:false,wasAboveHighTimestamp:0,peakSpeed:0,trail:[]};
  lastBeatMs=0;autoPaused=false;countdownActive=false;
  fistSinceMs=0;fistPaused=false;fistResumeCooldownMs=0;handFrameCounter=0;
  pinchSinceMs=0;fermataPaused=false;
  smoothedBpm=0;lastIctusMs=0;bpmBuffer=[];avgBpm=0;
  gainScale=1.0;
  if(scheduler)scheduler.gainScale=1.0;
  _prevBeatMs=0;_nextBeatMs=0;_nextBeatNum=1;
  _flareMs=0;_nextFlareAtMs=0;_flareBeatNum=0;
  isPaused=false;
  _hudDirty=true;
}
function restartGame(){
  document.getElementById('startOverlay').style.display='none';
  if(scheduler)scheduler.reset();
  _resetPlayState();
  const pb=document.getElementById('pauseBtn');
  if(pb){pb.disabled=true;pb.textContent='⏸';pb.title=STRINGS[currentLang].pauseTitle;}
  waitForStartClick();
}
function showSongEnd(){
  if(scheduler)scheduler.pause();
  _resetPlayState();
  document.getElementById('songEndOverlay').style.display='flex';
  const pb=document.getElementById('pauseBtn');
  if(pb){pb.disabled=true;pb.textContent='⏸';pb.title=STRINGS[currentLang].pauseTitle;}
}
function playAgain(){
  document.getElementById('songEndOverlay').style.display='none';
  restartGame();
}
function loadNewSong(){
  document.getElementById('songEndOverlay').style.display='none';
  document.getElementById('uploadOverlay').style.display='flex';
}


// ═══════════════════════════════════════════
//  FILE UPLOAD
// ═══════════════════════════════════════════
document.getElementById('fileInput').addEventListener('change',async(e)=>{
  const file=e.target.files[0];if(!file)return;
  document.getElementById('startOverlay').style.display='none';
  document.getElementById('fileName').textContent=file.name;

  try{
    analyzer=new MidiAnalyzer(await file.arrayBuffer());
    bpm0=analyzer.initialBpm;
    currentTS=analyzer.timeSig;
    const COMPOUND_MAP={6:2,9:3,12:4};
    currentTS[0]=COMPOUND_MAP[currentTS[0]]??currentTS[0];
    if(![[2,4],[3,4],[4,4]].some(t=>t[0]===currentTS[0]&&t[1]===currentTS[1]))currentTS=[4,4];

    if(instrument)instrument.dispose();
    if(fermataGain)fermataGain.dispose();
    fermataGain = new Tone.Volume(0).toDestination();
    instrument = new Tone.PolySynth(Tone.Synth, {
      oscillator: {
        type: 'fattriangle',  // 'fattriangle' layers multiple
                              // detuned triangle waves for organ
                              // body and warmth
        count: 3,             // three layered oscillators
        spread: 20            // slight detune spread in cents for
                              // fullness
      },
      envelope: {
        attack:  0.01,   // fast attack like an organ key press
        decay:   0.0,    // no decay — organ sustains immediately
        sustain: 1.0,    // full amplitude while key is held
        release: 0.3     // short release so notes do not blur
      },
      volume: -12
    }).connect(fermataGain);

    if (fermataSustainSynth) fermataSustainSynth.releaseAll();
    if (fermataSustainSynth) {
      fermataSustainSynth.dispose();
      fermataSustainSynth = null;
    }

    // Triangle wave is the warmest, most piano-adjacent oscillator
    // type available in Tone.js without additional processing.
    // attack: 0.15 means the synth takes 150ms to reach full
    // amplitude — slow enough that the piano attack passes before
    // the synth becomes perceptible.
    // sustain: 1.0 means the amplitude holds completely flat for
    // as long as the note is held, which is the entire point.
    // release: 0.4 gives a gentle 400ms fade on pinch release,
    // matching the feel of a piano's natural decay tail.
    // volume: -20 keeps the synth sitting quietly underneath the
    // piano rather than replacing it — the listener should perceive
    // "chord still present" not "different instrument appeared".
    fermataSustainSynth = new Tone.PolySynth(Tone.Synth, {
      oscillator: {
        type: 'fattriangle',
        count: 3,
        spread: 20
      },
      envelope: {
        attack:  0.15,
        decay:   0.0,
        sustain: 1.0,
        release: 0.4
      },
      volume: -20
    }).connect(fermataGain);

    await Tone.start();

    _prevBeatMs=0;_nextBeatMs=0;_nextBeatNum=1;
    handState.left ={poseBuf:[],wasAboveHigh:false,wasAboveHighTimestamp:0,peakSpeed:0,trail:[]};
    handState.right={poseBuf:[],wasAboveHigh:false,wasAboveHighTimestamp:0,peakSpeed:0,trail:[]};
    lastBeatMs=0;autoPaused=false;smoothedBpm=0;lastIctusMs=0;

    scheduler=new AutoScheduler(analyzer,instrument,(beatPerfMs,beatNum)=>{
      _hudDirty=true;
      _prevBeatMs=_nextBeatMs;
      _nextBeatMs=beatPerfMs;
      _nextBeatNum=beatNum;
      _nextFlareAtMs=beatPerfMs;
      _flareBeatNum=beatNum;
    },()=>{showSongEnd();});
    scheduler.setTS(currentTS);

    document.getElementById('uploadOverlay').style.display='none';
    document.getElementById('songEndOverlay').style.display='none';
    isPaused=false;
    const pb=document.getElementById('pauseBtn');
    if(pb){pb.disabled=true;pb.textContent='⏸';pb.title=STRINGS[currentLang].pauseTitle;}
    // First load: show loading state; startCamera() reveals the click overlay
    // once the video stream and MediaPipe models are ready.
    // Subsequent loads (camera already running): show click overlay directly.
    if(!cameraStarted){
      document.getElementById('cameraLoading').style.display='flex';
      startCamera().catch(camErr=>{
        document.getElementById('cameraLoading').style.display='none';
        waitForStartClick();
        console.error('Camera/MediaPipe failed:',camErr);
        alert('相機無法啟動：'+camErr.message+'\n\n音樂仍會繼續播放。請開啟瀏覽器主控台查看詳細資訊。');
      });
    } else {
      waitForStartClick();
    }

  }catch(err){
    console.error('Error loading MIDI file:',err);
    alert('MIDI 載入失敗：'+err.message+'\n\n請按 F12 開啟瀏覽器主控台查看詳細資訊。');
    document.getElementById('fileName').textContent=file.name+' — load error';
  }
});



// ═══════════════════════════════════════════
//  METRONOME HUD  (dedicated overlay canvas)
// ═══════════════════════════════════════════
function drawMetronomeHUD() {
  const hudCanvas = elHudCanvas;

  const dpr   = window.devicePixelRatio || 1;
  const W     = (hudCanvas.width  || 1280) / dpr;
  const H     = (hudCanvas.height || 720)  / dpr;
  const scale = Math.min(W / 1280, 0.75);

  const ctx = hudCanvas.getContext('2d');
  const light = isLight();
  const elder = document.documentElement.getAttribute('data-fontsize') === 'large';
  const gold  = light ? '#6a7480' : '#b0b8c4';

  const HUD_W = (elder ? 300 : 220) * scale;
  const HUD_H = (elder ? 190 : 150) * scale;
  const bx = (W - HUD_W) / 2, by = 8 * scale;

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  // Backdrop
  ctx.fillStyle = light ? 'rgba(244,241,235,0.92)' : 'rgba(7,7,15,0.86)';
  ctx.beginPath(); ctx.roundRect(bx, by, HUD_W, HUD_H, 14 * scale); ctx.fill();
  ctx.strokeStyle = light ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.07)';
  ctx.lineWidth = scale;
  ctx.beginPath(); ctx.roundRect(bx, by, HUD_W, HUD_H, 14 * scale); ctx.stroke();

  const isIdle = !scheduler;
  const isB1   = _nextBeatNum === 1;

  // Beat progress 0→1 between prev and next scheduled beat times
  const now = performance.now();
  let bp = 0;
  if (!isIdle) {
    const _total   = _nextBeatMs - _prevBeatMs;
    const _elapsed = now - _prevBeatMs;
    bp = (_total > 50 && _prevBeatMs > 0)
      ? Math.min(1, Math.max(0, _elapsed / _total)) : 0;
  }
  const urgency = Math.max(0, (bp - 0.70) / 0.30);

  // Flare: triggers the moment we cross the scheduled beat time
  if (!isIdle && _nextFlareAtMs > 0 && now >= _nextFlareAtMs && _flareMs < _nextFlareAtMs) {
    _flareMs = _nextFlareAtMs;
  }
  const flareAge = now - _flareMs;
  const flareT   = _flareMs > 0 && flareAge < 160 ? Math.max(0, 1 - flareAge / 160) : 0;

  // Beat anticipation arc
  if (!isIdle) {
    const arcCx = W / 2;
    const arcCy = by + HUD_H / 2;
    const arcR  = (elder ? 68 : 52) * scale;
    const arcLW = (elder ? 3 : 2) * scale;
    const flareIsB1 = _flareBeatNum === 1;

    // Dim track ring
    ctx.beginPath();
    ctx.arc(arcCx, arcCy, arcR, 0, 2 * Math.PI);
    ctx.strokeStyle = light ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.07)';
    ctx.lineWidth = arcLW;
    ctx.stroke();

    // Sweep arc: grows clockwise from top as the beat approaches
    if (bp > 0.01) {
      const alpha = 0.3 + bp * 0.5 + flareT * 0.2;
      ctx.beginPath();
      ctx.arc(arcCx, arcCy, arcR, -Math.PI / 2, -Math.PI / 2 + bp * 2 * Math.PI);
      ctx.strokeStyle = isB1
        ? (light ? `rgba(106,116,128,${alpha})`       : `rgba(176,184,196,${alpha})`)
        : (light ? `rgba(106,116,128,${alpha * 0.5})` : `rgba(176,184,196,${alpha * 0.5})`);
      ctx.lineWidth = arcLW + flareT * 1.5 * scale;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // Flare ring: expands and fades on beat arrival
    if (flareT > 0) {
      const flareR = arcR + (1 - flareT) * (elder ? 20 : 14) * scale;
      ctx.beginPath();
      ctx.arc(arcCx, arcCy, flareR, 0, 2 * Math.PI);
      ctx.strokeStyle = flareIsB1
        ? (light ? `rgba(106,116,128,${flareT * 0.55})` : `rgba(176,184,196,${flareT * 0.55})`)
        : (light ? `rgba(106,116,128,${flareT * 0.28})` : `rgba(176,184,196,${flareT * 0.28})`);
      ctx.lineWidth = arcLW;
      ctx.stroke();
    }
  }

  // Beat number (centered in backdrop)
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `bold ${(elder ? 62 : 38) * scale}px DM Mono, monospace`;
  if (!isIdle && isB1) {
    ctx.fillStyle   = gold;
    ctx.shadowColor = gold;
    ctx.shadowBlur  = urgency > 0 ? ((elder ? 10 : 6) + urgency * (elder ? 20 : 14)) * scale : (elder ? 10 : 6) * scale;
  } else {
    ctx.fillStyle  = light ? 'rgba(80,76,68,0.55)' : 'rgba(200,200,200,0.45)';
    ctx.shadowBlur = 0;
  }
  ctx.fillText(isIdle ? '—' : String(_nextBeatNum), W / 2, by + HUD_H / 2 + (elder ? 8 : 5) * scale);
  ctx.shadowBlur = 0;

  // BPM panels — upper-right of backdrop
  ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  const _x  = bx + HUD_W - 10 * scale;
  const _lh = (elder ? 12 : 9) * scale;
  const _vh = (elder ? 16 : 12) * scale;
  const _rg = (elder ? 6  : 4) * scale;

  // Row 1 — SCORE (smallest, dimmest)
  let _y = by + 10 * scale;
  ctx.font = `${(elder ? 9 : 7) * scale}px DM Mono, monospace`;
  ctx.fillStyle = light ? 'rgba(100,90,70,0.28)' : 'rgba(180,180,180,0.25)';
  ctx.fillText('SCORE', _x, _y);
  _y += _lh;
  ctx.font = `${(elder ? 11 : 9) * scale}px DM Mono, monospace`;
  ctx.fillStyle = light ? 'rgba(100,90,70,0.40)' : 'rgba(180,180,180,0.38)';
  ctx.fillText(bpm0.toFixed(0) + ' BPM', _x, _y);
  _y += _vh + _rg;

  // Row 2 — LIVE (largest, brightest)
  ctx.font = `${(elder ? 10 : 8) * scale}px DM Mono, monospace`;
  ctx.fillStyle = light ? 'rgba(100,90,70,0.48)' : 'rgba(180,180,180,0.45)';
  ctx.fillText('LIVE', _x, _y);
  _y += _lh;
  ctx.font = `${(elder ? 14 : 12) * scale}px DM Mono, monospace`;
  ctx.fillStyle = light ? 'rgba(100,90,70,0.78)' : 'rgba(180,180,180,0.80)';
  ctx.fillText(smoothedBpm > 0 ? smoothedBpm.toFixed(0) + ' BPM' : '— BPM', _x, _y);
  _y += _vh + _rg;

  // Row 3 — AVG (medium size, medium brightness)
  ctx.font = `${(elder ? 9 : 7) * scale}px DM Mono, monospace`;
  ctx.fillStyle = light ? 'rgba(100,90,70,0.35)' : 'rgba(180,180,180,0.32)';
  ctx.fillText('AVG', _x, _y);
  _y += _lh;
  ctx.font = `${(elder ? 12 : 10) * scale}px DM Mono, monospace`;
  ctx.fillStyle = light ? 'rgba(100,90,70,0.58)' : 'rgba(180,180,180,0.58)';
  ctx.fillText(avgBpm > 0 ? avgBpm.toFixed(0) + ' BPM' : '— BPM', _x, _y);

  const tsText=currentTS?currentTS[0]+'/'+currentTS[1]:'4/4';
  ctx.textAlign='center';ctx.textBaseline='bottom';
  ctx.font=`${(elder?11:9)*scale}px DM Mono, monospace`;
  ctx.fillStyle=light?'rgba(100,90,70,0.35)':'rgba(180,180,180,0.32)';
  ctx.fillText(tsText,W/2,by+HUD_H-6*scale);

  // Dynamics bar — left side of backdrop
  const _barX  = bx + 8 * scale;
  const _barW  = (elder ? 8 : 6) * scale;
  const _barTY = by + 8 * scale;
  const _barH  = HUD_H - 16 * scale;
  ctx.fillStyle = light ? 'rgba(100,90,70,0.08)' : 'rgba(180,180,180,0.08)';
  ctx.fillRect(_barX, _barTY, _barW, _barH);
  const _gainFrac = Math.min(1, Math.max(0, (gainScale - GAIN_MIN) / (GAIN_MAX - GAIN_MIN)));
  const _fillH = _gainFrac * _barH;
  if(_fillH > 1){
    ctx.fillStyle = light ? 'rgba(100,90,70,0.50)' : 'rgba(180,180,180,0.55)';
    ctx.fillRect(_barX, _barTY + _barH - _fillH, _barW, _fillH);
  }
  const _tickFrac = (1.0 - GAIN_MIN) / (GAIN_MAX - GAIN_MIN);
  const _tickY = _barTY + _barH - _tickFrac * _barH;
  ctx.fillStyle = light ? 'rgba(100,90,70,0.35)' : 'rgba(180,180,180,0.40)';
  ctx.fillRect(_barX - 2 * scale, _tickY - scale, _barW + 4 * scale, 2 * scale);

  ctx.restore();
}

// Dedicated 60fps loop for the HUD — decoupled from MediaPipe
function hudLoop() {
  const needsAnim = scheduler?.playing || (performance.now() - _flareMs < 200);
  if (_hudDirty || needsAnim) { drawMetronomeHUD(); _hudDirty = false; }
  requestAnimationFrame(hudLoop);
}
requestAnimationFrame(hudLoop);

function resizeHudCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w   = Math.round(elHudCanvas.clientWidth  * dpr);
  const h   = Math.round(elHudCanvas.clientHeight * dpr);
  if (w > 0 && h > 0 && (elHudCanvas.width !== w || elHudCanvas.height !== h)) {
    elHudCanvas.width  = w;
    elHudCanvas.height = h;
    _hudDirty = true;
  }
}
new ResizeObserver(resizeHudCanvas).observe(elHudCanvas);


// ═══════════════════════════════════════════
//  MEDIAPIPE CAMERA
// ═══════════════════════════════════════════
const TRAIL_STYLES=Array.from({length:18},(_,i)=>`rgba(176,184,196,${((i+1)/18)*0.7})`);


async function startCamera(){
  cameraStarted=true;
  const video=document.getElementById('videoEl');
  const canvas=elCamCanvas;
  const ctx=canvas.getContext('2d');
  let frameTimestamp=0;



  const known={
    left: {lm:null,speed:0,wx:0,wy:0},
    right:{lm:null,speed:0,wx:0,wy:0}
  };

  const SIDES=['left','right'];
  const WRIST_IDX={left:19,right:20};

  try{
    const vision=await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
    );

    let poseLandmarker;
    try{
      poseLandmarker=await PoseLandmarker.createFromOptions(vision,{
        baseOptions:{
          modelAssetPath:'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
          delegate:'GPU'
        },
        runningMode:'VIDEO',
        numPoses:1,
        minPoseDetectionConfidence:0.5,
        minPosePresenceConfidence:0.5,
        minTrackingConfidence:0.5
      });
    }catch(gpuErr){
      console.warn('Pose GPU delegate failed, falling back to CPU:',gpuErr);
      poseLandmarker=await PoseLandmarker.createFromOptions(vision,{
        baseOptions:{
          modelAssetPath:'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
          delegate:'CPU'
        },
        runningMode:'VIDEO',
        numPoses:1,
        minPoseDetectionConfidence:0.5,
        minPosePresenceConfidence:0.5,
        minTrackingConfidence:0.5
      });
    }

    let handLandmarker;
    try{
      handLandmarker=await HandLandmarker.createFromOptions(vision,{
        baseOptions:{
          modelAssetPath:'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          delegate:'GPU'
        },
        runningMode:'VIDEO',
        numHands:2,
        minHandDetectionConfidence:0.5,
        minHandPresenceConfidence:0.5,
        minTrackingConfidence:0.5
      });
    }catch(gpuErr){
      console.warn('Hand GPU delegate failed, falling back to CPU:',gpuErr);
      handLandmarker=await HandLandmarker.createFromOptions(vision,{
        baseOptions:{
          modelAssetPath:'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          delegate:'CPU'
        },
        runningMode:'VIDEO',
        numHands:2,
        minHandDetectionConfidence:0.5,
        minHandPresenceConfidence:0.5,
        minTrackingConfidence:0.5
      });
    }

    let lastHandResult = {landmarks:[],handedness:[]};
    let fermataActiveNotes = null;

    function isPinch(lm){
      const dx=lm[4].x-lm[8].x, dy=lm[4].y-lm[8].y;
      const pinchDist=Math.sqrt(dx*dx+dy*dy);
      const hx=lm[0].x-lm[9].x, hy=lm[0].y-lm[9].y;
      const handSize=Math.sqrt(hx*hx+hy*hy);
      return handSize>0 && (pinchDist/handSize)<0.25;
    }

    const stream=await navigator.mediaDevices.getUserMedia({
      video:{facingMode:'user', width:{ideal:1280}, height:{ideal:720}}
    });
    video.srcObject=stream;
    await new Promise(resolve=>video.onloadedmetadata=resolve);
    video.play();
    canvas.width  = video.videoWidth  || 1280;
    canvas.height = video.videoHeight || 720;
    resizeHudCanvas();
    document.getElementById('cameraLoading').style.display='none';
    waitForStartClick();

    function detect(){
      if(video.readyState<2){requestAnimationFrame(detect);return;}
      const W=canvas.width,H=canvas.height;
      const timestamp=performance.now();
      frameTimestamp=timestamp;

      // ── POSE ──
      const poseResult=poseLandmarker.detectForVideo(video,timestamp);
      const lm=poseResult.landmarks&&poseResult.landmarks[0]?poseResult.landmarks[0]:null;

      // Landmark indices are from the subject's perspective (lm[19]=person's left index tip,
      // lm[20]=person's right index tip). Right index tip drives beat detection ("右手 — 指揮節拍").
      // Left index tip tracked for trail, speed-bar, and dot display.
      // Dynamics use only the left hand (lm[19]/lm[11]/lm[23]) per spec.
      // k.wx = (1-pt.x)*W mirrors x from raw camera space to match the flipped display.
      for(const side of SIDES){
        const pt=lm&&lm[WRIST_IDX[side]];
        const state=handState[side];
        const k=known[side];
        if(!pt||pt.visibility<0.3){k.lm=null;state.trail=[];continue;}
        k.lm=pt;
        k.wx=(1-pt.x)*W; k.wy=pt.y*H;
        state.trail.push([k.wx,k.wy]);
        if(state.trail.length>18)state.trail.shift();
        const lastPos = state.poseBuf[state.poseBuf.length - 1];
        const jumped = lastPos && (Math.abs(pt.x - lastPos.x) + Math.abs(pt.y - lastPos.y)) > 0.25;
        if(!jumped){
          state.poseBuf.push({x:pt.x,y:pt.y,t:frameTimestamp});
          if(state.poseBuf.length>POS_BUF_SIZE)state.poseBuf.shift();
        }else{
          state.poseBuf=[];
        }
        k.speed=handSpeed(state);
        if(side==='right') detectBeat(k.speed,frameTimestamp,state);
      }

      const lFinger=lm&&lm[19];
      const lShoulder=lm&&lm[11];
      const lHip=lm&&lm[23];
      if(lFinger&&lShoulder&&lHip&&lFinger.visibility>0.3&&lShoulder.visibility>0.3&&lHip.visibility>0.3){
        if(lFinger.y<lShoulder.y){
          gainScale=Math.min(GAIN_MAX,gainScale+GAIN_RATE);
          if(scheduler)scheduler.gainScale=gainScale;
        }else if(lFinger.y>lHip.y){
          gainScale=Math.max(GAIN_MIN,gainScale-GAIN_RATE);
          if(scheduler)scheduler.gainScale=gainScale;
        }
      }
      known.left.shoulderY=lShoulder&&lShoulder.visibility>0.3?lShoulder.y:null;
      known.left.hipY=lHip&&lHip.visibility>0.3?lHip.y:null;
      known.left.fingerVisible=!!(lFinger&&lFinger.visibility>0.3);

      const now=performance.now();

      // ── HANDS (fist cut-off) ──
      let leftLm=null;
      if(handLandmarker&&!countdownActive){
        handFrameCounter++;
        if(handFrameCounter%3===0){
          try{
            lastHandResult=handLandmarker.detectForVideo(video,frameTimestamp);
          }catch{
            lastHandResult={landmarks:[],handedness:[]};
          }
        }
        const handResult=lastHandResult;
        if(handResult.landmarks&&handResult.landmarks.length>0){
          for(let i=0;i<handResult.handedness.length;i++){
            if(handResult.handedness[i][0].categoryName==='Left'){
              leftLm=handResult.landmarks[i];
            }
          }
        }
        if(leftLm&&isRightFist(leftLm)){
          if(fistSinceMs===0)fistSinceMs=now;
          fistResumeCooldownMs=0;
          if(!fistPaused&&!isPaused&&scheduler&&scheduler.playing&&now-fistSinceMs>=FIST_HOLD_MS){
            scheduler.pause();scheduler._stopAll();
            autoPaused=true;fistPaused=true;_hudDirty=true;
          }
        }else{
          fistSinceMs=0;
          if(fistPaused&&!isPaused&&scheduler){
            if(fistResumeCooldownMs===0)fistResumeCooldownMs=now;
            if(now-fistResumeCooldownMs>=FIST_COOLDOWN){
              fistPaused=false;autoPaused=false;fistResumeCooldownMs=0;
              Tone.start();
              scheduler.resume(0.1);_hudDirty=true;
            }
          }
        }
        if(!fistPaused&&fistSinceMs===0&&leftLm){
          if(isPinch(leftLm)){
            if(pinchSinceMs===0)pinchSinceMs=now;
            if(now-pinchSinceMs>=20&&!fermataPaused){
              fermataPaused = true;

              // pauseOnly() freezes score position without cutting audio.
              // The sampler notes keep decaying naturally.
              scheduler.pauseOnly();

              // Harvest from beat snapshots: find the most recent beat that
              // has already fired (at <= audioNow). This avoids both the
              // false-exclusion bug (overwritten common tones from lookahead
              // pre-scheduling) and the false-inclusion bug (stale notes from
              // the previous beat leaking in via NOTE_SUSTAIN > beatS).
              const audioNow = Tone.now();
              const firedSnap = scheduler.beatSnapshots
                .filter(s => s.at <= audioNow)
                .sort((a, b) => b.at - a.at)[0];
              fermataActiveNotes = firedSnap ? firedSnap.notes.slice() : [];

              // Delay the synth attack by 150ms so the piano's own attack
              // transient fully passes before the synth becomes audible.
              // This prevents the listener from hearing two distinct onsets.
              // Velocity 0.5 is moderate — the -20 dB volume on the synth
              // itself is what keeps it quiet, not the velocity value.
              if (fermataActiveNotes.length > 0) {
                fermataAttackTimer = setTimeout(() => {
                  if (fermataSustainSynth && fermataActiveNotes?.length > 0) {
                    fermataSustainSynth.triggerAttack(
                      fermataActiveNotes,
                      Tone.now(),   // schedule immediately since we are already
                                    // 150ms later
                      0.5
                    );
                  }
                  fermataAttackTimer = null;
                }, 150);
              }

              _hudDirty = true;
            }
          }else{
            if(fermataPaused){
              if (fermataAttackTimer !== null) {
                clearTimeout(fermataAttackTimer);
                fermataAttackTimer = null;
                // The attack never fired so there is nothing to release.
                // Skip the triggerRelease path entirely and just resume.
                fermataActiveNotes = null;
                fermataPaused = false;
                pinchSinceMs = 0;
                Tone.start().then(() => {
                  if (scheduler) scheduler.resume(0.1);
                });
                _hudDirty = true;
              } else {
                fermataPaused = false;
                pinchSinceMs = 0;

                if (fermataSustainSynth && fermataActiveNotes?.length > 0) {
                  // Trigger the 400ms release envelope on the synth.
                  // The envelope fades it out naturally — no fermataGain
                  // manipulation needed.
                  fermataSustainSynth.triggerRelease(
                    fermataActiveNotes,
                    Tone.now()
                  );

                  const _rel = [...fermataActiveNotes];
                  fermataActiveNotes = null;

                  // Wait 450ms — slightly longer than the 400ms release
                  // envelope — so the synth is fully silent before new
                  // MIDI notes begin. This prevents harmonic overlap
                  // between the fading fermata and the resumed playback.
                  setTimeout(() => {
                    Tone.start().then(() => {
                      if (scheduler) scheduler.resume(0.1);
                    });
                  }, 450);

                  // Safety: ensure no voices are left running after the
                  // 400ms release envelope completes.
                  setTimeout(() => {
                    if (fermataSustainSynth) fermataSustainSynth.releaseAll();
                  }, 500);

                } else {
                  // No notes were captured — resume immediately.
                  fermataActiveNotes = null;
                  Tone.start().then(() => {
                    if (scheduler) scheduler.resume(0.1);
                  });
                }

                _hudDirty = true;
              }
            }else{
              pinchSinceMs=0;
            }
          }
        }
      }

      // ── DRAW ──
      ctx.clearRect(0,0,W,H);
      ctx.save();ctx.translate(W,0);ctx.scale(-1,1);
      ctx.drawImage(video,0,0,W,H);
      ctx.restore();

      const elder = document.documentElement.getAttribute('data-fontsize') === 'large';
      for(const side of SIDES){
        const k=known[side];
        if(!k.lm)continue;
        const wx=k.wx,wy=k.wy;
        const trail=handState[side].trail;

        ctx.beginPath();
        for(let i=1;i<trail.length;i++){
          ctx.strokeStyle=TRAIL_STYLES[i-1];
          ctx.lineWidth=(i/trail.length)*4.5;
          ctx.beginPath();ctx.moveTo(trail[i-1][0],trail[i-1][1]);
          ctx.lineTo(trail[i][0],trail[i][1]);ctx.stroke();
        }

        const dotColor='#50d89a';
        ctx.fillStyle=dotColor;ctx.shadowColor=dotColor;ctx.shadowBlur=elder?20:12;
        ctx.beginPath();ctx.arc(wx,wy,elder?11:6,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;

        if(side==='left'&&leftLm){
          const HAND_BONES=[[0,1,2,3,4],[0,5,6,7,8],[0,9,10,11,12],[0,13,14,15,16],[0,17,18,19,20]];
          ctx.strokeStyle='rgba(176,184,196,0.6)';
          ctx.lineWidth=1.5;
          ctx.lineCap='round';ctx.lineJoin='round';
          for(const chain of HAND_BONES){
            ctx.beginPath();
            for(let j=0;j<chain.length;j++){
              const p=leftLm[chain[j]];
              const sx=(1-p.x)*W,sy=p.y*H;
              if(j===0)ctx.moveTo(sx,sy);else ctx.lineTo(sx,sy);
            }
            ctx.stroke();
          }
          ctx.fillStyle='rgba(176,184,196,0.85)';
          for(let j=0;j<21;j++){
            const p=leftLm[j];
            ctx.beginPath();ctx.arc((1-p.x)*W,p.y*H,3,0,Math.PI*2);ctx.fill();
          }
          ctx.lineCap='butt';ctx.lineJoin='miter';
        }

        const highThr=cachedHighThr;
        const BAR_W=60,BAR_H=5;
        const bx=wx-BAR_W/2,by=wy-22;
        ctx.beginPath();ctx.roundRect(bx,by,BAR_W,BAR_H,3);
        ctx.fillStyle='rgba(255,255,255,0.1)';ctx.fill();
        const fill=Math.min(k.speed/highThr,1)*BAR_W;
        ctx.beginPath();ctx.roundRect(bx,by,fill,BAR_H,3);
        ctx.fillStyle=k.speed>=highThr?'#ff9040':'#b0b8c4';ctx.fill();
        ctx.beginPath();ctx.moveTo(bx+BAR_W,by-2);ctx.lineTo(bx+BAR_W,by+BAR_H+2);
        ctx.strokeStyle='rgba(255,255,255,0.25)';ctx.lineWidth=1;ctx.stroke();
      }

      if(known.left.fingerVisible&&known.left.shoulderY!==null){
        ctx.lineWidth=1;
        ctx.strokeStyle='rgba(176,184,196,0.4)';
        ctx.beginPath();ctx.moveTo(0,known.left.shoulderY*H);ctx.lineTo(W,known.left.shoulderY*H);ctx.stroke();
      }
      if(known.left.fingerVisible&&known.left.hipY!==null){
        ctx.lineWidth=1;
        ctx.strokeStyle='rgba(176,184,196,0.2)';
        ctx.beginPath();ctx.moveTo(0,known.left.hipY*H);ctx.lineTo(W,known.left.hipY*H);ctx.stroke();
      }

      if(fistPaused){
        ctx.save();
        ctx.textAlign='center';ctx.textBaseline='middle';
        ctx.font=`bold ${elder?52:36}px Cormorant Garamond, serif`;
        ctx.fillStyle='rgba(224,82,82,0.88)';
        ctx.shadowColor='rgba(224,82,82,0.55)';ctx.shadowBlur=12;
        ctx.fillText(STRINGS[currentLang].cutoff,W/2,H/2);
        ctx.shadowBlur=0;
        ctx.restore();
      }
      if(fermataPaused){
        ctx.save();
        ctx.textAlign='center';ctx.textBaseline='middle';
        ctx.font=`bold ${elder?52:36}px Cormorant Garamond, serif`;
        ctx.fillStyle='rgba(80,160,255,0.88)';
        ctx.shadowColor='rgba(80,160,255,0.55)';ctx.shadowBlur=12;
        ctx.fillText(STRINGS[currentLang].fermata,W/2,H/2);
        ctx.shadowBlur=0;
        ctx.restore();
      }

      requestAnimationFrame(detect);
    }
    requestAnimationFrame(detect);

  }catch(err){
    console.error('Camera init error:',err);
    alert('相機無法啟動：'+err.message);
  }
}


// ═══════════════════════════════════════════
//  KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════
document.addEventListener('keydown',e=>{
  if(e.key==='r'||e.key==='R'){
    if(analyzer)restartGame();
  }else if(e.key===' '){
    e.preventDefault();togglePause();
  }else if(e.key==='m'||e.key==='M'){
    if(scheduler)scheduler.muted=!scheduler.muted;
  }else if(e.key==='+'||e.key==='='){
    const s=document.getElementById('sensSlider');
    s.value=Math.max(1,+s.value-1);onSensChange(s.value);
  }else if(e.key==='-'||e.key==='_'){
    const s=document.getElementById('sensSlider');
    s.value=Math.min(10,+s.value+1);onSensChange(s.value);
  }else if(e.key==='l'||e.key==='L'){
    toggleTheme();
  }
});

'use strict';

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
    this.currentTick=0; this.eventIndex=0;
    this.nextBeatAudioTime=0; this._beatNum=1; this._songEndScheduled=false;
  }
  setTS(ts){this.ts=ts;}
  start(delayS=0.35){
    this.playing=true;
    this.nextBeatAudioTime=Tone.now()+delayS;
  }
  pause(){this.playing=false;this._stopAll();}
  resume(delayS=0.08){
    this.nextBeatAudioTime=Tone.now()+delayS;
    this.playing=true;
  }
  setSpeed(factor){
    this.beatS=(60/this.bpm)/factor;
  }
  reset(){this.playing=false;this.currentTick=0;this.eventIndex=0;this._beatNum=1;this._songEndScheduled=false;this._stopAll();this.lastChord=new Map();}
  _stopAll(){if(this.inst)this.inst.releaseAll();}
  _midiName(n){return['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][n%12]+(Math.floor(n/12)-1);}
  _play(ev,when){
    if(this.muted||ev.channel===9||!this.inst)return;
    if(ev.type==='note_on'&&ev.velocity>0){
      const noteName=this._midiName(ev.note);
      this.inst.triggerAttackRelease(noteName,1.5,when,(ev.velocity/127)*0.9*this.gainScale);
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
    while(i<evs.length&&evs[i].absTick<e){
      const ev=evs[i],frac=(ev.absTick-s)/this.a.tpb;
      this._play(ev,startTime+frac*this.beatS);i++;
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
let crossPauseSinceMs = 0;
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
  b.textContent=open?'說明 ▴':'說明 ▾';
}
document.addEventListener('click',e=>{
  const wrap=document.getElementById('helpWrap');
  if(wrap&&!wrap.contains(e.target)){
    const d=document.getElementById('helpDropdown');
    const b=document.getElementById('helpBtn');
    if(d)d.classList.remove('open');
    if(b)b.textContent='說明 ▾';
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
    if(btn){btn.textContent='▶';btn.title='Resume';}
  }else{
    await Tone.start();
    scheduler.resume(0.1);
    if(btn){btn.textContent='⏸';btn.title='Pause';}
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
  for(let i=10;i>=1;i--){nm.textContent=i;await new Promise(r=>setTimeout(r,900));}
  nm.textContent='♩';await new Promise(r=>setTimeout(r,600));
  ov.style.display='none';
  countdownActive=false;
  await Tone.start();
  scheduler.start(0.25);
  const pb=document.getElementById('pauseBtn');
  if(pb){pb.disabled=false;pb.textContent='⏸';pb.title='暫停';}
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
  lastBeatMs=0;autoPaused=false;crossPauseSinceMs=0;countdownActive=false;
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
  if(pb){pb.disabled=true;pb.textContent='⏸';pb.title='暫停';}
  waitForStartClick();
}
function showSongEnd(){
  if(scheduler)scheduler.pause();
  _resetPlayState();
  document.getElementById('songEndOverlay').style.display='flex';
  const pb=document.getElementById('pauseBtn');
  if(pb){pb.disabled=true;pb.textContent='⏸';pb.title='暫停';}
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

    if(instrument)instrument.disconnect();
    const sampler=new Tone.Sampler({
      urls:{
        A0:'A0.mp3',C1:'C1.mp3','D#1':'Ds1.mp3','F#1':'Fs1.mp3',
        A1:'A1.mp3',C2:'C2.mp3','D#2':'Ds2.mp3','F#2':'Fs2.mp3',
        A2:'A2.mp3',C3:'C3.mp3','D#3':'Ds3.mp3','F#3':'Fs3.mp3',
        A3:'A3.mp3',C4:'C4.mp3','D#4':'Ds4.mp3','F#4':'Fs4.mp3',
        A4:'A4.mp3',C5:'C5.mp3','D#5':'Ds5.mp3','F#5':'Fs5.mp3',
        A5:'A5.mp3',C6:'C6.mp3','D#6':'Ds6.mp3','F#6':'Fs6.mp3',
        A6:'A6.mp3',C7:'C7.mp3','D#7':'Ds7.mp3','F#7':'Fs7.mp3',
        A7:'A7.mp3',C8:'C8.mp3'
      },
      release:1,
      baseUrl:'https://tonejs.github.io/audio/salamander/',
    });
    if(fermataGain)fermataGain.dispose();
    fermataGain = new Tone.Volume(0).toDestination();
    instrument=sampler;
    instrument.connect(fermataGain);

    await Tone.loaded();

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
    if(pb){pb.disabled=true;pb.textContent='⏸';pb.title='暫停';}
    // Show start overlay — countdown begins only on click
    waitForStartClick();

    // Start camera separately so a camera failure doesn't block audio
    if(!cameraStarted){
      try{ startCamera(); }
      catch(camErr){
        console.error('Camera/MediaPipe failed:',camErr);
        alert('相機無法啟動：'+camErr.message+'\n\n音樂仍會繼續播放。請開啟瀏覽器主控台查看詳細資訊。');
      }
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
  const camCanvas = elCamCanvas;

  const W = hudCanvas.width  || 1280;
  const H = hudCanvas.height || 720;
  const scale = Math.min(W / 1280, 0.75);

  const ctx = hudCanvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const light = isLight();
  const elder = document.documentElement.getAttribute('data-fontsize') === 'large';
  const gold  = light ? '#6a7480' : '#b0b8c4';

  const HUD_W = (elder ? 300 : 220) * scale;
  const HUD_H = (elder ? 190 : 150) * scale;
  const bx = (W - HUD_W) / 2, by = 8 * scale;

  ctx.save();

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

  // Cross-pause gesture progress ring
  if (crossPauseSinceMs > 0) {
    const prog  = Math.min(1, (now - crossPauseSinceMs) / 400);
    const indCx = W / 2;
    const indCy = by + HUD_H + (elder ? 28 : 20) * scale;
    const indR  = (elder ? 16 : 12) * scale;
    const indLW = (elder ? 2.5 : 2) * scale;

    ctx.beginPath();
    ctx.arc(indCx, indCy, indR, 0, 2 * Math.PI);
    ctx.strokeStyle = light ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)';
    ctx.lineWidth = indLW;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(indCx, indCy, indR, -Math.PI / 2, -Math.PI / 2 + prog * 2 * Math.PI);
    ctx.strokeStyle = light
      ? `rgba(80,76,68,${0.45 + prog * 0.45})`
      : `rgba(200,200,200,${0.45 + prog * 0.45})`;
    ctx.lineWidth = indLW;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  ctx.restore();
}

// Dedicated 60fps loop for the HUD — decoupled from MediaPipe
function hudLoop() {
  const needsAnim = scheduler?.playing || (performance.now() - _flareMs < 200) || crossPauseSinceMs > 0;
  if (_hudDirty || needsAnim) { drawMetronomeHUD(); _hudDirty = false; }
  requestAnimationFrame(hudLoop);
}
requestAnimationFrame(hudLoop);


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
    let fermataSynth = null;
    let fermataActiveNotes = null;

    function isPinch(lm){
      const dx=lm[4].x-lm[8].x, dy=lm[4].y-lm[8].y;
      const pinchDist=Math.sqrt(dx*dx+dy*dy);
      const hx=lm[0].x-lm[9].x, hy=lm[0].y-lm[9].y;
      const handSize=Math.sqrt(hx*hx+hy*hy);
      return handSize>0 && (pinchDist/handSize)<0.25;
    }

    const stream=await navigator.mediaDevices.getUserMedia({
      video:{facingMode:'user'}
    });
    video.srcObject=stream;
    await new Promise(resolve=>video.onloadedmetadata=resolve);
    video.play();
    canvas.width  = video.videoWidth  || 1280;
    canvas.height = video.videoHeight || 720;
    elHudCanvas.width  = canvas.width;
    elHudCanvas.height = canvas.height;

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

      if(!countdownActive&&scheduler&&scheduler.playing&&!isPaused&&!autoPaused){
        const el=lm&&lm[3], er=lm&&lm[4];
        const wl=known.left.lm, wr=known.right.lm;
        const crossGesture=el&&er&&wl&&wr&&wl.y<el.y&&wr.y<er.y;
        if(crossGesture){
          if(crossPauseSinceMs===0)crossPauseSinceMs=now;
          if(now-crossPauseSinceMs>=150){
            crossPauseSinceMs=0;
            autoPaused=true;scheduler.pause();_hudDirty=true;
          }
        }else{
          crossPauseSinceMs=0;
        }
      }else if(!autoPaused&&!isPaused){
        crossPauseSinceMs=0;
      }
      if(autoPaused&&!isPaused&&!fistPaused&&scheduler){
        const el=lm&&lm[3], er=lm&&lm[4];
        const wl=known.left.lm, wr=known.right.lm;
        const resumeGesture=el&&er&&wl&&wr&&wl.y>el.y&&wr.y>er.y;
        if(resumeGesture){
          autoPaused=false;
          Tone.start();
          scheduler.resume(0.1);_hudDirty=true;
        }
      }

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
              fermataPaused=true;
              if(scheduler)scheduler.pause();
              const audioNow = Tone.now();
              const NOTE_SUSTAIN = scheduler ? Math.max(0.6, scheduler.beatS * 1.2) : 0.6;
              fermataActiveNotes = Array.from(scheduler.lastChord.entries())
                .filter(([, t]) => t <= audioNow && audioNow - t < NOTE_SUSTAIN)
                .map(([n]) => n);
              if(fermataActiveNotes.length > 0){
                fermataGain.volume.value = -40;
                scheduler.inst.triggerAttack(fermataActiveNotes, audioNow + 0.02, 0.01);
                fermataGain.volume.rampTo(0, 0.08);
                fermataSynth = true;
              }
              _hudDirty=true;
            }
          }else{
            if(fermataPaused){
              fermataPaused=false;pinchSinceMs=0;
              if(fermataSynth && scheduler?.inst){
                fermataGain.volume.rampTo(-40, 0.05);
                const _rel=fermataActiveNotes?.length>0?[...fermataActiveNotes]:null;
                setTimeout(()=>{
                  if(_rel)scheduler.inst.triggerRelease(_rel,Tone.now());
                  if(fermataGain)fermataGain.volume.value=0;
                  Tone.start().then(()=>{if(scheduler)scheduler.resume(0.1);});
                },60);
                fermataSynth=null;fermataActiveNotes=null;
              }else{
                Tone.start().then(()=>{if(scheduler)scheduler.resume(0.1);});
              }
              _hudDirty=true;
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
        ctx.fillText('✕ 截止',W/2,H/2);
        ctx.shadowBlur=0;
        ctx.restore();
      }else if(autoPaused&&!fermataPaused){
        ctx.save();
        ctx.textAlign='center';ctx.textBaseline='middle';
        ctx.font=`bold ${elder?52:36}px Cormorant Garamond, serif`;
        ctx.fillStyle='rgba(220,220,220,0.88)';
        ctx.shadowColor='rgba(0,0,0,0.55)';ctx.shadowBlur=12;
        ctx.fillText('停止',W/2,H/2);
        ctx.restore();
      }
      if(fermataPaused){
        ctx.save();
        ctx.textAlign='center';ctx.textBaseline='middle';
        ctx.font=`bold ${elder?52:36}px Cormorant Garamond, serif`;
        ctx.fillStyle='rgba(80,160,255,0.88)';
        ctx.shadowColor='rgba(80,160,255,0.55)';ctx.shadowBlur=12;
        ctx.fillText('𝄐 延音',W/2,H/2);
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

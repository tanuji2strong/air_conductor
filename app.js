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
      p+=4;p+=4; const fmt=r16(),numTracks=r16(); this.tpb=r16();
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
  constructor(analyzer,ac,instrument,onBeatScheduled,onSongEnd){
    this.a=analyzer; this.ac=ac; this.inst=instrument;
    this.onBeatScheduled=onBeatScheduled; this.onSongEnd=onSongEnd||null;
    this.bpm=analyzer.initialBpm; this.speedFactor=1.0; this.beatS=60/this.bpm;
    this.ts=[4,4]; this.playing=false; this.muted=false;
    this._nodes=[]; this._AHEAD=0.15;
    this.currentTick=0; this.eventIndex=0;
    this.nextBeatAudioTime=0; this._beatNum=1; this._songEndScheduled=false;
  }
  setTS(ts){this.ts=ts;}
  start(delayS=0.35){
    this.playing=true;
    this.nextBeatAudioTime=this.ac.currentTime+delayS;
  }
  pause(){this.playing=false;this._stopAll();}
  resume(delayS=0.08){
    this.nextBeatAudioTime=this.ac.currentTime+delayS;
    this.playing=true;
  }
  setSpeed(factor){
    this.speedFactor=factor;
    this.beatS=(60/this.bpm)/factor;
  }
  reset(){this.playing=false;this.currentTick=0;this.eventIndex=0;this._beatNum=1;this._songEndScheduled=false;this._stopAll();}
  _stopAll(){for(const n of this._nodes)try{n.node.stop();}catch{}this._nodes=[];}
  _midiName(n){return['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][n%12]+(Math.floor(n/12)-1);}
  _play(ev,when){
    if(this.muted||ev.channel===9||!this.inst)return;
    if(ev.type==='note_on'&&ev.velocity>0){
      const nd=this.inst.play(this._midiName(ev.note),when,{duration:1.5,gain:(ev.velocity/127)*0.9});
      if(nd)this._nodes.push({node:nd,endTime:when+1.65});
    }
  }
  update(){
    if(!this.playing)return;
    const now=this.ac.currentTime;
    this._nodes=this._nodes.filter(n=>n.endTime>now);
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
//  BEAT JUDGE  — every synced beat = +1
// ═══════════════════════════════════════════
class BeatJudge {
  constructor(bpm=120){
    this._bpm=bpm; this.score=0; this.streak=0;
    this.b1Hits=0; this.bonusHits=0; this.perfectHits=0;
    this.pending=[]; this.lastResult=null; this.lastResultTime=0;
  }
  setBpm(b){this._bpm=b;}
  // Window = 55% of beat interval, clamped 380–650ms.
  get windowMs(){return Math.min(650,Math.max(380,(60000/this._bpm)*0.55));}
  addBeat(perfTime,beatNum){this.pending.push({perfTime,beatNum,judged:false});}

  checkMisses(){
    const now=performance.now();
    for(const b of this.pending){
      if(!b.judged&&now>b.perfTime+this.windowMs)this.streak=0;
    }
  }

  onGesture(){
    this.checkMisses();
    const now=performance.now();
    let best=null,bestDiff=Infinity;
    for(const b of this.pending){
      if(b.judged)continue;
      const diff=Math.abs(now-b.perfTime);
      if(diff<bestDiff){bestDiff=diff;best=b;}
    }
    let result='ignored';
    if(best&&bestDiff<=this.windowMs){
      best.judged=true;
      const perfect=bestDiff<=this.windowMs*0.35;
      if(best.beatNum===1){
        if(perfect){this.score+=7;this.streak++;this.b1Hits++;this.perfectHits++;result='perfect1';}
        else        {this.score+=5;this.streak++;this.b1Hits++;result='hit1';}
      } else {
        if(perfect){this.score+=2;this.streak++;this.bonusHits++;this.perfectHits++;result='perfectBonus';}
        else        {this.score+=1;this.streak++;this.bonusHits++;result='bonus';}
      }
    }
    const cutoff=now-this.windowMs*2;
    this.pending=this.pending.filter(b=>b.perfTime>cutoff);
    return this._set(result,now);
  }

  _set(r,t){this.lastResult=r;this.lastResultTime=t;return r;}
  get accuracy(){return this.b1Hits===0?null:Math.round((this.b1Hits/(this.b1Hits+this.bonusHits))*100);}
  reset(){
    this.score=0;this.streak=0;this.b1Hits=0;this.bonusHits=0;this.perfectHits=0;
    this.pending=[];this.lastResult=null;
  }
}


// ═══════════════════════════════════════════
//  APP STATE
// ═══════════════════════════════════════════
let analyzer=null,scheduler=null,judge=null,audioCtx=null,instrument=null;
let currentTS=[4,4],bpm0=120;
let cameraStarted=false;
let _prevBeatMs=0,_nextBeatMs=0,_currentBeatNum=1,_nextBeatNum=1;
let _flareMs=0,_nextFlareAtMs=0,_flareBeatNum=0;
let isPaused=false;
let cachedSens=5,_hudDirty=true;
let cachedHighThr=0.003*Math.pow(0.22,(5-1)/4);

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
let bothStillSinceMs = 0;

// Cached DOM references — queried once, reused in rAF loops
const elProgressFill=document.getElementById('progressFill');
const elHudCanvas   =document.getElementById('hudCanvas');
const elCamCanvas   =document.getElementById('canvasEl');
const elSpeedSlider =document.getElementById('speedSlider');


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
function isElderMode(){return document.documentElement.hasAttribute('data-elder');}

function toggleElderMode(){
  const html=document.documentElement;
  const active=html.hasAttribute('data-elder');
  if(active){
    html.removeAttribute('data-elder');
    localStorage.removeItem('airConductor_elder');
  }else{
    html.setAttribute('data-elder','');
    localStorage.setItem('airConductor_elder','1');
  }
  const btn=document.getElementById('elderBtn');
  if(btn)btn.classList.toggle('active',!active);
  _hudDirty=true;
}




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
    if(dt>0){
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
      if(scheduler?.playing&&judge){
        const result=judge.onGesture();
        if(result==='perfect1'||result==='perfectBonus'){flashOverlay(255,200,80);}
        else if(result==='hit1')      {flashOverlay(80,216,154);}
        else if(result==='bonus'){flashOverlay(80,160,255);}
        if(result!=='ignored')updateScoreUI();
      }
    }
    state.wasAboveHigh=false;
    state.peakSpeed=0;
  }
}


// ═══════════════════════════════════════════
//  PAUSE / RESUME
// ═══════════════════════════════════════════
function togglePause(){
  if(!scheduler)return;
  isPaused=!isPaused;
  _hudDirty=true;
  const btn=document.getElementById('pauseBtn');
  if(isPaused){
    scheduler.pause();
    if(btn){btn.textContent='▶';btn.title='Resume';}
  }else{
    if(audioCtx?.state==='suspended')audioCtx.resume();
    scheduler.resume(0.1);
    if(btn){btn.textContent='⏸';btn.title='Pause';}
  }
}


// ═══════════════════════════════════════════
//  PLAYBACK SPEED
// ═══════════════════════════════════════════
function onSpeedChange(val){
  const factor=Number(val)/100;
  if(scheduler)scheduler.setSpeed(factor);
  if(judge)judge.setBpm(bpm0*factor);
  document.getElementById('speedVal').textContent=factor.toFixed(2)+'×';
  document.getElementById('fileBpm').textContent=(bpm0*factor).toFixed(1);
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
//  FALLBACK BEEP  (Web Audio synth tone)
//  Used when Soundfont CDN is unavailable.
// ═══════════════════════════════════════════
function makeFallbackInstrument(ac){
  return {
    play(noteName, when, opts){
      try{
        const NOTE_MAP={C:0,'C#':1,D:2,'D#':3,E:4,F:5,'F#':6,G:7,'G#':8,A:9,'A#':10,B:11};
        const m=noteName.match(/^([A-G]#?)(-?\d+)$/);
        if(!m)return null;
        const semi=NOTE_MAP[m[1]]+(parseInt(m[2])+1)*12;
        const freq=440*Math.pow(2,(semi-69)/12);
        const osc=ac.createOscillator();
        const gain=ac.createGain();
        osc.type='triangle';
        osc.frequency.value=freq;
        const g=(opts?.gain||0.6)*0.4;
        gain.gain.setValueAtTime(g, when);
        gain.gain.exponentialRampToValueAtTime(0.0001, when+(opts?.duration||0.4));
        osc.connect(gain);gain.connect(ac.destination);
        osc.start(when);osc.stop(when+(opts?.duration||0.4)+0.05);
        return osc;
      }catch(e){return null;}
    }
  };
}


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
  if(audioCtx&&audioCtx.state==='suspended') audioCtx.resume();
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
function showEndScreen(){
  if(!judge)return;
  document.getElementById('endScore').textContent  =judge.score;
  document.getElementById('endB1').textContent     =judge.b1Hits;
  document.getElementById('endBonus').textContent  =judge.bonusHits;
  document.getElementById('endPerfect').textContent=judge.perfectHits;
  document.getElementById('endOverlay').style.display='flex';
  isPaused=false;
  _hudDirty=true;
  const pb=document.getElementById('pauseBtn');
  if(pb){pb.disabled=true;pb.textContent='⏸';pb.title='暫停';}
}
function _resetPlayState(){
  handState.left ={poseBuf:[],wasAboveHigh:false,wasAboveHighTimestamp:0,peakSpeed:0,trail:[]};
  handState.right={poseBuf:[],wasAboveHigh:false,wasAboveHighTimestamp:0,peakSpeed:0,trail:[]};
  lastBeatMs=0;autoPaused=false;crossPauseSinceMs=0;countdownActive=false;bothStillSinceMs=0;
  _prevBeatMs=0;_nextBeatMs=0;_currentBeatNum=1;_nextBeatNum=1;
  _flareMs=0;_nextFlareAtMs=0;_flareBeatNum=0;
  isPaused=false;
  _hudDirty=true;
}
function restartGame(){
  document.getElementById('endOverlay').style.display='none';
  document.getElementById('startOverlay').style.display='none';
  if(scheduler)scheduler.reset();
  if(judge){judge.reset();updateScoreUI();}
  _resetPlayState();
  const pb=document.getElementById('pauseBtn');
  if(pb){pb.disabled=true;pb.textContent='⏸';pb.title='暫停';}
  waitForStartClick();
}
function finishGame(){
  document.getElementById('endOverlay').style.display='none';
  if(scheduler)scheduler.reset();
  if(judge){judge.reset();updateScoreUI();}
  _resetPlayState();
  analyzer=null;scheduler=null;judge=null;
  const pb=document.getElementById('pauseBtn');
  if(pb){pb.disabled=true;pb.textContent='⏸';pb.title='暫停';}
  document.getElementById('uploadOverlay').style.display='flex';
}


// ═══════════════════════════════════════════
//  FILE UPLOAD
// ═══════════════════════════════════════════
document.getElementById('fileInput').addEventListener('change',async(e)=>{
  const file=e.target.files[0];if(!file)return;
  document.getElementById('startOverlay').style.display='none';
  document.getElementById('endOverlay').style.display='none';
  document.getElementById('fileName').textContent=file.name;

  try{
    analyzer=new MidiAnalyzer(await file.arrayBuffer());
    bpm0=analyzer.initialBpm;
    document.getElementById('fileBpm').textContent=bpm0.toFixed(1);

    currentTS=analyzer.timeSig;
    const COMPOUND_MAP={6:2,9:3,12:4};
    currentTS[0]=COMPOUND_MAP[currentTS[0]]??currentTS[0];
    if(![[2,4],[3,4],[4,4]].some(t=>t[0]===currentTS[0]&&t[1]===currentTS[1]))currentTS=[4,4];
    document.getElementById('tsLabel').textContent=`${currentTS[0]} / ${currentTS[1]}`;

    if(!audioCtx) audioCtx=new(window.AudioContext||window.webkitAudioContext)();
    if(audioCtx.state==='suspended') await audioCtx.resume();

    // Use fallback beep immediately so scheduler can play right away.
    // Soundfont loads in the background and swaps in when ready.
    if(!instrument) instrument=makeFallbackInstrument(audioCtx);

    judge=new BeatJudge(bpm0);
    _prevBeatMs=0;_nextBeatMs=0;_currentBeatNum=1;_nextBeatNum=1;
    handState.left ={poseBuf:[],wasAboveHigh:false,wasAboveHighTimestamp:0,peakSpeed:0,trail:[]};
    handState.right={poseBuf:[],wasAboveHigh:false,wasAboveHighTimestamp:0,peakSpeed:0,trail:[]};
    lastBeatMs=0;autoPaused=false;

    scheduler=new AutoScheduler(analyzer,audioCtx,instrument,(beatPerfMs,beatNum)=>{
      judge.addBeat(beatPerfMs,beatNum);
      _hudDirty=true;
      _prevBeatMs=_nextBeatMs;
      _currentBeatNum=_nextBeatNum;
      _nextBeatMs=beatPerfMs;
      _nextBeatNum=beatNum;
      _nextFlareAtMs=beatPerfMs;
      _flareBeatNum=beatNum;
    },showEndScreen);
    scheduler.setTS(currentTS);

    document.getElementById('uploadOverlay').style.display='none';
    isPaused=false;
    const pb=document.getElementById('pauseBtn');
    if(pb){pb.disabled=true;pb.textContent='⏸';pb.title='暫停';}
    // Reset speed slider to 100% for new file
    const ss=document.getElementById('speedSlider');
    if(ss){ss.value=100;document.getElementById('speedVal').textContent='1.00×';}
    updateScoreUI();

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

    // Load Soundfont in background — swap into scheduler when ready
    Soundfont.instrument(audioCtx,'acoustic_grand_piano',{soundfont:'FluidR3_GM',format:'mp3'})
      .then(sf=>{
        instrument=sf;
        if(scheduler) scheduler.inst=sf;
      })
      .catch(err=>console.warn('Soundfont unavailable, using synth fallback:',err));

  }catch(err){
    console.error('Error loading MIDI file:',err);
    alert('MIDI 載入失敗：'+err.message+'\n\n請按 F12 開啟瀏覽器主控台查看詳細資訊。');
    document.getElementById('fileName').textContent=file.name+' — load error';
  }
});


// ═══════════════════════════════════════════
//  SCORE UI
// ═══════════════════════════════════════════
function updateScoreUI(){
  if(!judge)return;
  document.getElementById('scoreVal').textContent  =judge.score;
  document.getElementById('streakVal').textContent =judge.streak;
  document.getElementById('b1HitsVal').textContent  =judge.b1Hits;
  document.getElementById('bonusVal').textContent   =judge.bonusHits;
  document.getElementById('perfHitsVal').textContent=judge.perfectHits;
}

function flashOverlay(r,g,b){
  const el=document.getElementById('beatFlash');
  const elder=isElderMode();
  el.style.background=`rgba(${r},${g},${b},${elder?0.45:0.2})`;
  el.style.opacity='1';
  setTimeout(()=>el.style.opacity='0',elder?300:110);
}


// ═══════════════════════════════════════════
//  METRONOME HUD  (dedicated overlay canvas)
// ═══════════════════════════════════════════
function drawMetronomeHUD() {
  const hudCanvas = elHudCanvas;
  const camCanvas = elCamCanvas;

  const W = camCanvas.width  || camCanvas.clientWidth  || 640;
  const H = camCanvas.height || camCanvas.clientHeight || 480;
  if (hudCanvas.width !== W)  hudCanvas.width  = W;
  if (hudCanvas.height !== H) hudCanvas.height = H;

  const ctx = hudCanvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const light = isLight();
  const elder = isElderMode();
  const gold  = light ? '#6a7480' : '#b0b8c4';

  const HUD_W = elder ? 300 : 220;
  const HUD_H = elder ? 130 : 100;
  const bx = (W - HUD_W) / 2, by = 8;

  ctx.save();

  // Backdrop
  ctx.fillStyle = light ? 'rgba(244,241,235,0.92)' : 'rgba(7,7,15,0.86)';
  ctx.beginPath(); ctx.roundRect(bx, by, HUD_W, HUD_H, 14); ctx.fill();
  ctx.strokeStyle = light ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(bx, by, HUD_W, HUD_H, 14); ctx.stroke();

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
    const arcR  = elder ? 68 : 52;
    const arcLW = elder ? 3 : 2;
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
      ctx.lineWidth = arcLW + flareT * 1.5;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // Flare ring: expands and fades on beat arrival
    if (flareT > 0) {
      const flareR = arcR + (1 - flareT) * (elder ? 20 : 14);
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
  ctx.font = `bold ${elder ? 62 : 38}px DM Mono, monospace`;
  if (!isIdle && isB1) {
    ctx.fillStyle   = gold;
    ctx.shadowColor = gold;
    ctx.shadowBlur  = urgency > 0 ? (elder ? 10 : 6) + urgency * (elder ? 20 : 14) : (elder ? 10 : 6);
  } else {
    ctx.fillStyle  = light ? 'rgba(80,76,68,0.55)' : 'rgba(200,200,200,0.45)';
    ctx.shadowBlur = 0;
  }
  ctx.fillText(isIdle ? '—' : String(_nextBeatNum), W / 2, by + HUD_H / 2 + (elder ? 8 : 5));
  ctx.shadowBlur = 0;

  // BPM label — upper-right of backdrop
  const speedFactor = Number(elSpeedSlider.value) / 100;
  ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.font = `${elder ? 13 : 10}px DM Mono, monospace`;
  ctx.fillStyle = light ? 'rgba(100,90,70,0.55)' : 'rgba(180,180,180,0.5)';
  ctx.fillText(isIdle ? '— BPM' : (bpm0 * speedFactor).toFixed(0) + ' BPM', bx + HUD_W - 10, by + 10);

  // Cross-pause gesture progress ring
  if (crossPauseSinceMs > 0) {
    const prog  = Math.min(1, (now - crossPauseSinceMs) / 400);
    const indCx = W / 2;
    const indCy = by + HUD_H + (elder ? 28 : 20);
    const indR  = elder ? 16 : 12;
    const indLW = elder ? 2.5 : 2;

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
const _SCORE_COLOR={perfect1:'255,200,80',perfectBonus:'255,200,80',hit1:'80,216,154',bonus:'80,160,255'};
const _SCORE_TEXT ={perfect1:'完美！',   perfectBonus:'完美！',   hit1:'✓ 第一拍',  bonus:'✦ 加分拍'};
const _SCORE_DELTA={perfect1:'+7',       perfectBonus:'+2',       hit1:'+5',        bonus:'+1'};

function startCamera(){
  cameraStarted=true;
  const video=document.getElementById('videoEl');
  const canvas=elCamCanvas;
  const ctx=canvas.getContext('2d');
  let frameTimestamp=0;

  // Fixed display resolution — camera captures 320×240 but canvas stays at 640×480
  canvas.width=640;canvas.height=480;

  // Last-known hand state shared between detection callback and draw loop.
  // wx/wy are stable pixel-coord copies set in onResults so drawFrame never reads
  // a lm reference that MediaPipe may have replaced with a newer frame's data.
  const known={
    left: {lm:null,speed:0,wx:0,wy:0},
    right:{lm:null,speed:0,wx:0,wy:0}
  };

  const pose=new Pose({
    locateFile:f=>`https://cdn.jsdelivr.net/npm/@mediapipe/pose/${f}`
  });
  pose.setOptions({
    modelComplexity:0,
    smoothLandmarks:true,
    minDetectionConfidence:0.5,
    minTrackingConfidence:0.5
  });

  const SIDES=['left','right'];
  // Pose landmark indices: left wrist=15, right wrist=16 (person's own left/right)
  const WRIST_IDX={left:15,right:16};

  // Detection-only callback — no drawing here
  pose.onResults(results=>{
    const W=canvas.width,H=canvas.height;
    const lm=results.poseLandmarks;

    // Update known state, trails, and beat detection
    for(const side of SIDES){
      const pt=lm&&lm[WRIST_IDX[side]];
      const state=handState[side];
      const k=known[side];
      if(!pt||pt.visibility<0.3){k.lm=null;state.trail=[];continue;}
      k.lm=pt;
      // Mirrored pixel position — matches the flipped camera feed in drawFrame
      k.wx=(1-pt.x)*W; k.wy=pt.y*H;
      state.trail.push([k.wx,k.wy]);
      if(state.trail.length>18)state.trail.shift();
      state.poseBuf.push({x:pt.x,y:pt.y,t:frameTimestamp});
      if(state.poseBuf.length>POS_BUF_SIZE)state.poseBuf.shift();
      k.speed=handSpeed(state);
      detectBeat(k.speed,frameTimestamp,state);
    }

    // Auto-pause/resume using bilateral stillness detection
    const lVis=known.left.lm!==null,  rVis=known.right.lm!==null;
    const now=performance.now();
    const STILL_THR=0.0003;
    const STILL_MS=scheduler ? Math.max(800, scheduler.beatS * 2000) : 800;
    const bothStill=lVis&&rVis&&known.left.speed<STILL_THR&&known.right.speed<STILL_THR;
    if(!countdownActive&&scheduler&&scheduler.playing&&!isPaused&&!autoPaused){
      if(bothStill){
        if(bothStillSinceMs===0)bothStillSinceMs=now;
        if(now-bothStillSinceMs>=STILL_MS){
          bothStillSinceMs=0;
          autoPaused=true;scheduler.pause();_hudDirty=true;
        }
      }else{
        bothStillSinceMs=0;
      }
    }else if(!bothStill){
      bothStillSinceMs=0;
    }
    if(autoPaused&&!isPaused&&scheduler){
      if((lVis&&known.left.speed>=STILL_THR)||(rVis&&known.right.speed>=STILL_THR)){
        autoPaused=false;bothStillSinceMs=0;crossPauseSinceMs=0;
        if(audioCtx?.state==='suspended')audioCtx.resume();
        scheduler.resume(0.1);_hudDirty=true;
      }
    }

    // Pause gesture: both wrists above eye level, sustained 400ms
    if(!countdownActive&&scheduler&&scheduler.playing&&!isPaused&&!autoPaused){
      const el=lm&&lm[3], er=lm&&lm[4];
      const wl=known.left.lm,  wr=known.right.lm;
      const crossGesture=el&&er&&wl&&wr
        &&wl.y<el.y&&wr.y<er.y;  // both wrists above respective eye landmarks
      if(crossGesture){
        if(crossPauseSinceMs===0)crossPauseSinceMs=now;
        if(now-crossPauseSinceMs>=400){
          crossPauseSinceMs=0;
          autoPaused=true;scheduler.pause();_hudDirty=true;
        }
      }else{
        crossPauseSinceMs=0;
      }
    }else if(!autoPaused&&!isPaused){
      crossPauseSinceMs=0;
    }
  });

  // Draw loop — runs every rAF frame, reads last-known state
  function drawFrame(){
    const W=canvas.width,H=canvas.height;
    ctx.clearRect(0,0,W,H);

    // Mirrored camera feed (scales 320×240 video up to 640×480 canvas)
    ctx.save();ctx.translate(W,0);ctx.scale(-1,1);
    ctx.drawImage(video,0,0,W,H);
    ctx.restore();

    const elder=isElderMode();
    for(const side of SIDES){
      const k=known[side];
      if(!k.lm)continue;
      const wx=k.wx, wy=k.wy;        // stable copies, never read k.lm[0] here
      const trail=handState[side].trail;

      // Hard reset before each hand — prevents stale path from previous hand
      // bleeding in when this hand's trail has 0 or 1 point (loop body never fires).
      ctx.beginPath();
      for(let i=1;i<trail.length;i++){
        ctx.strokeStyle=TRAIL_STYLES[i-1];
        ctx.lineWidth=(i/trail.length)*4.5;
        ctx.beginPath();ctx.moveTo(trail[i-1][0],trail[i-1][1]);
        ctx.lineTo(trail[i][0],trail[i][1]);ctx.stroke();
      }

      // Wrist dot: green = moving, orange = pre-pause warning (both still, 500ms window)
      const prePause=bothStillSinceMs>0&&!autoPaused;
      const dotColor=prePause?'#ff9040':'#50d89a';
      ctx.fillStyle=dotColor;ctx.shadowColor=dotColor;ctx.shadowBlur=elder?20:12;
      ctx.beginPath();ctx.arc(wx,wy,elder?11:6,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;

      // Speed bar
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

    // Auto-pause overlay
    if(autoPaused){
      ctx.save();
      ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.font=`bold ${elder?52:36}px Cormorant Garamond, serif`;
      ctx.fillStyle='rgba(220,220,220,0.88)';
      ctx.shadowColor='rgba(0,0,0,0.55)';ctx.shadowBlur=12;
      ctx.fillText('停止',W/2,H/2);
      ctx.restore();
    }

    // Floating score HUD
    if(judge?.lastResult){
      const age=performance.now()-judge.lastResultTime;
      if(age<800){
        const r=judge.lastResult;
        if(r!=='ignored'){
          const elder2=isElderMode();
          const alpha=Math.max(0,1-age/800);
          const c=_SCORE_COLOR[r]||'180,180,180';
          const floatY=H/2-14-age*0.045;
          ctx.save();ctx.textAlign='center';
          ctx.font=`bold ${elder2?38:25}px DM Mono, monospace`;
          ctx.fillStyle=`rgba(${c},${alpha})`;
          ctx.shadowColor=`rgba(${c},${alpha*0.5})`;ctx.shadowBlur=elder2?22:16;
          ctx.fillText(_SCORE_TEXT[r],W/2,floatY);
          ctx.font=`${elder2?22:15}px DM Mono, monospace`;ctx.shadowBlur=0;
          ctx.fillStyle=`rgba(${c},${alpha*0.85})`;
          ctx.fillText(_SCORE_DELTA[r],W/2,floatY+(elder2?36:25));
          ctx.restore();
        }
      }
    }
    requestAnimationFrame(drawFrame);
  }
  requestAnimationFrame(drawFrame);

  // Initialize fully before starting the camera — eliminates the race condition where
  // early onFrame calls arrive before the WASM model has finished downloading.
  const camera=new Camera(video,{
    onFrame:()=>{
      frameTimestamp=performance.now();
      pose.send({image:video}).catch(err=>console.error('pose.send error:',err));
    },
    width:480,height:360
  });
  pose.initialize().then(()=>camera.start()).catch(()=>alert('需要相機權限。請允許存取後重新整理頁面。'));
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

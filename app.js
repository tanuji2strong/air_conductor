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
  constructor(analyzer,ac,instrument,onBeatScheduled){
    this.a=analyzer; this.ac=ac; this.inst=instrument;
    this.onBeatScheduled=onBeatScheduled;
    this.bpm=analyzer.initialBpm; this.speedFactor=1.0; this.beatS=60/this.bpm;
    this.ts=[4,4]; this.playing=false; this.muted=false;
    this._nodes=[]; this._AHEAD=0.15;
    this.currentTick=0; this.eventIndex=0;
    this.nextBeatAudioTime=0; this._beatNum=1;
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
  reset(){this.playing=false;this.currentTick=0;this.eventIndex=0;this._beatNum=1;this._stopAll();}
  _stopAll(){for(const n of this._nodes)try{n.stop();}catch{}this._nodes=[];}
  _midiName(n){return['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][n%12]+(Math.floor(n/12)-1);}
  _play(ev,when){
    if(this.muted||ev.channel===9||!this.inst)return;
    if(ev.type==='note_on'&&ev.velocity>0){
      const nd=this.inst.play(this._midiName(ev.note),when,{duration:1.5,gain:(ev.velocity/127)*0.9});
      if(nd)this._nodes.push(nd);
    }
  }
  update(){
    if(!this.playing)return;
    const now=this.ac.currentTime;
    while(this.nextBeatAudioTime<now+this._AHEAD){
      this._scheduleBeat(this.nextBeatAudioTime);
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
    if(this.currentTick>=this.a.totalTicks){this.currentTick=0;this.eventIndex=0;}
  }
  get progress(){return this.a.totalTicks?this.currentTick/this.a.totalTicks:0;}
}


// ═══════════════════════════════════════════
//  BEAT JUDGE  — every synced beat = +1
// ═══════════════════════════════════════════
class BeatJudge {
  constructor(bpm=120){
    this._bpm=bpm; this.score=0; this.streak=0;
    this.b1Hits=0; this.bonusHits=0;
    this.pending=[]; this.lastResult=null; this.lastResultTime=0;
  }
  setBpm(b){this._bpm=b;}
  // Window = 55% of beat interval, clamped 380–650ms.
  get windowMs(){return Math.min(650,Math.max(380,(60000/this._bpm)*0.55));}
  addBeat(perfTime,beatNum){this.pending.push({perfTime,beatNum,judged:false});}

  onGesture(){
    const now=performance.now();
    let best=null,bestDiff=Infinity;
    for(const b of this.pending){
      if(b.judged)continue;
      const diff=Math.abs(now-b.perfTime);
      if(diff<bestDiff){bestDiff=diff;best=b;}
    }
    if(best&&bestDiff<=this.windowMs){
      best.judged=true;
      if(best.beatNum===1){
        this.score+=5;this.streak++;this.b1Hits++;
        return this._set('hit1',now);
      } else {
        this.score+=1;this.streak++;this.bonusHits++;
        return this._set('bonus',now);
      }
    }
    return this._set('ignored',now);
  }

  _set(r,t){this.lastResult=r;this.lastResultTime=t;return r;}
  get accuracy(){return this.b1Hits===0?null:Math.round((this.b1Hits/(this.b1Hits+this.bonusHits))*100);}
  reset(){
    this.score=0;this.streak=0;this.b1Hits=0;this.bonusHits=0;
    this.pending=[];this.lastResult=null;
  }
}


// ═══════════════════════════════════════════
//  APP STATE
// ═══════════════════════════════════════════
let analyzer=null,scheduler=null,judge=null,audioCtx=null,instrument=null;
let currentTS=[4,4],bpm0=120;
let trail=[],cameraStarted=false;
let _prevBeatMs=0,_nextBeatMs=0,_currentBeatNum=1,_nextBeatNum=1;
let _shmPhaseOriginMs=0,_shmBeatIntervalMs=500;
let isPaused=false;
let cachedSens=5,_hudDirty=true;

// Beat detection state (ported from metronome.html)
const POS_BUF_SIZE = 8;
const VELO_WINDOW  = 3;
const MIN_BEAT_MS  = 200;
let poseBuf = [];
let wasAboveHigh = false;
let wasAboveHighTimestamp = 0;
let peakSpeed = 0;
let lastBeatMs = 0;


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



// ═══════════════════════════════════════════
//  METRONOME CANVAS
// ═══════════════════════════════════════════
function drawMetronome(expectedBeat,playing){
  const mc=document.getElementById('metroCanvas');
  const mctx=mc.getContext('2d');
  const W=mc.width,H=mc.height;
  mctx.clearRect(0,0,W,H);

  const light=isLight();
  const gold =light?'#6a7480':'#b0b8c4';
  const dim  =light?'#dedad0':'#252530';
  const red  =light?'#c73c3c':'#e05252';

  // Beat progress 0→1
  const now=performance.now();
  const total=_nextBeatMs-_prevBeatMs;
  const elapsed=now-_prevBeatMs;
  const progress=(playing&&total>50&&_prevBeatMs>0)
    ?Math.min(1,Math.max(0,elapsed/total)):0;

  const cx=W/2, cy=38, R=26;

  // Track ring
  mctx.beginPath();
  mctx.arc(cx,cy,R,0,Math.PI*2);
  mctx.strokeStyle=dim; mctx.lineWidth=5; mctx.stroke();

  // Progress arc — colour shifts gold→red as beat approaches
  if(playing){
    const u=progress;
    const cr=Math.round((light?106:176)+(u*((light?199:224)-(light?106:176))));
    const cg=Math.round((light?116:184)+(u*((light?60:82) -(light?116:184))));
    const cb=Math.round((light?128:196)+(u*((light?60:82) -(light?128:196))));
    mctx.beginPath();
    mctx.arc(cx,cy,R,-Math.PI/2,-Math.PI/2+u*Math.PI*2);
    mctx.strokeStyle=`rgb(${cr},${cg},${cb})`;
    mctx.lineWidth=5; mctx.lineCap='round'; mctx.stroke();
  }

  // Centre beat number
  mctx.textAlign='center'; mctx.textBaseline='middle';
  mctx.font=`300 ${playing?'20':'16'}px Cormorant Garamond, serif`;
  mctx.fillStyle=playing?gold:(light?'#c0bbb0':'#2a2a38');
  mctx.fillText(playing?String(expectedBeat):'—',cx,cy);

  // Position dots + pendulum tick marks
  const n=currentTS[0];
  const spacing=13;
  const startX=cx-((n-1)*spacing)/2;
  const dotY=cy+R+14;

  for(let i=1;i<=n;i++){
    const dx2=startX+(i-1)*spacing;
    const isActive=i===expectedBeat&&playing;
    const isB1=i===1;

    // Outer ring for beat-1
    if(isB1){
      mctx.beginPath();mctx.arc(dx2,dotY,5.5,0,Math.PI*2);
      mctx.strokeStyle=isActive?gold:(light?'#c5bfb0':'#363640');
      mctx.lineWidth=1;mctx.stroke();
    }

    mctx.beginPath();mctx.arc(dx2,dotY,3.5,0,Math.PI*2);
    if(isActive){
      mctx.fillStyle=gold;
      mctx.shadowColor=gold;mctx.shadowBlur=8;
    } else {
      mctx.fillStyle=dim;mctx.shadowBlur=0;
    }
    mctx.fill();mctx.shadowBlur=0;
  }

  // BPM label
  if(bpm0>0){
    mctx.textAlign='right'; mctx.textBaseline='bottom';
    mctx.font=`9px DM Mono, monospace`;
    mctx.fillStyle=light?'#c0bbb0':'#2a2a38';
    mctx.fillText(bpm0.toFixed(0)+' bpm',W-4,H-2);
  }
}


// ═══════════════════════════════════════════
//  SENSITIVITY
// ═══════════════════════════════════════════
function onSensChange(val){
  cachedSens=Number(val);
  document.getElementById('sensVal').textContent=Number(val);
}


// ═══════════════════════════════════════════
//  BEAT DETECTION (ported from metronome.html)
// ═══════════════════════════════════════════
function smoothedSpeed() {
  const buf = poseBuf.slice(-VELO_WINDOW);
  if (buf.length < 2) return 0;
  let sum = 0, n = 0;
  for (let i = 1; i < buf.length; i++) {
    const dt = buf[i].t - buf[i - 1].t;
    if (dt > 0) {
      const dx = buf[i].x - buf[i - 1].x;
      const dy = buf[i].y - buf[i - 1].y;
      sum += Math.sqrt(dx * dx + dy * dy) / dt;
      n++;
    }
  }
  return n ? sum / n : 0;
}

function onWrist(x, y, speed) {
  const t = performance.now();
  poseBuf.push({ x, y, t });
  if (poseBuf.length > POS_BUF_SIZE) poseBuf.shift();
  if (poseBuf.length < VELO_WINDOW) return;

  const highThr = 0.003 * Math.pow(0.22, (cachedSens - 1) / 4);

  if (speed > highThr) {
    if (!wasAboveHigh) {
      wasAboveHigh = true;
      wasAboveHighTimestamp = t;
      peakSpeed = speed;
    } else if (speed > peakSpeed) {
      peakSpeed = speed;
    }
  }

  if (wasAboveHigh && speed < peakSpeed * 0.55) {
    const elapsed = t - lastBeatMs;
    const withinWindow = (t - wasAboveHighTimestamp) < 600;
    if (elapsed >= MIN_BEAT_MS && withinWindow) {
      lastBeatMs = t;
      if (scheduler?.playing && judge) {
        const result = judge.onGesture();
        if (result === 'hit1')       { flashOverlay(80, 216, 154); }
        else if (result === 'bonus') { flashOverlay(80, 160, 255); }
        if (result !== 'ignored') updateScoreUI();
      }
    }
    wasAboveHigh = false;
    peakSpeed = 0;
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
      document.getElementById('progressFill').style.width=(scheduler.progress*100)+'%';
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
  for(let i=3;i>=1;i--){nm.textContent=i;await new Promise(r=>setTimeout(r,900));}
  nm.textContent='♩';await new Promise(r=>setTimeout(r,600));
  ov.style.display='none';
  // Resume audioCtx here too — user just interacted via file picker
  if(audioCtx&&audioCtx.state==='suspended') audioCtx.resume();
  scheduler.start(0.25);
}


// ═══════════════════════════════════════════
//  FILE UPLOAD
// ═══════════════════════════════════════════
document.getElementById('fileInput').addEventListener('change',async(e)=>{
  const file=e.target.files[0];if(!file)return;
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
    _shmPhaseOriginMs=0;_shmBeatIntervalMs=500;
    poseBuf=[];wasAboveHigh=false;wasAboveHighTimestamp=0;peakSpeed=0;lastBeatMs=0;

    scheduler=new AutoScheduler(analyzer,audioCtx,instrument,(beatPerfMs,beatNum)=>{
      judge.addBeat(beatPerfMs,beatNum);
      _hudDirty=true;
      if (_nextBeatMs > 0) _shmBeatIntervalMs = beatPerfMs - _nextBeatMs;
      if (beatNum === 1) _shmPhaseOriginMs = beatPerfMs;
      _prevBeatMs=_nextBeatMs;
      _currentBeatNum=_nextBeatNum;
      _nextBeatMs=beatPerfMs;
      _nextBeatNum=beatNum;
    });
    scheduler.setTS(currentTS);

    document.getElementById('uploadOverlay').style.display='none';
    isPaused=false;
    const pb=document.getElementById('pauseBtn');
    if(pb){pb.disabled=false;pb.textContent='⏸';pb.title='Pause';}
    // Reset speed slider to 100% for new file
    const ss=document.getElementById('speedSlider');
    if(ss){ss.value=100;document.getElementById('speedVal').textContent='1.00×';}
    updateScoreUI();

    // Start audio/countdown regardless of camera state
    startCountdown();

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
  document.getElementById('b1HitsVal').textContent =judge.b1Hits;
  document.getElementById('bonusVal').textContent  =judge.bonusHits;
}

function flashOverlay(r,g,b){
  const el=document.getElementById('beatFlash');
  el.style.background=`rgba(${r},${g},${b},0.2)`;
  el.style.opacity='1';
  setTimeout(()=>el.style.opacity='0',110);
}


// ═══════════════════════════════════════════
//  METRONOME HUD  (dedicated overlay canvas)
// ═══════════════════════════════════════════
function drawMetronomeHUD() {
  const hudCanvas = document.getElementById('hudCanvas');
  const camCanvas = document.getElementById('canvasEl');

  const W = camCanvas.width  || camCanvas.clientWidth  || 640;
  const H = camCanvas.height || camCanvas.clientHeight || 480;
  if (hudCanvas.width !== W)  hudCanvas.width  = W;
  if (hudCanvas.height !== H) hudCanvas.height = H;

  const ctx = hudCanvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const light = isLight();
  const gold  = light ? '#6a7480' : '#b0b8c4';

  const HUD_W = 220, HUD_H = 100;
  const bx = (W - HUD_W) / 2, by = 8;

  ctx.save();

  // Backdrop
  ctx.fillStyle = light ? 'rgba(244,241,235,0.92)' : 'rgba(7,7,15,0.86)';
  ctx.beginPath(); ctx.roundRect(bx, by, HUD_W, HUD_H, 12); ctx.fill();
  ctx.strokeStyle = light ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(bx, by, HUD_W, HUD_H, 12); ctx.stroke();

  const isIdle = !scheduler;
  const isB1   = _nextBeatNum === 1;

  // Urgency glow: beat progress > 70%
  let urgency = 0;
  if (!isIdle) {
    const now      = performance.now();
    const _total   = _nextBeatMs - _prevBeatMs;
    const _elapsed = now - _prevBeatMs;
    const bp = (_total > 50 && _prevBeatMs > 0)
      ? Math.min(1, Math.max(0, _elapsed / _total)) : 0;
    urgency = Math.max(0, (bp - 0.70) / 0.30);
  }

  // Beat number (centered in backdrop)
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 38px DM Mono, monospace';
  if (!isIdle && isB1) {
    ctx.fillStyle  = gold;
    ctx.shadowColor = gold;
    ctx.shadowBlur  = urgency > 0 ? 6 + urgency * 14 : 6;
  } else {
    ctx.fillStyle  = light ? 'rgba(80,76,68,0.55)' : 'rgba(200,200,200,0.45)';
    ctx.shadowBlur = 0;
  }
  ctx.fillText(isIdle ? '—' : String(_nextBeatNum), W / 2, by + HUD_H / 2 + 5);
  ctx.shadowBlur = 0;

  // BPM label — upper-right of backdrop
  const speedFactor = Number(document.getElementById('speedSlider').value) / 100;
  ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.font = '10px DM Mono, monospace';
  ctx.fillStyle = light ? 'rgba(100,90,70,0.55)' : 'rgba(180,180,180,0.5)';
  ctx.fillText(isIdle ? '— BPM' : (bpm0 * speedFactor).toFixed(0) + ' BPM', bx + HUD_W - 10, by + 10);

  ctx.restore();
}

// Dedicated 60fps loop for the HUD — decoupled from MediaPipe
function hudLoop() {
  if(_hudDirty){drawMetronomeHUD();_hudDirty=false;}
  requestAnimationFrame(hudLoop);
}
requestAnimationFrame(hudLoop);


// ═══════════════════════════════════════════
//  MEDIAPIPE CAMERA
// ═══════════════════════════════════════════
const TRAIL_STYLES=Array.from({length:18},(_,i)=>`rgba(176,184,196,${((i+1)/18)*0.7})`);

function startCamera(){
  cameraStarted=true;
  const video=document.getElementById('videoEl');
  const canvas=document.getElementById('canvasEl');
  const ctx=canvas.getContext('2d');

  const pose=new Pose({
    locateFile:f=>`https://cdn.jsdelivr.net/npm/@mediapipe/pose/${f}`
  });
  pose.setOptions({
    modelComplexity:0,smoothLandmarks:true,
    minDetectionConfidence:0.6,minTrackingConfidence:0.6
  });

  pose.onResults(results=>{
    const W=canvas.width,H=canvas.height;
    ctx.clearRect(0,0,W,H);

    // Mirrored camera feed
    ctx.save();ctx.translate(W,0);ctx.scale(-1,1);
    ctx.drawImage(results.image,0,0,W,H);
    ctx.restore();

    // Beat progress for this frame
    const now=performance.now();
    const _total=_nextBeatMs-_prevBeatMs;
    const _elapsed=now-_prevBeatMs;
    const beatProgress=(scheduler?.playing&&_total>50&&_prevBeatMs>0)
      ?Math.min(1,Math.max(0,_elapsed/_total)):0;

    if(results.poseLandmarks){
      const speed=smoothedSpeed();
      const lm=results.poseLandmarks;
      const mirX=l=>(1-l.x)*W, mirY=l=>l.y*H;

      // Right arm: shoulder → elbow → wrist
      const sh=lm[12],el=lm[14],wr=lm[16],idx=lm[20];
      const sx=mirX(sh),sy=mirY(sh);
      const ex=mirX(el),ey=mirY(el);
      const wx=mirX(wr),wy=mirY(wr);
      const ix=mirX(idx),iy=mirY(idx);

      // Skeleton
      ctx.strokeStyle='rgba(200,200,200,0.45)';ctx.lineWidth=2;
      [[sx,sy,ex,ey],[ex,ey,wx,wy]].forEach(([x1,y1,x2,y2])=>{
        ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
      });

      // Trail (wrist)
      trail.push([ix,iy]);if(trail.length>18)trail.shift();
      for(let i=1;i<trail.length;i++){
        const a=i/trail.length;
        ctx.strokeStyle=TRAIL_STYLES[i-1];
        ctx.lineWidth=a*4.5;
        ctx.beginPath();ctx.moveTo(trail[i-1][0],trail[i-1][1]);ctx.lineTo(trail[i][0],trail[i][1]);ctx.stroke();
      }

      // Wrist dot
      ctx.fillStyle='#b0b8c4';ctx.shadowColor='#b0b8c4';ctx.shadowBlur=12;
      ctx.beginPath();ctx.arc(ix,iy,6,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;

      // Speed bar
      {
        const highThr=0.003-(cachedSens-1)*0.00026;
        const BAR_W=60,BAR_H=5;
        const bx=ix-BAR_W/2,by=iy-22;
        ctx.beginPath();ctx.roundRect(bx,by,BAR_W,BAR_H,3);
        ctx.fillStyle='rgba(255,255,255,0.1)';ctx.fill();
        const fill=Math.min(speed/highThr,1)*BAR_W;
        ctx.beginPath();ctx.roundRect(bx,by,fill,BAR_H,3);
        ctx.fillStyle=speed>=highThr?'#ff9040':'#b0b8c4';ctx.fill();
        ctx.beginPath();ctx.moveTo(bx+BAR_W,by-2);ctx.lineTo(bx+BAR_W,by+BAR_H+2);
        ctx.strokeStyle='rgba(255,255,255,0.25)';ctx.lineWidth=1;ctx.stroke();
      }

      // Beat detection
      if(lm[20].visibility>0.3) onWrist(lm[20].x,lm[20].y,speed);
    } else {
      trail=[];
    }

    // (HUD drawn on hudCanvas by its own rAF loop)
    // (scheduler.update handled by the independent rAF loop above)

    // Floating score HUD
    if(judge?.lastResult&&performance.now()-judge.lastResultTime<800){
      const age=performance.now()-judge.lastResultTime;
      const alpha=Math.max(0,1-age/800);
      const r=judge.lastResult;
      if(r!=='ignored'){
        const CM={hit1:'80,216,154',bonus:'80,160,255'};
        const TM={hit1:'✓ 第一拍',  bonus:'✦ 加分拍'};
        const DM={hit1:'+1',        bonus:'+1'};
        const c=CM[r]||'180,180,180';
        const floatY=H/2-14-age*0.045;
        ctx.save();ctx.textAlign='center';
        ctx.font='bold 25px DM Mono, monospace';
        ctx.fillStyle=`rgba(${c},${alpha})`;
        ctx.shadowColor=`rgba(${c},${alpha*0.5})`;ctx.shadowBlur=16;
        ctx.fillText(TM[r],W/2,floatY);
        ctx.font='15px DM Mono, monospace';ctx.shadowBlur=0;
        ctx.fillStyle=`rgba(${c},${alpha*0.85})`;
        ctx.fillText(DM[r],W/2,floatY+25);
        ctx.restore();
      }
    }
  });

  const camera=new Camera(video,{
    onFrame:async()=>{
      canvas.width =video.videoWidth ||640;
      canvas.height=video.videoHeight||480;
      await pose.send({image:video});
    },
    width:640,height:480
  });
  camera.start().catch(()=>alert('需要相機權限。請允許存取後重新整理頁面。'));
}


// ═══════════════════════════════════════════
//  KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════
document.addEventListener('keydown',e=>{
  if(e.key==='r'||e.key==='R'){
    if(scheduler){scheduler.reset();startCountdown();}
    if(judge){judge.reset();updateScoreUI();}
    trail=[];
    poseBuf=[];wasAboveHigh=false;wasAboveHighTimestamp=0;peakSpeed=0;lastBeatMs=0;
    _prevBeatMs=0;_nextBeatMs=0;_currentBeatNum=1;_nextBeatNum=1;
    _shmPhaseOriginMs=0;_shmBeatIntervalMs=500;
    isPaused=false;
    _hudDirty=true;
    const pb=document.getElementById('pauseBtn');
    if(pb){pb.textContent='⏸';pb.title='Pause';}
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

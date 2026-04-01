'use strict';

// ═══════════════════════════════════════════
//  BEAT DIRECTION DATA
//  angle°: 0=right, 90=down, 180=left, 270=up
// ═══════════════════════════════════════════
const BEAT_DATA = {
  '2,4': [
    {beat:1,sym:'↓',dir:'Down',  angle:90, pts:'+5',isMain:true },
    {beat:2,sym:'↑',dir:'Up',    angle:270,pts:'+1',isMain:false},
  ],
  '3,4': [
    {beat:1,sym:'↓',dir:'Down',  angle:90, pts:'+5',isMain:true },
    {beat:2,sym:'→',dir:'Right', angle:0,  pts:'+1',isMain:false},
    {beat:3,sym:'↑',dir:'Up',    angle:270,pts:'+1',isMain:false},
  ],
  '4,4': [
    {beat:1,sym:'↓',dir:'Down',  angle:90, pts:'+5',isMain:true },
    {beat:2,sym:'←',dir:'Left',  angle:180,pts:'+1',isMain:false},
    {beat:3,sym:'→',dir:'Right', angle:0,  pts:'+1',isMain:false},
    {beat:4,sym:'↑',dir:'Up',    angle:270,pts:'+1',isMain:false},
  ],
};


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
        }catch(e){break;} // skip to next track on header read error
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
    this.bpm=analyzer.initialBpm; this.beatS=60/this.bpm;
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
//  BEAT JUDGE  — Beat-1 mandatory
//  Beat 1:  +5 hit  |  −2 wrong/miss
//  Others:  +1 hit  |  no penalty ever
// ═══════════════════════════════════════════
class BeatJudge {
  constructor(bpm=120){
    this._bpm=bpm; this.score=0; this.streak=0;
    this.b1Hits=0; this.bonusHits=0; this.b1Misses=0;
    this.pending=[]; this.lastResult=null; this.lastResultTime=0;
  }
  setBpm(b){this._bpm=b;}
  get windowMs(){return Math.min(1200,Math.max(1000,(60000/this._bpm)*0.9));}
  addBeat(perfTime,beatNum){this.pending.push({perfTime,beatNum,judged:false});}

  onGesture(gestureBeat){
    const now=performance.now();
    let best=null,bestDiff=Infinity;
    for(const b of this.pending){
      if(b.judged)continue;
      const diff=Math.abs(now-b.perfTime);
      if(diff<bestDiff){bestDiff=diff;best=b;}
    }
    if(best&&bestDiff<=this.windowMs){
      best.judged=true;
      if(gestureBeat===1){
        this.score+=5;this.streak++;this.b1Hits++;
        return this._set('hit1',now);
      } else {
        this.score+=1;this.streak++;this.bonusHits++;
        return this._set('bonus',now);
      }
    } else {
      if(gestureBeat===1){
        this.score=Math.max(0,this.score-2);this.streak=0;this.b1Misses++;
        return this._set('wrong1',now);
      }
      return this._set('ignored',now);
    }
  }

  checkMisses(onBeat1Miss){
    const now=performance.now();
    for(const b of this.pending){
      if(b.judged)continue;
      if(now>b.perfTime+this.windowMs){
        b.judged=true;
        if(b.beatNum===1){
          this.score=Math.max(0,this.score-2);this.streak=0;this.b1Misses++;
          this._set('miss1',now);
          if(onBeat1Miss)onBeat1Miss();
        }
        // other beats: silently expire
      }
    }
    this.pending=this.pending.filter(b=>!b.judged||now-b.perfTime<4000);
  }

  _set(r,t){this.lastResult=r;this.lastResultTime=t;return r;}
  get b1Total(){return this.b1Hits+this.b1Misses;}
  get accuracy(){return this.b1Total===0?null:Math.round((this.b1Hits/this.b1Total)*100);}
  reset(){
    this.score=0;this.streak=0;this.b1Hits=0;this.bonusHits=0;this.b1Misses=0;
    this.pending=[];this.lastResult=null;
  }
}


// ═══════════════════════════════════════════
//  CONDUCTOR DETECTOR
// ═══════════════════════════════════════════
class ConductorDetector {
  constructor(sig){
    this.sig=sig;this.expected=1;this.lastFire=performance.now();
    this.V=60;this.H=60;this.MX=10;this.MY=10;this.DEBOUNCE=160;
  }
  setSens(t){this.V=t;this.H=t;this.MX=t*0.16;this.MY=t*0.16;}
  setSignature(s){this.sig=s;this.reset();}
  reset(){this.expected=1;this.lastFire=performance.now();}
  forceAdvance(){
    this.expected=(this.expected%this.sig[0])+1;
    this.lastFire=performance.now()-this.DEBOUNCE-10;
  }
  tryFire(dx,dy,mx,my){
    const now=performance.now();
    if(now-this.lastFire<this.DEBOUNCE)return null;
    const{V,H,MX,MY}=this,[num]=this.sig;
    let fired=false;
    if(num===2){
      if     (this.expected===1&&my>MY&&dy>V*0.4)             fired=true;
      else if(this.expected===2&&my<-MY&&dy<-V*0.15)           fired=true;
    }else if(num===3){
      if     (this.expected===1&&my>MY&&dy>V*0.4)             fired=true;
      else if(this.expected===2&&mx>MX&&dx>H*0.25)            fired=true;
      else if(this.expected===3&&my<-MY&&mx>=0&&dy<-V*0.15)   fired=true;
    }else{
      if     (this.expected===1&&my>MY&&dy>V*0.4)             fired=true;
      else if(this.expected===2&&mx<-MX&&dx<-H*0.25)          fired=true;
      else if(this.expected===3&&mx>MX&&dx>H*0.25)            fired=true;
      else if(this.expected===4&&my<-MY&&dy<-V*0.15)          fired=true;
    }
    if(fired){const b=this.expected;this.expected=(this.expected%num)+1;this.lastFire=now;return b;}
    return null;
  }
}


// ═══════════════════════════════════════════
//  APP STATE
// ═══════════════════════════════════════════
let analyzer=null,scheduler=null,judge=null,audioCtx=null,instrument=null;
const detector=new ConductorDetector([4,4]);
let currentTS=[4,4],bpm0=120;
let trail=[],prevIx=null,prevIy=null,cameraStarted=false;
let _prevBeatMs=0,_nextBeatMs=0,_currentBeatNum=1,_nextBeatNum=1;


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
//  PATTERN SVG
// ═══════════════════════════════════════════
function drawPattern(ts){
  const svg=document.getElementById('patternSvg');
  const W=256,H=110,cx=128,cy=55;
  const PATS={
    '2,4':[[cx,cy-36,'1↓'],[cx,cy+36,'2↑']],
    '3,4':[[cx,cy+36,'1↓'],[cx+58,cy-14,'2→'],[cx,cy-36,'3↑']],
    '4,4':[[cx,cy+36,'1↓'],[cx-58,cy,'2←'],[cx+58,cy,'3→'],[cx,cy-36,'4↑']],
  };
  const pts=PATS[ts.join(',')]||PATS['4,4'];
  const path=pts.map((p,i)=>(i?`L${p[0]},${p[1]}`:`M${p[0]},${p[1]}`)).join(' ');
  svg.innerHTML=`
    <path d="${path}" stroke="var(--border)" stroke-width="1.5" fill="none" stroke-dasharray="4 3"/>
    ${pts.map(([x,y,l],i)=>`
      <circle cx="${x}" cy="${y}" r="15" fill="var(--surface)"
              stroke="${i===0?'var(--gold)':'var(--border)'}" stroke-width="${i===0?'1.5':'1'}"/>
      <text x="${x}" y="${y+4}" text-anchor="middle"
            fill="${i===0?'var(--gold)':'var(--text-dim)'}"
            font-size="9" font-family="DM Mono,monospace">${l}</text>
    `).join('')}
  `;
}
drawPattern([4,4]);


// ═══════════════════════════════════════════
//  BEAT GUIDE
// ═══════════════════════════════════════════
function renderBeatGuide(ts){
  const beats=BEAT_DATA[ts.join(',')]||BEAT_DATA['4,4'];
  document.getElementById('guideList').innerHTML=beats.map(b=>`
    <div class="guide-row ${b.isMain?'g-main':''}" data-beat="${b.beat}">
      <span class="g-num">${b.beat}</span>
      <span class="g-sym">${b.sym}</span>
      <span class="g-dir">${b.dir}</span>
      <span class="g-pts">${b.pts}</span>
    </div>
  `).join('');
}
renderBeatGuide([4,4]);

function highlightGuide(beat){
  document.querySelectorAll('.guide-row').forEach(el=>{
    el.classList.toggle('g-active',+el.dataset.beat===beat);
  });
}


// ═══════════════════════════════════════════
//  METRONOME CANVAS
// ═══════════════════════════════════════════
function drawMetronome(expectedBeat,playing){
  const mc=document.getElementById('metroCanvas');
  const mctx=mc.getContext('2d');
  const W=mc.width,H=mc.height;
  mctx.clearRect(0,0,W,H);

  const light=isLight();
  const gold =light?'#9a6f28':'#c9a84c';
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
    const cr=Math.round((light?154:201)+(u*((light?199:224)-(light?154:201))));
    const cg=Math.round((light?111:168)+(u*((light?60:82)-(light?111:168))));
    const cb=Math.round((light?40:76) +(u*((light?60:82)-(light?40:76))));
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
  const t=Number(val);detector.setSens(t);
  document.getElementById('sensVal').textContent=(t/60).toFixed(1)+'×';
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
        // Parse note name like "C4", "F#3", etc.
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
    if(![[2,4],[3,4],[4,4]].some(t=>t[0]===currentTS[0]&&t[1]===currentTS[1]))currentTS=[4,4];
    detector.setSignature(currentTS);
    document.getElementById('tsLabel').textContent=`${currentTS[0]} / ${currentTS[1]}`;
    drawPattern(currentTS);renderBeatGuide(currentTS);

    if(!audioCtx) audioCtx=new(window.AudioContext||window.webkitAudioContext)();
    if(audioCtx.state==='suspended') await audioCtx.resume();

    // Use fallback beep immediately so scheduler can play right away.
    // Soundfont loads in the background and swaps in when ready.
    if(!instrument) instrument=makeFallbackInstrument(audioCtx);

    judge=new BeatJudge(bpm0);
    _prevBeatMs=0;_nextBeatMs=0;_currentBeatNum=1;_nextBeatNum=1;

    scheduler=new AutoScheduler(analyzer,audioCtx,instrument,(beatPerfMs,beatNum)=>{
      judge.addBeat(beatPerfMs,beatNum);
      detector.expected = beatNum;
      _prevBeatMs=_nextBeatMs;
      _currentBeatNum=_nextBeatNum;
      _nextBeatMs=beatPerfMs;
      _nextBeatNum=beatNum;
    });
    scheduler.setTS(currentTS);

    document.getElementById('uploadOverlay').style.display='none';
    updateScoreUI();

    // Start audio/countdown regardless of camera state
    startCountdown();

    // Start camera separately so a camera failure doesn't block audio
    if(!cameraStarted){
      try{ startCamera(); }
      catch(camErr){
        console.error('Camera/MediaPipe failed:',camErr);
        alert('Camera could not start: '+camErr.message+'\n\nAudio will still play. Check the browser console for details.');
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
    alert('Failed to load MIDI: '+err.message+'\n\nSee browser console (F12) for details.');
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
  document.getElementById('b1MissVal').textContent =judge.b1Misses;
  const acc=judge.accuracy;
  document.getElementById('accuracyVal').textContent=acc!==null?acc+'%':'—';
}

function flashOverlay(r,g,b){
  const el=document.getElementById('beatFlash');
  el.style.background=`rgba(${r},${g},${b},0.2)`;
  el.style.opacity='1';
  setTimeout(()=>el.style.opacity='0',110);
}


// ═══════════════════════════════════════════
//  CANVAS ARROW CUE
//  Drawn at bottom-centre of video canvas.
//  Brightens as beat window opens (~last 30%).
// ═══════════════════════════════════════════
function drawArrowCue(ctx,W,H,expectedBeat,ts,progress){
  const beats=BEAT_DATA[ts.join(',')]||BEAT_DATA['4,4'];
  const info=beats.find(b=>b.beat===expectedBeat)||beats[0];

  // Urgency: 0 until 70% through interval, then ramps to 1
  const urgency=Math.max(0,(progress-0.68)/0.32);
  const baseAlpha=0.2+urgency*0.58;
  const size=46+urgency*16;
  const isMain=info.isMain;

  const cx=W/2,cy=H-76;

  // Glow halo
  if(urgency>0.05){
    const grd=ctx.createRadialGradient(cx,cy,0,cx,cy,size);
    const gc=isMain?`rgba(201,168,76,${urgency*0.2})`:`rgba(220,220,220,${urgency*0.1})`;
    grd.addColorStop(0,gc);grd.addColorStop(1,'transparent');
    ctx.fillStyle=grd;ctx.beginPath();ctx.arc(cx,cy,size,0,Math.PI*2);ctx.fill();
  }

  // Arrow
  const rad=info.angle*Math.PI/180;
  ctx.save();
  ctx.translate(cx,cy);ctx.rotate(rad);
  ctx.globalAlpha=baseAlpha;
  ctx.strokeStyle=isMain?(isLight()?'#9a6f28':'#c9a84c'):(isLight()?'#555550':'rgba(200,200,200,0.9)');
  ctx.lineWidth=isMain?3.5:2.5;
  ctx.lineCap='round';ctx.lineJoin='round';

  // Shaft
  ctx.beginPath();ctx.moveTo(-size*0.46,0);ctx.lineTo(size*0.40,0);ctx.stroke();
  // Head
  ctx.beginPath();
  ctx.moveTo(size*0.40,0);ctx.lineTo(size*0.08,-size*0.27);
  ctx.moveTo(size*0.40,0);ctx.lineTo(size*0.08, size*0.27);
  ctx.stroke();

  ctx.globalAlpha=1;ctx.restore();

  // Label beneath
  ctx.save();
  ctx.textAlign='center';
  ctx.font=`${isMain?'bold ':''}11px DM Mono, monospace`;
  const labelAlpha=0.35+urgency*0.55;
  ctx.fillStyle=isMain
    ?(isLight()?`rgba(154,111,40,${labelAlpha})`:`rgba(201,168,76,${labelAlpha})`)
    :`rgba(170,170,170,${labelAlpha})`;
  ctx.fillText(`${info.sym}  beat ${expectedBeat}  ${info.pts}`,cx,cy+size*0.78);
  ctx.restore();
}


// ═══════════════════════════════════════════
//  BEAT BAR — autonomous metronome guide
//  Each beat is a slot. A sweep fill advances
//  left→right within the active slot, glowing
//  as the gesture window opens. Ticks forward
//  on its own clock, independent of gestures.
// ═══════════════════════════════════════════
function drawBeatBar(ctx,W,_unused,ts,progress){
  const beats=BEAT_DATA[ts.join(',')]||BEAT_DATA['4,4'];
  const n=beats.length;

  // Autonomous clock beat (not gesture-driven)
  const metroBeat=(_prevBeatMs>0)?_currentBeatNum:1;

  // Urgency: ramps 0→1 in the final 45% of the beat interval
  const urgency=Math.max(0,(progress-0.55)/0.45);

  // Layout — slots are wider for legibility
  const slotW=66,slotH=50,gap=10,pad=14;
  const barW=n*slotW+(n-1)*gap+pad*2;
  const barH=slotH+22;
  const bx=(W-barW)/2, by=8;

  ctx.save();

  // ── Backdrop ──
  ctx.fillStyle=isLight()?'rgba(244,241,235,0.93)':'rgba(7,7,15,0.86)';
  ctx.beginPath();ctx.roundRect(bx,by,barW,barH,12);ctx.fill();
  ctx.strokeStyle=isLight()?'rgba(0,0,0,0.08)':'rgba(255,255,255,0.07)';
  ctx.lineWidth=1;
  ctx.beginPath();ctx.roundRect(bx,by,barW,barH,12);ctx.stroke();

  beats.forEach((b,i)=>{
    const isActive=b.beat===metroBeat;
    const isMain=b.isMain;
    const sx=bx+pad+i*(slotW+gap);
    const sy=by+11;
    const col=isMain?'201,168,76':'80,144,224';
    const dimCol=isLight()?'0,0,0':'255,255,255';

    // ── Slot base ──
    ctx.beginPath();ctx.roundRect(sx,sy,slotW,slotH,7);
    ctx.fillStyle=isActive
      ?(isMain?`rgba(201,168,76,${0.07+urgency*0.09})`:`rgba(80,144,224,${0.05+urgency*0.08})`)
      :`rgba(${dimCol},0.025)`;
    ctx.fill();

    // ── Sweep fill (left→right countdown) ──
    if(isActive&&_prevBeatMs>0){
      const p=Math.min(progress,1);
      ctx.save();
      ctx.beginPath();ctx.roundRect(sx,sy,slotW,slotH,7);ctx.clip();

      // Background gradient sweep
      const grd=ctx.createLinearGradient(sx,0,sx+slotW,0);
      grd.addColorStop(0,  `rgba(${col},0.03)`);
      grd.addColorStop(0.5,`rgba(${col},${0.10+urgency*0.14})`);
      grd.addColorStop(1,  `rgba(${col},${0.24+urgency*0.26})`);
      ctx.fillStyle=grd;
      ctx.fillRect(sx,sy,slotW*p,slotH);

      // Leading-edge glow pulse
      if(urgency>0.05){
        const ex=sx+slotW*p;
        const eGrd=ctx.createLinearGradient(ex-14,0,ex+1,0);
        eGrd.addColorStop(0,`rgba(${col},0)`);
        eGrd.addColorStop(1,`rgba(${col},${urgency*0.75})`);
        ctx.fillStyle=eGrd;
        ctx.fillRect(ex-14,sy,15,slotH);
      }
      ctx.restore();
    }

    // ── Slot border ──
    ctx.beginPath();ctx.roundRect(sx,sy,slotW,slotH,7);
    ctx.strokeStyle=isActive
      ?(isMain
        ?`rgba(201,168,76,${0.30+urgency*0.60})`
        :`rgba(80,144,224,${0.22+urgency*0.52})`)
      :`rgba(${dimCol},0.09)`;
    ctx.lineWidth=isActive?1.5:1;
    ctx.stroke();

    // ── Beat number (top-centre) ──
    ctx.textAlign='center';ctx.textBaseline='top';
    ctx.font='bold 9px DM Mono, monospace';
    ctx.fillStyle=isActive
      ?(isMain?(isLight()?'#7a5210':'#d4a044'):(isLight()?'#1a50a0':'#76acf4'))
      :(isLight()?'#c4bfb5':'#2a2a3a');
    ctx.fillText(b.beat,sx+slotW/2,sy+5);

    // ── Arrow symbol (centre) ──
    if(isActive){
      ctx.shadowColor=isMain?'#c9a84c':'#4e8de0';
      ctx.shadowBlur=urgency>0.15?6+urgency*18:4;
    }
    ctx.font=`${isActive?'bold ':''} 24px sans-serif`;
    ctx.textBaseline='middle';
    ctx.fillStyle=isActive
      ?(isMain?(isLight()?'#8a5c18':'#d4a040'):(isLight()?'#1e5ab4':'#88beff'))
      :(isLight()?'#ccc8be':'#191920');
    ctx.fillText(b.sym,sx+slotW/2,sy+slotH/2+2);
    ctx.shadowBlur=0;

    // ── Direction label (bottom-centre) ──
    ctx.textBaseline='bottom';
    ctx.font='8px DM Mono, monospace';
    ctx.fillStyle=isActive
      ?(isMain?(isLight()?'#9a7228':'#b0883a'):(isLight()?'#1e5ab4':'#4e78a8'))
      :(isLight()?'#c8c3b8':'#222230');
    ctx.fillText(b.dir.toUpperCase(),sx+slotW/2,sy+slotH-4);
  });

  ctx.restore();
}


// ═══════════════════════════════════════════
//  MEDIAPIPE CAMERA
// ═══════════════════════════════════════════
function startCamera(){
  cameraStarted=true;
  const video=document.getElementById('videoEl');
  const canvas=document.getElementById('canvasEl');
  const ctx=canvas.getContext('2d');

  const pose=new Pose({
    locateFile:f=>`https://cdn.jsdelivr.net/npm/@mediapipe/pose/${f}`
  });
  pose.setOptions({
    modelComplexity:1,smoothLandmarks:true,
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
      const lm=results.poseLandmarks;
      const mirX=l=>(1-l.x)*W, mirY=l=>l.y*H;

      // Right arm (mirrored: indices 12,14,16,20)
      const sh=lm[12],el=lm[14],wr=lm[16],idx=lm[20];
      const sx=mirX(sh),sy=mirY(sh);
      const ex=mirX(el),ey=mirY(el);
      const wx=mirX(wr),wy=mirY(wr);
      const ix=mirX(idx),iy=mirY(idx);

      const dx=ix-sx,dy=iy-sy;
      const mx=prevIx!==null?ix-prevIx:0;
      const my=prevIy!==null?iy-prevIy:0;
      prevIx=ix;prevIy=iy;

      // Skeleton
      ctx.strokeStyle='rgba(200,200,200,0.45)';ctx.lineWidth=2;
      [[sx,sy,ex,ey],[ex,ey,wx,wy],[wx,wy,ix,iy]].forEach(([x1,y1,x2,y2])=>{
        ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
      });

      // Trail
      trail.push([ix,iy]);if(trail.length>18)trail.shift();
      for(let i=1;i<trail.length;i++){
        const a=i/trail.length;
        ctx.strokeStyle=`rgba(201,168,76,${a*0.7})`;
        ctx.lineWidth=a*4.5;
        ctx.beginPath();ctx.moveTo(trail[i-1][0],trail[i-1][1]);ctx.lineTo(trail[i][0],trail[i][1]);ctx.stroke();
      }

      // Fingertip
      ctx.fillStyle='#c9a84c';ctx.shadowColor='#c9a84c';ctx.shadowBlur=12;
      ctx.beginPath();ctx.arc(ix,iy,6,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;

      // Gesture detection + judge
      if(scheduler?.playing&&judge){
        const beat=detector.tryFire(dx,dy,mx,my);
        if(beat!==null){
          const result=judge.onGesture(beat);
          if(result==='hit1')  {flashOverlay(80,216,154);}
          else if(result==='bonus') {flashOverlay(80,160,255);}
          else if(result==='wrong1'){flashOverlay(224,82,82);}
          if(result!=='ignored')updateScoreUI();
        }
        judge.checkMisses(()=>{
          flashOverlay(224,82,82);
         
          updateScoreUI();
        });
      }
    } else {
      prevIx=prevIy=null;trail=[];
    }

    // Beat bar (top) + Arrow cue (bottom)
    if(scheduler?.playing){
      const metroBeat=_prevBeatMs>0?_currentBeatNum:detector.expected;
      drawBeatBar(ctx,W,metroBeat,currentTS,beatProgress);
      drawArrowCue(ctx,W,H,metroBeat,currentTS,beatProgress);
    }

    // (scheduler.update handled by the independent rAF loop above)

    // Guide highlight
    highlightGuide(_prevBeatMs>0?_currentBeatNum:detector.expected);

    // Floating score HUD
    if(judge?.lastResult&&performance.now()-judge.lastResultTime<800){
      const age=performance.now()-judge.lastResultTime;
      const alpha=Math.max(0,1-age/800);
      const r=judge.lastResult;
      if(r!=='ignored'){
        const CM={hit1:'80,216,154',bonus:'80,160,255',wrong1:'224,82,82',miss1:'224,82,82'};
        const TM={hit1:'✓ BEAT 1',  bonus:'✦ BONUS',   wrong1:'✗ BEAT 1',miss1:'◯ MISSED'};
        const DM={hit1:'+5',        bonus:'+1',         wrong1:'−2',     miss1:'−2'};
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
  camera.start().catch(()=>alert('Camera permission is required. Please allow and reload.'));
}


// ═══════════════════════════════════════════
//  KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════
document.addEventListener('keydown',e=>{
  if(e.key==='r'||e.key==='R'){
    if(scheduler){scheduler.reset();startCountdown();}
    if(judge){judge.reset();updateScoreUI();}
    detector.reset();prevIx=prevIy=null;trail=[];
    _prevBeatMs=0;_nextBeatMs=0;_currentBeatNum=1;_nextBeatNum=1;
  }else if(e.key==='m'||e.key==='M'){
    if(scheduler)scheduler.muted=!scheduler.muted;
  }else if(e.key==='+'||e.key==='='){
    const s=document.getElementById('sensSlider');
    s.value=Math.max(30,+s.value-10);onSensChange(s.value);
  }else if(e.key==='-'||e.key==='_'){
    const s=document.getElementById('sensSlider');
    s.value=Math.min(150,+s.value+10);onSensChange(s.value);
  }else if(e.key==='l'||e.key==='L'){
    toggleTheme();
  }
});

// =========================================================
// EMOJI ESCAPE — core engine
// =========================================================
(function(){
"use strict";

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

let DPR = Math.min(window.devicePixelRatio || 1, 2.5);
let VW = 0, VH = 0; // logical (CSS) pixels

function resize(){
  const rect = canvas.parentElement.getBoundingClientRect();
  VW = rect.width; VH = rect.height;
  canvas.width = Math.round(VW * DPR);
  canvas.height = Math.round(VH * DPR);
  canvas.style.width = VW + 'px';
  canvas.style.height = VH + 'px';
  ctx.setTransform(DPR,0,0,DPR,0,0);
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------
// Utility
// ---------------------------------------------------------
const TAU = Math.PI * 2;
function rand(a,b){ return a + Math.random()*(b-a); }
function randInt(a,b){ return Math.floor(rand(a,b+1)); }
function choice(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function lerp(a,b,t){ return a + (b-a)*t; }
function dist2(x1,y1,x2,y2){ const dx=x2-x1, dy=y2-y1; return dx*dx+dy*dy; }
function dist(x1,y1,x2,y2){ return Math.sqrt(dist2(x1,y1,x2,y2)); }
function angleTo(x1,y1,x2,y2){ return Math.atan2(y2-y1, x2-x1); }
function easeOutCubic(t){ return 1 - Math.pow(1-t, 3); }
function easeOutBack(t){ const c1=1.70158, c3=c1+1; return 1 + c3*Math.pow(t-1,3) + c1*Math.pow(t-1,2); }

function uid(){ return Math.random().toString(36).slice(2,10); }

// ---------------------------------------------------------
// Persistent storage (localStorage) — best-effort, falls back to memory
// ---------------------------------------------------------
const Store = (function(){
  let memFallback = {};
  let ok = true;
  try{
    localStorage.setItem('__ee_test__','1');
    localStorage.removeItem('__ee_test__');
  }catch(e){ ok = false; }

  function get(key, def){
    try{
      if(!ok) return (key in memFallback) ? memFallback[key] : def;
      const v = localStorage.getItem('ee_'+key);
      return v === null ? def : JSON.parse(v);
    }catch(e){ return def; }
  }
  function set(key, val){
    try{
      if(!ok){ memFallback[key] = val; return; }
      localStorage.setItem('ee_'+key, JSON.stringify(val));
    }catch(e){ /* ignore */ }
  }
  return { get, set };
})();

// ---------------------------------------------------------
// Persistent game data
// ---------------------------------------------------------
const Profile = {
  bestTime: Store.get('bestTime', 0),
  totalCoins: Store.get('totalCoins', 0),
  bestCombo: Store.get('bestCombo', 0),
  achievements: Store.get('achievements', {}),
  cosmetics: Store.get('cosmetics', {
    skins: ['classic'], glows: ['cyan'], trails: ['none'], themes: ['cyber']
  }),
  equipped: Store.get('equipped', {
    skin:'classic', glow:'cyan', trail:'none', theme:'cyber'
  }),
  leaderboard: Store.get('leaderboard', []), // {name, time, coins, date}
  stats: Store.get('stats', { totalRuns:0, totalCoinsEver:0, bossesDefeated:{}, noDamageRuns:0, nearMisses:0 }),
  settings: Store.get('settings', { sound:true, shake:true, reduced:false }),
  lastDailySeed: Store.get('lastDailySeed', ''),
};

function saveProfile(){
  Store.set('bestTime', Profile.bestTime);
  Store.set('totalCoins', Profile.totalCoins);
  Store.set('bestCombo', Profile.bestCombo);
  Store.set('achievements', Profile.achievements);
  Store.set('cosmetics', Profile.cosmetics);
  Store.set('equipped', Profile.equipped);
  Store.set('leaderboard', Profile.leaderboard);
  Store.set('stats', Profile.stats);
  Store.set('settings', Profile.settings);
}

// ---------------------------------------------------------
// Input
// ---------------------------------------------------------
const Input = {
  keys: {},
  pointerActive: false,
  pointerX: 0, pointerY: 0,
  targetX: 0, targetY: 0,
  useTouch: false,
};

window.addEventListener('keydown', e=>{
  Input.keys[e.key.toLowerCase()] = true;
  if(['arrowup','arrowdown','arrowleft','arrowright',' '].includes(e.key.toLowerCase())) e.preventDefault();
  if(e.key.toLowerCase() === 'p' || e.key === 'Escape'){ Game.togglePause(); }
}, {passive:false});
window.addEventListener('keyup', e=>{ Input.keys[e.key.toLowerCase()] = false; });

function getCanvasPos(clientX, clientY){
  const rect = canvas.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

canvas.addEventListener('pointerdown', e=>{
  Input.useTouch = true;
  Input.pointerActive = true;
  const p = getCanvasPos(e.clientX, e.clientY);
  Input.pointerX = p.x; Input.pointerY = p.y;
  Input.targetX = p.x; Input.targetY = p.y;
});
window.addEventListener('pointermove', e=>{
  if(!Input.pointerActive) return;
  const p = getCanvasPos(e.clientX, e.clientY);
  Input.pointerX = p.x; Input.pointerY = p.y;
  Input.targetX = p.x; Input.targetY = p.y;
});
window.addEventListener('pointerup', ()=>{ Input.pointerActive = false; });
window.addEventListener('pointercancel', ()=>{ Input.pointerActive = false; });

// ---------------------------------------------------------
// Lightweight audio (WebAudio synthesized — no external assets)
// ---------------------------------------------------------
const Audio_ = (function(){
  let actx = null;
  let musicGain = null, sfxGain = null;
  let musicIntensity = 0;
  let musicNodes = [];
  let musicTimer = null;
  let started = false;

  function ensure(){
    if(actx) return;
    try{
      actx = new (window.AudioContext || window.webkitAudioContext)();
      musicGain = actx.createGain(); musicGain.gain.value = 0.18;
      musicGain.connect(actx.destination);
      sfxGain = actx.createGain(); sfxGain.gain.value = 0.5;
      sfxGain.connect(actx.destination);
    }catch(e){ actx = null; }
  }

  function enabled(){ return Profile.settings.sound && actx; }

  function tone(freq, dur, type, vol, gainNode, when, glide){
    if(!enabled()) return;
    const t0 = actx.currentTime + (when||0);
    const osc = actx.createOscillator();
    const g = actx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if(glide) osc.frequency.exponentialRampToValueAtTime(Math.max(1,glide), t0+dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0+0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t0+dur);
    osc.connect(g); g.connect(gainNode||sfxGain);
    osc.start(t0); osc.stop(t0+dur+0.02);
  }

  function noiseBurst(dur, vol, gainNode, when){
    if(!enabled()) return;
    const t0 = actx.currentTime + (when||0);
    const bufferSize = actx.sampleRate * dur;
    const buffer = actx.createBuffer(1, bufferSize, actx.sampleRate);
    const data = buffer.getChannelData(0);
    for(let i=0;i<bufferSize;i++) data[i] = (Math.random()*2-1) * (1 - i/bufferSize);
    const src = actx.createBufferSource();
    src.buffer = buffer;
    const g = actx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0+dur);
    src.connect(g); g.connect(gainNode||sfxGain);
    src.start(t0);
  }

  const sfx = {
    hit(){ ensure(); tone(120,0.18,'sawtooth',0.5,sfxGain,0,60); noiseBurst(0.12,0.25); },
    coin(){ ensure(); tone(880,0.08,'square',0.18,sfxGain,0); tone(1320,0.09,'square',0.14,sfxGain,0.04); },
    powerup(){ ensure(); tone(440,0.1,'triangle',0.2,sfxGain,0); tone(660,0.1,'triangle',0.2,sfxGain,0.08); tone(880,0.14,'triangle',0.22,sfxGain,0.16); },
    nearMiss(){ ensure(); tone(300,0.12,'sine',0.12,sfxGain,0,900); },
    explosion(){ ensure(); noiseBurst(0.4,0.4); tone(80,0.4,'sawtooth',0.35,sfxGain,0,30); },
    laserWarn(){ ensure(); tone(200,0.5,'sawtooth',0.08,sfxGain,0,260); },
    laserFire(){ ensure(); noiseBurst(0.15,0.35); tone(900,0.1,'square',0.18,sfxGain,0,200); },
    teleport(){ ensure(); tone(1200,0.18,'sine',0.16,sfxGain,0,200); },
    death(){ ensure(); tone(220,0.6,'sawtooth',0.3,sfxGain,0,40); noiseBurst(0.5,0.3,sfxGain,0.05); },
    bossWarn(){ ensure(); tone(110,0.8,'sawtooth',0.25,sfxGain,0,90); },
    bossDefeat(){ ensure(); [0,0.1,0.2,0.3].forEach((t,i)=>tone(440*(1+i*0.5),0.3,'triangle',0.25,sfxGain,t)); },
    combo(){ ensure(); tone(660,0.07,'square',0.12,sfxGain,0); },
    select(){ ensure(); tone(500,0.06,'sine',0.15,sfxGain,0); },
    lightning(){ ensure(); noiseBurst(0.3,0.4); tone(1500,0.2,'sawtooth',0.2,sfxGain,0,100); },
  };

  function startMusic(){
    ensure();
    if(!actx || started) return;
    started = true;
    scheduleMusic();
  }
  function setIntensity(v){ musicIntensity = clamp(v,0,1); }

  let nextNoteTime = 0;
  function scheduleMusic(){
    if(!enabled()){ musicTimer = setTimeout(scheduleMusic, 300); return; }
    const bpm = lerp(96, 168, musicIntensity);
    const beat = 60/bpm;
    const bass = [55,55,82,73];
    const idx = Math.floor(performance.now()/1000) % bass.length;
    tone(bass[idx % bass.length], beat*0.9, 'triangle', 0.1 + musicIntensity*0.08, musicGain, 0);
    if(musicIntensity > 0.3){
      tone(bass[idx % bass.length]*2, beat*0.3, 'square', 0.04, musicGain, beat*0.5);
    }
    musicTimer = setTimeout(scheduleMusic, beat*1000);
  }

  return { sfx, startMusic, setIntensity, ensure };
})();

// expose minimal globals used across files
window.EE = {
  ctx, canvas, get VW(){return VW;}, get VH(){return VH;},
  rand, randInt, choice, clamp, lerp, dist, dist2, angleTo, easeOutCubic, easeOutBack, TAU, uid,
  Input, Store, Profile, saveProfile, Audio: Audio_,
};

})();

// =========================================================
// ENTITIES
// =========================================================
(function(){
"use strict";
const { ctx, rand, randInt, choice, clamp, lerp, dist, dist2, angleTo, easeOutCubic, easeOutBack, TAU, uid, Audio, Profile } = window.EE;

// ---------------------------------------------------------
// Particle system (pooled)
// ---------------------------------------------------------
const PARTICLE_POOL_SIZE = 600;
const particles = [];
for(let i=0;i<PARTICLE_POOL_SIZE;i++){
  particles.push({active:false,x:0,y:0,vx:0,vy:0,life:0,maxLife:1,size:2,color:'#fff',glow:0,gravity:0,fade:true,shape:'circle',text:null,rot:0,vrot:0});
}
let particleCursor = 0;
function spawnParticle(opts){
  let p = null;
  for(let i=0;i<PARTICLE_POOL_SIZE;i++){
    const idx = (particleCursor+i) % PARTICLE_POOL_SIZE;
    if(!particles[idx].active){ p = particles[idx]; particleCursor = idx; break; }
  }
  if(!p){ p = particles[particleCursor]; particleCursor = (particleCursor+1)%PARTICLE_POOL_SIZE; }
  Object.assign(p, {active:true, life:0, maxLife:1, gravity:0, fade:true, shape:'circle', text:null, rot:0, vrot:0}, opts);
  return p;
}
function burst(x,y,count,opts){
  opts = opts || {};
  for(let i=0;i<count;i++){
    const a = rand(0,TAU);
    const sp = rand(opts.minSpeed||40, opts.maxSpeed||180);
    spawnParticle({
      x, y, vx:Math.cos(a)*sp, vy:Math.sin(a)*sp,
      maxLife: rand(opts.minLife||0.3, opts.maxLife||0.8),
      size: rand(opts.minSize||2, opts.maxSize||5),
      color: opts.color || '#fff',
      glow: opts.glow||0, gravity: opts.gravity||0,
      shape: opts.shape || 'circle',
    });
  }
}
function floatText(x,y,text,color,size){
  spawnParticle({x,y,vx:rand(-10,10),vy:-rand(40,70),maxLife:0.9,size:size||16,color:color||'#fff',shape:'text',text,gravity:-20,fade:true});
}
function updateParticles(dt){
  for(let i=0;i<PARTICLE_POOL_SIZE;i++){
    const p = particles[i];
    if(!p.active) continue;
    p.life += dt;
    if(p.life >= p.maxLife){ p.active=false; continue; }
    p.vy += p.gravity*dt;
    p.x += p.vx*dt; p.y += p.vy*dt;
    p.vx *= (1 - Math.min(1,dt*1.5));
    p.rot += p.vrot*dt;
  }
}
function drawParticles(){
  for(let i=0;i<PARTICLE_POOL_SIZE;i++){
    const p = particles[i];
    if(!p.active) continue;
    const t = p.life/p.maxLife;
    const alpha = p.fade ? (1-t) : 1;
    ctx.save();
    ctx.globalAlpha = clamp(alpha,0,1);
    if(p.shape === 'text'){
      ctx.font = `900 ${p.size}px system-ui, sans-serif`;
      ctx.fillStyle = p.color;
      ctx.textAlign = 'center';
      ctx.shadowColor = p.color; ctx.shadowBlur = 8;
      ctx.fillText(p.text, p.x, p.y);
    } else if(p.shape === 'spark'){
      ctx.strokeStyle = p.color; ctx.lineWidth = p.size*0.5;
      ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(p.x-p.vx*0.04, p.y-p.vy*0.04); ctx.stroke();
    } else {
      if(p.glow){ ctx.shadowColor = p.color; ctx.shadowBlur = p.glow; }
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x,p.y, p.size*(1-t*0.3), 0, TAU); ctx.fill();
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------
// Player
// ---------------------------------------------------------
class Player{
  constructor(){
    this.x = 0; this.y = 0;
    this.vx = 0; this.vy = 0;
    this.radius = 14;
    this.baseRadius = 14;
    this.maxSpeed = 320;
    this.lives = 3;
    this.maxLives = 5;
    this.invuln = 0;
    this.slowTimer = 0;
    this.shieldHits = 0;
    this.speedBoostTimer = 0;
    this.freezeAuraTimer = 0;
    this.magnetTimer = 0;
    this.ghostModeTimer = 0;
    this.invincibleTimer = 0;
    this.sizeMod = 1;
    this.sizeModTimer = 0;
    this.trailTimer = 0;
    this.damagedThisRun = false;
    this.angle = 0;
  }
  get effectiveRadius(){ return this.baseRadius * this.sizeMod; }
  get isInvincible(){ return this.invincibleTimer>0 || this.invuln>0; }
  get speedMultiplier(){
    let m = 1;
    if(this.slowTimer>0) m *= 0.5;
    if(this.speedBoostTimer>0) m *= 2;
    if(this.sizeMod>1.3) m *= 1.15;
    if(this.sizeMod<0.8) m *= 1.05;
    return m;
  }
  update(dt, input, vw, vh){
    let dx=0, dy=0;
    if(input.useTouch && input.pointerActive){
      dx = input.targetX - this.x; dy = input.targetY - this.y;
      const d = Math.hypot(dx,dy);
      if(d>4){ dx/=d; dy/=d; } else { dx=0; dy=0; }
    } else {
      if(input.keys['w']||input.keys['arrowup']) dy -= 1;
      if(input.keys['s']||input.keys['arrowdown']) dy += 1;
      if(input.keys['a']||input.keys['arrowleft']) dx -= 1;
      if(input.keys['d']||input.keys['arrowright']) dx += 1;
      const d = Math.hypot(dx,dy);
      if(d>0){ dx/=d; dy/=d; }
    }
    const sm = this.speedMultiplier;
    const targetVx = dx * this.maxSpeed * sm;
    const targetVy = dy * this.maxSpeed * sm;
    const k = 1 - Math.exp(-dt*10);
    this.vx = lerp(this.vx, targetVx, k);
    this.vy = lerp(this.vy, targetVy, k);

    this.x += this.vx*dt;
    this.y += this.vy*dt;

    const r = this.effectiveRadius;
    this.x = clamp(this.x, r, vw-r);
    this.y = clamp(this.y, r, vh-r);

    if(Math.hypot(this.vx,this.vy) > 5){
      this.angle = Math.atan2(this.vy, this.vx);
    }

    if(this.invuln>0) this.invuln -= dt;
    if(this.slowTimer>0) this.slowTimer -= dt;
    if(this.speedBoostTimer>0) this.speedBoostTimer -= dt;
    if(this.freezeAuraTimer>0) this.freezeAuraTimer -= dt;
    if(this.magnetTimer>0) this.magnetTimer -= dt;
    if(this.ghostModeTimer>0) this.ghostModeTimer -= dt;
    if(this.invincibleTimer>0) this.invincibleTimer -= dt;
    if(this.sizeModTimer>0){ this.sizeModTimer -= dt; if(this.sizeModTimer<=0) this.sizeMod = 1; }

    this.trailTimer += dt;
  }
  takeHit(){
    if(this.isInvincible || this.ghostModeTimer>0) return false;
    if(this.shieldHits>0){ this.shieldHits--; this.invuln = 0.3; return false; }
    this.lives--;
    this.invuln = 1.0;
    this.damagedThisRun = true;
    return true;
  }
  draw(equipped){
    const r = this.effectiveRadius;
    const blinking = this.invuln>0 && Math.floor(this.invuln*12)%2===0;
    if(blinking) return;

    ctx.save();
    const glowColors = {
      cyan:'#5ef0ff', magenta:'#ff5ec4', gold:'#ffd23f', green:'#39ff9d', violet:'#b388ff', red:'#ff5c5c'
    };
    let glowColor = glowColors[equipped.glow] || '#5ef0ff';
    if(this.invincibleTimer>0){
      const hue = (performance.now()/5)%360;
      glowColor = `hsl(${hue},100%,65%)`;
    }
    if(this.ghostModeTimer>0){ ctx.globalAlpha = 0.45; }

    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 22;
    const grad = ctx.createRadialGradient(this.x,this.y,0,this.x,this.y,r*2.2);
    grad.addColorStop(0, glowColor+'cc');
    grad.addColorStop(1, glowColor+'00');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(this.x,this.y,r*2.2,0,TAU); ctx.fill();

    if(this.shieldHits>0){
      ctx.shadowBlur = 14;
      ctx.strokeStyle = 'rgba(94,240,255,0.8)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(this.x,this.y,r+8,0,TAU); ctx.stroke();
    }

    ctx.shadowBlur = 14;
    let coreColor = '#ffffff';
    if(equipped.skin === 'fire') coreColor = '#fff1d6';
    if(equipped.skin === 'ice') coreColor = '#e3fbff';
    if(equipped.skin === 'galaxy') coreColor = '#f0e8ff';
    ctx.fillStyle = coreColor;
    ctx.beginPath(); ctx.arc(this.x,this.y,r,0,TAU); ctx.fill();

    ctx.shadowBlur = 0;
    ctx.fillStyle = glowColor;
    ctx.globalAlpha *= 0.5;
    ctx.beginPath(); ctx.arc(this.x - r*0.25, this.y - r*0.25, r*0.4, 0, TAU); ctx.fill();

    ctx.restore();
  }
}

// ---------------------------------------------------------
// Enemy definitions
// ---------------------------------------------------------
const ENEMY_DEFS = {
  normal:    { glyph:'😀', speed:70,  radius:16, score:1,  weight:30, minTime:0 },
  crazy:     { glyph:'😂', speed:110, radius:16, score:2,  weight:18, minTime:5 },
  angry:     { glyph:'😡', speed:130, radius:16, score:3,  weight:14, minTime:10 },
  sleep:     { glyph:'😴', speed:55,  radius:16, score:2,  weight:10, minTime:8 },
  poison:    { glyph:'🤢', speed:65,  radius:16, score:3,  weight:10, minTime:15 },
  ghost:     { glyph:'👻', speed:90,  radius:16, score:3,  weight:9,  minTime:20 },
  explosive: { glyph:'🤯', speed:95,  radius:17, score:4,  weight:9,  minTime:18 },
  devil:     { glyph:'😈', speed:100, radius:16, score:3,  weight:8,  minTime:25 },
  freeze:    { glyph:'🥶', speed:50,  radius:17, score:3,  weight:7,  minTime:22 },
  love:      { glyph:'😍', speed:60,  radius:16, score:3,  weight:6,  minTime:30 },
  robot:     { glyph:'🤖', speed:45,  radius:17, score:5,  weight:6,  minTime:35 },
  alien:     { glyph:'👽', speed:80,  radius:16, score:5,  weight:5,  minTime:40 },
  skull:     { glyph:'💀', speed:230, radius:15, score:8,  weight:1.5, minTime:45 },
};
const RARE_DEFS = {
  heart:   { glyph:'❤️', weight:5 },
  star:    { glyph:'⭐', weight:5 },
  diamond: { glyph:'💎', weight:6 },
  clover:  { glyph:'🍀', weight:4 },
  fire:    { glyph:'🔥', weight:3 },
  lightning:{ glyph:'⚡', weight:2 },
};

let enemyIdSeq = 1;
class Enemy{
  constructor(type, x, y){
    this.id = enemyIdSeq++;
    this.type = type;
    const def = ENEMY_DEFS[type];
    this.glyph = def.glyph;
    this.baseSpeed = def.speed;
    this.radius = def.radius;
    this.score = def.score;
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.alive = true;
    this.age = 0;
    this.flashT = 0;
    this.scale = 0;
    this.zigT = rand(0,10);
    this.lockTimer = rand(0,2);
    this.lockDirX = 0; this.lockDirY = 0;
    this.visible = true;
    this.ghostTimer = rand(1.5,3);
    this.explodeT = 0; this.exploding = false; this.exploded = false;
    this.trailTick = 0;
    this.devilSplit = false;
    this.isSplitChild = false;
    this.freezeFieldR = 70;
    this.attractRange = 130;
    this.laserState = 'idle';
    this.laserT = 0; this.laserAngle = 0;
    this.teleportT = rand(1.5,3);
    this.teleportFlash = 0;
    this.hue = 0;
    this.knockX = 0; this.knockY = 0;
  }
  get effRadius(){ return this.radius * this.scale; }
}

let pickupIdSeq = 1;
class Pickup{
  constructor(type, x, y){
    this.id = pickupIdSeq++;
    this.type = type;
    this.glyph = (RARE_DEFS[type] && RARE_DEFS[type].glyph) || '❓';
    this.x = x; this.y = y;
    this.radius = 15;
    this.alive = true;
    this.age = 0;
    this.scale = 0;
    this.bob = rand(0,TAU);
  }
}

class Coin{
  constructor(x,y,value){
    this.x=x;this.y=y; this.value=value||1;
    this.alive=true; this.age=0; this.scale=0;
    this.vx = rand(-60,60); this.vy = rand(-60,60);
  }
}

class TrailPuddle{
  constructor(x,y){ this.x=x;this.y=y; this.life=5; this.maxLife=5; this.radius=14; this.alive=true; }
}
class ExplosionZone{
  constructor(x,y,radius,life){ this.x=x;this.y=y;this.radius=radius; this.life=life||0.35; this.maxLife=this.life; this.alive=true; this.damaged=false; }
}

window.EE.Entities = {
  particles, spawnParticle, burst, floatText, updateParticles, drawParticles,
  Player, Enemy, Pickup, Coin, TrailPuddle, ExplosionZone,
  ENEMY_DEFS, RARE_DEFS,
};

})();

// =========================================================
// BOSSES
// =========================================================
(function(){
"use strict";
const { rand, randInt, choice, clamp, lerp, dist, angleTo, TAU } = window.EE;

const BOSS_DEFS = {
  clown:  { name:'Giant Clown',  glyph:'🤡', hp:80,  speed:55, color:'#ff5ec4' },
  devilking:{ name:'Devil King', glyph:'😈', hp:100, speed:50, color:'#ff3b5c' },
  robotcore:{ name:'Robot Core', glyph:'🤖', hp:110, speed:40, color:'#5ef0ff' },
  alienmother:{name:'Alien Mother',glyph:'👽',hp:90,  speed:60, color:'#39ff9d' },
  deathemoji:{name:'Death Emoji', glyph:'💀', hp:130, speed:80, color:'#ffd23f' },
};
const BOSS_ORDER = ['clown','devilking','robotcore','alienmother','deathemoji'];

class Boss{
  constructor(type, x, y, hpMult){
    const def = BOSS_DEFS[type];
    this.type = type;
    this.name = def.name;
    this.glyph = def.glyph;
    this.color = def.color;
    this.maxHp = Math.round(def.hp * (hpMult||1));
    this.hp = this.maxHp;
    this.speed = def.speed;
    this.x = x; this.y = y;
    this.radius = 42;
    this.alive = true;
    this.age = 0;
    this.scale = 0;
    this.state = 'entering'; // entering, active, dying
    this.actionTimer = rand(1,2);
    this.telegraphs = []; // {type, x,y,r, t, maxT}
    this.projectiles = []; // {x,y,vx,vy,r,glyph}
    this.summons = [];
    this.flashT = 0;
    this.dying = 0;
  }
}

window.EE.Bosses = { BOSS_DEFS, BOSS_ORDER, Boss };

})();

// =========================================================
// GAME — state machine, spawner, update, render orchestration
// =========================================================
(function(){
"use strict";
const EE = window.EE;
const { ctx, canvas, rand, randInt, choice, clamp, lerp, dist, dist2, angleTo, easeOutCubic, easeOutBack, TAU, Input, Audio, Profile, saveProfile } = EE;
const { Player, Enemy, Pickup, Coin, TrailPuddle, ExplosionZone, burst, floatText, updateParticles, drawParticles, ENEMY_DEFS, RARE_DEFS } = EE.Entities;
const { Boss, BOSS_DEFS, BOSS_ORDER } = EE.Bosses;
// Lazy proxy: the UI module loads after this one, so resolve EE.UI at call time, not parse time.
const UI = new Proxy({}, { get(_, prop){ return (...args) => EE.UI[prop](...args); } });

// ---------------------------------------------------------
// Achievements definitions
// ---------------------------------------------------------
const ACHIEVEMENTS = [
  { id:'survive1',  name:'First Minute',   desc:'Survive 1 minute',        icon:'⏱', check: s => s.time >= 60 },
  { id:'survive5',  name:'Marathoner',     desc:'Survive 5 minutes',       icon:'🏃', check: s => s.time >= 300 },
  { id:'coins1000', name:'Coin Collector', desc:'Collect 1000 coins (lifetime)', icon:'💰', check: s => Profile.stats.totalCoinsEver >= 1000 },
  { id:'allbosses', name:'Boss Slayer',    desc:'Defeat every boss type',  icon:'👑', check: s => BOSS_ORDER.every(b => Profile.stats.bossesDefeated[b]) },
  { id:'nearmiss100',name:'Close Calls',   desc:'100 near misses (lifetime)', icon:'💨', check: s => Profile.stats.nearMisses >= 100 },
  { id:'nodamage',  name:'Untouchable',    desc:'Survive 60s without damage', icon:'🛡', check: s => s.time >= 60 && !s.player.damagedThisRun },
  { id:'combo10',   name:'Combo Starter',  desc:'Reach a 10x combo',       icon:'🔥', check: s => s.maxComboThisRun >= 10 },
  { id:'combo50',   name:'Combo Master',   desc:'Reach a 50x combo',       icon:'⚡', check: s => s.maxComboThisRun >= 50 },
  { id:'combo100',  name:'Combo God',      desc:'Reach a 100x combo',      icon:'👑', check: s => s.maxComboThisRun >= 100 },
];

// ---------------------------------------------------------
// Cosmetics catalog
// ---------------------------------------------------------
const COSMETIC_CATALOG = {
  skins: [
    { id:'classic', name:'Classic', cost:0, icon:'⚪' },
    { id:'ghost_glow', name:'Ghost', cost:200, icon:'👻' },
    { id:'galaxy', name:'Galaxy', cost:500, icon:'🌌' },
    { id:'fire', name:'Ember', cost:500, icon:'🔥' },
    { id:'ice', name:'Frost', cost:500, icon:'❄️' },
  ],
  glows: [
    { id:'cyan', name:'Cyan', cost:0, icon:'🔵' },
    { id:'magenta', name:'Magenta', cost:150, icon:'🟣' },
    { id:'gold', name:'Gold', cost:300, icon:'🟡' },
    { id:'green', name:'Green', cost:300, icon:'🟢' },
    { id:'violet', name:'Violet', cost:400, icon:'🟪' },
    { id:'red', name:'Red', cost:400, icon:'🔴' },
  ],
  trails: [
    { id:'none', name:'None', cost:0, icon:'⬛' },
    { id:'spark', name:'Spark', cost:250, icon:'✨' },
    { id:'smoke', name:'Smoke', cost:250, icon:'💨' },
    { id:'rainbow', name:'Rainbow', cost:600, icon:'🌈' },
  ],
  themes: [
    { id:'cyber', name:'Cyber City', cost:0, icon:'🌃' },
    { id:'space', name:'Outer Space', cost:300, icon:'🪐' },
    { id:'volcano', name:'Volcano', cost:300, icon:'🌋' },
    { id:'ice', name:'Ice Cave', cost:300, icon:'🧊' },
    { id:'ocean', name:'Ocean', cost:300, icon:'🌊' },
  ],
};
const THEME_PALETTES = {
  cyber:   { bg0:'#05060d', bg1:'#0a0e1f', grid:'rgba(94,240,255,0.07)', particle:'#5ef0ff' },
  space:   { bg0:'#04030a', bg1:'#0c0820', grid:'rgba(179,136,255,0.07)', particle:'#b388ff' },
  volcano: { bg0:'#0d0402', bg1:'#1f0a06', grid:'rgba(255,138,63,0.08)', particle:'#ff8a3f' },
  ice:     { bg0:'#020a0d', bg1:'#06181f', grid:'rgba(150,235,255,0.08)', particle:'#96ebff' },
  ocean:   { bg0:'#020a14', bg1:'#04182a', grid:'rgba(63,180,255,0.08)', particle:'#3fb4ff' },
};

// ---------------------------------------------------------
// Daily challenge modifiers
// ---------------------------------------------------------
const DAILY_MODIFIERS = [
  { id:'doublespeed', name:'Double Speed', desc:'All enemies move 2x faster', icon:'💨' },
  { id:'ghostsonly', name:'Ghost Swarm', desc:'Only ghost emojis spawn', icon:'👻' },
  { id:'tinyplayer', name:'Tiny Player', desc:'Your hitbox is tiny', icon:'🔬' },
  { id:'explosive', name:'Powder Keg', desc:'Explosive emojis everywhere', icon:'🤯' },
  { id:'lowgravity', name:'Low Gravity', desc:'Floaty, drifty movement', icon:'🪶' },
  { id:'darkness', name:'Darkness', desc:'Limited visibility radius', icon:'🌑' },
];
function dailySeedString(){
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
}
function dailyModifierForToday(){
  const seed = dailySeedString();
  let h = 0;
  for(let i=0;i<seed.length;i++) h = (h*31 + seed.charCodeAt(i)) >>> 0;
  return DAILY_MODIFIERS[h % DAILY_MODIFIERS.length];
}

// ---------------------------------------------------------
// Game state
// ---------------------------------------------------------
const State = {
  mode: 'menu', // menu, playing, paused, gameover
  time: 0,
  coins: 0,
  combo: 0,
  comboTimer: 0,
  maxComboThisRun: 0,
  player: null,
  enemies: [],
  pickups: [],
  coinsList: [],
  puddles: [],
  explosions: [],
  boss: null,
  bossActive: false,
  nextBossTime: 60,
  bossWarningTimer: 0,
  bossIndex: 0,
  difficultyTier: 0,
  spawnTimer: 0,
  spawnInterval: 1.1,
  shakeAmt: 0,
  shakeT: 0,
  slowMoT: 0,
  flashAlpha: 0,
  flashColor: '#fff',
  powerups: {}, // active powerup states besides player fields
  isDaily: false,
  dailyModifier: null,
  lightningCooldown: 0,
  particlesTheme: 'cyber',
  bgParticles: [],
  gridPulse: 0,
  bossesDefeatedThisRun: [],
};

function resetRunState(){
  State.time = 0;
  State.coins = 0;
  State.combo = 0;
  State.comboTimer = 0;
  State.maxComboThisRun = 0;
  State.enemies = [];
  State.pickups = [];
  State.coinsList = [];
  State.puddles = [];
  State.explosions = [];
  State.boss = null;
  State.bossActive = false;
  State.nextBossTime = 60;
  State.bossWarningTimer = 0;
  State.bossIndex = 0;
  State.difficultyTier = 0;
  State.spawnTimer = 0;
  State.spawnInterval = 1.1;
  State.shakeAmt = 0; State.shakeT = 0;
  State.slowMoT = 0;
  State.flashAlpha = 0;
  State.lightningCooldown = 0;
  State.bossesDefeatedThisRun = [];

  const p = new Player();
  p.x = EE.VW/2; p.y = EE.VH/2;
  State.player = p;

  State.particlesTheme = choice(Object.keys(THEME_PALETTES));
  initBgParticles();
}

function initBgParticles(){
  State.bgParticles = [];
  const count = 36;
  for(let i=0;i<count;i++){
    State.bgParticles.push({
      x: rand(0, EE.VW), y: rand(0, EE.VH),
      vx: rand(-8,8), vy: rand(-8,8),
      size: rand(1,3), tw: rand(0,TAU),
    });
  }
}

// ---------------------------------------------------------
// Weighted pick helper
// ---------------------------------------------------------
function weightedPick(defsObj, filterFn){
  const entries = Object.entries(defsObj).filter(([k,v]) => !filterFn || filterFn(k,v));
  const total = entries.reduce((s,[,v])=>s+v.weight,0);
  let r = rand(0,total);
  for(const [k,v] of entries){
    if(r < v.weight) return k;
    r -= v.weight;
  }
  return entries[0][0];
}

// ---------------------------------------------------------
// Spawning
// ---------------------------------------------------------
function spawnEdgePosition(){
  const vw = EE.VW, vh = EE.VH;
  const side = randInt(0,3);
  const margin = 30;
  if(side===0) return {x:rand(0,vw), y:-margin};
  if(side===1) return {x:vw+margin, y:rand(0,vh)};
  if(side===2) return {x:rand(0,vw), y:vh+margin};
  return {x:-margin, y:rand(0,vh)};
}

function availableEnemyTypes(){
  const t = State.time;
  if(State.isDaily && State.dailyModifier){
    if(State.dailyModifier.id === 'ghostsonly') return ['ghost'];
    if(State.dailyModifier.id === 'explosive'){
      return Object.keys(ENEMY_DEFS).filter(k => ENEMY_DEFS[k].minTime <= t || k==='explosive');
    }
  }
  return Object.keys(ENEMY_DEFS).filter(k => ENEMY_DEFS[k].minTime <= t + 1e-6);
}

function trySpawnEnemy(){
  const types = availableEnemyTypes();
  const defsFiltered = {};
  types.forEach(t => defsFiltered[t] = ENEMY_DEFS[t]);
  let type = weightedPick(defsFiltered);
  if(State.isDaily && State.dailyModifier && State.dailyModifier.id === 'explosive' && Math.random()<0.4){
    type = 'explosive';
  }
  const pos = spawnEdgePosition();
  const e = new Enemy(type, pos.x, pos.y);
  if(State.isDaily && State.dailyModifier && State.dailyModifier.id === 'doublespeed'){
    e.baseSpeed *= 2;
  }
  State.enemies.push(e);
}

function tryRareSpawn(dt){
  // small chance each second-ish to spawn a rare pickup
  if(Math.random() < dt * 0.12 && State.pickups.length < 3){
    const type = weightedPick(RARE_DEFS);
    const margin = 60;
    const x = rand(margin, EE.VW-margin), y = rand(margin, EE.VH-margin);
    State.pickups.push(new Pickup(type, x, y));
  }
}

function dropCoin(x,y,value){
  if(Math.random() < 0.55){
    State.coinsList.push(new Coin(x,y,value||1));
  }
}

// ---------------------------------------------------------
// Difficulty scaling (every 15s)
// ---------------------------------------------------------
function difficultyMultiplier(){
  const tier = Math.floor(State.time/15);
  State.difficultyTier = tier;
  return {
    speedMult: 1 + tier*0.09,
    spawnMult: Math.max(0.28, 1 - tier*0.065),
    varietyTier: tier,
    explosionFreqMult: 1 + tier*0.12,
    bossChanceMult: 1 + tier*0.05,
    shakeMult: 1 + tier*0.08,
    musicIntensity: clamp(tier/14, 0, 1),
  };
}

// ---------------------------------------------------------
// Enemy AI behaviors
// ---------------------------------------------------------
function updateEnemy(e, dt, diff){
  e.age += dt;
  if(e.scale < 1) e.scale = Math.min(1, e.scale + dt*6);
  const p = State.player;
  const speed = e.baseSpeed * diff.speedMult * (e.slowedByFreeze ? 0.4 : 1);

  switch(e.type){
    case 'normal': {
      const a = angleTo(e.x,e.y,p.x,p.y);
      e.vx = Math.cos(a)*speed; e.vy = Math.sin(a)*speed;
      break;
    }
    case 'crazy': {
      e.zigT += dt*5;
      const a = angleTo(e.x,e.y,p.x,p.y) + Math.sin(e.zigT)*1.1;
      e.vx = Math.cos(a)*speed; e.vy = Math.sin(a)*speed;
      break;
    }
    case 'angry': {
      e.lockTimer -= dt;
      if(e.lockTimer <= 0){
        e.lockTimer = 2;
        e.lockDirX = p.x - e.x; e.lockDirY = p.y - e.y;
        const d = Math.hypot(e.lockDirX,e.lockDirY)||1;
        e.lockDirX/=d; e.lockDirY/=d;
      }
      e.vx = e.lockDirX*speed*1.3; e.vy = e.lockDirY*speed*1.3;
      break;
    }
    case 'sleep': {
      const a = angleTo(e.x,e.y,p.x,p.y);
      e.vx = Math.cos(a)*speed*0.8; e.vy = Math.sin(a)*speed*0.8;
      break;
    }
    case 'poison': {
      const a = angleTo(e.x,e.y,p.x,p.y);
      e.vx = Math.cos(a)*speed; e.vy = Math.sin(a)*speed;
      e.trailTick -= dt;
      if(e.trailTick <= 0){
        e.trailTick = 0.25;
        State.puddles.push(new TrailPuddle(e.x,e.y));
      }
      break;
    }
    case 'ghost': {
      e.ghostTimer -= dt;
      if(e.ghostTimer <= 0){
        e.visible = !e.visible;
        e.ghostTimer = e.visible ? rand(2,3.5) : rand(1,2);
      }
      const a = angleTo(e.x,e.y,p.x,p.y);
      e.vx = Math.cos(a)*speed*(e.visible?1:1.3); e.vy = Math.sin(a)*speed*(e.visible?1:1.3);
      break;
    }
    case 'explosive': {
      if(!e.exploding){
        const d = dist(e.x,e.y,p.x,p.y);
        if(d < 150){
          e.exploding = true; e.explodeT = 1.0 * (1/diff.explosionFreqMult);
        } else {
          const a = angleTo(e.x,e.y,p.x,p.y);
          e.vx = Math.cos(a)*speed; e.vy = Math.sin(a)*speed;
        }
      } else {
        e.vx *= 0.85; e.vy *= 0.85;
        e.explodeT -= dt;
        e.flashT += dt*12;
        if(e.explodeT <= 0 && !e.exploded){
          e.exploded = true;
          e.alive = false;
          State.explosions.push(new ExplosionZone(e.x,e.y,95,0.4));
          burst(e.x,e.y,28,{color:'#ff8a3f',minSpeed:80,maxSpeed:320,glow:14,maxLife:0.6});
          Audio.sfx.explosion();
          triggerShake(14);
        }
      }
      break;
    }
    case 'devil': {
      const a = angleTo(e.x,e.y,p.x,p.y);
      e.vx = Math.cos(a)*speed; e.vy = Math.sin(a)*speed;
      if(!e.devilSplit && !e.isSplitChild && e.age > 3 && Math.random() < dt*0.15){
        e.devilSplit = true;
        spawnDevilChildren(e);
      }
      break;
    }
    case 'freeze': {
      const a = angleTo(e.x,e.y,p.x,p.y);
      e.vx = Math.cos(a)*speed*0.7; e.vy = Math.sin(a)*speed*0.7;
      if(dist(e.x,e.y,p.x,p.y) < e.freezeFieldR + p.effectiveRadius){
        p.freezeFieldActive = true;
      }
      break;
    }
    case 'love': {
      const a = angleTo(e.x,e.y,p.x,p.y);
      e.vx = Math.cos(a)*speed*0.6; e.vy = Math.sin(a)*speed*0.6;
      break;
    }
    case 'robot': {
      if(e.laserState==='idle'){
        if(Math.random() < dt*0.25){
          e.laserState='warn'; e.laserT=0.8; e.laserAngle = angleTo(e.x,e.y,p.x,p.y);
          Audio.sfx.laserWarn();
        } else {
          const d = dist(e.x,e.y,p.x,p.y);
          if(d>220){ const a=angleTo(e.x,e.y,p.x,p.y); e.vx=Math.cos(a)*speed; e.vy=Math.sin(a)*speed; }
          else { e.vx*=0.9; e.vy*=0.9; }
        }
      } else if(e.laserState==='warn'){
        e.laserT -= dt;
        e.vx*=0.8; e.vy*=0.8;
        if(e.laserT<=0){ e.laserState='fire'; e.laserT=0.18; Audio.sfx.laserFire(); }
      } else if(e.laserState==='fire'){
        e.laserT -= dt;
        if(e.laserT<=0){ e.laserState='idle'; e.laserT=0; }
      }
      break;
    }
    case 'alien': {
      e.teleportT -= dt;
      if(e.teleportFlash>0) e.teleportFlash -= dt;
      if(e.teleportT <= 0){
        e.teleportT = rand(2,3.5);
        e.teleportFlash = 0.3;
        const pos = spawnEdgePosition();
        e.x = clamp(pos.x, 20, EE.VW-20); e.y = clamp(pos.y, 20, EE.VH-20);
        burst(e.x,e.y,14,{color:'#39ff9d',glow:10,maxLife:0.4});
        Audio.sfx.teleport();
      } else {
        const a = angleTo(e.x,e.y,p.x,p.y);
        e.vx = Math.cos(a)*speed; e.vy = Math.sin(a)*speed;
      }
      break;
    }
    case 'skull': {
      const a = angleTo(e.x,e.y,p.x,p.y);
      e.vx = Math.cos(a)*speed; e.vy = Math.sin(a)*speed;
      break;
    }
  }

  e.x += e.vx*dt; e.y += e.vy*dt;
  // soft clamp to arena with bounce-back if way off-screen too long
  if(e.age > 12 && (e.x<-200||e.x>EE.VW+200||e.y<-200||e.y>EE.VH+200)){
    e.alive = false;
  }
}

function spawnDevilChildren(parent){
  for(let i=0;i<2;i++){
    const c = new Enemy('devil', parent.x+rand(-10,10), parent.y+rand(-10,10));
    c.isSplitChild = true;
    c.baseSpeed = parent.baseSpeed * 1.4;
    c.radius = parent.radius*0.7;
    c.scale = 1;
    State.enemies.push(c);
  }
  burst(parent.x,parent.y,16,{color:'#ff3b5c',glow:10,maxLife:0.4});
}

// ---------------------------------------------------------
// Love attraction (cluster nearby enemies toward love emoji)
// ---------------------------------------------------------
function applyLoveAttraction(dt){
  for(const love of State.enemies){
    if(love.type!=='love' || !love.alive) continue;
    for(const e of State.enemies){
      if(e===love || !e.alive) continue;
      const d = dist(e.x,e.y,love.x,love.y);
      if(d < love.attractRange && d>1){
        const a = angleTo(e.x,e.y,love.x,love.y);
        e.x += Math.cos(a)*40*dt;
        e.y += Math.sin(a)*40*dt;
      }
    }
  }
}

// ---------------------------------------------------------
// Freeze field application
// ---------------------------------------------------------
function applyFreezeFields(){
  for(const e of State.enemies) e.slowedByFreeze = false;
  for(const f of State.enemies){
    if(f.type!=='freeze' || !f.alive) continue;
    for(const e of State.enemies){
      if(e===f || !e.alive) continue;
      if(dist(e.x,e.y,f.x,f.y) < f.freezeFieldR) e.slowedByFreeze = true;
    }
  }
}

// ---------------------------------------------------------
// Combo / near miss system
// ---------------------------------------------------------
const NEAR_MISS_RADIUS_BONUS = 26;
function checkNearMisses(dt){
  const p = State.player;
  for(const e of State.enemies){
    if(!e.alive || e.nearMissChecked) continue;
    const d = dist(e.x,e.y,p.x,p.y);
    const threshold = p.effectiveRadius + e.radius*e.scale + NEAR_MISS_RADIUS_BONUS;
    if(d < threshold && d > p.effectiveRadius + e.radius*e.scale){
      // moving away after being close counts; simplistic: flag once enemy passes near
      e.wasNear = true;
    }
    if(e.wasNear && d > threshold + 30){
      e.nearMissChecked = true;
      registerNearMiss();
    }
  }
}
function registerNearMiss(){
  Profile.stats.nearMisses = (Profile.stats.nearMisses||0) + 1;
  addCombo(1);
  Audio.sfx.nearMiss();
  flashScreen('#5ef0ff', 0.08);
  UI.toast('Near Miss!');
}
function addCombo(n){
  State.combo += n;
  State.comboTimer = 3.2;
  State.maxComboThisRun = Math.max(State.maxComboThisRun, State.combo);
  if(State.combo>0 && State.combo % 10 === 0) Audio.sfx.combo();
  UI.pulseCombo();
}

// ---------------------------------------------------------
// Screen shake / flash helpers
// ---------------------------------------------------------
function triggerShake(amt){
  if(!Profile.settings.shake) return;
  State.shakeAmt = Math.max(State.shakeAmt, amt);
  State.shakeT = 0.35;
}
function flashScreen(color, intensity){
  State.flashColor = color;
  State.flashAlpha = Math.max(State.flashAlpha, intensity);
}

// ---------------------------------------------------------
// Boss spawning & update
// ---------------------------------------------------------
function maybeTriggerBoss(){
  if(State.bossActive || State.boss) return;
  if(State.time >= State.nextBossTime){
    State.bossWarningTimer = 2.2;
    State.bossActive = true; // lock further triggers while warning/active
  }
}
function spawnBoss(){
  const type = BOSS_ORDER[State.bossIndex % BOSS_ORDER.length];
  const cycles = Math.floor(State.bossIndex / BOSS_ORDER.length);
  const hpMult = 1 + cycles*0.5;
  const b = new Boss(type, EE.VW/2, -80, hpMult);
  State.boss = b;
  Audio.sfx.bossWarn();
  UI.showBossBar(b);
}
function updateBoss(b, dt, diff){
  b.age += dt;
  if(b.scale<1) b.scale = Math.min(1, b.scale+dt*1.2);
  const p = State.player;
  if(b.flashT>0) b.flashT -= dt;

  if(b.state==='entering'){
    b.y += 70*dt;
    if(b.y > 110) b.state = 'active';
    return;
  }
  if(b.state==='dying'){
    b.dying += dt;
    return;
  }

  // movement: drift toward a point near player but keep distance
  const targetX = clamp(p.x + Math.sin(b.age*0.5)*150, b.radius, EE.VW-b.radius);
  const targetY = clamp(120 + Math.sin(b.age*0.3)*40, b.radius, EE.VH*0.5);
  b.x = lerp(b.x, targetX, dt*0.6);
  b.y = lerp(b.y, targetY, dt*0.6);

  b.actionTimer -= dt;
  if(b.actionTimer <= 0){
    bossAction(b, diff);
    b.actionTimer = rand(1.4, 2.4) / Math.sqrt(diff.speedMult);
  }

  // update telegraphs -> projectiles/damage
  for(let i=b.telegraphs.length-1;i>=0;i--){
    const t = b.telegraphs[i];
    t.t += dt;
    if(t.t >= t.maxT){
      executeTelegraph(b, t);
      b.telegraphs.splice(i,1);
    }
  }
  // update projectiles
  for(let i=b.projectiles.length-1;i>=0;i--){
    const pr = b.projectiles[i];
    pr.x += pr.vx*dt; pr.y += pr.vy*dt; pr.age += dt;
    if(dist(pr.x,pr.y,p.x,p.y) < p.effectiveRadius + pr.r && !pr.hit){
      pr.hit = true;
      onPlayerHit();
    }
    if(pr.age > 4 || pr.x<-50||pr.x>EE.VW+50||pr.y<-50||pr.y>EE.VH+50){
      b.projectiles.splice(i,1);
    }
  }
}
function bossAction(b, diff){
  switch(b.type){
    case 'clown': {
      // throw laughing emoji projectiles in a spread
      const a0 = angleTo(b.x,b.y,State.player.x,State.player.y);
      for(let i=-1;i<=1;i++){
        const a = a0 + i*0.35;
        b.projectiles.push({x:b.x,y:b.y,vx:Math.cos(a)*210,vy:Math.sin(a)*210,r:14,age:0,glyph:'😂'});
      }
      Audio.sfx.laserFire();
      break;
    }
    case 'devilking': {
      for(let i=0;i<2;i++){
        const e = new Enemy('devil', b.x+rand(-30,30), b.y+rand(-30,30));
        e.isSplitChild = true; e.scale = 1; e.baseSpeed *= 1.1;
        State.enemies.push(e);
      }
      burst(b.x,b.y,18,{color:'#ff3b5c',glow:12});
      break;
    }
    case 'robotcore': {
      b.telegraphs.push({type:'beam', angle:angleTo(b.x,b.y,State.player.x,State.player.y), t:0, maxT:0.7});
      Audio.sfx.laserWarn();
      break;
    }
    case 'alienmother': {
      const pos = spawnEdgePosition();
      b.x = clamp(pos.x, b.radius, EE.VW-b.radius);
      b.y = clamp(rand(80,200), b.radius, EE.VH-b.radius);
      burst(b.x,b.y,20,{color:'#39ff9d',glow:12});
      Audio.sfx.teleport();
      // create a portal hazard
      b.telegraphs.push({type:'portal', x:rand(60,EE.VW-60), y:rand(60,EE.VH-60), t:0, maxT:1.0});
      break;
    }
    case 'deathemoji': {
      b.telegraphs.push({type:'bigexplosion', x:State.player.x, y:State.player.y, t:0, maxT:0.9});
      break;
    }
  }
}
function executeTelegraph(b, t){
  if(t.type==='beam'){
    const len = 1200;
    const x2 = b.x + Math.cos(t.angle)*len, y2 = b.y + Math.sin(t.angle)*len;
    const p = State.player;
    const d = pointLineDistance(p.x,p.y,b.x,b.y,x2,y2);
    if(d < p.effectiveRadius + 16) onPlayerHit();
    Audio.sfx.laserFire();
    triggerShake(8);
    b.beamFlash = 0.2;
  } else if(t.type==='portal'){
    State.explosions.push(new ExplosionZone(t.x,t.y,70,0.5));
  } else if(t.type==='bigexplosion'){
    State.explosions.push(new ExplosionZone(t.x,t.y,140,0.5));
    burst(t.x,t.y,40,{color:'#ffd23f',minSpeed:100,maxSpeed:380,glow:16,maxLife:0.7});
    Audio.sfx.explosion();
    triggerShake(20);
  }
}
function pointLineDistance(px,py,x1,y1,x2,y2){
  const A = px-x1, B = py-y1, C = x2-x1, D = y2-y1;
  const dot = A*C+B*D, lenSq = C*C+D*D;
  let t = lenSq ? dot/lenSq : 0;
  t = clamp(t,0,1);
  const xx = x1+t*C, yy = y1+t*D;
  return dist(px,py,xx,yy);
}

function damageBoss(amount){
  if(!State.boss) return;
  State.boss.hp -= amount;
  State.boss.flashT = 0.15;
  UI.updateBossBar(State.boss);
  if(State.boss.hp <= 0 && State.boss.state!=='dying'){
    State.boss.state='dying';
    State.boss.dying = 0;
    onBossDefeated(State.boss);
  }
}
function onBossDefeated(b){
  Audio.sfx.bossDefeat();
  triggerShake(18);
  flashScreen('#ffffff', 0.4);
  for(let i=0;i<10;i++){
    setTimeout(()=>{
      if(State.mode!=='playing') return;
      State.coinsList.push(new Coin(b.x+rand(-60,60), b.y+rand(-60,60), 5));
    }, i*60);
  }
  Profile.stats.bossesDefeated[b.type] = true;
  State.bossesDefeatedThisRun.push(b.type);
  State.bossIndex++;
  State.nextBossTime = State.time + 60;
  UI.toast(`${b.name} defeated!`);
  setTimeout(()=>{
    State.boss = null;
    State.bossActive = false;
    UI.hideBossBar();
  }, 900);
}

// ---------------------------------------------------------
// Power-up active states (timers live on player; bomb/magnet are instant or short)
// ---------------------------------------------------------
function activatePowerup(type){
  const p = State.player;
  Audio.sfx.powerup();
  switch(type){
    case 'shield': p.shieldHits = Math.min(3, p.shieldHits+1); UI.toast('Shield Up!'); break;
    case 'speed': p.speedBoostTimer = 6; UI.toast('Speed Boost!'); break;
    case 'freezeTime': for(const e of State.enemies) e.frozenTime = 4; UI.toast('Time Frozen!'); break;
    case 'magnet': p.magnetTimer = 8; UI.toast('Magnet!'); break;
    case 'bomb': {
      for(const e of State.enemies){
        if(e.alive){ burst(e.x,e.y,10,{color:'#ff8a3f',maxLife:0.5}); dropCoin(e.x,e.y,1); }
        e.alive = false;
      }
      triggerShake(16); flashScreen('#ff8a3f',0.3);
      UI.toast('Bomb!');
      break;
    }
    case 'mini': p.sizeMod = 0.6; p.sizeModTimer = 8; UI.toast('Mini Mode!'); break;
    case 'giant': p.sizeMod = 1.6; p.sizeModTimer = 8; UI.toast('Giant Mode!'); break;
    case 'ghostMode': p.ghostModeTimer = 5; UI.toast('Ghost Mode!'); break;
  }
}

// ---------------------------------------------------------
// Rare pickup effects
// ---------------------------------------------------------
function applyRareEffect(type, x, y){
  const p = State.player;
  switch(type){
    case 'heart':
      p.lives = Math.min(p.maxLives, p.lives+1);
      floatText(x,y-10,'+1 LIFE','#ff5c5c',18);
      break;
    case 'star':
      p.invincibleTimer = 6;
      floatText(x,y-10,'INVINCIBLE!','#ffd23f',18);
      break;
    case 'diamond':
      State.coins += 50;
      Profile.stats.totalCoinsEver += 50;
      floatText(x,y-10,'+50 COINS','#ffd23f',18);
      break;
    case 'clover':
      State.scoreMultTimer = 10;
      State.scoreMult = 2;
      floatText(x,y-10,'2x SCORE','#39ff9d',18);
      break;
    case 'fire':
      for(const e of State.enemies){
        if(e.alive && dist(e.x,e.y,x,y) < 220){ e.alive=false; burst(e.x,e.y,14,{color:'#ff8a3f',maxLife:0.5}); dropCoin(e.x,e.y,1); }
      }
      floatText(x,y-10,'BURN!','#ff8a3f',18);
      triggerShake(10);
      break;
    case 'lightning':
      for(const e of State.enemies){
        if(e.alive){ burst(e.x,e.y,8,{color:'#5ef0ff',maxLife:0.4}); dropCoin(e.x,e.y,1); }
        e.alive = false;
      }
      Audio.sfx.lightning();
      flashScreen('#5ef0ff',0.5);
      triggerShake(20);
      floatText(x,y-10,'CLEAR!','#5ef0ff',20);
      break;
  }
  Audio.sfx.powerup();
}

// ---------------------------------------------------------
// Player hit handling
// ---------------------------------------------------------
function onPlayerHit(){
  const p = State.player;
  const hit = p.takeHit();
  if(hit){
    Audio.sfx.hit();
    triggerShake(12);
    flashScreen('#ff3b5c', 0.35);
    State.combo = 0;
    burst(p.x,p.y,16,{color:'#ff3b5c',glow:10,maxLife:0.5});
    if(p.lives <= 0){
      triggerGameOver();
    }
  }
}

// ---------------------------------------------------------
// Game Over
// ---------------------------------------------------------
function triggerGameOver(){
  if(State.mode === 'gameover') return;
  State.mode = 'gameover';
  Audio.sfx.death();
  triggerShake(20);
  State.slowMoT = 0.9;

  const coinsEarned = State.coins;
  Profile.totalCoins += coinsEarned;
  Profile.stats.totalCoinsEver += coinsEarned;
  Profile.stats.totalRuns += 1;
  const isNewBest = State.time > Profile.bestTime;
  if(isNewBest) Profile.bestTime = State.time;
  if(State.maxComboThisRun > Profile.bestCombo) Profile.bestCombo = State.maxComboThisRun;
  if(!State.player.damagedThisRun && State.time>10) Profile.stats.noDamageRuns += 1;

  Profile.leaderboard.push({ name:'You', time:State.time, coins:coinsEarned, date:Date.now() });
  Profile.leaderboard.sort((a,b)=>b.time-a.time);
  Profile.leaderboard = Profile.leaderboard.slice(0,50);

  checkAchievements();
  saveProfile();

  setTimeout(()=>{
    UI.showGameOver({
      time: State.time, coins: coinsEarned, best: Profile.bestTime,
      combo: State.maxComboThisRun, isNewBest
    });
  }, 650);
}

function checkAchievements(){
  const newly = [];
  for(const a of ACHIEVEMENTS){
    if(!Profile.achievements[a.id] && a.check(State)){
      Profile.achievements[a.id] = true;
      newly.push(a);
    }
  }
  newly.forEach((a,i)=> setTimeout(()=> UI.toast(`🏆 ${a.name}`), i*1400+1000));
}

// ---------------------------------------------------------
// Collision detection (simple O(n) — fine for hundreds of entities)
// ---------------------------------------------------------
function handleCollisions(){
  const p = State.player;
  for(const e of State.enemies){
    if(!e.alive) continue;
    if(e.type==='ghost' && !e.visible) continue;
    if(e.type==='explosive' && e.exploding) continue; // handled via explosion zone
    const d = dist(e.x,e.y,p.x,p.y);
    if(d < p.effectiveRadius + e.radius*e.scale*0.85){
      if(e.type==='sleep'){
        p.slowTimer = 4;
        e.alive = false;
        burst(e.x,e.y,10,{color:'#b388ff',maxLife:0.4});
        dropCoin(e.x,e.y,e.score);
        State.coins += 0; // sleep doesn't damage, but is consumed
        continue;
      }
      if(e.type==='love'){
        // love doesn't directly damage; just wanders. Treat as soft contact: push away, small damage chance
      }
      onPlayerHit();
      if(e.type==='skull'){
        // skull instant kill regardless of shield/lives (per spec) — but respect invincibility/star
        if(!p.isInvincible){
          p.lives = 0;
          triggerGameOver();
        }
      }
      e.alive = false;
      burst(e.x,e.y,12,{color:'#ff3b5c',maxLife:0.45});
      dropCoin(e.x,e.y,e.score);
    }
  }

  // poison puddles
  for(const pu of State.puddles){
    if(dist(pu.x,pu.y,p.x,p.y) < pu.radius + p.effectiveRadius*0.6){
      if(!p.isInvincible && Math.random()<0.02) onPlayerHit();
    }
  }

  // explosion zones
  for(const ex of State.explosions){
    if(!ex.damaged && dist(ex.x,ex.y,p.x,p.y) < ex.radius + p.effectiveRadius){
      ex.damaged = true;
      onPlayerHit();
    }
  }

  // boss melee contact
  if(State.boss && State.boss.state==='active'){
    const b = State.boss;
    if(dist(b.x,b.y,p.x,p.y) < b.radius*0.8 + p.effectiveRadius){
      onPlayerHit();
    }
  }

  // pickups
  for(const pk of State.pickups){
    if(!pk.alive) continue;
    if(dist(pk.x,pk.y,p.x,p.y) < pk.radius + p.effectiveRadius){
      pk.alive = false;
      applyRareEffect(pk.type, pk.x, pk.y);
    }
  }

  // coins
  for(const c of State.coinsList){
    if(!c.alive) continue;
    const magnetRange = p.magnetTimer>0 ? 260 : 70;
    const d = dist(c.x,c.y,p.x,p.y);
    if(d < magnetRange){
      const a = angleTo(c.x,c.y,p.x,p.y);
      c.x += Math.cos(a)*420*0.016*(magnetRange/70);
      c.y += Math.sin(a)*420*0.016*(magnetRange/70);
    }
    if(d < p.effectiveRadius + 8){
      c.alive = false;
      const mult = (State.scoreMultTimer>0)?2:1;
      State.coins += c.value*mult;
      Audio.sfx.coin();
      floatText(c.x,c.y,'+'+(c.value*mult),'#ffd23f',14);
    }
  }

  // damage to enemies from explosion zones (explosive chain reactions + fire-type effects already handled)
  for(const ex of State.explosions){
    for(const e of State.enemies){
      if(!e.alive || e.explosionHit) continue;
      if(dist(ex.x,ex.y,e.x,e.y) < ex.radius){
        e.alive = false; e.explosionHit = true;
        dropCoin(e.x,e.y,e.score);
      }
    }
  }

  // boss damage from explosions (e.g., bomb / fire / lightning should also hurt boss a bit)
}

// ---------------------------------------------------------
// Cleanup
// ---------------------------------------------------------
function cleanupEntities(){
  State.enemies = State.enemies.filter(e=>e.alive);
  State.pickups = State.pickups.filter(p=>p.alive && p.age < 14);
  State.coinsList = State.coinsList.filter(c=>c.alive && c.age < 10);
  State.puddles = State.puddles.filter(pu=>{ pu.life -= 0; return pu.life>0; });
  State.explosions = State.explosions.filter(ex=>ex.life>0);
}

window.EE.GameLogic = {
  ACHIEVEMENTS, COSMETIC_CATALOG, THEME_PALETTES, DAILY_MODIFIERS,
  dailySeedString, dailyModifierForToday,
  State, resetRunState, initBgParticles,
  trySpawnEnemy, tryRareSpawn, dropCoin, difficultyMultiplier,
  updateEnemy, applyLoveAttraction, applyFreezeFields,
  checkNearMisses, addCombo, triggerShake, flashScreen,
  maybeTriggerBoss, spawnBoss, updateBoss, damageBoss,
  activatePowerup, applyRareEffect, onPlayerHit, triggerGameOver,
  handleCollisions, cleanupEntities, checkAchievements,
};

})();

// =========================================================
// RENDER
// =========================================================
(function(){
"use strict";
const EE = window.EE;
const { ctx, rand, clamp, lerp, dist, TAU } = EE;
const GL = EE.GameLogic;
const { State, THEME_PALETTES } = GL;
const { drawParticles } = EE.Entities;

function drawBackground(vw, vh, dt){
  const palette = THEME_PALETTES[State.particlesTheme] || THEME_PALETTES.cyber;
  const t = performance.now()/1000;

  const grad = ctx.createLinearGradient(0,0,vw,vh);
  grad.addColorStop(0, palette.bg1);
  grad.addColorStop(1, palette.bg0);
  ctx.fillStyle = grad;
  ctx.fillRect(0,0,vw,vh);

  // animated radial glow that drifts
  const gx = vw/2 + Math.sin(t*0.15)*vw*0.2;
  const gy = vh/2 + Math.cos(t*0.12)*vh*0.2;
  const rg = ctx.createRadialGradient(gx,gy,0,gx,gy,Math.max(vw,vh)*0.7);
  rg.addColorStop(0, palette.grid.replace(/[\d.]+\)$/, '0.5)'));
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rg;
  ctx.fillRect(0,0,vw,vh);

  // grid
  ctx.save();
  ctx.strokeStyle = palette.grid;
  ctx.lineWidth = 1;
  const gridSize = 56;
  const pulse = 1 + Math.sin(t*1.4)*0.03;
  const offset = (t*8) % gridSize;
  for(let x = -offset; x<=vw; x+=gridSize*pulse){
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,vh); ctx.stroke();
  }
  for(let y = -offset; y<=vh; y+=gridSize*pulse){
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(vw,y); ctx.stroke();
  }
  ctx.restore();

  // floating dust particles
  for(const bp of State.bgParticles){
    bp.x += bp.vx*dt; bp.y += bp.vy*dt;
    bp.tw += dt*1.5;
    if(bp.x<0) bp.x=vw; if(bp.x>vw) bp.x=0;
    if(bp.y<0) bp.y=vh; if(bp.y>vh) bp.y=0;
    const alpha = 0.25 + Math.sin(bp.tw)*0.2;
    ctx.beginPath();
    ctx.fillStyle = palette.particle;
    ctx.globalAlpha = clamp(alpha,0.05,0.5);
    ctx.arc(bp.x,bp.y,bp.size,0,TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // vignette
  const vg = ctx.createRadialGradient(vw/2,vh/2,Math.min(vw,vh)*0.35,vw/2,vh/2,Math.max(vw,vh)*0.75);
  vg.addColorStop(0,'rgba(0,0,0,0)');
  vg.addColorStop(1,'rgba(0,0,0,0.55)');
  ctx.fillStyle = vg;
  ctx.fillRect(0,0,vw,vh);
}

function drawEmojiEntity(glyph, x, y, size, alpha, rotation){
  ctx.save();
  ctx.globalAlpha = alpha!==undefined?alpha:1;
  ctx.translate(x,y);
  if(rotation) ctx.rotate(rotation);
  ctx.font = `${size}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, 0, size*0.06);
  ctx.restore();
}

function drawEnemies(){
  for(const e of State.enemies){
    if(e.type==='ghost' && !e.visible){
      // only glowing eyes visible
      ctx.save();
      ctx.fillStyle = 'rgba(220,255,255,0.9)';
      ctx.shadowColor = '#bfffff'; ctx.shadowBlur = 10;
      const ex = e.x, ey = e.y;
      ctx.beginPath(); ctx.arc(ex-6,ey-3,2.6,0,TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(ex+6,ey-3,2.6,0,TAU); ctx.fill();
      ctx.restore();
      continue;
    }

    const size = e.radius*2*e.scale;

    // explosive warning flash
    if(e.type==='explosive' && e.exploding){
      const f = (Math.sin(e.flashT)+1)/2;
      ctx.save();
      ctx.globalAlpha = 0.5*f;
      ctx.fillStyle = '#ff3b5c';
      ctx.beginPath(); ctx.arc(e.x,e.y,e.radius*1.8,0,TAU); ctx.fill();
      ctx.restore();
    }

    // poison glow
    if(e.type==='poison'){
      ctx.save();
      ctx.shadowColor = '#7cff5e'; ctx.shadowBlur = 8;
      drawEmojiEntity(e.glyph, e.x, e.y, size, 1, 0);
      ctx.restore();
    } else if(e.type==='angry'){
      ctx.save();
      ctx.shadowColor = '#ff3b5c'; ctx.shadowBlur = 10;
      drawEmojiEntity(e.glyph, e.x, e.y, size);
      ctx.restore();
    } else if(e.type==='alien' && e.teleportFlash>0){
      ctx.save();
      ctx.shadowColor = '#39ff9d'; ctx.shadowBlur = 16;
      ctx.globalAlpha = clamp(e.teleportFlash/0.3,0,1);
      drawEmojiEntity(e.glyph, e.x, e.y, size);
      ctx.restore();
    } else {
      drawEmojiEntity(e.glyph, e.x, e.y, size);
    }

    // freeze field
    if(e.type==='freeze'){
      ctx.save();
      ctx.strokeStyle = 'rgba(150,235,255,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(e.x,e.y,e.freezeFieldR,0,TAU); ctx.stroke();
      ctx.restore();
    }
    // love attraction range (subtle)
    if(e.type==='love'){
      ctx.save();
      ctx.strokeStyle = 'rgba(255,150,200,0.18)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(e.x,e.y,e.attractRange,0,TAU); ctx.stroke();
      ctx.restore();
    }
    // robot laser warning / fire
    if(e.type==='robot' && e.laserState!=='idle'){
      ctx.save();
      const len = 1400;
      const x2 = e.x+Math.cos(e.laserAngle)*len, y2 = e.y+Math.sin(e.laserAngle)*len;
      if(e.laserState==='warn'){
        ctx.strokeStyle = `rgba(255,59,92,${0.3+0.3*Math.sin(performance.now()/40)})`;
        ctx.lineWidth = 2;
        ctx.setLineDash([8,8]);
      } else {
        ctx.strokeStyle = '#ff3b5c';
        ctx.shadowColor='#ff3b5c'; ctx.shadowBlur=14;
        ctx.lineWidth = 6;
      }
      ctx.beginPath(); ctx.moveTo(e.x,e.y); ctx.lineTo(x2,y2); ctx.stroke();
      ctx.restore();
    }
  }
}

function drawPuddles(){
  for(const pu of State.puddles){
    const t = pu.life/pu.maxLife;
    ctx.save();
    ctx.globalAlpha = clamp(t*0.5,0,0.5);
    ctx.fillStyle = '#7cff5e';
    ctx.shadowColor = '#7cff5e'; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(pu.x,pu.y,pu.radius,0,TAU); ctx.fill();
    ctx.restore();
  }
}

function drawExplosions(){
  for(const ex of State.explosions){
    const t = 1 - ex.life/ex.maxLife;
    const r = ex.radius * EE.easeOutCubic(t);
    ctx.save();
    ctx.globalAlpha = clamp(1-t,0,1)*0.7;
    const g = ctx.createRadialGradient(ex.x,ex.y,0,ex.x,ex.y,r);
    g.addColorStop(0,'rgba(255,200,120,0.9)');
    g.addColorStop(0.6,'rgba(255,100,60,0.5)');
    g.addColorStop(1,'rgba(255,80,40,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(ex.x,ex.y,r,0,TAU); ctx.fill();
    ctx.restore();
  }
}

function drawPickups(){
  for(const pk of State.pickups){
    if(pk.scale<1) pk.scale = Math.min(1, pk.scale + 1/6);
    pk.bob += 1/60*3;
    const size = 30*pk.scale;
    const y = pk.y + Math.sin(pk.bob)*4;
    ctx.save();
    ctx.shadowColor = '#fff'; ctx.shadowBlur = 12;
    drawEmojiEntity(pk.glyph, pk.x, y, size);
    ctx.restore();
  }
}

function drawCoins(){
  for(const c of State.coinsList){
    if(c.scale<1) c.scale = Math.min(1, c.scale+1/8);
    ctx.save();
    ctx.font = `${18*c.scale}px serif`;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor = '#ffd23f'; ctx.shadowBlur = 8;
    ctx.fillText('🪙', c.x, c.y);
    ctx.restore();
  }
}

function drawBoss(b){
  if(!b) return;
  ctx.save();
  if(b.state==='dying'){
    ctx.globalAlpha = clamp(1 - b.dying/0.9, 0, 1);
    ctx.translate(0, b.dying*40);
  }
  const size = b.radius*2*b.scale;
  if(b.flashT>0){
    ctx.shadowColor = '#fff'; ctx.shadowBlur = 30;
  } else {
    ctx.shadowColor = b.color; ctx.shadowBlur = 20;
  }
  drawEmojiEntity(b.glyph, b.x, b.y, size);
  ctx.restore();

  // projectiles
  for(const pr of b.projectiles){
    drawEmojiEntity(pr.glyph, pr.x, pr.y, pr.r*2.2);
  }
  // telegraphs
  for(const t of b.telegraphs){
    const prog = t.t/t.maxT;
    if(t.type==='beam'){
      ctx.save();
      const len=1400;
      const x2=b.x+Math.cos(t.angle)*len, y2=b.y+Math.sin(t.angle)*len;
      ctx.strokeStyle = `rgba(255,59,92,${0.2+0.5*prog})`;
      ctx.lineWidth = 3+prog*3;
      ctx.setLineDash(prog<0.85?[10,10]:[]);
      ctx.beginPath(); ctx.moveTo(b.x,b.y); ctx.lineTo(x2,y2); ctx.stroke();
      ctx.restore();
    } else if(t.type==='portal' || t.type==='bigexplosion'){
      ctx.save();
      ctx.strokeStyle = `rgba(255,150,80,${0.3+0.5*prog})`;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(t.x,t.y, 70*prog + 10, 0, TAU); ctx.stroke();
      ctx.restore();
    }
  }
}

function drawPlayerTrail(p, equipped, dt){
  if(equipped.trail === 'none') return;
  const speed = Math.hypot(p.vx,p.vy);
  if(speed < 30) return;
  const colorMap = { spark:'#ffd23f', smoke:'rgba(200,200,200,0.6)', rainbow:`hsl(${(performance.now()/8)%360},100%,65%)` };
  const color = colorMap[equipped.trail] || '#5ef0ff';
  EE.Entities.spawnParticle({
    x:p.x, y:p.y, vx:rand(-15,15), vy:rand(-15,15),
    maxLife:0.35, size:rand(3,6), color, glow:8, gravity:0,
  });
}

function applyShake(vw,vh){
  if(State.shakeT>0 && State.shakeAmt>0){
    const k = State.shakeT/0.35;
    const dx = (Math.random()*2-1)*State.shakeAmt*k;
    const dy = (Math.random()*2-1)*State.shakeAmt*k;
    ctx.translate(dx,dy);
  }
}

window.EE.Render = {
  drawBackground, drawEnemies, drawPuddles, drawExplosions, drawPickups, drawCoins,
  drawBoss, drawEmojiEntity, drawPlayerTrail, applyShake,
};

})();

// =========================================================
// UI
// =========================================================
(function(){
"use strict";
const EE = window.EE;
const { clamp, Profile, saveProfile, Audio } = EE;
const GL = EE.GameLogic;
const { State, ACHIEVEMENTS, COSMETIC_CATALOG } = GL;

const $ = sel => document.querySelector(sel);
const $id = id => document.getElementById(id);

let comboPulseTimeout = null;
let toastTimeout = null;
let powerupChipEls = {}; // type -> {el, ring}

function fmtTime(t){
  return t.toFixed(1)+'s';
}

function updateHUD(){
  $id('livesVal').textContent = State.player ? State.player.lives : 3;
  $id('timeVal').textContent = State.time.toFixed(1);
  $id('coinVal').textContent = State.coins;

  const comboWrap = $id('comboWrap');
  if(State.combo > 1){
    comboWrap.classList.add('show');
    $id('comboText').textContent = 'x'+State.combo;
  } else {
    comboWrap.classList.remove('show');
  }

  updatePowerupBar();
}

function pulseCombo(){
  const el = $id('comboText');
  el.style.transform = 'scale(1.3)';
  clearTimeout(comboPulseTimeout);
  comboPulseTimeout = setTimeout(()=>{ el.style.transform='scale(1)'; }, 140);
  el.style.transition = 'transform 0.14s ease';
}

function toast(msg){
  const el = $id('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(()=> el.classList.remove('show'), 1800);
}

function updatePowerupBar(){
  const bar = $id('powerupBar');
  const p = State.player;
  if(!p) return;
  const active = [];
  if(p.shieldHits>0) active.push({key:'shield', icon:'🛡', p:1});
  if(p.speedBoostTimer>0) active.push({key:'speed', icon:'⚡', p:p.speedBoostTimer/6});
  if(p.magnetTimer>0) active.push({key:'magnet', icon:'🧲', p:p.magnetTimer/8});
  if(p.ghostModeTimer>0) active.push({key:'ghost', icon:'👻', p:p.ghostModeTimer/5});
  if(p.invincibleTimer>0) active.push({key:'star', icon:'⭐', p:p.invincibleTimer/6});
  if(p.sizeModTimer>0) active.push({key:'size', icon:p.sizeMod>1?'🦣':'🐜', p:p.sizeModTimer/8});
  if(p.slowTimer>0) active.push({key:'slow', icon:'😴', p:p.slowTimer/4});
  if(State.scoreMultTimer>0) active.push({key:'mult', icon:'🍀', p:State.scoreMultTimer/10});

  bar.innerHTML = '';
  for(const a of active){
    const chip = document.createElement('div');
    chip.className = 'pu-chip';
    chip.innerHTML = `<div class="ring" style="--p:${clamp(a.p,0,1)}"></div><span>${a.icon}</span>`;
    bar.appendChild(chip);
  }
}

function showBossBar(b){
  $id('bossBar').classList.add('show');
  $id('bossName').textContent = b.name;
  $id('bossHpInner').style.width='100%';
}
function updateBossBar(b){
  const pct = clamp(b.hp/b.maxHp,0,1)*100;
  $id('bossHpInner').style.width = pct+'%';
}
function hideBossBar(){
  $id('bossBar').classList.remove('show');
}

function showBossWarning(text, cb){
  const el = $id('bossWarning');
  $id('bossWarningText').textContent = text || '⚠ BOSS INCOMING ⚠';
  el.style.transition = 'opacity 0.3s';
  el.style.opacity = '1';
  setTimeout(()=>{
    el.style.opacity = '0';
    if(cb) cb();
  }, 1800);
}

// ---------------------------------------------------------
// Screen management
// ---------------------------------------------------------
function showScreen(id){
  document.querySelectorAll('.overlay').forEach(o=>o.classList.remove('show'));
  if(id) $id(id).classList.add('show');
}
function hideAllScreens(){
  document.querySelectorAll('.overlay').forEach(o=>o.classList.remove('show'));
}

function refreshStartScreen(){
  $id('bestTimeDisplay').textContent = fmtTime(Profile.bestTime);
  $id('totalCoinsDisplay').textContent = Profile.totalCoins;
}

function showGameOver(stats){
  $id('finalTime').textContent = fmtTime(stats.time);
  $id('finalCoins').textContent = stats.coins;
  $id('finalBest').textContent = fmtTime(stats.best);
  $id('finalCombo').textContent = stats.combo;
  $id('bestTimeBox').classList.toggle('new', stats.isNewBest);
  showScreen('gameOverScreen');
}

// ---------------------------------------------------------
// Cosmetics shop
// ---------------------------------------------------------
let currentCosmeticTab = 'skins';
const TAB_LABELS = { skins:'SKINS', glows:'GLOWS', trails:'TRAILS', themes:'ARENAS' };

function renderCosmeticTabs(){
  const wrap = $id('cosmeticTabs');
  wrap.innerHTML = '';
  Object.keys(TAB_LABELS).forEach(key=>{
    const btn = document.createElement('div');
    btn.className = 'tab-btn' + (key===currentCosmeticTab?' active':'');
    btn.textContent = TAB_LABELS[key];
    btn.onclick = ()=>{ currentCosmeticTab = key; renderCosmeticTabs(); renderCosmeticGrid(); };
    wrap.appendChild(btn);
  });
}

function renderCosmeticGrid(){
  $id('cosmeticCoinsLine').textContent = `🪙 ${Profile.totalCoins} coins`;
  const grid = $id('cosmeticGrid');
  grid.innerHTML = '';
  const items = COSMETIC_CATALOG[currentCosmeticTab];
  const ownedKey = currentCosmeticTab; // 'skins','glows','trails','themes'
  const equippedKey = { skins:'skin', glows:'glow', trails:'trail', themes:'theme' }[currentCosmeticTab];

  items.forEach(item=>{
    const owned = Profile.cosmetics[ownedKey].includes(item.id);
    const equipped = Profile.equipped[equippedKey] === item.id;
    const div = document.createElement('div');
    div.className = 'cos-item' + (owned?'':' locked') + (equipped?' selected':'');
    div.innerHTML = `${item.icon}` + (!owned ? `<div class="lock-tag">${item.cost}</div>` : '');
    div.title = item.name;
    div.onclick = ()=>{
      Audio.sfx.select();
      if(owned){
        Profile.equipped[equippedKey] = item.id;
        saveProfile();
        renderCosmeticGrid();
      } else {
        if(Profile.totalCoins >= item.cost){
          Profile.totalCoins -= item.cost;
          Profile.cosmetics[ownedKey].push(item.id);
          Profile.equipped[equippedKey] = item.id;
          saveProfile();
          renderCosmeticGrid();
          refreshStartScreen();
          toast(`Unlocked ${item.name}!`);
        } else {
          toast('Not enough coins');
        }
      }
    };
    grid.appendChild(div);
  });
}

// ---------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------
let currentLeaderRange = 'daily';
function renderLeaderboard(){
  const list = $id('leaderList');
  list.innerHTML = '';
  const now = Date.now();
  const rangeMs = currentLeaderRange==='daily' ? 86400000 : currentLeaderRange==='weekly' ? 7*86400000 : Infinity;
  let rows = Profile.leaderboard.filter(r => (now - r.date) <= rangeMs);
  rows = rows.sort((a,b)=>b.time-a.time).slice(0,20);
  if(rows.length===0){
    list.innerHTML = '<div style="color:var(--ink-dim); padding:20px 0; font-size:13px;">No runs yet. Go set a record!</div>';
    return;
  }
  rows.forEach((r,i)=>{
    const row = document.createElement('div');
    row.className = 'leader-row';
    row.innerHTML = `<span class="rank">#${i+1}</span><span class="nm">${r.name}</span><span class="sc">${r.time.toFixed(1)}s · 🪙${r.coins}</span>`;
    list.appendChild(row);
  });
}

// ---------------------------------------------------------
// Achievements
// ---------------------------------------------------------
function renderAchievements(){
  const list = $id('achList');
  list.innerHTML = '';
  ACHIEVEMENTS.forEach(a=>{
    const done = !!Profile.achievements[a.id];
    const row = document.createElement('div');
    row.className = 'ach-row' + (done?' done':'');
    row.innerHTML = `<div class="ic ${done?'':'locked'}">${a.icon}</div>
      <div class="tx"><div class="nm">${a.name}</div><div class="ds">${a.desc}</div></div>
      ${done?'<div style="color:var(--ok);">✓</div>':''}`;
    list.appendChild(row);
  });
}

// ---------------------------------------------------------
// Flash / shake DOM effects
// ---------------------------------------------------------
function applyFlashDOM(){
  const el = $id('flashOverlay');
  if(State.flashAlpha > 0.005){
    el.style.background = State.flashColor;
    el.style.opacity = String(State.flashAlpha);
  } else {
    el.style.opacity = '0';
  }
}

window.EE.UI = {
  updateHUD, pulseCombo, toast, updatePowerupBar,
  showBossBar, updateBossBar, hideBossBar, showBossWarning,
  showScreen, hideAllScreens, refreshStartScreen, showGameOver,
  renderCosmeticTabs, renderCosmeticGrid, renderLeaderboard, renderAchievements,
  applyFlashDOM, fmtTime,
  setLeaderRange(r){ currentLeaderRange = r; renderLeaderboard(); },
};

})();

// =========================================================
// MAIN GAME CONTROLLER
// =========================================================
(function(){
"use strict";
const EE = window.EE;
const { ctx, canvas, clamp, rand, dist, Input, Audio, Profile, saveProfile } = EE;
const GL = EE.GameLogic;
const { State } = GL;
const Render = EE.Render;
const UI = EE.UI;
const Entities = EE.Entities;

let lastT = performance.now();
let rafId = null;
let powerupSpawnTimer = 8;
let scoreMultDecay = 0;

// ---------------------------------------------------------
// Mode control
// ---------------------------------------------------------
const Game = {
  togglePause(){
    if(State.mode === 'playing'){ this.pause(); }
    else if(State.mode === 'paused'){ this.resume(); }
  },
  pause(){
    if(State.mode !== 'playing') return;
    State.mode = 'paused';
    UI.showScreen('pauseScreen');
  },
  resume(){
    if(State.mode !== 'paused') return;
    State.mode = 'playing';
    UI.hideAllScreens();
    lastT = performance.now();
  },
  startRun(isDaily){
    GL.resetRunState();
    State.isDaily = !!isDaily;
    State.dailyModifier = isDaily ? GL.dailyModifierForToday() : null;
    if(State.dailyModifier && State.dailyModifier.id === 'tinyplayer'){
      State.player.baseRadius = 8;
    }
    State.scoreMult = 1;
    State.scoreMultTimer = 0;
    powerupSpawnTimer = 8;
    State.mode = 'playing';
    UI.hideAllScreens();
    Audio.ensure();
    Audio.startMusic();
    lastT = performance.now();
    if(!rafId) rafId = requestAnimationFrame(loop);
  },
  toMenu(){
    State.mode = 'menu';
    UI.refreshStartScreen();
    UI.showScreen('startScreen');
  },
};
window.Game = Game; // for keyboard pause hook in game.js part 1

// ---------------------------------------------------------
// Power-up spawning as floating pickups in-world (separate from rare emoji pickups)
// We represent them as pickup-like entities reusing Pickup class with custom glyph mapping.
// ---------------------------------------------------------
const POWERUP_GLYPHS = {
  shield:'🛡', speed:'🥾', freezeTime:'🧊', magnet:'🧲', bomb:'💣', mini:'🔬', giant:'🦣', ghostMode:'👻‍'
};
function spawnPowerupPickup(){
  const margin = 60;
  const type = EE.choice(Object.keys(POWERUP_GLYPHS));
  const x = rand(margin, EE.VW-margin), y = rand(margin, EE.VH-margin);
  const pk = new Entities.Pickup('__powerup_'+type, x, y);
  pk.glyph = POWERUP_GLYPHS[type];
  pk.isPowerup = true;
  pk.powerupType = type;
  State.pickups.push(pk);
}

// patch collision handling for powerup pickups (extends handleCollisions behavior)
function handlePowerupPickupCollisions(){
  const p = State.player;
  for(const pk of State.pickups){
    if(!pk.alive || !pk.isPowerup) continue;
    if(dist(pk.x,pk.y,p.x,p.y) < pk.radius + p.effectiveRadius){
      pk.alive = false;
      GL.activatePowerup(pk.powerupType);
    }
  }
}

// ---------------------------------------------------------
// Update
// ---------------------------------------------------------
function update(dt){
  // slow-mo on death
  if(State.slowMoT > 0){
    State.slowMoT -= dt;
    dt *= 0.15;
  }

  State.time += dt;
  if(State.scoreMultTimer>0){ State.scoreMultTimer -= dt; if(State.scoreMultTimer<=0) State.scoreMult = 1; }

  const diff = GL.difficultyMultiplier();
  Audio.setIntensity(diff.musicIntensity);

  const p = State.player;
  p.update(dt, Input, EE.VW, EE.VH);
  Render.drawPlayerTrail(p, Profile.equipped, dt);

  // combo decay
  if(State.comboTimer > 0){
    State.comboTimer -= dt;
    if(State.comboTimer <= 0){ State.combo = 0; }
  }

  // spawn logic
  State.spawnTimer -= dt;
  const targetInterval = clamp(1.1 * diff.spawnMult, 0.08, 1.2);
  if(State.spawnTimer <= 0 && !State.boss){
    State.spawnTimer = targetInterval;
    const burstCount = 1 + Math.floor(diff.varietyTier/4);
    for(let i=0;i<burstCount;i++) GL.trySpawnEnemy();
  }
  GL.tryRareSpawn(dt);

  powerupSpawnTimer -= dt;
  if(powerupSpawnTimer <= 0 && State.pickups.filter(p=>p.isPowerup).length < 1){
    powerupSpawnTimer = rand(14,22);
    spawnPowerupPickup();
  }

  // enemy updates
  GL.applyFreezeFields();
  for(const e of State.enemies){
    if(!e.alive) continue;
    GL.updateEnemy(e, dt, diff);
  }
  GL.applyLoveAttraction(dt);

  // boss
  GL.maybeTriggerBoss();
  if(State.bossWarningTimer > 0){
    if(State.bossWarningTimer === 2.2){ /* first frame trigger handled below */ }
    State.bossWarningTimer -= dt;
    if(State.bossWarningTimer <= 0 && !State.boss){
      GL.spawnBoss();
    }
  }
  if(State.boss){
    GL.updateBoss(State.boss, dt, diff);
  }

  // puddle life
  for(const pu of State.puddles) pu.life -= dt;
  for(const ex of State.explosions) ex.life -= dt;
  for(const pk of State.pickups) pk.age += dt;
  for(const c of State.coinsList) c.age += dt;

  // near-miss / combo
  GL.checkNearMisses(dt);

  // collisions
  GL.handleCollisions();
  handlePowerupPickupCollisions();

  GL.cleanupEntities();

  Entities.updateParticles(dt);

  if(State.shakeT > 0) State.shakeT -= dt;
  if(State.flashAlpha > 0) State.flashAlpha = Math.max(0, State.flashAlpha - dt*2.2);

  UI.updateHUD();
  UI.applyFlashDOM();

  // boss warning UI trigger (once)
  if(State.bossWarningTimer > 2.0 && !State._warnShown){
    State._warnShown = true;
    UI.showBossWarning();
  }
  if(!State.bossWarningTimer || State.bossWarningTimer<=0) State._warnShown = false;
}

// ---------------------------------------------------------
// Render
// ---------------------------------------------------------
function render(dt){
  const vw = EE.VW, vh = EE.VH;
  ctx.save();
  Render.applyShake(vw,vh);

  Render.drawBackground(vw, vh, dt);
  Render.drawPuddles();
  Render.drawExplosions();
  Render.drawEnemies();
  Render.drawPickups();
  Render.drawCoins();
  if(State.boss) Render.drawBoss(State.boss);

  Entities.drawParticles();

  if(State.player) State.player.draw(Profile.equipped);

  ctx.restore();
}

// ---------------------------------------------------------
// Loop
// ---------------------------------------------------------
function loop(now){
  rafId = requestAnimationFrame(loop);
  let dt = (now - lastT)/1000;
  lastT = now;
  dt = Math.min(dt, 1/20); // clamp for tab-switch hitches

  if(State.mode === 'playing'){
    update(dt);
    render(dt);
  } else if(State.mode === 'menu' || State.mode==='paused' || State.mode==='gameover'){
    // keep rendering a gently animated background behind overlays
    render(dt);
  }
}

// kick off render loop immediately so the menu has an animated background
rafId = requestAnimationFrame(loop);

// ---------------------------------------------------------
// Damage boss when player attacks? -> In this game player doesn't attack directly;
// bosses are defeated via player using bomb/fire/lightning power-ups & rare items hitting them,
// and via near-miss/avoidance not applicable. We let explosions & bomb/fire/lightning effects also hit boss.
// ---------------------------------------------------------
function patchAreaEffectsToHitBoss(){
  // Wrap applyRareEffect & activatePowerup bomb branch indirectly by checking boss proximity after explosions added.
}

// Extend explosion-vs-boss + rare pickups vs boss inside the update loop via a lightweight hook:
const _origHandleCollisions = GL.handleCollisions;
GL.handleCollisions = function(){
  _origHandleCollisions();
  if(State.boss && State.boss.state==='active'){
    const b = State.boss;
    for(const ex of State.explosions){
      if(!ex.hitBoss && EE.dist(ex.x,ex.y,b.x,b.y) < ex.radius + b.radius){
        ex.hitBoss = true;
        GL.damageBoss(8);
      }
    }
  }
};

// also let bomb/fire/lightning area attacks damage boss directly
const _origActivatePowerup = GL.activatePowerup;
GL.activatePowerup = function(type){
  _origActivatePowerup(type);
  if(type==='bomb' && State.boss && State.boss.state==='active'){ GL.damageBoss(20); }
};
const _origApplyRareEffect = GL.applyRareEffect;
GL.applyRareEffect = function(type,x,y){
  _origApplyRareEffect(type,x,y);
  if(State.boss && State.boss.state==='active'){
    const b = State.boss;
    if((type==='fire' && EE.dist(x,y,b.x,b.y)<220) ) GL.damageBoss(15);
    if(type==='lightning') GL.damageBoss(25);
  }
};

// touching the boss itself with player while player is invincible (star) should also chip boss hp,
// rewarding risky play -- small continuous damage while invincible & overlapping
function bossContactDamageTick(dt){
  if(State.boss && State.boss.state==='active' && State.player.invincibleTimer>0){
    const b = State.boss, p = State.player;
    if(EE.dist(b.x,b.y,p.x,p.y) < b.radius*0.8 + p.effectiveRadius){
      b._touchDamageAcc = (b._touchDamageAcc||0) + dt*30;
      if(b._touchDamageAcc >= 1){
        GL.damageBoss(Math.floor(b._touchDamageAcc));
        b._touchDamageAcc = 0;
      }
    }
  }
}
const _origUpdateBoss = GL.updateBoss;
GL.updateBoss = function(b, dt, diff){
  _origUpdateBoss(b, dt, diff);
  bossContactDamageTick(dt);
};

window.EE.Game = Game;

})();

// =========================================================
// DOM EVENT WIRING
// =========================================================
(function(){
"use strict";
const EE = window.EE;
const { Audio, Profile, saveProfile } = EE;
const Game = EE.Game;
const UI = EE.UI;
const $id = id => document.getElementById(id);

function on(id, evt, fn){
  const el = $id(id);
  if(el) el.addEventListener(evt, fn);
}

document.addEventListener('DOMContentLoaded', init);
if(document.readyState !== 'loading') init();

let inited = false;
function init(){
  if(inited) return;
  inited = true;

  UI.refreshStartScreen();

  on('playBtn','click', ()=>{ Audio.sfx.select(); Game.startRun(false); });
  on('dailyBtn','click', ()=>{
    Audio.sfx.select();
    const mod = EE.GameLogic.dailyModifierForToday();
    UI.toast(`Daily: ${mod.name} — ${mod.desc}`);
    setTimeout(()=> Game.startRun(true), 600);
  });

  on('cosmeticsBtn','click', ()=>{
    Audio.sfx.select();
    UI.renderCosmeticTabs();
    UI.renderCosmeticGrid();
    UI.showScreen('cosmeticsScreen');
  });
  on('closeCosmetics','click', ()=> UI.showScreen('startScreen'));
  on('closeCosmeticsBtn','click', ()=> UI.showScreen('startScreen'));

  on('leaderboardBtn','click', ()=>{
    Audio.sfx.select();
    UI.setLeaderRange('daily');
    document.querySelectorAll('#leaderTabs .tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.range==='daily'));
    UI.showScreen('leaderboardScreen');
  });
  on('closeLeaderboard','click', ()=> UI.showScreen('startScreen'));
  on('closeLeaderboardBtn','click', ()=> UI.showScreen('startScreen'));
  document.querySelectorAll('#leaderTabs .tab-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('#leaderTabs .tab-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      UI.setLeaderRange(btn.dataset.range);
    });
  });

  on('achievementsBtn','click', ()=>{
    Audio.sfx.select();
    UI.renderAchievements();
    UI.showScreen('achievementsScreen');
  });
  on('closeAchievements','click', ()=> UI.showScreen('startScreen'));
  on('closeAchievementsBtn','click', ()=> UI.showScreen('startScreen'));

  on('pauseBtn','click', ()=> Game.togglePause());
  on('resumeBtn','click', ()=> Game.resume());
  on('restartFromPauseBtn','click', ()=> Game.startRun(false));
  on('menuFromPauseBtn','click', ()=> Game.toMenu());

  on('settingsBtn','click', ()=>{
    $id('soundToggle').checked = Profile.settings.sound;
    $id('shakeToggle').checked = Profile.settings.shake;
    $id('reducedToggle').checked = Profile.settings.reduced;
    UI.showScreen('settingsScreen');
  });
  on('closeSettings','click', closeSettings);
  on('closeSettingsBtn','click', closeSettings);
  function closeSettings(){
    Profile.settings.sound = $id('soundToggle').checked;
    Profile.settings.shake = $id('shakeToggle').checked;
    Profile.settings.reduced = $id('reducedToggle').checked;
    saveProfile();
    UI.showScreen(EE.GameLogic.State.mode==='paused' ? 'pauseScreen' : 'startScreen');
  }
  on('soundToggle','change', e=>{ Profile.settings.sound = e.target.checked; saveProfile(); });
  on('shakeToggle','change', e=>{ Profile.settings.shake = e.target.checked; saveProfile(); });
  on('reducedToggle','change', e=>{ Profile.settings.reduced = e.target.checked; saveProfile(); });

  on('restartBtn','click', ()=> Game.startRun(false));
  on('menuBtn','click', ()=> Game.toMenu());
  on('shareBtn','click', async ()=>{
    const state = EE.GameLogic.State;
    const text = `I survived ${state.time.toFixed(1)}s and collected ${state.coins} coins in Emoji Escape! 🎮`;
    try{
      if(navigator.share){ await navigator.share({ text }); }
      else if(navigator.clipboard){ await navigator.clipboard.writeText(text); UI.toast('Copied to clipboard!'); }
      else { UI.toast(text); }
    }catch(e){ /* user cancelled share — ignore */ }
  });

  // first interaction unlocks audio context (browser policy)
  ['pointerdown','keydown'].forEach(evt=>{
    window.addEventListener(evt, ()=> Audio.ensure(), {once:true});
  });
}

})();

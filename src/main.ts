import "./styles.css";

type GameState = "ready" | "playing" | "paused" | "over";
type Lane = 0 | 1 | 2;
type HazardKind = "janice" | "bot" | "fallingIce" | "pap";
type PickupKind = "record" | "spark" | "shield" | "tower";

interface Actor {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Hazard extends Actor {
  lane: Lane;
  speed: number;
  kind: HazardKind;
  wobble: number;
}

interface Pickup extends Actor {
  lane: Lane;
  speed: number;
  kind: PickupKind;
  spin: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
  size: number;
}

interface Toast {
  text: string;
  life: number;
  color: string;
}

const WIDTH = 1024;
const HEIGHT = 576;
const GROUND_Y = 452;
const lanes = [WIDTH * 0.28, WIDTH * 0.5, WIDTH * 0.72] as const;
const bestKey = "iceman-run-best";
const levelNames = ["Ice Block Drop", "CN Tower Freeze", "Bot Farm Burnout", "Late Night Victory"];

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root not found");
}

function mustQuery<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Required element missing: ${selector}`);
  return element;
}

app.innerHTML = `
  <main class="shell">
    <section class="game-card" aria-label="ICEMAN RUN arcade game">
      <header class="topbar">
        <div class="brand-block">
          <span class="mark" aria-hidden="true">◆</span>
          <div>
            <p class="kicker">Toronto ice-block arcade</p>
            <h1>ICEMAN RUN</h1>
          </div>
        </div>
        <div class="stat-grid" aria-live="polite">
          <span><b id="score">0</b><small>score</small></span>
          <span><b id="best">0</b><small>best</small></span>
          <span><b id="combo">x1</b><small>combo</small></span>
          <span><b id="ice">3</b><small>ice</small></span>
          <span><b id="reveal">0%</b><small>reveal</small></span>
        </div>
      </header>

      <div class="stage-wrap">
        <canvas id="game" width="${WIDTH}" height="${HEIGHT}" aria-label="Playable 8-bit Iceman arcade game"></canvas>
        <div class="overlay" id="overlay">
          <div class="overlay-panel">
            <p class="episode" id="episodeLabel">Episode 1: melt the block, dodge the chatter.</p>
            <p id="stateLabel">Swipe lanes. Collect ice records and heat sparks. Hit <b>Melt</b> when the city gets loud.</p>
            <button id="primaryBtn" type="button">Start with sound</button>
            <button id="quietBtn" type="button">Start quiet</button>
            <p class="hint">Controls: swipe or arrows to move. Melt clears hazards when charged. Audio starts only after you tap.</p>
          </div>
        </div>
      </div>

      <div class="meter-row" aria-label="Ability meters">
        <label>
          <span>Melt charge</span>
          <progress id="meltMeter" max="100" value="0"></progress>
        </label>
        <label>
          <span>Shield</span>
          <progress id="shieldMeter" max="100" value="0"></progress>
        </label>
      </div>

      <div class="controls" aria-label="Game controls">
        <button id="leftBtn" type="button" aria-label="Move left">◀</button>
        <button id="meltBtn" type="button">Melt</button>
        <button id="pauseBtn" type="button">Pause</button>
        <button id="audioBtn" type="button" aria-pressed="false">Sound off</button>
        <button id="rightBtn" type="button" aria-label="Move right">▶</button>
      </div>
    </section>
  </main>
`;

const canvas = mustQuery<HTMLCanvasElement>("#game");
const context = canvas.getContext("2d");
const scoreEl = mustQuery<HTMLElement>("#score");
const bestEl = mustQuery<HTMLElement>("#best");
const comboEl = mustQuery<HTMLElement>("#combo");
const iceEl = mustQuery<HTMLElement>("#ice");
const revealEl = mustQuery<HTMLElement>("#reveal");
const meltMeter = mustQuery<HTMLProgressElement>("#meltMeter");
const shieldMeter = mustQuery<HTMLProgressElement>("#shieldMeter");
const overlay = mustQuery<HTMLDivElement>("#overlay");
const episodeLabel = mustQuery<HTMLElement>("#episodeLabel");
const stateLabel = mustQuery<HTMLElement>("#stateLabel");
const primaryBtn = mustQuery<HTMLButtonElement>("#primaryBtn");
const quietBtn = mustQuery<HTMLButtonElement>("#quietBtn");
const leftBtn = mustQuery<HTMLButtonElement>("#leftBtn");
const rightBtn = mustQuery<HTMLButtonElement>("#rightBtn");
const meltBtn = mustQuery<HTMLButtonElement>("#meltBtn");
const pauseBtn = mustQuery<HTMLButtonElement>("#pauseBtn");
const audioBtn = mustQuery<HTMLButtonElement>("#audioBtn");

if (!context) {
  throw new Error("2D canvas context is unavailable");
}

const ctx = context;
ctx.imageSmoothingEnabled = false;

let state: GameState = "ready";
let lane: Lane = 1;
let score = 0;
let bestScore = Number(window.localStorage.getItem(bestKey) ?? 0);
let combo = 1;
let ice = 3;
let reveal = 0;
let melt = 0;
let shield = 0;
let level = 0;
let spawnTimer = 0;
let pickupTimer = 0;
let waveTimer = 0;
let shake = 0;
let skylineShift = 0;
let lastTime = 0;
let soundEnabled = false;
let hazards: Hazard[] = [];
let pickups: Pickup[] = [];
let particles: Particle[] = [];
let toasts: Toast[] = [];
let audio: AudioEngine | null = null;

const player: Actor = {
  x: lanes[lane] - 28,
  y: GROUND_Y - 74,
  width: 56,
  height: 74
};

class AudioEngine {
  private readonly audioContext = new AudioContext();
  private readonly master = this.audioContext.createGain();
  private timer: number | undefined;
  private step = 0;

  constructor() {
    this.master.gain.value = 0.18;
    this.master.connect(this.audioContext.destination);
  }

  async start(): Promise<void> {
    await this.audioContext.resume();
    if (this.timer) return;
    this.timer = window.setInterval(() => this.playStep(), 120);
  }

  stop(): void {
    if (!this.timer) return;
    window.clearInterval(this.timer);
    this.timer = undefined;
  }

  setMuted(muted: boolean): void {
    this.master.gain.setTargetAtTime(muted ? 0.0001 : 0.18, this.audioContext.currentTime, 0.02);
  }

  hit(): void {
    this.noise(0.16, 0.12);
    this.tone(92.5, 0.1, "sawtooth", 0.08);
  }

  collect(): void {
    this.tone(830.61, 0.045, "square", 0.09);
    window.setTimeout(() => this.tone(987.77, 0.055, "square", 0.075), 52);
  }

  melt(): void {
    [277.18, 369.99, 554.37, 739.99].forEach((note, index) => {
      window.setTimeout(() => this.tone(note, 0.09, "square", 0.09), index * 40);
    });
  }

  private playStep(): void {
    const roots = [138.59, 207.65, 164.81, 246.94]; // C#m, G#m, E, Emaj7 color without copying the hook.
    const icyLead = [415.3, 0, 493.88, 0, 622.25, 554.37, 493.88, 0, 369.99, 0, 415.3, 466.16, 493.88, 0, 369.99, 0];
    const index = this.step % icyLead.length;
    const root = roots[Math.floor(this.step / 8) % roots.length];
    if (this.step % 4 === 0) this.tone(root, 0.11, "triangle", 0.075);
    if (icyLead[index]) this.tone(icyLead[index], 0.055, "square", 0.045);
    if (this.step % 8 === 2 || this.step % 8 === 6) this.noise(0.025, 0.045);
    this.step += 1;
  }

  private tone(frequency: number, duration: number, type: OscillatorType, gainValue: number): void {
    const now = this.audioContext.currentTime;
    const oscillator = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(gainValue, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  private noise(duration: number, gainValue: number): void {
    const buffer = this.audioContext.createBuffer(1, this.audioContext.sampleRate * duration, this.audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    const source = this.audioContext.createBufferSource();
    const gain = this.audioContext.createGain();
    gain.gain.value = gainValue;
    source.buffer = buffer;
    source.connect(gain).connect(this.master);
    source.start();
  }
}

function rect(x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

function outline(x: number, y: number, w: number, h: number, color: string, line = 4): void {
  rect(x, y, w, line, color);
  rect(x, y + h - line, w, line, color);
  rect(x, y, line, h, color);
  rect(x + w - line, y, line, h, color);
}

function text(value: string, x: number, y: number, size = 18, color = "#f7f2d4", align: CanvasTextAlign = "left"): void {
  ctx.fillStyle = color;
  ctx.font = `700 ${size}px "Courier New", monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = "top";
  ctx.fillText(value, Math.round(x), Math.round(y));
}

function drawBackground(delta: number): void {
  skylineShift = (skylineShift + delta * (0.035 + level * 0.01)) % WIDTH;
  const sky = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  sky.addColorStop(0, "#06101e");
  sky.addColorStop(0.52, "#102b49");
  sky.addColorStop(1, "#06101e");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  for (let i = 0; i < 95; i += 1) {
    const x = (i * 67 + skylineShift * 0.25) % WIDTH;
    const y = 26 + ((i * 29) % 170);
    rect(x, y, i % 8 === 0 ? 5 : 3, i % 7 === 0 ? 5 : 3, i % 3 === 0 ? "#f4cf63" : "#9fe8ff");
  }

  drawMoonAndTower();

  for (let i = -1; i < 15; i += 1) {
    const x = i * 84 - (skylineShift * 0.72) % 84;
    const height = 70 + ((i * 31) % 90);
    rect(x, GROUND_Y - height, 62, height, "#09182a");
    rect(x + 8, GROUND_Y - height + 16, 7, 7, "#f4cf63");
    rect(x + 28, GROUND_Y - height + 34, 7, 7, "#64d8ff");
    rect(x + 45, GROUND_Y - height + 56, 7, 7, "#f4cf63");
  }

  drawIceBlock();
  rect(0, GROUND_Y, WIDTH, HEIGHT - GROUND_Y, "#12283a");
  rect(0, GROUND_Y - 8, WIDTH, 8, "#d7f6ff");
  rect(0, GROUND_Y, WIDTH, 8, "#75d8ff");
  for (const laneX of lanes) {
    rect(laneX - 3, GROUND_Y, 6, HEIGHT - GROUND_Y, "rgba(215,246,255,0.22)");
  }
  for (let x = -40; x < WIDTH; x += 72) {
    rect(x - (skylineShift * 2.2) % 72, GROUND_Y - 14, 28, 5, "#f7f2d4");
  }
}

function drawMoonAndTower(): void {
  rect(800, 42, 78, 78, "rgba(244,207,99,0.08)");
  rect(824, 52, 34, 54, "#f4cf63");
  rect(838, 106, 6, 44, "#f4cf63");
  rect(818, 148, 46, 7, "#8bd7ff");
  rect(833, 155, 16, 120, "#8bd7ff");
  rect(813, 208, 56, 10, "#f4cf63");
}

function drawIceBlock(): void {
  const x = 54;
  const y = 282;
  const w = 196;
  const h = 126;
  rect(x, y, w, h, "rgba(130,232,255,0.18)");
  outline(x, y, w, h, "#b9f3ff", 5);
  rect(x + 14, y + 14, w - 28, 20, "rgba(255,255,255,0.28)");
  const visibleLetters = Math.min(6, Math.floor(reveal / 16.6));
  const letters = "MAY 15";
  text("MELT THE DATE", x + 22, y + 42, 16, "#f4cf63");
  text(letters.slice(0, visibleLetters).padEnd(6, "■"), x + 28, y + 70, 26, "#ffffff");
}

function drawPlayer(delta: number): void {
  player.x += (lanes[lane] - player.width / 2 - player.x) * Math.min(0.32, delta / 42);
  const bob = Math.sin(performance.now() / 90) * 3;
  const x = player.x;
  const y = player.y + bob;

  if (shield > 0) {
    outline(x - 10, y - 10, player.width + 20, player.height + 20, "rgba(139,215,255,0.75)", 4);
  }

  rect(x + 10, y + 22, 38, 44, "#111820");
  rect(x + 14, y + 25, 30, 22, "#1d2735");
  rect(x + 7, y + 32, 12, 25, "#090d12");
  rect(x + 42, y + 32, 12, 25, "#090d12");
  rect(x + 14, y + 2, 28, 24, "#b77755");
  rect(x + 10, y, 36, 9, "#0a0d12");
  rect(x + 15, y + 11, 11, 5, "#05070a");
  rect(x + 32, y + 11, 11, 5, "#05070a");
  rect(x + 9, y + 26, 40, 12, "#f4cf63");
  rect(x + 18, y + 64, 11, 12, "#d7f6ff");
  rect(x + 36, y + 64, 11, 12, "#d7f6ff");
}

function drawHazard(hazard: Hazard): void {
  const x = hazard.x + Math.sin(hazard.wobble) * 5;
  const y = hazard.y;
  if (hazard.kind === "janice") {
    rect(x, y + 10, 92, 44, "#eef6ff");
    outline(x, y + 10, 92, 44, "#101a2d", 4);
    rect(x + 18, y + 54, 15, 15, "#eef6ff");
    text("STFU?", x + 12, y + 22, 19, "#101a2d");
    return;
  }
  if (hazard.kind === "bot") {
    rect(x + 12, y + 4, 58, 58, "#182338");
    outline(x + 12, y + 4, 58, 58, "#ff5f79", 4);
    rect(x + 24, y + 22, 10, 10, "#ff5f79");
    rect(x + 48, y + 22, 10, 10, "#ff5f79");
    text("BOT", x + 24, y + 42, 13, "#f7f2d4");
    return;
  }
  if (hazard.kind === "pap") {
    rect(x + 8, y + 12, 70, 42, "#111820");
    rect(x + 22, y, 32, 22, "#2d3848");
    rect(x + 58, y + 24, 22, 18, "#f4cf63");
    rect(x + 32, y + 23, 18, 18, "#8bd7ff");
    text("FLASH", x + 11, y + 58, 12, "#ff5f79");
    return;
  }
  rect(x + 26, y, 28, 68, "#92edff");
  rect(x + 33, y + 8, 12, 48, "#e4fbff");
  rect(x + 19, y + 55, 42, 12, "#5ecce6");
}

function drawPickup(pickup: Pickup): void {
  const x = pickup.x + Math.sin(pickup.spin) * 7;
  const y = pickup.y;
  if (pickup.kind === "record") {
    rect(x, y, 48, 48, "#f4cf63");
    rect(x + 8, y + 8, 32, 32, "#101a2d");
    rect(x + 20, y + 20, 8, 8, "#f4cf63");
    return;
  }
  if (pickup.kind === "spark") {
    rect(x + 20, y, 10, 52, "#ff9f43");
    rect(x + 8, y + 16, 34, 10, "#f4cf63");
    rect(x + 16, y + 8, 18, 34, "#fff3a1");
    return;
  }
  if (pickup.kind === "shield") {
    outline(x + 5, y + 2, 42, 48, "#8bd7ff", 5);
    rect(x + 16, y + 14, 20, 20, "#d7f6ff");
    return;
  }
  rect(x + 16, y, 12, 56, "#8bd7ff");
  rect(x + 4, y + 20, 36, 8, "#f4cf63");
}

function drawParticles(delta: number): void {
  particles = particles.filter((particle) => {
    particle.life -= delta;
    particle.x += particle.vx * (delta / 1000);
    particle.y += particle.vy * (delta / 1000);
    particle.vy += 220 * (delta / 1000);
    rect(particle.x, particle.y, particle.size, particle.size, particle.color);
    return particle.life > 0;
  });
}

function drawToasts(delta: number): void {
  toasts = toasts.filter((toast, index) => {
    toast.life -= delta;
    text(toast.text, WIDTH / 2, 76 + index * 30, 22, toast.color, "center");
    return toast.life > 0;
  });
}

function update(delta: number): void {
  if (state !== "playing") return;

  const difficulty = 1 + level * 0.18 + score / 20000;
  spawnTimer -= delta;
  pickupTimer -= delta;
  waveTimer += delta;
  score += delta * 0.035 * combo;
  reveal = Math.min(100, reveal + delta * 0.0035);
  shield = Math.max(0, shield - delta * 0.012);
  shake = Math.max(0, shake - delta * 0.02);
  level = Math.min(levelNames.length - 1, Math.floor(score / 3500));

  if (spawnTimer <= 0) {
    spawnTimer = Math.max(390, 940 - difficulty * 85);
    spawnHazard();
  }

  if (pickupTimer <= 0) {
    pickupTimer = 620 + Math.random() * 420;
    spawnPickup();
  }

  hazards = hazards.filter((hazard) => {
    hazard.y += hazard.speed * difficulty * (delta / 1000);
    hazard.wobble += delta * 0.006;
    if (intersects(player, hazard)) {
      collide(hazard);
      return false;
    }
    return hazard.y < HEIGHT + 90;
  });

  pickups = pickups.filter((pickup) => {
    pickup.y += pickup.speed * (delta / 1000);
    pickup.spin += delta * 0.01;
    if (intersects(player, pickup)) {
      collect(pickup);
      return false;
    }
    return pickup.y < HEIGHT + 80;
  });

  if (waveTimer > 8000) {
    waveTimer = 0;
    toast(`${levelNames[level]} wave`, 1400, "#8bd7ff");
  }
}

function spawnHazard(): void {
  const hazardLane = Math.floor(Math.random() * lanes.length) as Lane;
  const kinds: HazardKind[] = level >= 2 ? ["janice", "bot", "fallingIce", "pap"] : ["janice", "fallingIce", "pap"];
  const kind = kinds[Math.floor(Math.random() * kinds.length)];
  hazards.push({
    lane: hazardLane,
    x: lanes[hazardLane] - 44,
    y: -82,
    width: kind === "janice" ? 92 : 80,
    height: kind === "fallingIce" ? 68 : 62,
    speed: 185 + Math.random() * 90 + level * 16,
    kind,
    wobble: Math.random() * 8
  });
}

function spawnPickup(): void {
  const pickupLane = Math.floor(Math.random() * lanes.length) as Lane;
  const roll = Math.random();
  const kind: PickupKind = roll > 0.9 ? "shield" : roll > 0.72 ? "spark" : roll > 0.58 ? "tower" : "record";
  pickups.push({
    lane: pickupLane,
    x: lanes[pickupLane] - 24,
    y: -58,
    width: 52,
    height: 56,
    speed: 160 + level * 12,
    kind,
    spin: Math.random() * 6
  });
}

function collide(hazard: Hazard): void {
  burst(player.x + player.width / 2, player.y + 28, "#ff5f79", 18);
  shake = 8;
  if (shield > 0) {
    shield = Math.max(0, shield - 42);
    combo = Math.max(1, combo - 1);
    toast("shield ate the noise", 900, "#8bd7ff");
    audio?.collect();
    return;
  }
  ice -= 1;
  combo = 1;
  melt = Math.max(0, melt - 16);
  reveal = Math.max(0, reveal - 5);
  toast(hazard.kind === "janice" ? "too much chatter" : "ice cracked", 900, "#ff8aa0");
  audio?.hit();
  if (ice <= 0) endGame();
}

function collect(pickup: Pickup): void {
  burst(pickup.x + 24, pickup.y + 24, pickup.kind === "spark" ? "#ffcf63" : "#8bd7ff", 14);
  combo = Math.min(12, combo + 1);
  audio?.collect();
  if (pickup.kind === "record") {
    score += 260 * combo;
    reveal = Math.min(100, reveal + 3.5);
    melt = Math.min(100, melt + 10);
    toast("ice record +combo", 700, "#f4cf63");
  } else if (pickup.kind === "spark") {
    score += 160 * combo;
    melt = Math.min(100, melt + 28);
    toast("heat spark charged", 700, "#ffcf63");
  } else if (pickup.kind === "shield") {
    shield = 100;
    toast("blue shield live", 900, "#8bd7ff");
  } else {
    score += 420 * combo;
    reveal = Math.min(100, reveal + 8);
    melt = Math.min(100, melt + 16);
    toast("CN checkpoint", 900, "#d7f6ff");
  }
}

function triggerMelt(): void {
  if (state !== "playing" || melt < 100) return;
  melt = 0;
  reveal = Math.min(100, reveal + 18);
  score += hazards.length * 180 * combo;
  hazards.forEach((hazard) => burst(hazard.x + 34, hazard.y + 28, "#ffcf63", 18));
  hazards = [];
  shake = 12;
  toast("MELT MODE: city cleared", 1100, "#f4cf63");
  audio?.melt();
}

function intersects(a: Actor, b: Actor): boolean {
  return a.x + 8 < b.x + b.width - 8 && a.x + a.width - 8 > b.x && a.y + 8 < b.y + b.height && a.y + a.height > b.y + 8;
}

function burst(x: number, y: number, color: string, count: number): void {
  for (let i = 0; i < count; i += 1) {
    particles.push({
      x,
      y,
      vx: (Math.random() - 0.5) * 260,
      vy: -90 - Math.random() * 180,
      life: 360 + Math.random() * 320,
      color,
      size: 3 + Math.random() * 5
    });
  }
}

function toast(value: string, life: number, color: string): void {
  toasts.unshift({ text: value, life, color });
  toasts = toasts.slice(0, 3);
}

function render(delta: number): void {
  ctx.save();
  if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  drawBackground(delta);
  pickups.forEach(drawPickup);
  hazards.forEach(drawHazard);
  drawPlayer(delta);
  drawParticles(delta);
  drawCanvasHud();
  drawToasts(delta);
  ctx.restore();
}

function drawCanvasHud(): void {
  rect(24, 22, 284, 70, "rgba(5,9,16,0.72)");
  outline(24, 22, 284, 70, "rgba(139,215,255,0.55)", 3);
  text(levelNames[level], 42, 36, 18, "#f4cf63");
  text("Collect records. Melt the block. Clear the noise.", 42, 62, 13, "#d7f6ff");
  if (melt >= 100) text("MELT READY", WIDTH - 54, 38, 23, "#f4cf63", "right");
}

function frame(time: number): void {
  const delta = Math.min(time - lastTime, 34) || 16;
  lastTime = time;
  update(delta);
  render(delta);
  syncHud();
  requestAnimationFrame(frame);
}

function syncHud(): void {
  const wholeScore = Math.floor(score);
  if (wholeScore > bestScore) {
    bestScore = wholeScore;
    window.localStorage.setItem(bestKey, String(bestScore));
  }
  scoreEl.textContent = wholeScore.toLocaleString();
  bestEl.textContent = bestScore.toLocaleString();
  comboEl.textContent = `x${combo}`;
  iceEl.textContent = `${ice}`;
  revealEl.textContent = `${Math.floor(reveal)}%`;
  meltMeter.value = melt;
  shieldMeter.value = shield;
  meltBtn.disabled = melt < 100 || state !== "playing";
  meltBtn.textContent = melt >= 100 ? "MELT!" : "Melt";
}

function move(direction: -1 | 1): void {
  if (state === "ready") void startGame(soundEnabled);
  if (state !== "playing") return;
  lane = Math.max(0, Math.min(2, lane + direction)) as Lane;
}

async function ensureAudio(startEnabled: boolean): Promise<void> {
  audio ??= new AudioEngine();
  soundEnabled = startEnabled;
  audio.setMuted(!soundEnabled);
  audioBtn.setAttribute("aria-pressed", String(soundEnabled));
  audioBtn.textContent = soundEnabled ? "Sound on" : "Sound off";
  if (soundEnabled) await audio.start();
}

async function startGame(withSound: boolean): Promise<void> {
  await ensureAudio(withSound);
  state = "playing";
  score = 0;
  combo = 1;
  ice = 3;
  reveal = 0;
  melt = 35;
  shield = 0;
  level = 0;
  lane = 1;
  hazards = [];
  pickups = [];
  particles = [];
  toasts = [];
  spawnTimer = 360;
  pickupTimer = 420;
  waveTimer = 0;
  overlay.classList.add("hidden");
  pauseBtn.textContent = "Pause";
  toast("Episode 1: ice block drop", 1100, "#8bd7ff");
}

function endGame(): void {
  state = "over";
  audio?.stop();
  const won = reveal >= 100;
  episodeLabel.textContent = won ? "Date revealed. The city heard it." : "Run frozen.";
  stateLabel.innerHTML = `Score <b>${Math.floor(score).toLocaleString()}</b>. Best <b>${bestScore.toLocaleString()}</b>. ${won ? "You melted the block." : "Collect sparks sooner and save Melt for crowded lanes."}`;
  primaryBtn.textContent = "Run it back with sound";
  quietBtn.textContent = "Run it back quiet";
  overlay.classList.remove("hidden");
}

function togglePause(): void {
  if (state === "ready") return;
  if (state === "over") {
    void startGame(soundEnabled);
    return;
  }
  state = state === "playing" ? "paused" : "playing";
  pauseBtn.textContent = state === "paused" ? "Resume" : "Pause";
  episodeLabel.textContent = "Paused";
  stateLabel.textContent = "Take a breath. Resume when you are ready.";
  primaryBtn.textContent = "Resume";
  quietBtn.textContent = soundEnabled ? "Mute and resume" : "Sound on";
  overlay.classList.toggle("hidden", state === "playing");
  if (state === "playing" && soundEnabled) {
    void audio?.start();
  } else {
    audio?.stop();
  }
}

primaryBtn.addEventListener("click", () => {
  if (state === "paused") {
    togglePause();
    return;
  }
  void startGame(true);
});

quietBtn.addEventListener("click", () => {
  if (state === "paused") {
    soundEnabled = false;
    audio?.setMuted(true);
    togglePause();
    return;
  }
  void startGame(false);
});

leftBtn.addEventListener("click", () => move(-1));
rightBtn.addEventListener("click", () => move(1));
meltBtn.addEventListener("click", triggerMelt);
pauseBtn.addEventListener("click", togglePause);
audioBtn.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  void ensureAudio(soundEnabled);
});

window.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a") move(-1);
  if (event.key === "ArrowRight" || event.key.toLowerCase() === "d") move(1);
  if (event.key === "ArrowUp" || event.key.toLowerCase() === "w" || event.key === " ") {
    event.preventDefault();
    triggerMelt();
  }
  if (event.key.toLowerCase() === "p") togglePause();
  if (event.key === "Enter" && state !== "playing") void startGame(true);
});

let touchStartX = 0;
let touchStartY = 0;
canvas.addEventListener("touchstart", (event) => {
  touchStartX = event.touches[0]?.clientX ?? 0;
  touchStartY = event.touches[0]?.clientY ?? 0;
});

canvas.addEventListener("touchend", (event) => {
  const endX = event.changedTouches[0]?.clientX ?? touchStartX;
  const endY = event.changedTouches[0]?.clientY ?? touchStartY;
  const dx = endX - touchStartX;
  const dy = endY - touchStartY;
  if (Math.abs(dx) < 18 && Math.abs(dy) < 18) {
    if (state === "ready") void startGame(true);
    else triggerMelt();
    return;
  }
  if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 1 : -1);
  else if (dy < -24) triggerMelt();
});

bestEl.textContent = bestScore.toLocaleString();
requestAnimationFrame(frame);

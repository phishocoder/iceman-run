import "./styles.css";

type GameState = "ready" | "playing" | "paused" | "over";
type Lane = 0 | 1 | 2 | 3;
type FallingKind = "talk" | "camera" | "record" | "spotlight";

interface Falling {
  lane: Lane;
  y: number;
  speed: number;
  kind: FallingKind;
  wobble: number;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

const WIDTH = 1024;
const HEIGHT = 576;
const lanes = [210, 410, 610, 810] as const;
const bpm = 112.75;
const stepMs = 60_000 / bpm / 4;
const bestKey = "janice-room-best";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root not found");

function mustQuery<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

app.innerHTML = `
  <main class="shell">
    <section class="game-card" aria-label="Janice STFU 64-bit arcade game">
      <header class="topbar">
        <div class="brand-block">
          <span class="mark" aria-hidden="true">◆</span>
          <div>
            <p class="kicker">64-bit private-room arcade</p>
            <h1>JANICE ROOM</h1>
          </div>
        </div>
        <div class="stat-grid" aria-live="polite">
          <span><b id="score">0</b><small>score</small></span>
          <span><b id="best">0</b><small>best</small></span>
          <span><b id="combo">x1</b><small>combo</small></span>
          <span><b id="ice">3</b><small>focus</small></span>
          <span><b id="reveal">0%</b><small>room</small></span>
        </div>
      </header>

      <div class="stage-wrap">
        <canvas id="game" width="${WIDTH}" height="${HEIGHT}" aria-label="Playable 64-bit party room game"></canvas>
        <div class="overlay" id="overlay">
          <div class="overlay-panel">
            <p class="episode" id="episodeLabel">One room. One performance. Too much commentary.</p>
            <p id="stateLabel">Move under records and spotlights. Dodge talk bubbles and camera flashes. Charge <b>Silence</b>, then clear the room.</p>
            <button id="primaryBtn" type="button">Start with sound</button>
            <button id="quietBtn" type="button">Start quiet</button>
            <p class="hint">Swipe or tap arrows to move. Tap Silence when charged. Tempo locked to the uploaded memo: 112.75 BPM.</p>
          </div>
        </div>
      </div>

      <div class="meter-row" aria-label="Ability meter">
        <label>
          <span>Silence charge</span>
          <progress id="meltMeter" max="100" value="0"></progress>
        </label>
        <label>
          <span>Room control</span>
          <progress id="shieldMeter" max="100" value="0"></progress>
        </label>
      </div>

      <div class="controls" aria-label="Game controls">
        <button id="leftBtn" type="button" aria-label="Move left">◀</button>
        <button id="meltBtn" type="button">Silence</button>
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
const focusEl = mustQuery<HTMLElement>("#ice");
const roomEl = mustQuery<HTMLElement>("#reveal");
const silenceMeter = mustQuery<HTMLProgressElement>("#meltMeter");
const roomMeter = mustQuery<HTMLProgressElement>("#shieldMeter");
const overlay = mustQuery<HTMLDivElement>("#overlay");
const episodeLabel = mustQuery<HTMLElement>("#episodeLabel");
const stateLabel = mustQuery<HTMLElement>("#stateLabel");
const primaryBtn = mustQuery<HTMLButtonElement>("#primaryBtn");
const quietBtn = mustQuery<HTMLButtonElement>("#quietBtn");
const leftBtn = mustQuery<HTMLButtonElement>("#leftBtn");
const rightBtn = mustQuery<HTMLButtonElement>("#rightBtn");
const silenceBtn = mustQuery<HTMLButtonElement>("#meltBtn");
const pauseBtn = mustQuery<HTMLButtonElement>("#pauseBtn");
const audioBtn = mustQuery<HTMLButtonElement>("#audioBtn");

if (!context) throw new Error("2D canvas unavailable");
const ctx = context;
ctx.imageSmoothingEnabled = false;

let state: GameState = "ready";
let lane: Lane = 1;
let score = 0;
let best = Number(localStorage.getItem(bestKey) ?? 0);
let combo = 1;
let focus = 3;
let room = 0;
let silence = 0;
let spawnTimer = 0;
let lastTime = 0;
let beatPulse = 0;
let shake = 0;
let soundOn = false;
let falling: Falling[] = [];
let sparks: Spark[] = [];
let audio: AudioEngine | null = null;

class AudioEngine {
  private readonly audioContext = new AudioContext();
  private readonly master = this.audioContext.createGain();
  private timer: number | undefined;
  private step = 0;

  constructor() {
    this.master.gain.value = 0.44;
    this.master.connect(this.audioContext.destination);
  }

  async start(): Promise<void> {
    await this.audioContext.resume();
    if (!this.timer) this.timer = window.setInterval(() => this.tick(), stepMs);
  }

  stop(): void {
    if (!this.timer) return;
    window.clearInterval(this.timer);
    this.timer = undefined;
  }

  setMuted(muted: boolean): void {
    this.master.gain.setTargetAtTime(muted ? 0.0001 : 0.44, this.audioContext.currentTime, 0.02);
  }

  startCue(): void {
    [220, 277.18, 369.99, 440, 554.37].forEach((note, index) => {
      window.setTimeout(() => this.tone(note, 0.11, "square", 0.2), index * 82);
    });
  }

  collect(): void {
    this.tone(880, 0.06, "square", 0.18);
    window.setTimeout(() => this.tone(1108.73, 0.08, "square", 0.14), 55);
  }

  hit(): void {
    this.noise(0.13, 0.22);
    this.tone(110, 0.12, "sawtooth", 0.16);
  }

  silence(): void {
    [554.37, 440, 369.99, 277.18].forEach((note, index) => {
      window.setTimeout(() => this.tone(note, 0.14, "square", 0.21), index * 55);
    });
    window.setTimeout(() => this.noise(0.09, 0.12), 250);
  }

  private tick(): void {
    const i = this.step % 32;
    const bass = [138.59, 138.59, 207.65, 207.65, 164.81, 164.81, 246.94, 246.94];
    const lead = [0, 554.37, 0, 622.25, 739.99, 0, 622.25, 0, 0, 493.88, 0, 554.37, 622.25, 0, 493.88, 0];
    const arp = [277.18, 329.63, 415.3, 493.88, 329.63, 415.3, 554.37, 622.25];
    if (i % 8 === 0) this.kick();
    if (i % 8 === 4) this.snare();
    if (i % 2 === 1) this.noise(0.018, 0.075);
    if (i % 4 === 0) this.tone(bass[Math.floor(i / 4) % bass.length], 0.18, "triangle", 0.17);
    this.tone(arp[i % arp.length], 0.045, "square", i % 4 === 0 ? 0.11 : 0.075);
    if (lead[i % lead.length]) this.tone(lead[i % lead.length], 0.1, "square", 0.12);
    this.step += 1;
  }

  private kick(): void {
    const now = this.audioContext.currentTime;
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(116, now);
    osc.frequency.exponentialRampToValueAtTime(44, now + 0.12);
    gain.gain.setValueAtTime(0.28, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.15);
  }

  private snare(): void {
    this.noise(0.055, 0.16);
    this.tone(196, 0.055, "triangle", 0.08);
  }

  private tone(frequency: number, duration: number, type: OscillatorType, volume: number): void {
    const now = this.audioContext.currentTime;
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  private noise(duration: number, volume: number): void {
    const buffer = this.audioContext.createBuffer(1, this.audioContext.sampleRate * duration, this.audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    const src = this.audioContext.createBufferSource();
    const gain = this.audioContext.createGain();
    gain.gain.value = volume;
    src.buffer = buffer;
    src.connect(gain).connect(this.master);
    src.start();
  }
}

function rect(x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

function stroke(x: number, y: number, w: number, h: number, color: string, s = 4): void {
  rect(x, y, w, s, color);
  rect(x, y + h - s, w, s, color);
  rect(x, y, s, h, color);
  rect(x + w - s, y, s, h, color);
}

function label(value: string, x: number, y: number, size = 18, color = "#f7f2d4", align: CanvasTextAlign = "left"): void {
  ctx.fillStyle = color;
  ctx.font = `700 ${size}px "Courier New", monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = "top";
  ctx.fillText(value, Math.round(x), Math.round(y));
}

function update(delta: number): void {
  if (state !== "playing") return;
  spawnTimer -= delta;
  room = Math.min(100, room + delta * 0.004 + combo * 0.002);
  silence = Math.min(100, silence + delta * 0.006);
  score += delta * 0.035 * combo;
  beatPulse = Math.max(0, beatPulse - delta * 0.003);
  shake = Math.max(0, shake - delta * 0.04);

  if (spawnTimer <= 0) {
    spawnTimer = Math.max(420, 880 - room * 3);
    spawnFalling();
  }

  falling = falling.filter((item) => {
    item.y += item.speed * (delta / 1000);
    item.wobble += delta * 0.006;
    if (item.y > 392 && item.y < 478 && item.lane === lane) {
      item.kind === "record" || item.kind === "spotlight" ? collect(item.kind) : hit();
      return false;
    }
    return item.y < HEIGHT + 70;
  });

  sparks = sparks.filter((spark) => {
    spark.life -= delta;
    spark.x += spark.vx * (delta / 1000);
    spark.y += spark.vy * (delta / 1000);
    spark.vy += 180 * (delta / 1000);
    return spark.life > 0;
  });
}

function spawnFalling(): void {
  const roll = Math.random();
  const kind: FallingKind = roll > 0.76 ? "record" : roll > 0.62 ? "spotlight" : roll > 0.28 ? "talk" : "camera";
  const itemLane = Math.floor(Math.random() * lanes.length) as Lane;
  falling.push({
    lane: itemLane,
    y: -70,
    speed: 170 + room * 1.4 + Math.random() * 55,
    kind,
    wobble: Math.random() * 6
  });
}

function collect(kind: "record" | "spotlight"): void {
  const x = lanes[lane];
  burst(x, 420, kind === "record" ? "#f4cf63" : "#8bd7ff");
  combo = Math.min(9, combo + 1);
  score += kind === "record" ? 240 * combo : 420 * combo;
  silence = Math.min(100, silence + (kind === "record" ? 14 : 24));
  room = Math.min(100, room + (kind === "record" ? 4 : 8));
  beatPulse = 1;
  audio?.collect();
  if (room >= 100) endGame(true);
}

function hit(): void {
  burst(lanes[lane], 420, "#ff5f79");
  focus -= 1;
  combo = 1;
  room = Math.max(0, room - 8);
  shake = 8;
  audio?.hit();
  if (focus <= 0) endGame(false);
}

function useSilence(): void {
  if (state !== "playing" || silence < 100) return;
  silence = 0;
  score += falling.filter((item) => item.kind === "talk" || item.kind === "camera").length * 180;
  falling = falling.filter((item) => item.kind === "record" || item.kind === "spotlight");
  room = Math.min(100, room + 18);
  beatPulse = 1;
  shake = 10;
  audio?.silence();
  if (room >= 100) endGame(true);
}

function burst(x: number, y: number, color: string): void {
  for (let i = 0; i < 18; i += 1) {
    sparks.push({
      x,
      y,
      vx: (Math.random() - 0.5) * 270,
      vy: -80 - Math.random() * 160,
      life: 420 + Math.random() * 240,
      color
    });
  }
}

function render(delta: number): void {
  ctx.save();
  if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  drawRoom(delta);
  falling.forEach(drawFalling);
  drawPlayer();
  drawSparks();
  drawGameText();
  ctx.restore();
}

function drawRoom(delta: number): void {
  const pulse = 1 + beatPulse * 0.08;
  const wall = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  wall.addColorStop(0, "#0b1224");
  wall.addColorStop(0.48, "#18253a");
  wall.addColorStop(1, "#120d1c");
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  rect(0, 0, WIDTH, 92, "rgba(6, 10, 20, 0.82)");
  for (let y = 92; y < 410; y += 34) {
    rect(0, y, WIDTH, 3, "rgba(139, 215, 255, 0.05)");
  }

  const floor = ctx.createLinearGradient(0, 398, 0, HEIGHT);
  floor.addColorStop(0, "#2b1737");
  floor.addColorStop(1, "#0d0814");
  ctx.fillStyle = floor;
  ctx.fillRect(0, 398, WIDTH, 178);
  for (let x = -120; x < WIDTH + 120; x += 88) {
    rect(x, 398, 42, 178, x % 176 === 0 ? "rgba(244, 207, 99, 0.08)" : "rgba(139, 215, 255, 0.06)");
  }

  rect(78, 108, 868, 284, "#172034");
  rect(96, 124, 832, 246, "#202a42");
  stroke(78, 108, 868, 284, "#617891", 5);
  rect(142, 132, 740, 54, "#090d18");
  label("PRIVATE ROOM", WIDTH / 2, 145, 28 * pulse, "#8bd7ff", "center");
  label("DIRECT TO CAMERA. KEEP THE ROOM QUIET.", WIDTH / 2, 192, 16, "#f4cf63", "center");

  rect(118, 240, 156, 84, "rgba(139, 215, 255, 0.18)");
  rect(750, 230, 162, 96, "rgba(244, 207, 99, 0.14)");
  stroke(118, 240, 156, 84, "#40556d", 3);
  stroke(750, 230, 162, 96, "#5b4d25", 3);

  for (const laneX of lanes) {
    const selected = laneX === lanes[lane];
    rect(laneX - 60, 394, 120, 12, selected ? "#f4cf63" : "#52677c");
    rect(laneX - 44, 406, 88, 9, selected ? "#fff3a1" : "#28354a");
  }

  rect(835, 212, 66, 106, "#f4cf63");
  rect(846, 226, 44, 74, "#ffe27d");
  rect(858, 318, 24, 84, "#8bd7ff");
  rect(816, 396, 108, 12, "#f4cf63");
}

function drawPlayer(): void {
  const x = lanes[lane] - 58;
  const y = 300 + Math.sin(performance.now() / 120) * 4;

  rect(x + 22, y + 122, 24, 18, "#d7f6ff");
  rect(x + 74, y + 122, 24, 18, "#d7f6ff");
  rect(x + 16, y + 84, 34, 44, "#080b13");
  rect(x + 70, y + 84, 34, 44, "#080b13");

  rect(x + 8, y + 48, 104, 54, "#080b13");
  rect(x + 18, y + 56, 84, 34, "#1f2d42");
  rect(x + 16, y + 46, 90, 14, "#f4cf63");
  rect(x + 34, y + 64, 52, 10, "#fff3a1");

  rect(x + 24, y + 6, 72, 54, "#b77755");
  rect(x + 18, y, 82, 18, "#12151c");
  rect(x + 24, y + 15, 16, 18, "#12151c");
  rect(x + 80, y + 15, 16, 18, "#12151c");
  rect(x + 26, y + 27, 68, 24, "#21120f");
  rect(x + 42, y + 20, 14, 7, "#06080d");
  rect(x + 66, y + 20, 14, 7, "#06080d");
  rect(x + 52, y + 35, 22, 7, "#f0b68d");

  rect(x + 12, y + 60, 18, 46, "#090d18");
  rect(x + 92, y + 60, 18, 46, "#090d18");
  rect(x + 104, y + 92, 30, 10, "#f4cf63");
  rect(x + 130, y + 88, 18, 18, "#d7f6ff");
  rect(x + 148, y + 93, 22, 6, "#8bd7ff");
}

function drawFalling(item: Falling): void {
  const x = lanes[item.lane] + Math.sin(item.wobble) * 9;
  const y = item.y;
  if (item.kind === "talk") {
    rect(x - 58, y, 116, 46, "#eef6ff");
    stroke(x - 58, y, 116, 46, "#080b13", 4);
    rect(x - 20, y + 44, 22, 16, "#eef6ff");
    label("TALK", x, y + 13, 20, "#080b13", "center");
  } else if (item.kind === "camera") {
    rect(x - 44, y + 8, 88, 52, "#080b13");
    rect(x - 24, y - 4, 48, 22, "#28344a");
    rect(x + 20, y + 24, 32, 18, "#f4cf63");
    rect(x - 12, y + 24, 24, 24, "#8bd7ff");
  } else if (item.kind === "record") {
    rect(x - 30, y, 60, 60, "#f4cf63");
    rect(x - 18, y + 12, 36, 36, "#080b13");
    rect(x - 5, y + 25, 10, 10, "#f4cf63");
  } else {
    rect(x - 12, y, 24, 70, "#8bd7ff");
    rect(x - 42, y + 24, 84, 14, "#d7f6ff");
    rect(x - 20, y + 14, 40, 34, "#f4cf63");
  }
}

function drawSparks(): void {
  sparks.forEach((spark) => rect(spark.x, spark.y, 5, 5, spark.color));
}

function drawGameText(): void {
  rect(22, 18, 440, 40, "rgba(5, 9, 18, 0.62)");
  label("DODGE TALK + FLASH", 38, 25, 20, "#d7f6ff");
  label("CATCH RECORDS + LIGHT", 252, 25, 20, "#f4cf63");
  if (silence >= 100) label("SILENCE READY", WIDTH - 40, 28, 24, "#f4cf63", "right");
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
  const whole = Math.floor(score);
  if (whole > best) {
    best = whole;
    localStorage.setItem(bestKey, String(best));
  }
  scoreEl.textContent = whole.toLocaleString();
  bestEl.textContent = best.toLocaleString();
  comboEl.textContent = `x${combo}`;
  focusEl.textContent = `${focus}`;
  roomEl.textContent = `${Math.floor(room)}%`;
  silenceMeter.value = silence;
  roomMeter.value = room;
  silenceBtn.disabled = silence < 100 || state !== "playing";
  silenceBtn.textContent = silence >= 100 ? "SILENCE!" : "Silence";
}

async function ensureAudio(enabled: boolean): Promise<void> {
  audio ??= new AudioEngine();
  soundOn = enabled;
  audio.setMuted(!enabled);
  audioBtn.textContent = enabled ? "Sound on ✓" : "Sound off";
  audioBtn.setAttribute("aria-pressed", String(enabled));
  if (enabled) {
    await audio.start();
    audio.startCue();
  }
}

async function startGame(withSound: boolean): Promise<void> {
  await ensureAudio(withSound);
  state = "playing";
  lane = 1;
  score = 0;
  combo = 1;
  focus = 3;
  room = 0;
  silence = 24;
  spawnTimer = 420;
  falling = [];
  sparks = [];
  overlay.classList.add("hidden");
  pauseBtn.textContent = "Pause";
}

function endGame(won: boolean): void {
  state = "over";
  audio?.stop();
  episodeLabel.textContent = won ? "Room controlled." : "Focus broken.";
  stateLabel.innerHTML = won
    ? `You kept the room locked in. Score <b>${Math.floor(score).toLocaleString()}</b>.`
    : `The commentary got too loud. Score <b>${Math.floor(score).toLocaleString()}</b>.`;
  primaryBtn.textContent = "Run it back with sound";
  quietBtn.textContent = "Run it back quiet";
  overlay.classList.remove("hidden");
}

function move(direction: -1 | 1): void {
  if (state === "ready") void startGame(soundOn);
  if (state !== "playing") return;
  lane = Math.max(0, Math.min(3, lane + direction)) as Lane;
}

function togglePause(): void {
  if (state === "ready") return;
  if (state === "over") {
    void startGame(soundOn);
    return;
  }
  state = state === "playing" ? "paused" : "playing";
  pauseBtn.textContent = state === "paused" ? "Resume" : "Pause";
  episodeLabel.textContent = "Paused";
  stateLabel.textContent = "Resume when you are ready.";
  primaryBtn.textContent = "Resume";
  quietBtn.textContent = soundOn ? "Mute and resume" : "Sound on";
  overlay.classList.toggle("hidden", state === "playing");
  if (state === "playing" && soundOn) void audio?.start();
  else audio?.stop();
}

primaryBtn.addEventListener("click", () => {
  if (state === "paused") togglePause();
  else void startGame(true);
});
quietBtn.addEventListener("click", () => {
  if (state === "paused") {
    soundOn = false;
    audio?.setMuted(true);
    togglePause();
  } else {
    void startGame(false);
  }
});
leftBtn.addEventListener("click", () => move(-1));
rightBtn.addEventListener("click", () => move(1));
silenceBtn.addEventListener("click", useSilence);
pauseBtn.addEventListener("click", togglePause);
audioBtn.addEventListener("click", () => void ensureAudio(!soundOn));

window.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a") move(-1);
  if (event.key === "ArrowRight" || event.key.toLowerCase() === "d") move(1);
  if (event.key === " " || event.key === "ArrowUp") {
    event.preventDefault();
    useSilence();
  }
  if (event.key.toLowerCase() === "p") togglePause();
});

let touchStartX = 0;
canvas.addEventListener("touchstart", (event) => {
  touchStartX = event.touches[0]?.clientX ?? 0;
});
canvas.addEventListener("touchend", (event) => {
  const endX = event.changedTouches[0]?.clientX ?? touchStartX;
  const dx = endX - touchStartX;
  if (Math.abs(dx) < 20) useSilence();
  else move(dx > 0 ? 1 : -1);
});

bestEl.textContent = best.toLocaleString();
requestAnimationFrame(frame);

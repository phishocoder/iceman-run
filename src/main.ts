import "./styles.css";

type GameState = "ready" | "playing" | "paused" | "over";
type Lane = 0 | 1 | 2;

interface Actor {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Hazard extends Actor {
  speed: number;
  kind: "noise" | "ice";
}

interface Collectible extends Actor {
  speed: number;
  spin: number;
}

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root not found");
}

function mustQuery<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Required element missing: ${selector}`);
  }
  return element;
}

app.innerHTML = `
  <main class="shell">
    <section class="game-card" aria-label="ICEMAN RUN arcade game">
      <div class="topbar">
        <div>
          <p class="kicker">OVO fan arcade</p>
          <h1>ICEMAN RUN</h1>
        </div>
        <div class="stat-grid" aria-live="polite">
          <span><b id="score">0</b><small>score</small></span>
          <span><b id="streak">x1</b><small>streak</small></span>
          <span><b id="hearts">3</b><small>ice</small></span>
        </div>
      </div>

      <div class="stage-wrap">
        <canvas id="game" width="960" height="540" aria-label="Playable 8-bit runner game"></canvas>
        <div class="overlay" id="overlay">
          <div class="overlay-panel">
            <p id="stateLabel">Tap start and outrun the noise.</p>
            <button id="primaryBtn" type="button">Start run</button>
            <p class="hint">Move lanes, collect ice records, dodge speech-bubble static.</p>
          </div>
        </div>
      </div>

      <div class="controls" aria-label="Game controls">
        <button id="leftBtn" type="button" aria-label="Move left">◀</button>
        <button id="audioBtn" type="button" aria-pressed="false">Audio</button>
        <button id="pauseBtn" type="button">Pause</button>
        <button id="rightBtn" type="button" aria-label="Move right">▶</button>
      </div>
    </section>
  </main>
`;

const canvas = mustQuery<HTMLCanvasElement>("#game");
const context = canvas.getContext("2d");
const scoreEl = mustQuery<HTMLElement>("#score");
const streakEl = mustQuery<HTMLElement>("#streak");
const heartsEl = mustQuery<HTMLElement>("#hearts");
const overlay = mustQuery<HTMLDivElement>("#overlay");
const stateLabel = mustQuery<HTMLElement>("#stateLabel");
const primaryBtn = mustQuery<HTMLButtonElement>("#primaryBtn");
const leftBtn = mustQuery<HTMLButtonElement>("#leftBtn");
const rightBtn = mustQuery<HTMLButtonElement>("#rightBtn");
const pauseBtn = mustQuery<HTMLButtonElement>("#pauseBtn");
const audioBtn = mustQuery<HTMLButtonElement>("#audioBtn");

if (!context) {
  throw new Error("2D canvas context is unavailable");
}

const ctx = context;
const lanes = [canvas.width * 0.28, canvas.width * 0.5, canvas.width * 0.72] as const;
let state: GameState = "ready";
let lane: Lane = 1;
let score = 0;
let streak = 1;
let hearts = 3;
let spawnTimer = 0;
let recordTimer = 0;
let lastTime = 0;
let skylineShift = 0;
let hazards: Hazard[] = [];
let records: Collectible[] = [];
let audio: AudioEngine | null = null;

const player: Actor = {
  x: lanes[lane] - 28,
  y: canvas.height - 112,
  width: 56,
  height: 72
};

class AudioEngine {
  private readonly audioContext = new AudioContext();
  private timer: number | undefined;
  private step = 0;
  private muted = true;

  toggle(): boolean {
    this.muted = !this.muted;
    if (!this.muted) {
      void this.audioContext.resume();
      this.start();
    } else {
      this.stop();
    }
    return !this.muted;
  }

  start(): void {
    if (this.muted || this.timer) return;
    this.timer = window.setInterval(() => this.playStep(), 138);
  }

  stop(): void {
    if (!this.timer) return;
    window.clearInterval(this.timer);
    this.timer = undefined;
  }

  blip(frequency = 880): void {
    if (this.muted) return;
    this.tone(frequency, 0.045, "square", 0.055);
  }

  private playStep(): void {
    const bass = [110, 110, 146.83, 130.81, 98, 110, 164.81, 146.83];
    const lead = [440, 0, 493.88, 0, 392, 440, 329.63, 0];
    const index = this.step % bass.length;
    this.tone(bass[index], 0.09, "triangle", 0.08);
    if (lead[index] > 0 && this.step % 2 === 0) {
      this.tone(lead[index], 0.055, "square", 0.04);
    }
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
    oscillator.connect(gain).connect(this.audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.015);
  }
}

function drawPixelRect(x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

function drawText(text: string, x: number, y: number, size = 18, color = "#f7f2d4"): void {
  ctx.fillStyle = color;
  ctx.font = `${size}px "Courier New", monospace`;
  ctx.textBaseline = "top";
  ctx.fillText(text, x, y);
}

function drawBackground(delta: number): void {
  skylineShift = (skylineShift + delta * 0.018) % canvas.width;
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, "#07111f");
  gradient.addColorStop(0.62, "#12233b");
  gradient.addColorStop(1, "#0d1422");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < 72; i += 1) {
    const x = (i * 83 + skylineShift * 0.25) % canvas.width;
    drawPixelRect(x, 28 + (i % 5) * 17, 3, 3, i % 3 === 0 ? "#f4cf63" : "#8bd7ff");
  }

  for (let i = -1; i < 12; i += 1) {
    const x = i * 96 - (skylineShift * 0.6) % 96;
    const height = 70 + (i % 5) * 24;
    drawPixelRect(x, canvas.height - 172 - height, 70, height, "#101a2d");
    drawPixelRect(x + 8, canvas.height - 160 - height, 8, 8, "#f4cf63");
    drawPixelRect(x + 40, canvas.height - 132 - height, 8, 8, "#5fd6ff");
  }

  drawPixelRect(0, canvas.height - 92, canvas.width, 92, "#162b3d");
  drawPixelRect(0, canvas.height - 98, canvas.width, 6, "#d7f6ff");
  for (const laneX of lanes) {
    drawPixelRect(laneX - 3, canvas.height - 92, 6, 92, "rgba(215, 246, 255, 0.22)");
  }
}

function drawPlayer(): void {
  player.x += (lanes[lane] - player.width / 2 - player.x) * 0.24;
  const x = player.x;
  const y = player.y;
  drawPixelRect(x + 8, y + 16, 40, 44, "#171717");
  drawPixelRect(x + 14, y, 28, 22, "#c28d61");
  drawPixelRect(x + 10, y + 20, 36, 12, "#f2c75a");
  drawPixelRect(x + 18, y + 7, 8, 5, "#07111f");
  drawPixelRect(x + 32, y + 7, 8, 5, "#07111f");
  drawPixelRect(x + 2, y + 28, 10, 26, "#202020");
  drawPixelRect(x + 44, y + 28, 10, 26, "#202020");
  drawPixelRect(x + 14, y + 60, 10, 12, "#d7f6ff");
  drawPixelRect(x + 34, y + 60, 10, 12, "#d7f6ff");
}

function drawHazard(hazard: Hazard): void {
  if (hazard.kind === "ice") {
    drawPixelRect(hazard.x + 10, hazard.y, 24, 48, "#87eaff");
    drawPixelRect(hazard.x + 16, hazard.y + 8, 10, 30, "#e4fbff");
    return;
  }
  drawPixelRect(hazard.x, hazard.y + 8, 64, 34, "#eef6ff");
  drawPixelRect(hazard.x + 12, hazard.y + 42, 12, 12, "#eef6ff");
  drawText("STFU", hazard.x + 9, hazard.y + 16, 14, "#101a2d");
}

function drawRecord(record: Collectible): void {
  const x = record.x + Math.sin(record.spin) * 5;
  drawPixelRect(x, record.y, 42, 42, "#f4cf63");
  drawPixelRect(x + 8, record.y + 8, 26, 26, "#151a22");
  drawPixelRect(x + 18, record.y + 18, 6, 6, "#f4cf63");
}

function update(delta: number): void {
  if (state !== "playing") return;
  spawnTimer -= delta;
  recordTimer -= delta;
  score += delta * 0.028 * streak;

  if (spawnTimer <= 0) {
    spawnTimer = Math.max(520, 1100 - score * 0.9);
    const hazardLane = Math.floor(Math.random() * lanes.length) as Lane;
    hazards.push({
      x: lanes[hazardLane] - 32,
      y: -64,
      width: 64,
      height: 54,
      speed: 170 + score * 0.07,
      kind: Math.random() > 0.78 ? "ice" : "noise"
    });
  }

  if (recordTimer <= 0) {
    recordTimer = 780;
    const recordLane = Math.floor(Math.random() * lanes.length) as Lane;
    records.push({
      x: lanes[recordLane] - 21,
      y: -44,
      width: 42,
      height: 42,
      speed: 150 + score * 0.04,
      spin: 0
    });
  }

  hazards = hazards.filter((hazard) => {
    hazard.y += hazard.speed * (delta / 1000);
    if (intersects(player, hazard)) {
      hearts -= 1;
      streak = 1;
      audio?.blip(140);
      if (hearts <= 0) endGame();
      return false;
    }
    return hazard.y < canvas.height + 80;
  });

  records = records.filter((record) => {
    record.y += record.speed * (delta / 1000);
    record.spin += delta * 0.01;
    if (intersects(player, record)) {
      score += 250 * streak;
      streak = Math.min(streak + 1, 9);
      audio?.blip(1046.5);
      return false;
    }
    return record.y < canvas.height + 70;
  });
}

function intersects(a: Actor, b: Actor): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function render(delta: number): void {
  drawBackground(delta);
  hazards.forEach(drawHazard);
  records.forEach(drawRecord);
  drawPlayer();
  drawText("DODGE THE NOISE", 28, 28, 20, "#f4cf63");
  drawText("COLLECT ICE RECORDS", 28, 56, 16, "#8bd7ff");
}

function frame(time: number): void {
  const delta = Math.min(time - lastTime, 32) || 16;
  lastTime = time;
  update(delta);
  render(delta);
  syncHud();
  requestAnimationFrame(frame);
}

function syncHud(): void {
  scoreEl.textContent = Math.floor(score).toLocaleString();
  streakEl.textContent = `x${streak}`;
  heartsEl.textContent = `${hearts}`;
}

function move(direction: -1 | 1): void {
  if (state === "ready") startGame();
  if (state !== "playing") return;
  lane = Math.max(0, Math.min(2, lane + direction)) as Lane;
}

function startGame(): void {
  state = "playing";
  score = 0;
  streak = 1;
  hearts = 3;
  lane = 1;
  hazards = [];
  records = [];
  spawnTimer = 400;
  recordTimer = 250;
  overlay.classList.add("hidden");
  pauseBtn.textContent = "Pause";
  audio?.start();
}

function endGame(): void {
  state = "over";
  stateLabel.textContent = `Run iced out at ${Math.floor(score).toLocaleString()} points.`;
  primaryBtn.textContent = "Run it back";
  overlay.classList.remove("hidden");
  audio?.stop();
}

function togglePause(): void {
  if (state === "ready") return;
  if (state === "over") {
    startGame();
    return;
  }
  state = state === "playing" ? "paused" : "playing";
  pauseBtn.textContent = state === "paused" ? "Resume" : "Pause";
  stateLabel.textContent = "Paused on ice.";
  primaryBtn.textContent = "Resume";
  overlay.classList.toggle("hidden", state === "playing");
  if (state === "playing") {
    audio?.start();
  } else {
    audio?.stop();
  }
}

primaryBtn.addEventListener("click", () => {
  startGame();
});

leftBtn.addEventListener("click", () => move(-1));
rightBtn.addEventListener("click", () => move(1));
pauseBtn.addEventListener("click", togglePause);
audioBtn.addEventListener("click", () => {
  audio ??= new AudioEngine();
  const enabled = audio.toggle();
  audioBtn.setAttribute("aria-pressed", String(enabled));
  audioBtn.textContent = enabled ? "Mute" : "Audio";
});

window.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a") move(-1);
  if (event.key === "ArrowRight" || event.key.toLowerCase() === "d") move(1);
  if (event.key === " " || event.key === "Enter") {
    event.preventDefault();
    if (state === "playing") togglePause();
    else startGame();
  }
});

let touchStartX = 0;
canvas.addEventListener("touchstart", (event) => {
  touchStartX = event.touches[0]?.clientX ?? 0;
});

canvas.addEventListener("touchend", (event) => {
  const endX = event.changedTouches[0]?.clientX ?? touchStartX;
  if (Math.abs(endX - touchStartX) < 18) {
    startGame();
    return;
  }
  move(endX > touchStartX ? 1 : -1);
});

requestAnimationFrame(frame);

const ASSETS = {
  katy: "./assets/images/katy.PNG",
  hook: "./assets/images/hook.PNG",
  hookGrabbing: "./assets/images/hook_grabbing.PNG",
  fire: "./assets/images/fire.PNG",
  boom: "./assets/images/boom.png",
  bug: "./assets/images/bug.PNG",
  bugWithCrystal: "./assets/images/bug_with_crystal.PNG",
  fight0: "./assets/images/fight-0.PNG",
  fight1: "./assets/images/fight-1.PNG",
  sky: "./assets/images/sky.jpg",
  ground: "./assets/images/ground.jpg",
};

/** 铠虫：每局 35% 概率出现 1～2 只；40% 为带水晶立绘 */
const BUG_SPAWN_CHANCE = 0.35;
const BUG_WITH_CRYSTAL_CHANCE = 0.4;
const BUG_SCALE = 0.5;
const BUG_MOVE_SPEED_MIN = 105;
const BUG_MOVE_SPEED_MAX = 195;
const BUG_INPUT_LOCK_MS = 5000;
const BUG_FIGHT_FRAME_MS = 500;

/** 抓取回收：除「最小水晶」外，水晶/石头相对当前公式再乘此系数（空钩速度不变） */
const GRAB_RETRACT_NON_MIN_MULT = 0.75;

/** 每累计多少分，火焰计数 +1（单次抓取最高 500，不可能一次跨两档 800） */
const FIRE_SCORE_THRESHOLD = 800;

/** 火焰次数跨局继承（sessionStorage：同标签内刷新保留，关标签清零） */
const FIRE_CHARGES_STORAGE_KEY = "crystalMiner_fireCharges";

/** 音效开关（localStorage） */
const SOUND_STORAGE_KEY = "crystalMiner_soundOn";

const AUDIO_PATHS = {
  background: "./assets/audios/background.mp3",
  shoot: "./assets/audios/shoot.mp3",
  fireGet: "./assets/audios/fire-get.mp3",
  boom: "./assets/audios/boom.mp3",
  fight: "./assets/audios/fight.mp3",
  crystal: "./assets/audios/crystal.mp3",
  stone: "./assets/audios/stone.mp3",
  bug: "./assets/audios/bug.mp3",
};

const ICON_SOUND_ON = "./assets/images/icons/sound.PNG";
const ICON_SOUND_OFF = "./assets/images/icons/no_sound.PNG";

/** 获得火焰音效音量（约比其他音效低一半） */
const FIRE_GET_VOLUME = 0.5;

function createAudioPool(paths) {
  const out = {};
  for (const [key, src] of Object.entries(paths)) {
    const a = new Audio(src);
    a.preload = "auto";
    if (key === "background") a.loop = true;
    if (key === "fireGet") a.volume = FIRE_GET_VOLUME;
    out[key] = a;
  }
  return out;
}

/** 水晶 / 石头多美术变体：随机时从中选一张 */
const CRYSTAL_VARIANTS = [
  "./assets/images/crystal-0.PNG",
  "./assets/images/crystal-1.PNG",
  "./assets/images/crystal-2.PNG",
];
const STONE_VARIANTS = [
  "./assets/images/stone-0.PNG",
  "./assets/images/stone-1.PNG",
];

/** 与 CSS / isMobile 断点一致：窄屏用较小倍率区间，宽屏用较大倍率区间 */
const MINERAL_BREAKPOINT_QUERY = "(max-width: 860px)";

const MINERAL_LAYOUT_WIDE = {
  crystalScales: [0.3, 0.6, 0.8, 1.0],
  crystalScores: { 0.3: 50, 0.6: 150, 0.8: 300, 1.0: 500 },
  stoneScales: [0.3, 0.7, 1.0],
  stoneScores: { 0.3: 10, 0.7: 15, 1.0: 20 },
  minCrystalScaleForSpeed: 0.3,
};

const MINERAL_LAYOUT_NARROW = {
  crystalScales: [0.2, 0.4, 0.6, 0.7],
  crystalScores: { 0.2: 50, 0.4: 150, 0.6: 300, 0.7: 500 },
  stoneScales: [0.2, 0.5, 0.7],
  stoneScores: { 0.2: 10, 0.5: 15, 0.7: 20 },
  minCrystalScaleForSpeed: 0.2,
};

/** 得分飘字颜色：与 crystal-0 / crystal-1 / crystal-2 对应 */
const CRYSTAL_SCORE_POPUP_COLORS = [
  "#7bdbff", // crystal-0
  "#78ffd1", // crystal-1
  "#e556ff", // crystal-2
];
const STONE_SCORE_POPUP_COLOR = "#94a3b8";

const DEG2RAD = Math.PI / 180;

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function createImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load: ${src}`));
    img.src = src;
  });
}

async function loadAssets() {
  const out = {};
  await Promise.all(
    Object.entries(ASSETS).map(async ([key, src]) => {
      out[key] = await createImage(src);
    })
  );
  out.crystalVariants = await Promise.all(CRYSTAL_VARIANTS.map((src) => createImage(src)));
  out.stoneVariants = await Promise.all(STONE_VARIANTS.map((src) => createImage(src)));
  return out;
}

function speedForCrystalBase(baseSpeedPxPerSec, crystalScale, minCrystalScale) {
  // 最小倍率的水晶回收速度与 base 相同；更大倍率更慢。
  return baseSpeedPxPerSec * (minCrystalScale / crystalScale);
}

function speedForStoneFromCrystalSpeed(crystalSpeedPxPerSec) {
  // same-sized crystal is 2x stone
  return crystalSpeedPxPerSec / 2;
}

function scoreForMineral(layout, type, scale) {
  if (!layout) return 0;
  if (type === "crystal") return layout.crystalScores[scale] ?? 0;
  if (type === "stone") return layout.stoneScores[scale] ?? 0;
  return 0;
}

class Game {
  constructor() {
    this.canvas = document.getElementById("gameCanvas");
    this.ctx = this.canvas.getContext("2d", { alpha: true });

    this.scoreEl = document.getElementById("score");
    this.timeEl = document.getElementById("time");
    this.fireCountEl = document.getElementById("fireCount");
    this.bombBtn = document.getElementById("bombBtn");

    /** 可用火焰次数：达 800 分 +1，使用「炸！」-1 */
    this.fireCharges = 0;
    /** @type {null | { phase: 'fly' | 'boom', t: number, dur: number, sx: number, sy: number, tx: number, ty: number, bx?: number, by?: number, boomW?: number, boomH?: number }} */
    this.bombState = null;
    this.overlay = document.getElementById("overlay");
    this.finalText = document.getElementById("finalText");
    this.restartBtn = document.getElementById("restartBtn");
    this.pauseOverlay = document.getElementById("pauseOverlay");
    this.helpOverlay = document.getElementById("helpOverlay");
    this.pauseBtn = document.getElementById("pauseBtn");
    this.helpBtn = document.getElementById("helpBtn");
    this.resumeFromPauseBtn = document.getElementById("resumeFromPauseBtn");
    this.resumeFromHelpBtn = document.getElementById("resumeFromHelpBtn");
    this.soundBtn = document.getElementById("soundBtn");
    this.soundIcon = document.getElementById("soundIcon");

    /** 说明 / 暂停面板打开时冻结玩法与倒计时 */
    this.menuPaused = false;

    /** 是否播放音效与背景音乐（可关） */
    this.soundEnabled = true;
    try {
      const v = localStorage.getItem(SOUND_STORAGE_KEY);
      if (v === "0") this.soundEnabled = false;
    } catch {
      // ignore
    }

    /** @type {null | Record<string, HTMLAudioElement>} */
    this.audio = null;

    this.assets = null;
    /** 宽窄屏矿物倍率与分值（在 recomputeLayout 中刷新） */
    this.mineralLayout = MINERAL_LAYOUT_WIDE;

    // Game settings (easy tweak)
    this.GAME_DURATION_MS = 60000; // 1min
    this.MINERALS_COUNT = 14; // desktop/base
    this.mineralsCount = this.MINERALS_COUNT;
    this.hookAngleMin = 0;
    this.hookAngleMax = 180;
    this.hookAngleSpeedDegPerSec = 95; // slower swing speed
    this.midpointOverlapFactor = 0.82; // point-circle match tolerance
    // Hook sprite looks opposite to the math line direction; rotate it by 180deg to fix.
    this.hookSpriteRotationOffsetDeg = 180;

    this.state = "loading"; // loading | swing | launching | grabbing | returning | gameover
    this.score = 0;
    this.timeLeftMs = this.GAME_DURATION_MS;

    this.angle = 0;
    this.angleDir = 1;

    this.layout = null;
    this.minerals = [];

    this.fireLength = 0;
    this.hookLength = 0;
    this.hookRestLength = 0;
    this.hookMaxLength = 0;

    this.fixedAngle = null;
    this.grabbed = null;

    /** @type {{ text: string, x: number, y: number, vy: number, color: string, life: number, maxLife: number, fontSize: number, firePlusOne: boolean }[]} */
    this.scorePopups = [];

    this.baseSpeedPxPerSec = 600;
    this.lastTs = 0;

    this.pointerLockPreventMultiTap = false;

    // Return (grabbed+hook return) speed multiplier: 0.8 => ~20% slower
    this.retractSpeedMultiplier = 0.8;

    // Hook line visual thickness (must match drawScene lineWidth)
    this.lineWidthCss = 5;
    this.lineHalfWidthCss = this.lineWidthCss / 2;
    // Collision sampling quality: smaller => more accurate but heavier
    this.collisionSampleStepPx = 1.9;
    // Sample points across the line thickness to better match thick stroke
    this.collisionLineOffsets = [-2.2, 0, 2.2];
    this.collisionPixelAlphaThreshold = 20;

    // Precomputed alpha masks for pixel-perfect collision
    this.alphaMasks = null;

    /** 抓取铠虫后禁止操作直到时间戳（performance.now） */
    this.inputLockedUntilMs = 0;
    /** fight-0/1 动画起始时间 */
    this.fightAnimStartMs = 0;

    this.restartBtn.addEventListener("click", () => this.resetAndStart());

    const syncMenuPaused = () => {
      this.menuPaused =
        !!(this.pauseOverlay && !this.pauseOverlay.hidden) ||
        !!(this.helpOverlay && !this.helpOverlay.hidden);
      this.pauseGameplaySfxForMenu();
      this.updateBackgroundMusic();
      if (!this.menuPaused) this.resumeSfxAfterMenuClose();
    };

    const openPauseMenu = () => {
      if (!this.canOpenPauseMenus()) return;
      if (this.helpOverlay) this.helpOverlay.hidden = true;
      if (this.pauseOverlay) this.pauseOverlay.hidden = false;
      syncMenuPaused();
    };

    const openHelpMenu = () => {
      if (!this.canOpenPauseMenus()) return;
      if (this.pauseOverlay) this.pauseOverlay.hidden = true;
      if (this.helpOverlay) this.helpOverlay.hidden = false;
      syncMenuPaused();
    };

    const closePauseMenu = () => {
      if (this.pauseOverlay) this.pauseOverlay.hidden = true;
      syncMenuPaused();
    };

    const closeHelpMenu = () => {
      if (this.helpOverlay) this.helpOverlay.hidden = true;
      syncMenuPaused();
    };

    if (this.pauseBtn) {
      this.pauseBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPauseMenu();
      });
    }
    if (this.helpBtn) {
      this.helpBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openHelpMenu();
      });
    }
    if (this.resumeFromPauseBtn) {
      this.resumeFromPauseBtn.addEventListener("click", (e) => {
        e.preventDefault();
        closePauseMenu();
      });
    }
    if (this.resumeFromHelpBtn) {
      this.resumeFromHelpBtn.addEventListener("click", (e) => {
        e.preventDefault();
        closeHelpMenu();
      });
    }

    this.syncSoundIcon();
    if (this.soundBtn) {
      this.soundBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setSoundEnabled(!this.soundEnabled);
      });
    }

    const tryUnlockBgm = () => this.updateBackgroundMusic();
    document.body.addEventListener("pointerdown", tryUnlockBgm, { capture: true });
    document.body.addEventListener("keydown", tryUnlockBgm, { capture: true });

    if (this.bombBtn) {
      this.bombBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.tryBomb();
      });
    }

    this.canvas.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.handleShoot();
    });

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      if (this.menuPaused) return;
      if (e.code === "Space" || e.code === "ArrowDown") {
        e.preventDefault();
        this.handleShoot();
      }
      if (e.code === "ArrowUp") {
        e.preventDefault();
        this.tryBomb();
      }
    };
    window.addEventListener("keydown", this._onKeyDown);
  }

  async init() {
    this.assets = await loadAssets();
    this.audio = createAudioPool(AUDIO_PATHS);
    this.prepareCollisionMasks();
    this.resize();
    this.loadFireChargesFromStorage();
    this.syncSoundIcon();
    this.resetAndStart();
    this.updateBackgroundMusic();
  }

  syncSoundIcon() {
    if (this.soundIcon) {
      this.soundIcon.src = this.soundEnabled ? ICON_SOUND_ON : ICON_SOUND_OFF;
    }
  }

  setSoundEnabled(on) {
    this.soundEnabled = Boolean(on);
    try {
      localStorage.setItem(SOUND_STORAGE_KEY, this.soundEnabled ? "1" : "0");
    } catch {
      // ignore
    }
    this.syncSoundIcon();
    if (!this.soundEnabled) {
      this.hardStopAllAudio();
    } else {
      this.updateBackgroundMusic();
    }
  }

  updateBackgroundMusic() {
    const el = this.audio?.background;
    if (!el) return;
    const shouldPlay =
      this.soundEnabled &&
      !this.menuPaused &&
      this.state !== "loading" &&
      this.state !== "gameover";
    if (shouldPlay) {
      el.play().catch(() => {});
    } else {
      try {
        el.pause();
      } catch {
        // ignore
      }
    }
  }

  /** 暂停除 BGM 外的轨道（菜单暂停时用；BGM 由 updateBackgroundMusic 单独处理） */
  pauseGameplaySfxForMenu() {
    if (!this.audio || !this.menuPaused) return;
    for (const [k, el] of Object.entries(this.audio)) {
      if (k === "background") continue;
      try {
        el.pause();
      } catch {
        // ignore
      }
    }
  }

  /** 关闭说明/暂停面板后，按当前游戏阶段恢复应存在的音效 */
  resumeSfxAfterMenuClose() {
    if (!this.soundEnabled || !this.audio || this.state === "gameover") return;
    if (this.state === "launching" || this.state === "returning") {
      this.playShootSfx();
      return;
    }
    if (this.state === "grabbing") {
      if (this.bombState?.phase === "boom") {
        this.playBoomSfx();
      } else if (!this.bombState && this.grabbed) {
        this.playMineralGrabSfx(this.grabbed.type);
      }
      return;
    }
    if (
      this.inputLockedUntilMs > 0 &&
      performance.now() < this.inputLockedUntilMs
    ) {
      this.playFightSfx();
    }
  }

  /** 关音效时：背景音乐只暂停、不重置进度，以便再打开或下一局接着播 */
  hardStopAllAudio() {
    if (!this.audio) return;
    for (const [key, el] of Object.entries(this.audio)) {
      try {
        el.pause();
        if (key !== "background") el.currentTime = 0;
      } catch {
        // ignore
      }
    }
  }

  stopShootSfx() {
    const el = this.audio?.shoot;
    if (!el) return;
    try {
      el.pause();
      el.currentTime = 0;
    } catch {
      // ignore
    }
  }

  playShootSfx() {
    if (!this.soundEnabled || !this.audio?.shoot || this.menuPaused) return;
    const el = this.audio.shoot;
    try {
      el.pause();
      el.currentTime = 0;
    } catch {
      // ignore
    }
    el.play().catch(() => {});
  }

  stopMineralGrabSfx() {
    if (!this.audio) return;
    for (const k of ["crystal", "stone", "bug"]) {
      const el = this.audio[k];
      if (!el) continue;
      try {
        el.pause();
        el.currentTime = 0;
      } catch {
        // ignore
      }
    }
  }

  playMineralGrabSfx(type) {
    if (!this.soundEnabled || !this.audio || this.menuPaused) return;
    const key =
      type === "crystal" ? "crystal" : type === "stone" ? "stone" : type === "bug" ? "bug" : null;
    if (!key || !this.audio[key]) return;
    this.stopMineralGrabSfx();
    const el = this.audio[key];
    try {
      el.pause();
      el.currentTime = 0;
    } catch {
      // ignore
    }
    el.play().catch(() => {});
  }

  stopFightSfx() {
    const el = this.audio?.fight;
    if (!el) return;
    try {
      el.pause();
      el.currentTime = 0;
    } catch {
      // ignore
    }
  }

  playFightSfx() {
    if (!this.soundEnabled || !this.audio?.fight || this.menuPaused) return;
    const el = this.audio.fight;
    try {
      el.pause();
      el.currentTime = 0;
    } catch {
      // ignore
    }
    el.play().catch(() => {});
  }

  stopBoomSfx() {
    const el = this.audio?.boom;
    if (!el) return;
    try {
      el.pause();
      el.currentTime = 0;
    } catch {
      // ignore
    }
  }

  playBoomSfx() {
    if (!this.soundEnabled || !this.audio?.boom || this.menuPaused) return;
    const el = this.audio.boom;
    try {
      el.pause();
      el.currentTime = 0;
    } catch {
      // ignore
    }
    el.play().catch(() => {});
  }

  stopFireGetSfx() {
    const el = this.audio?.fireGet;
    if (!el) return;
    try {
      el.pause();
      el.currentTime = 0;
    } catch {
      // ignore
    }
  }

  playFireGetSfx() {
    if (!this.soundEnabled || !this.audio?.fireGet || this.menuPaused) return;
    const el = this.audio.fireGet;
    el.volume = FIRE_GET_VOLUME;
    try {
      el.pause();
      el.currentTime = 0;
    } catch {
      // ignore
    }
    el.play().catch(() => {});
  }

  /**
   * 随游戏阶段截断音效：行为/动画结束即停（比音频文件先结束也会停）。
   */
  syncSfxToGameState() {
    if (!this.soundEnabled || !this.audio) return;

    if (this.state !== "launching" && this.state !== "returning") {
      this.stopShootSfx();
    }

    if (this.state !== "grabbing" || this.bombState) {
      this.stopMineralGrabSfx();
    }

    if (
      this.inputLockedUntilMs > 0 &&
      performance.now() >= this.inputLockedUntilMs
    ) {
      this.stopFightSfx();
    }

    if (!this.bombState || this.bombState.phase !== "boom") {
      this.stopBoomSfx();
    }
  }

  loadFireChargesFromStorage() {
    try {
      const raw = sessionStorage.getItem(FIRE_CHARGES_STORAGE_KEY);
      if (raw == null) return;
      const n = parseInt(raw, 10);
      if (!Number.isNaN(n)) this.fireCharges = Math.max(0, n);
    } catch {
      // 私密模式等可能导致不可用
    }
  }

  persistFireCharges() {
    try {
      sessionStorage.setItem(FIRE_CHARGES_STORAGE_KEY, String(this.fireCharges));
    } catch {
      // ignore
    }
  }

  prepareCollisionMasks() {
    const crystals = this.assets?.crystalVariants;
    const stones = this.assets?.stoneVariants;
    if (!crystals?.length || !stones?.length) return;

    const buildMask = (img) => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const offCtx = off.getContext("2d", { willReadFrequently: true });
      offCtx.clearRect(0, 0, w, h);
      offCtx.drawImage(img, 0, 0, w, h);
      const data = offCtx.getImageData(0, 0, w, h).data;
      const alpha = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        alpha[i] = data[i * 4 + 3];
      }
      return { w, h, alpha };
    };

    const bugMasks = [];
    if (this.assets?.bug) bugMasks.push(buildMask(this.assets.bug));
    if (this.assets?.bugWithCrystal) bugMasks.push(buildMask(this.assets.bugWithCrystal));

    this.alphaMasks = {
      crystal: crystals.map((img) => buildMask(img)),
      stone: stones.map((img) => buildMask(img)),
      bug: bugMasks,
    };
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;

    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.floor(cssW * dpr);
    this.canvas.height = Math.floor(cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.recomputeLayout();
  }

  recomputeLayout() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    const katyNatural = this.assets?.katy;
    if (!katyNatural) return;

    const katyAR = katyNatural.naturalWidth / katyNatural.naturalHeight;
    const isMobile = w <= 860; // pixel threshold (you can tweak)
    const narrowMinerals = window.matchMedia(MINERAL_BREAKPOINT_QUERY).matches;
    this.mineralLayout = narrowMinerals ? MINERAL_LAYOUT_NARROW : MINERAL_LAYOUT_WIDE;
    let katyHeight = 0;
    let groundY = 0;
    if (isMobile) {
      // Keep the top "sky + miner character area" at exactly 1/4 screen height.
      // We do this by fixing ground line (end of sky) at 25% of viewport height.
      groundY = h * 0.25;
      // Katy should also scale with the top section, but not exceed it.
      katyHeight = groundY * 0.72; // => ~18% of viewport height
    } else {
      // Desktop: keep the previous proportional placement.
      katyHeight = clamp(h * 0.18, 140, 260);
      // Katy is drawn with centerY = groundY - katyHeight/2 => groundY = targetCenterY + katyHeight/2
      const targetCenterY = h * 0.25;
      groundY = clamp(targetCenterY + katyHeight / 2, katyHeight + 50, h - 140);
    }

    const katyWidth = katyHeight * katyAR;
    const katyTop = groundY - katyHeight;
    const katyCenterX = w / 2;
    const katyX = katyCenterX - katyWidth / 2;

    // Hook pivot: bottom center of Katy sprite.
    const anchorX = katyCenterX;
    const anchorY = groundY; // bottom edge

    const spawnHeight = katyHeight * (isMobile ? 5.2 : 6);
    const spawnTop = groundY + 14;
    const spawnBottom = Math.min(h - 18, spawnTop + spawnHeight);
    const effectiveSpawnHeight = Math.max(0, spawnBottom - spawnTop);

    // Hook lengths
    const hookRestLength = katyHeight * 0.22;
    // Instead of approximating by vertical spawn height only,
    // compute max reachable distance along the hook line direction:
    // take the farthest corner distance from anchor to spawn rectangle.
    const corners = [
      { x: w * 0.2, y: spawnTop },
      { x: w * 0.8, y: spawnTop },
      { x: w * 0.2, y: spawnBottom },
      { x: w * 0.8, y: spawnBottom },
    ];
    const farthestDist = Math.max(
      ...corners.map((c) => Math.hypot(c.x - anchorX, c.y - anchorY))
    );
    const hookMaxLength = clamp(farthestDist * 1.03, hookRestLength + 20, farthestDist + 80);

    // Speed scales with katy size so it feels consistent across screens.
    this.baseSpeedPxPerSec = katyHeight * 2.8;

    const hookNatural = this.assets.hook;
    const hookAR = hookNatural.naturalWidth / hookNatural.naturalHeight;
    const hookHeight = katyHeight * 0.28;
    const hookWidth = hookHeight * hookAR;

    this.layout = {
      w,
      h,
      katy: { katyHeight, katyWidth, katyTop, katyX, katyCenterX, groundY, anchorX, anchorY },
      spawn: {
        xMin: w * (isMobile ? 0.16 : 0.2),
        xMax: w * (isMobile ? 0.84 : 0.8),
        yMin: spawnTop,
        yMax: spawnBottom,
      },
      hook: { hookRestLength, hookMaxLength, hookWidth, hookHeight },
    };

    this.hookRestLength = hookRestLength;
    this.hookMaxLength = hookMaxLength;

    // Adjust mineral count for mobile to avoid crowding.
    this.mineralsCount = isMobile ? Math.max(9, Math.floor(this.MINERALS_COUNT * 0.78)) : this.MINERALS_COUNT;
  }

  resetAndStart() {
    this.overlay.hidden = true;
    if (this.pauseOverlay) this.pauseOverlay.hidden = true;
    if (this.helpOverlay) this.helpOverlay.hidden = true;
    this.menuPaused = false;
    this.stopShootSfx();
    this.stopMineralGrabSfx();
    this.stopFightSfx();
    this.stopBoomSfx();
    this.stopFireGetSfx();
    this.state = "swing";

    this.score = 0;
    this.scoreEl.textContent = "0";
    // 火焰跨周目继承：不在此重置 fireCharges（见 persist / load）
    this.bombState = null;
    this.syncFireCountDisplay();

    this.timeLeftMs = this.GAME_DURATION_MS;
    this.timeEl.textContent = String(Math.ceil(this.timeLeftMs / 1000));

    this.angle = this.hookAngleMin;
    this.angleDir = 1;

    this.fixedAngle = null;
    this.grabbed = null;

    this.hookLength = this.hookRestLength;
    this.fireLength = this.hookRestLength;

    this.minerals = this.createMinerals();
    this.scorePopups = [];
    this.inputLockedUntilMs = 0;
    this.fightAnimStartMs = 0;

    this.updateBackgroundMusic();
  }

  isInputLocked() {
    return performance.now() < this.inputLockedUntilMs;
  }

  canOpenPauseMenus() {
    return (
      !!this.assets &&
      !!this.layout &&
      this.state !== "loading" &&
      this.state !== "gameover" &&
      this.overlay &&
      this.overlay.hidden
    );
  }

  popupColorForMineral(mineral) {
    if (mineral.type === "bug") {
      return mineral.bugWithCrystal ? "#ffffff" : "#92400e";
    }
    if (mineral.type === "stone") return STONE_SCORE_POPUP_COLOR;
    const idx = mineral.variantIndex ?? 0;
    return CRYSTAL_SCORE_POPUP_COLORS[idx] ?? CRYSTAL_SCORE_POPUP_COLORS[0];
  }

  spawnScorePopup(mineral, points, firePlusOne = false) {
    const katy = this.layout?.katy;
    if (!katy || points <= 0) return;

    const x = katy.katyCenterX;
    const y = katy.katyTop - katy.katyHeight * 0.06;
    const fontSize = clamp(katy.katyHeight * 0.13, 12, 28);

    const popupStyle =
      mineral.type === "bug" && mineral.bugWithCrystal ? "gradient" : "solid";

    this.scorePopups.push({
      text: `+${points}`,
      x,
      y,
      vy: -46,
      color: this.popupColorForMineral(mineral),
      popupStyle,
      life: 0,
      maxLife: 0.68,
      fontSize,
      firePlusOne: Boolean(firePlusOne),
    });
  }

  updateScorePopups(dt) {
    if (!this.scorePopups.length) return;
    this.scorePopups = this.scorePopups.filter((p) => {
      p.life += dt;
      p.y += p.vy * dt;
      return p.life < p.maxLife;
    });
  }

  drawScorePopups() {
    if (!this.scorePopups.length) return;
    const ctx = this.ctx;
    ctx.save();
    for (const p of this.scorePopups) {
      const t = p.life / p.maxLife;
      const alpha = Math.max(0, 1 - t * t);
      ctx.globalAlpha = alpha;
      ctx.font = `800 ${p.fontSize}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.shadowColor = "rgba(0,0,0,0.4)";
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 2;
      if (p.popupStyle === "gradient") {
        ctx.font = `800 ${p.fontSize}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`;
        const tw = ctx.measureText(p.text).width;
        const left = p.x - tw / 2;
        const grad = ctx.createLinearGradient(left, p.y, left + tw, p.y);
        grad.addColorStop(0, "#22d3ee");
        grad.addColorStop(0.5, "#3b82f6");
        grad.addColorStop(1, "#a855f7");
        ctx.fillStyle = grad;
      } else {
        ctx.fillStyle = p.color;
      }
      ctx.fillText(p.text, p.x, p.y);

      if (p.firePlusOne && this.assets?.fire) {
        const fireImg = this.assets.fire;
        if (!fireImg.naturalWidth || !fireImg.naturalHeight) continue;
        const fireFont = p.fontSize * 2;
        const iconH = fireFont;
        const iconW = (fireImg.naturalWidth / fireImg.naturalHeight) * iconH;
        const fireText = "+1";
        ctx.font = `800 ${fireFont}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`;
        const tw = ctx.measureText(fireText).width;
        const gap = Math.max(6, fireFont * 0.2);
        const totalW = iconW + gap + tw;
        const left = p.x - totalW / 2;
        const row2Y = p.y + p.fontSize * 0.85 + fireFont * 0.55;

        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
        ctx.drawImage(fireImg, left, row2Y - iconH / 2, iconW, iconH);

        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#fef3c7";
        ctx.shadowColor = "rgba(0,0,0,0.35)";
        ctx.shadowBlur = 6;
        ctx.shadowOffsetY = 1;
        ctx.fillText(fireText, left + iconW + gap, row2Y);
      }
    }
    ctx.restore();
  }

  createMinerals() {
    const out = [];
    if (!this.layout) return out;

    const L = this.mineralLayout;
    const crystalScales = L.crystalScales;
    const stoneScales = L.stoneScales;

    const crystalVariants = this.assets.crystalVariants;
    const stoneVariants = this.assets.stoneVariants;
    if (!crystalVariants?.length || !stoneVariants?.length) return out;
    if (!this.alphaMasks?.crystal?.length || !this.alphaMasks?.stone?.length) return out;

    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

    const xMin = this.layout.spawn.xMin;
    const xMax = this.layout.spawn.xMax;
    const yMin = this.layout.spawn.yMin;
    const yMax = this.layout.spawn.yMax;

    /** @type {{ yCenter: number, halfExtent: number }[]} */
    const bugRowBands = [];

    const bugMasksOk = this.alphaMasks?.bug?.length === 2;
    if (bugMasksOk && this.assets?.bug && this.assets?.bugWithCrystal) {
      let bugCount = 0;
      if (Math.random() < BUG_SPAWN_CHANCE) {
        bugCount = Math.random() < 0.5 ? 1 : 2;
      }
      const kh = this.layout.katy.katyHeight;
      const side = kh * BUG_SCALE;

      for (let b = 0; b < bugCount; b++) {
        const withCrystal = Math.random() < BUG_WITH_CRYSTAL_CHANCE;
        const img = withCrystal ? this.assets.bugWithCrystal : this.assets.bug;
        const variantIndex = withCrystal ? 1 : 0;
        const collisionMask = this.alphaMasks.bug[variantIndex];
        const naturalW = img.naturalWidth;
        const naturalH = img.naturalHeight;
        const ar = naturalW / naturalH;
        const drawW = side * ar;
        const drawH = side;
        const radius = Math.max(drawW, drawH) * 0.46;
        const rowHalf = drawH / 2 + 10;

        let y = 0;
        let placedBug = false;
        for (let att = 0; att < 120; att++) {
          const syMin = yMin + rowHalf;
          const syMax = yMax - rowHalf;
          if (syMin >= syMax) break;
          y = syMin + Math.random() * (syMax - syMin);
          let ok = true;
          for (const band of bugRowBands) {
            if (Math.abs(y - band.yCenter) < band.halfExtent + rowHalf) {
              ok = false;
              break;
            }
          }
          if (ok) {
            placedBug = true;
            break;
          }
        }
        if (!placedBug) continue;

        const movePad = drawW / 2 + 4;
        const bugMoveXMin = xMin + movePad;
        const bugMoveXMax = xMax - movePad;
        if (bugMoveXMin >= bugMoveXMax) continue;

        const x =
          bugMoveXMin + Math.random() * (bugMoveXMax - bugMoveXMin);
        const speed =
          BUG_MOVE_SPEED_MIN +
          Math.random() * (BUG_MOVE_SPEED_MAX - BUG_MOVE_SPEED_MIN);
        const vx = -Math.abs(speed);

        const halfW = drawW / 2;
        const halfH = drawH / 2;
        const aabb = {
          minX: x - halfW,
          maxX: x + halfW,
          minY: y - halfH,
          maxY: y + halfH,
        };

        bugRowBands.push({ yCenter: y, halfExtent: rowHalf });

        out.push({
          id: `bug-${b}-${Math.random().toString(16).slice(2)}`,
          type: "bug",
          bugWithCrystal: withCrystal,
          scale: BUG_SCALE,
          variantIndex,
          img,
          collisionMask,
          x,
          y,
          drawW,
          drawH,
          radius,
          rotation: 0,
          cosRot: 1,
          sinRot: 0,
          aabb,
          alive: true,
          bugMoveXMin,
          bugMoveXMax,
          vx,
          facing: -1,
        });
      }
    }

    const mineralOverlapsBugRow = (cy, r) => {
      for (const band of bugRowBands) {
        if (Math.abs(cy - band.yCenter) < band.halfExtent + r + 6) return true;
      }
      return false;
    };

    for (let i = 0; i < this.mineralsCount; i++) {
      const isCrystal = Math.random() < 0.6;
      const type = isCrystal ? "crystal" : "stone";
      const scale = isCrystal ? pick(crystalScales) : pick(stoneScales);

      const variantList = isCrystal ? crystalVariants : stoneVariants;
      const maskList = isCrystal ? this.alphaMasks.crystal : this.alphaMasks.stone;
      const variantIndex = Math.floor(Math.random() * variantList.length);
      const img = variantList[variantIndex];
      const collisionMask = maskList[variantIndex];

      const naturalW = img.naturalWidth;
      const naturalH = img.naturalHeight;
      const ar = naturalW / naturalH;

      // "边长" relative to katy height; we render mineral with height = side length.
      const side = this.layout.katy.katyHeight * scale;
      const drawW = side * ar;
      const drawH = side;
      // Slightly smaller radius than "half of max edge" to allow a bit more packing.
      const radius = Math.max(drawW, drawH) * 0.46;

      let placed = false;
      let x = 0;
      let y = 0;

      const maxAttempts = 1500;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const rx = radius * 1.05;
        const padX = Math.min((xMax - xMin) * 0.02, rx);
        const padY = Math.min((yMax - yMin) * 0.02, rx);

        // Ensure the sample point stays reasonably inside the play area.
        const sxMin = xMin + radius + padX;
        const sxMax = xMax - radius - padX;
        const syMin = yMin + radius + padY;
        const syMax = yMax - radius - padY;
        if (sxMin >= sxMax || syMin >= syMax) break;

        x = sxMin + Math.random() * (sxMax - sxMin);
        y = syMin + Math.random() * (syMax - syMin);

        let ok = true;
        if (mineralOverlapsBugRow(y, radius)) ok = false;
        if (ok) {
          for (const other of out) {
            if (!other.alive) continue;
            const dx = x - other.x;
            const dy = y - other.y;
            const dist = Math.hypot(dx, dy);
            const minDist = (radius + other.radius) * 0.95;
            if (dist < minDist) {
              ok = false;
              break;
            }
          }
        }

        if (ok) {
          placed = true;
          break;
        }
      }

      // Fallback: if packed too tightly, allow overlap but keep within bounds.
      if (!placed) {
        x = xMin + Math.random() * (xMax - xMin);
        y = yMin + Math.random() * (yMax - yMin);
      }

      const rotation = Math.random() * Math.PI * 2;
      // Precompute rotation helpers and AABB for faster collision checks during launching.
      const cosRot = Math.cos(rotation);
      const sinRot = Math.sin(rotation);

      // Oriented rect => AABB in world space (for cheap rejection in pixel collision).
      const halfW = drawW / 2;
      const halfH = drawH / 2;
      const corners = [
        { x: -halfW, y: -halfH },
        { x: halfW, y: -halfH },
        { x: halfW, y: halfH },
        { x: -halfW, y: halfH },
      ];
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const c of corners) {
        const rx = c.x * cosRot - c.y * sinRot;
        const ry = c.x * sinRot + c.y * cosRot;
        const wx = x + rx;
        const wy = y + ry;
        minX = Math.min(minX, wx);
        maxX = Math.max(maxX, wx);
        minY = Math.min(minY, wy);
        maxY = Math.max(maxY, wy);
      }

      out.push({
        id: `${type}-${scale}-${i}-${Math.random().toString(16).slice(2)}`,
        type,
        scale,
        variantIndex,
        img,
        collisionMask,
        x,
        y,
        drawW,
        drawH,
        radius,
        rotation,
        cosRot,
        sinRot,
        aabb: { minX, maxX, minY, maxY },
        alive: true,
      });
    }
    return out;
  }

  handleShoot() {
    if (this.menuPaused) return;
    if (this.isInputLocked()) return;
    if (this.state !== "swing") return;
    if (this.pointerLockPreventMultiTap) return;
    this.pointerLockPreventMultiTap = true;
    setTimeout(() => (this.pointerLockPreventMultiTap = false), 180);

    this.playShootSfx();

    this.state = "launching";
    this.fixedAngle = this.angle;
    this.hookLength = this.hookRestLength;
    this.grabbed = null;
  }

  syncFireCountDisplay() {
    if (this.fireCountEl) this.fireCountEl.textContent = String(this.fireCharges);
  }

  updateBombButton() {
    if (!this.bombBtn) return;
    const can =
      !this.menuPaused &&
      !this.isInputLocked() &&
      this.state === "grabbing" &&
      this.grabbed &&
      this.fireCharges > 0 &&
      !this.bombState;
    this.bombBtn.disabled = !can;
  }

  getKatyCenterWorld() {
    const k = this.layout?.katy;
    if (!k) return { x: 0, y: 0 };
    return {
      x: k.katyCenterX,
      y: k.groundY - k.katyHeight / 2,
    };
  }

  tryBomb() {
    if (this.menuPaused) return;
    if (this.isInputLocked()) return;
    if (this.state !== "grabbing" || !this.grabbed || this.fireCharges <= 0 || this.bombState) return;
    if (this.state === "gameover") return;

    const m = this.grabbed;
    const { x: sx, y: sy } = this.getKatyCenterWorld();
    const tx = m.x;
    const ty = m.y;

    this.fireCharges -= 1;
    this.syncFireCountDisplay();
    this.persistFireCharges();

    this.bombState = {
      phase: "fly",
      t: 0,
      dur: 0.14,
      sx,
      sy,
      tx,
      ty,
    };
    this.updateBombButton();
  }

  degToDir(deg) {
    const rad = deg * DEG2RAD;
    return { x: Math.cos(rad), y: Math.sin(rad) };
  }

  getAnchor() {
    return { x: this.layout.katy.anchorX, y: this.layout.katy.anchorY };
  }

  drawImageRotated(img, x, y, w, h, rotationRad) {
    this.ctx.save();
    this.ctx.translate(x, y);
    this.ctx.rotate(rotationRad);
    this.ctx.drawImage(img, -w / 2, -h / 2, w, h);
    this.ctx.restore();
  }

  drawCoverImage(img, dx, dy, dw, dh) {
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    if (!iw || !ih || dw <= 0 || dh <= 0) return;

    const srcAspect = iw / ih;
    const dstAspect = dw / dh;

    let sx = 0;
    let sy = 0;
    let sw = iw;
    let sh = ih;

    if (srcAspect > dstAspect) {
      // Source is wider: crop width
      sh = ih;
      sw = ih * dstAspect;
      sx = (iw - sw) / 2;
      sy = 0;
    } else {
      // Source is taller: crop height
      sw = iw;
      sh = iw / dstAspect;
      sx = 0;
      sy = (ih - sh) / 2;
    }

    this.ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  drawGround() {
    const { groundY } = this.layout.katy;
    const { w } = this.layout;

    this.ctx.save();
    this.ctx.strokeStyle = "rgba(180, 180, 180, 0.65)";
    this.ctx.lineWidth = 4;
    this.ctx.beginPath();
    this.ctx.moveTo(0, groundY);
    this.ctx.lineTo(w, groundY);
    this.ctx.stroke();
    this.ctx.restore();
  }

  drawFightOverlay() {
    if (!this.layout || performance.now() >= this.inputLockedUntilMs) return;
    const f0 = this.assets?.fight0;
    const f1 = this.assets?.fight1;
    if (!f0?.naturalWidth || !f1?.naturalWidth) return;
    const fightImg =
      Math.floor((performance.now() - this.fightAnimStartMs) / BUG_FIGHT_FRAME_MS) %
        2 ===
      0
        ? f0
        : f1;
    const k = this.layout.katy;
    const topY = k.groundY - k.katyHeight;
    const fightH = k.katyHeight;
    const ar = fightImg.naturalWidth / fightImg.naturalHeight;
    const fightW = fightH * ar;
    this.ctx.drawImage(fightImg, k.katyX, topY, fightW, fightH);
  }

  updateBugs(dt) {
    if (this.state === "gameover" || !this.minerals.length) return;
    for (const m of this.minerals) {
      if (m.type !== "bug" || !m.alive || m === this.grabbed) continue;
      m.x += m.vx * dt;
      const sp = Math.abs(m.vx);
      if (m.x <= m.bugMoveXMin) {
        m.x = m.bugMoveXMin;
        m.vx = sp;
        m.facing = 1;
      } else if (m.x >= m.bugMoveXMax) {
        m.x = m.bugMoveXMax;
        m.vx = -sp;
        m.facing = -1;
      }
      const halfW = m.drawW / 2;
      const halfH = m.drawH / 2;
      m.aabb = {
        minX: m.x - halfW,
        maxX: m.x + halfW,
        minY: m.y - halfH,
        maxY: m.y + halfH,
      };
    }
  }

  drawScene() {
    const { w, h } = this.layout;

    // Background split: sky above, ground below.
    this.ctx.clearRect(0, 0, w, h);
    const groundY = this.layout.katy.groundY;
    const skyImg = this.assets?.sky;
    const groundImg = this.assets?.ground;
    if (skyImg && groundImg) {
      this.drawCoverImage(skyImg, 0, 0, w, groundY);
      this.drawCoverImage(groundImg, 0, groundY, w, h - groundY);
    } else {
      const bg = this.ctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, "#0b0f14");
      bg.addColorStop(1, "#070a10");
      this.ctx.fillStyle = bg;
      this.ctx.fillRect(0, 0, w, h);
    }

    // Optional: spawn area tint
    this.ctx.save();
    this.ctx.fillStyle = "rgba(70, 90, 120, 0.14)";
    const spawn = this.layout.spawn;
    this.ctx.fillRect(0, spawn.yMin, w, spawn.yMax - spawn.yMin);
    this.ctx.restore();

    // Minerals
    for (const m of this.minerals) {
      if (!m.alive) continue;
      if (m === this.grabbed && this.bombState?.phase === "boom") continue;
      if (m.type === "bug") {
        this.ctx.save();
        this.ctx.translate(m.x, m.y);
        if (m.facing > 0) this.ctx.scale(-1, 1);
        this.ctx.drawImage(m.img, -m.drawW / 2, -m.drawH / 2, m.drawW, m.drawH);
        this.ctx.restore();
      } else {
        this.drawImageRotated(m.img, m.x, m.y, m.drawW, m.drawH, m.rotation);
      }
    }

    // Ground
    this.drawGround();

    // Katy
    const katy = this.layout.katy;
    this.drawImageRotated(this.assets.katy, katy.katyCenterX, katy.groundY - katy.katyHeight / 2, katy.katyWidth, katy.katyHeight, 0);

    // Hook line + hook sprite
    const anchor = this.getAnchor();

    const effectiveAngle = this.fixedAngle ?? this.angle;
    const dir = this.degToDir(effectiveAngle);

    const tip = { x: anchor.x + dir.x * this.hookLength, y: anchor.y + dir.y * this.hookLength };

    const lineColor = this.state === "launching" || this.state === "returning" || this.state === "grabbing"
      ? "rgba(200, 200, 200, 0.75)"
      : "rgba(165, 165, 165, 0.65)";
    this.ctx.save();
    this.ctx.strokeStyle = lineColor;
    this.ctx.lineWidth = this.lineWidthCss;
    this.ctx.lineCap = "round";
    this.ctx.beginPath();
    this.ctx.moveTo(anchor.x, anchor.y);
    this.ctx.lineTo(tip.x, tip.y);
    this.ctx.stroke();
    this.ctx.restore();

    const useGrabHook =
      this.state === "grabbing" && this.grabbed && this.bombState?.phase !== "boom";
    const hookImg = useGrabHook ? this.assets.hookGrabbing : this.assets.hook;
    const hook = this.layout.hook;
    // Rotate hook image so it follows the line direction.
    this.ctx.save();
    this.ctx.translate(tip.x, tip.y);
    // Add a sprite offset so the hook opening orientation matches the line direction.
    this.ctx.rotate((effectiveAngle + this.hookSpriteRotationOffsetDeg) * DEG2RAD);
    this.ctx.drawImage(hookImg, -hook.hookWidth / 2, -hook.hookHeight / 2, hook.hookWidth, hook.hookHeight);
    this.ctx.restore();

    if (this.bombState?.phase === "fly" && this.assets?.fire) {
      const b = this.bombState;
      const u = Math.min(1, b.t / b.dur);
      const px = b.sx + (b.tx - b.sx) * u;
      const py = b.sy + (b.ty - b.sy) * u;
      const kh = this.layout.katy.katyHeight;
      const iconH = clamp(kh * 0.22, 22, 64);
      const fw = this.assets.fire;
      if (fw.naturalWidth && fw.naturalHeight) {
        const iconW = (fw.naturalWidth / fw.naturalHeight) * iconH;
        this.ctx.drawImage(fw, px - iconW / 2, py - iconH / 2, iconW, iconH);
      }
    }

    if (this.bombState?.phase === "boom" && this.assets?.boom) {
      const b = this.bombState;
      const bw = b.boomW ?? 80;
      const bh = b.boomH ?? 80;
      this.drawImageRotated(this.assets.boom, b.bx, b.by, bw, bh, 0);
    }

    this.drawFightOverlay();

    this.drawScorePopups();
  }

  midpointAndDir(angleDeg, length) {
    const anchor = this.getAnchor();
    const dir = this.degToDir(angleDeg);
    const mid = { x: anchor.x + dir.x * length * 0.5, y: anchor.y + dir.y * length * 0.5 };
    return { mid, dir, anchor };
  }

  detectGrab(angleDeg, length) {
    // Pixel-level-ish collision:
    // 1) coarse filter: distance from segment center to mineral <= (radius + lineHalfWidth)
    // 2) precise check: sample points along the hook center line (thickness offsets),
    //    map sample point into mineral rotated image space, and check alpha>threshold.
    if (!this.alphaMasks?.crystal?.length || !this.alphaMasks?.stone?.length) return null;

    const anchor = this.getAnchor();
    const dir = this.degToDir(angleDeg);
    const tip = { x: anchor.x + dir.x * length, y: anchor.y + dir.y * length };

    const vx = tip.x - anchor.x;
    const vy = tip.y - anchor.y;
    const segLen = Math.hypot(vx, vy);
    if (segLen < 1) return null;

    const nx = vx / segLen;
    const ny = vy / segLen;
    const normal = { x: -ny, y: nx };

    const distPointToSegment = (px, py, ax, ay, bx, by) => {
      const abx = bx - ax;
      const aby = by - ay;
      const ab2 = abx * abx + aby * aby;
      if (ab2 <= 1e-6) return Math.hypot(px - ax, py - ay);
      let t = ((px - ax) * abx + (py - ay) * aby) / ab2;
      t = clamp(t, 0, 1);
      const cx = ax + abx * t;
      const cy = ay + aby * t;
      return Math.hypot(px - cx, py - cy);
    };

    const pixelAlphaHit = (m, sx, sy) => {
      // Cheap AABB rejection
      const aabb = m.aabb;
      if (sx < aabb.minX || sx > aabb.maxX || sy < aabb.minY || sy > aabb.maxY) return false;

      // World -> mineral local (undo rotation, then normalize to natural image coords)
      const dx = sx - m.x;
      const dy = sy - m.y;
      let lx = dx * m.cosRot + dy * m.sinRot;
      const ly = -dx * m.sinRot + dy * m.cosRot;
      if (m.type === "bug" && m.facing > 0) lx = -lx;

      const mask = m.collisionMask;
      if (!mask) return false;

      const u = ((lx + m.drawW / 2) / m.drawW) * mask.w;
      const v = ((ly + m.drawH / 2) / m.drawH) * mask.h;
      const ui = u | 0;
      const vi = v | 0;
      if (ui < 0 || vi < 0 || ui >= mask.w || vi >= mask.h) return false;
      const alpha = mask.alpha[vi * mask.w + ui];
      return alpha > this.collisionPixelAlphaThreshold;
    };

    let best = null; // {m, t}
    for (const m of this.minerals) {
      if (!m.alive) continue;

      const centerDist = distPointToSegment(m.x, m.y, anchor.x, anchor.y, tip.x, tip.y);
      if (centerDist > m.radius + this.lineHalfWidthCss) continue;

      // Sample along segment and check for alpha hits
      let hitT = null;
      for (let s = 0; s < segLen; s += this.collisionSampleStepPx) {
        const px = anchor.x + nx * s;
        const py = anchor.y + ny * s;

        for (const off of this.collisionLineOffsets) {
          const sx = px + normal.x * off;
          const sy = py + normal.y * off;
          if (pixelAlphaHit(m, sx, sy)) {
            hitT = s / segLen;
            break;
          }
        }
        if (hitT !== null) break;
      }

      // Ensure we also test the very end point (helps at extreme angles).
      if (hitT === null) {
        const px = anchor.x + nx * segLen;
        const py = anchor.y + ny * segLen;
        for (const off of this.collisionLineOffsets) {
          const sx = px + normal.x * off;
          const sy = py + normal.y * off;
          if (pixelAlphaHit(m, sx, sy)) {
            hitT = 1;
            break;
          }
        }
      }

      if (hitT !== null) {
        if (!best || hitT < best.t) best = { m, t: hitT };
      }
    }

    return best?.m ?? null;
  }

  mineralRetractSpeedPxPerSec(mineral) {
    const minS = this.mineralLayout?.minCrystalScaleForSpeed ?? 0.2;
    if (mineral.type === "bug") {
      // 与最轻（最小倍率）水晶回收速度一致
      return speedForCrystalBase(
        this.baseSpeedPxPerSec,
        minS,
        minS
      );
    }
    const crystalSpeed = speedForCrystalBase(
      this.baseSpeedPxPerSec,
      mineral.scale,
      minS
    );
    if (mineral.type === "crystal") {
      const isSmallestCrystal = Math.abs(mineral.scale - minS) < 1e-4;
      return isSmallestCrystal
        ? crystalSpeed
        : crystalSpeed * GRAB_RETRACT_NON_MIN_MULT;
    }
    return (
      speedForStoneFromCrystalSpeed(crystalSpeed) * GRAB_RETRACT_NON_MIN_MULT
    );
  }

  step(ts) {
    if (!this.assets || !this.layout) return;

    const now = ts;
    const dt = this.lastTs ? Math.min(0.04, (now - this.lastTs) / 1000) : 0;
    this.lastTs = now;

    if (this.state === "loading") {
      this.drawScene();
      requestAnimationFrame((t) => this.step(t));
      return;
    }

    if (this.menuPaused && this.state !== "gameover") {
      this.drawScene();
      requestAnimationFrame((t) => this.step(t));
      return;
    }

    this.updateScorePopups(dt);
    this.updateBugs(dt);

    if (this.state !== "gameover") {
      this.timeLeftMs -= dt * 1000;
      if (this.timeLeftMs <= 0) {
        this.timeLeftMs = 0;
        this.state = "gameover";
        this.finishGame();
      }
    }

    // Update angle during swing
    if (this.state === "swing") {
      this.angle += this.angleDir * this.hookAngleSpeedDegPerSec * dt;
      if (this.angle >= this.hookAngleMax) {
        this.angle = this.hookAngleMax;
        this.angleDir = -1;
      } else if (this.angle <= this.hookAngleMin) {
        this.angle = this.hookAngleMin;
        this.angleDir = 1;
      }
      this.hookLength = this.hookRestLength;
    } else if (this.state === "launching") {
      const dir = this.degToDir(this.fixedAngle);
      void dir;

      // Hook extends with base speed.
      const fireSpeed = this.baseSpeedPxPerSec;
      this.hookLength = Math.min(this.hookMaxLength, this.hookLength + fireSpeed * dt);

      // Grab check
      const grabbed = this.detectGrab(this.fixedAngle, this.hookLength);
      if (grabbed) {
        this.grabbed = grabbed;
        grabbed.alive = true; // keep visible
        this.state = "grabbing";
        this.playMineralGrabSfx(grabbed.type);
        this.retractSpeed = this.mineralRetractSpeedPxPerSec(grabbed) * this.retractSpeedMultiplier;
      } else if (this.hookLength >= this.hookMaxLength - 0.5) {
        // Nothing hit, return
        this.state = "returning";
        this.retractSpeed = this.baseSpeedPxPerSec * this.retractSpeedMultiplier;
      }
    } else if (this.state === "grabbing") {
      if (this.bombState) {
        if (this.bombState.phase === "fly") {
          this.bombState.t += dt;
          if (this.bombState.t >= this.bombState.dur) {
            const g = this.grabbed;
            const boomImg = this.assets.boom;
            const bw = g ? Math.max(g.drawW, g.drawH) * 1.15 : 80;
            let bh = bw;
            if (boomImg?.naturalWidth && boomImg?.naturalHeight) {
              bh = (boomImg.naturalHeight / boomImg.naturalWidth) * bw;
            }
            this.bombState = {
              phase: "boom",
              t: 0,
              dur: 0.24,
              bx: g ? g.x : this.bombState.tx,
              by: g ? g.y : this.bombState.ty,
              boomW: bw,
              boomH: bh,
            };
            this.playBoomSfx();
          }
        } else if (this.bombState.phase === "boom") {
          this.bombState.t += dt;
          if (this.bombState.t >= this.bombState.dur) {
            if (this.grabbed) this.grabbed.alive = false;
            this.grabbed = null;
            this.bombState = null;
            this.retractSpeed =
              this.baseSpeedPxPerSec * this.retractSpeedMultiplier;
          }
        }
      } else {
        // Retract with speed based on mineral size/type
        this.hookLength = Math.max(
          this.hookRestLength,
          this.hookLength - this.retractSpeed * dt
        );
        if (this.grabbed) {
          const anchor = this.getAnchor();
          const dir = this.degToDir(this.fixedAngle);
          const tip = {
            x: anchor.x + dir.x * this.hookLength,
            y: anchor.y + dir.y * this.hookLength,
          };
          this.grabbed.x = tip.x;
          this.grabbed.y = tip.y;
        }
      }
      if (!this.bombState && this.hookLength <= this.hookRestLength + 0.5) {
        // Score + remove
        const m = this.grabbed;
        if (m) {
          const pts =
            m.type === "bug"
              ? m.bugWithCrystal
                ? 602
                : 2
              : scoreForMineral(this.mineralLayout, m.type, m.scale);
          const oldScore = this.score;
          this.score += pts;
          const oldFire = Math.floor(oldScore / FIRE_SCORE_THRESHOLD);
          const newFire = Math.floor(this.score / FIRE_SCORE_THRESHOLD);
          this.spawnScorePopup(m, pts, newFire > oldFire);
          if (newFire > oldFire) this.playFireGetSfx();
          m.alive = false;
          this.fireCharges += newFire - oldFire;
          this.persistFireCharges();
          if (m.type === "bug") {
            const now = performance.now();
            this.inputLockedUntilMs = now + BUG_INPUT_LOCK_MS;
            this.fightAnimStartMs = now;
            this.playFightSfx();
          }
        }
        this.scoreEl.textContent = String(this.score);
        this.syncFireCountDisplay();

        this.grabbed = null;
        this.state = "swing";
        this.fixedAngle = null;
        this.hookLength = this.hookRestLength;
      }
    } else if (this.state === "returning") {
      this.hookLength = Math.max(this.hookRestLength, this.hookLength - this.retractSpeed * dt);
      if (this.hookLength <= this.hookRestLength + 0.5) {
        this.state = "swing";
        this.fixedAngle = null;
        this.hookLength = this.hookRestLength;
      }
    }

    this.timeEl.textContent = String(Math.ceil(this.timeLeftMs / 1000));
    this.updateBombButton();
    this.syncSfxToGameState();
    this.drawScene();

    // Always keep the render loop alive so "重开一局" 能恢复动画/交互.
    requestAnimationFrame((t) => this.step(t));
  }

  finishGame() {
    if (this.pauseOverlay) this.pauseOverlay.hidden = true;
    if (this.helpOverlay) this.helpOverlay.hidden = true;
    this.menuPaused = false;
    this.stopShootSfx();
    this.stopMineralGrabSfx();
    this.stopFightSfx();
    this.stopBoomSfx();
    this.stopFireGetSfx();
    try {
      this.audio?.background?.pause();
    } catch {
      // ignore
    }
    // Freeze visuals and show overlay
    this.finalText.textContent = `恭喜你！获得了${this.score}分！`;
    this.overlay.hidden = false;
    // Final draw
    this.drawScene();
  }
}

const game = new Game();

window.addEventListener("resize", () => {
  // Layout changes make exact positions meaningless; restart for simplicity.
  // (If you want persistence across resize later, we can implement it.)
  game.resize();
  if (game.state !== "loading") game.resetAndStart();
});

game
  .init()
  .then(() => {
    requestAnimationFrame((t) => game.step(t));
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    alert("资源加载失败：请确认 assets/images 下图片文件存在且可访问。");
  });


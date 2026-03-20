const ASSETS = {
  katy: "./assets/images/katy.PNG",
  hook: "./assets/images/hook.PNG",
  hookGrabbing: "./assets/images/hook_grabbing.PNG",
  crystal: "./assets/images/crystal.PNG",
  stone: "./assets/images/stone.PNG",
  sky: "./assets/images/sky.jpg",
  ground: "./assets/images/ground.jpg",
};

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
  const entries = Object.entries(ASSETS);
  const out = {};
  await Promise.all(
    entries.map(async ([key, src]) => {
      out[key] = await createImage(src);
    })
  );
  return out;
}

function speedForCrystalBase(baseSpeedPxPerSec, crystalScale) {
  // crystal scales: 0.2..1.0
  // Min crystal (0.2) speed == base speed
  // Max crystal (1.0) speed == 1/5 base speed => base * (0.2/1.0)
  return baseSpeedPxPerSec * (0.2 / crystalScale);
}

function speedForStoneFromCrystalSpeed(crystalSpeedPxPerSec) {
  // same-sized crystal is 2x stone
  return crystalSpeedPxPerSec / 2;
}

function scoreForMineral(type, scale) {
  if (type === "crystal") {
    const map = {
      0.2: 50,
      0.4: 100,
      0.6: 150,
      0.8: 300,
      1.0: 500,
    };
    return map[scale] ?? 0;
  }
  if (type === "stone") {
    const map = {
      0.4: 10,
      0.8: 20,
      1.0: 50,
    };
    return map[scale] ?? 0;
  }
  return 0;
}

class Game {
  constructor() {
    this.canvas = document.getElementById("gameCanvas");
    this.ctx = this.canvas.getContext("2d", { alpha: true });

    this.scoreEl = document.getElementById("score");
    this.timeEl = document.getElementById("time");
    this.overlay = document.getElementById("overlay");
    this.finalText = document.getElementById("finalText");
    this.restartBtn = document.getElementById("restartBtn");
    this.orientationHintEl = document.getElementById("orientationHint");

    this.assets = null;

    // Game settings (easy tweak)
    this.GAME_DURATION_MS = 60000; // 1min
    this.MINERALS_COUNT = 14;
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

    this.restartBtn.addEventListener("click", () => {
      this.tryForceLandscape();
      this.resetAndStart();
    });

    window.addEventListener("resize", () => this.updateOrientationHint());
    window.addEventListener("orientationchange", () => this.updateOrientationHint());

    this.canvas.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.tryForceLandscape();
      this.handleShoot();
    });
  }

  isPortrait() {
    return window.innerHeight > window.innerWidth;
  }

  updateOrientationHint() {
    if (!this.orientationHintEl) return;
    const show = this.isPortrait();
    this.orientationHintEl.hidden = !show;
  }

  async tryForceLandscape() {
    this.updateOrientationHint();
    const hintEl = this.orientationHintEl;
    if (!hintEl) return;
    if (!this.isPortrait()) return;

    // Best-effort: use Screen Orientation API (supported in many mobile browsers).
    try {
      if (screen?.orientation?.lock) {
        await screen.orientation.lock("landscape");
      }
    } catch {
      // Ignore: if browser doesn't allow lock, user will see hint.
    } finally {
      this.updateOrientationHint();
    }
  }

  async init() {
    this.assets = await loadAssets();
    this.prepareCollisionMasks();
    this.resize();
    this.updateOrientationHint();
    this.resetAndStart();
  }

  prepareCollisionMasks() {
    const crystal = this.assets?.crystal;
    const stone = this.assets?.stone;
    if (!crystal || !stone) return;

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

    this.alphaMasks = {
      crystal: buildMask(crystal),
      stone: buildMask(stone),
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
    const katyHeight = clamp(h * 0.18, 140, 260);
    const katyWidth = katyHeight * katyAR;

    // Place Katy visually around ~25% of the screen height.
    // Katy is drawn with centerY = groundY - katyHeight/2 => groundY = targetCenterY + katyHeight/2
    const targetCenterY = h * 0.25;
    const groundY = clamp(targetCenterY + katyHeight / 2, katyHeight + 50, h - 140);
    const katyTop = groundY - katyHeight;
    const katyCenterX = w / 2;
    const katyX = katyCenterX - katyWidth / 2;

    // Hook pivot: bottom center of Katy sprite.
    const anchorX = katyCenterX;
    const anchorY = groundY; // bottom edge

    const spawnHeight = katyHeight * 6;
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
        xMin: w * 0.2,
        xMax: w * 0.8,
        yMin: spawnTop,
        yMax: spawnBottom,
      },
      hook: { hookRestLength, hookMaxLength, hookWidth, hookHeight },
    };

    this.hookRestLength = hookRestLength;
    this.hookMaxLength = hookMaxLength;
  }

  resetAndStart() {
    this.overlay.hidden = true;
    this.state = "swing";

    this.score = 0;
    this.scoreEl.textContent = "0";

    this.timeLeftMs = this.GAME_DURATION_MS;
    this.timeEl.textContent = String(Math.ceil(this.timeLeftMs / 1000));

    this.angle = this.hookAngleMin;
    this.angleDir = 1;

    this.fixedAngle = null;
    this.grabbed = null;

    this.hookLength = this.hookRestLength;
    this.fireLength = this.hookRestLength;

    this.minerals = this.createMinerals();
  }

  createMinerals() {
    const out = [];
    if (!this.layout) return out;

    const crystalScales = [0.2, 0.4, 0.6, 0.8, 1.0];
    const stoneScales = [0.4, 0.8, 1.0];

    const crystalNatural = this.assets.crystal;
    const stoneNatural = this.assets.stone;

    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

    const xMin = this.layout.spawn.xMin;
    const xMax = this.layout.spawn.xMax;
    const yMin = this.layout.spawn.yMin;
    const yMax = this.layout.spawn.yMax;

    for (let i = 0; i < this.MINERALS_COUNT; i++) {
      const isCrystal = Math.random() < 0.6;
      const type = isCrystal ? "crystal" : "stone";
      const scale = isCrystal ? pick(crystalScales) : pick(stoneScales);

      const img = type === "crystal" ? crystalNatural : stoneNatural;
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
        img,
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
    if (this.state !== "swing") return;
    if (this.pointerLockPreventMultiTap) return;
    this.pointerLockPreventMultiTap = true;
    setTimeout(() => (this.pointerLockPreventMultiTap = false), 180);

    this.state = "launching";
    this.fixedAngle = this.angle;
    this.hookLength = this.hookRestLength;
    this.grabbed = null;
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
      this.drawImageRotated(m.img, m.x, m.y, m.drawW, m.drawH, m.rotation);
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

    const hookImg = this.state === "grabbing" ? this.assets.hookGrabbing : this.assets.hook;
    const hook = this.layout.hook;
    // Rotate hook image so it follows the line direction.
    this.ctx.save();
    this.ctx.translate(tip.x, tip.y);
    // Add a sprite offset so the hook opening orientation matches the line direction.
    this.ctx.rotate((effectiveAngle + this.hookSpriteRotationOffsetDeg) * DEG2RAD);
    this.ctx.drawImage(hookImg, -hook.hookWidth / 2, -hook.hookHeight / 2, hook.hookWidth, hook.hookHeight);
    this.ctx.restore();
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
    if (!this.alphaMasks) return null;

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
      const lx = dx * m.cosRot + dy * m.sinRot;
      const ly = -dx * m.sinRot + dy * m.cosRot;

      const u = ((lx + m.drawW / 2) / m.drawW) * this.alphaMasks[m.type].w;
      const v = ((ly + m.drawH / 2) / m.drawH) * this.alphaMasks[m.type].h;
      const ui = u | 0;
      const vi = v | 0;
      if (ui < 0 || vi < 0 || ui >= this.alphaMasks[m.type].w || vi >= this.alphaMasks[m.type].h) return false;

      const mask = this.alphaMasks[m.type];
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
    const crystalSpeed = speedForCrystalBase(this.baseSpeedPxPerSec, mineral.scale);
    if (mineral.type === "crystal") return crystalSpeed;
    return speedForStoneFromCrystalSpeed(crystalSpeed);
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
        this.retractSpeed = this.mineralRetractSpeedPxPerSec(grabbed) * this.retractSpeedMultiplier;
      } else if (this.hookLength >= this.hookMaxLength - 0.5) {
        // Nothing hit, return
        this.state = "returning";
        this.retractSpeed = this.baseSpeedPxPerSec * this.retractSpeedMultiplier;
      }
    } else if (this.state === "grabbing") {
      // Retract with speed based on mineral size/type
      this.hookLength = Math.max(this.hookRestLength, this.hookLength - this.retractSpeed * dt);
      if (this.grabbed) {
        const anchor = this.getAnchor();
        const dir = this.degToDir(this.fixedAngle);
        const tip = { x: anchor.x + dir.x * this.hookLength, y: anchor.y + dir.y * this.hookLength };
        this.grabbed.x = tip.x;
        this.grabbed.y = tip.y;
      }
      if (this.hookLength <= this.hookRestLength + 0.5) {
        // Score + remove
        const m = this.grabbed;
        if (m) {
          this.score += scoreForMineral(m.type, m.scale);
          m.alive = false;
        }
        this.scoreEl.textContent = String(this.score);

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
    this.drawScene();

    // Always keep the render loop alive so "重开一局" 能恢复动画/交互.
    requestAnimationFrame((t) => this.step(t));
  }

  finishGame() {
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


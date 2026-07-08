/*
 * MINE RUSH — js/effects.js
 * ─────────────────────────────────────────────────────────────────────────
 * The "juice" / dopamine layer: synthesized sound, canvas particles,
 * confetti, screen shake and haptics.
 *
 * Exposed as a global `window.Effects` (NOT an ES module — loaded via <script>).
 * Everything is heavily guarded so it can never throw in odd environments
 * (SSR, no Canvas, no Web Audio, no vibrate, reduced-motion, muted, etc.).
 *
 * Public API (see 기획서 §6.2):
 *   init(canvas)            — attach to #fxCanvas, DPR + resize, start rAF loop
 *   unlockAudio()           — create/resume AudioContext on first user gesture
 *   setMuted(bool)
 *   playReveal(comboLevel)  — pleasant blip; pitch rises with comboLevel
 *   playFlag()
 *   playExplosion()         — gritty low boom for hitting a mine
 *   playWin()               — short cheerful fanfare (arpeggio)
 *   playCombo(level)        — rising sparkle when combo tier increases
 *   burst(x, y, opts)       — small particle spray at canvas coords
 *   confetti()              — full-screen celebratory confetti burst
 *   shake(intensity)        — shake #app, decays over ~300ms, reduced-motion aware
 *   haptic(pattern)         — navigator.vibrate wrapper; no-op if unsupported
 * ─────────────────────────────────────────────────────────────────────────
 */
(function () {
  "use strict";

  /* =======================================================================
   * Internal state
   * ===================================================================== */

  /** @type {HTMLCanvasElement|null} */
  let canvas = null;
  /** @type {CanvasRenderingContext2D|null} */
  let ctx = null;
  /** Device-pixel-ratio-corrected logical (CSS) size of the canvas. */
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;

  /** Single requestAnimationFrame handle so we never spin up two loops. */
  let rafId = 0;
  /** Timestamp of the previous frame (ms), for delta-time integration. */
  let lastT = 0;

  /** Active particle pool. Dead particles are compacted out each frame. */
  const particles = [];
  /** Hard cap so a click-storm can never tank the framerate / leak memory. */
  const MAX_PARTICLES = 900;

  /** Screen-shake state (applied as a transform to #app). */
  const shakeState = { amp: 0, until: 0, el: null };

  /* --- Audio ------------------------------------------------------------ */
  /** @type {AudioContext|null} */
  let audioCtx = null;
  /** Master gain — also our mute switch (gain 0 when muted). */
  let masterGain = null;
  let muted = false;
  let audioReady = false;

  /* =======================================================================
   * Small utilities
   * ===================================================================== */

  const now = () =>
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();

  const rand = (min, max) => min + Math.random() * (max - min);

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /** True when the user has asked the OS to minimise motion. */
  function prefersReducedMotion() {
    try {
      return (
        typeof matchMedia === "function" &&
        matchMedia("(prefers-reduced-motion: reduce)").matches
      );
    } catch (_e) {
      return false;
    }
  }

  /** Nice neon-ish default palette, matching the game's dark/neon theme. */
  const PALETTE = [
    "#7c5cff", // violet
    "#ff5ca8", // pink
    "#22d3ee", // cyan
    "#a3e635", // lime
    "#fbbf24", // amber
    "#f472b6", // rose
    "#60a5fa", // blue
  ];

  const pickColor = () => PALETTE[(Math.random() * PALETTE.length) | 0];

  /* =======================================================================
   * Canvas init / resize / render loop
   * ===================================================================== */

  /**
   * Attach to the overlay canvas, size it for the current DPR and kick off
   * the single animation loop. Safe to call more than once.
   * @param {HTMLCanvasElement} el  the #fxCanvas element
   */
  function init(el) {
    try {
      if (!el || typeof el.getContext !== "function") return;
      canvas = el;
      ctx = canvas.getContext("2d");
      if (!ctx) return;

      resize();

      // Re-read the client size whenever the viewport changes.
      if (typeof window !== "undefined" && window.addEventListener) {
        window.removeEventListener("resize", resize);
        window.addEventListener("resize", resize, { passive: true });
      }

      startLoop();
    } catch (_e) {
      /* never throw from init */
    }
  }

  /** Re-read the canvas' CSS size and scale the backing store for the DPR. */
  function resize() {
    try {
      if (!canvas || !ctx) return;
      dpr = clamp(
        (typeof window !== "undefined" && window.devicePixelRatio) || 1,
        1,
        3 // cap DPR — retina phones can report 3-4; 3 is plenty and cheaper
      );

      // Prefer the real rendered size; fall back to attributes if unstyled.
      const rect = canvas.getBoundingClientRect
        ? canvas.getBoundingClientRect()
        : { width: canvas.width, height: canvas.height };
      cssW = Math.max(1, Math.round(rect.width || canvas.clientWidth || 300));
      cssH = Math.max(1, Math.round(rect.height || canvas.clientHeight || 150));

      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);

      // Draw in CSS pixels; the transform bakes in the DPR scale.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    } catch (_e) {
      /* ignore */
    }
  }

  /** Ensure exactly one rAF loop is running. */
  function startLoop() {
    if (rafId || typeof requestAnimationFrame !== "function") return;
    lastT = now();
    rafId = requestAnimationFrame(frame);
  }

  /**
   * The one and only animation frame. Advances particles, confetti and shake,
   * then redraws. Runs continuously but does almost nothing when idle.
   */
  function frame(t) {
    rafId = requestAnimationFrame(frame);
    try {
      const dt = clamp((t - lastT) / 1000, 0, 0.05); // seconds, clamped (tab switches)
      lastT = t;

      updateParticles(dt);
      updateShake();
      render();
    } catch (_e) {
      /* a bad frame should never kill the loop */
    }
  }

  /* =======================================================================
   * Particles
   * ===================================================================== */

  /**
   * Particle shape:
   *  { x, y, vx, vy, life, ttl, size, color, gravity, drag, shape, rot, vr, alpha }
   * Positions are in CSS pixels (same coord space callers use).
   */

  function spawnParticle(p) {
    if (particles.length >= MAX_PARTICLES) {
      // Recycle the oldest rather than growing unbounded.
      particles.shift();
    }
    particles.push(p);
  }

  function updateParticles(dt) {
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.life += dt;
      // Integrate simple physics.
      p.vy += p.gravity * dt;
      p.vx *= p.drag;
      p.vy *= p.drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      // Fade + shrink over the particle's lifetime.
      const k = 1 - p.life / p.ttl;
      p.alpha = clamp(k, 0, 1);
    }
    // Compact: drop dead / off-screen particles in one pass (no allocations).
    let w = 0;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const alive =
        p.life < p.ttl && p.y < cssH + 60 && p.alpha > 0.02;
      if (alive) particles[w++] = p;
    }
    particles.length = w;
  }

  function render() {
    if (!ctx) return;
    // Clear the whole logical surface.
    ctx.clearRect(0, 0, cssW, cssH);
    if (!particles.length) return;

    ctx.save();
    ctx.globalCompositeOperation = "lighter"; // additive glow reads well on dark UI
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const s = p.size * (0.35 + 0.65 * p.alpha); // shrink as it dies
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;

      if (p.shape === "ribbon") {
        // Confetti ribbon: a small rotating rectangle.
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalCompositeOperation = "source-over"; // solid confetti, not additive
        ctx.fillRect(-s * 0.5, -s * 0.9, s, s * 1.8);
        ctx.restore();
      } else {
        // Default spark: a soft round dot.
        ctx.beginPath();
        ctx.arc(p.x, p.y, s, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
    // Reset defaults that the loop relies on.
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /**
   * Small cheap spray of sparks — used every time a cell opens, so it must
   * stay light. Gravity pulls them down; they fade + shrink out.
   * @param {number} x  canvas (CSS px) x
   * @param {number} y  canvas (CSS px) y
   * @param {{color?:string,count?:number}} [opts]
   */
  function burst(x, y, opts) {
    try {
      if (!ctx) return;
      const o = opts || {};
      const color = o.color || pickColor();
      let count = o.count != null ? o.count : 10;
      // Under motion-reduction, still give a tiny pop but keep it minimal.
      if (prefersReducedMotion()) count = Math.min(count, 4);
      count = clamp(count | 0, 0, 40);

      for (let i = 0; i < count; i++) {
        const ang = rand(0, Math.PI * 2);
        const spd = rand(40, 190);
        spawnParticle({
          x,
          y,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd - rand(20, 90), // slight upward bias
          life: 0,
          ttl: rand(0.45, 0.85),
          size: rand(2, 4.5),
          color,
          gravity: 520,
          drag: 0.92,
          shape: "spark",
          rot: 0,
          vr: 0,
          alpha: 1,
        });
      }
    } catch (_e) {
      /* ignore */
    }
  }

  /**
   * Full-screen celebration: colourful ribbons raining from the top plus a
   * central pop. Lives ~2-3s (handled purely by particle ttl in the loop).
   * Skipped entirely under reduced-motion.
   */
  function confetti() {
    try {
      if (!ctx || prefersReducedMotion()) return;
      const N = 140;
      for (let i = 0; i < N; i++) {
        const fromTop = i < N * 0.7;
        const x = fromTop ? rand(0, cssW) : cssW * 0.5;
        const y = fromTop ? rand(-40, -4) : cssH * 0.5;
        const ang = fromTop ? rand(Math.PI * 0.35, Math.PI * 0.65) : rand(0, Math.PI * 2);
        const spd = fromTop ? rand(60, 160) : rand(180, 420);
        spawnParticle({
          x,
          y,
          vx: Math.cos(ang) * spd + (fromTop ? rand(-40, 40) : 0),
          vy: Math.abs(Math.sin(ang)) * spd + (fromTop ? rand(30, 80) : 0),
          life: 0,
          ttl: rand(2.0, 3.0),
          size: rand(5, 9),
          color: pickColor(),
          gravity: 260,
          drag: 0.995,
          shape: "ribbon",
          rot: rand(0, Math.PI * 2),
          vr: rand(-6, 6),
          alpha: 1,
        });
      }
    } catch (_e) {
      /* ignore */
    }
  }

  /* =======================================================================
   * Screen shake (transform on #app)
   * ===================================================================== */

  /**
   * Kick off a screen shake that decays over ~300ms. No-op under
   * reduced-motion. Intensity is roughly the peak pixel offset.
   * @param {number} [intensity=8]
   */
  function shake(intensity) {
    try {
      if (prefersReducedMotion()) return;
      if (!shakeState.el) {
        shakeState.el =
          (typeof document !== "undefined" &&
            (document.getElementById("app") || document.body)) ||
          null;
      }
      if (!shakeState.el) return;
      shakeState.amp = clamp(intensity != null ? intensity : 8, 0, 40);
      shakeState.until = now() + 300;
    } catch (_e) {
      /* ignore */
    }
  }

  /** Per-frame update of the shake transform; clears itself when done. */
  function updateShake() {
    const el = shakeState.el;
    if (!el) return;
    const t = now();
    if (t >= shakeState.until || shakeState.amp <= 0) {
      if (shakeState.amp !== 0) {
        // One final reset so we don't leave the element nudged.
        el.style.transform = "";
        shakeState.amp = 0;
      }
      return;
    }
    // Linear decay of amplitude toward the end time.
    const remain = (shakeState.until - t) / 300;
    const a = shakeState.amp * remain;
    const dx = rand(-a, a);
    const dy = rand(-a, a);
    el.style.transform = "translate(" + dx.toFixed(2) + "px," + dy.toFixed(2) + "px)";
  }

  /* =======================================================================
   * Haptics
   * ===================================================================== */

  /**
   * Thin wrapper over navigator.vibrate. Accepts a number or pattern array.
   * Silently no-ops where unsupported (desktop, iOS Safari) or reduced-motion.
   * @param {number|number[]} pattern
   */
  function haptic(pattern) {
    try {
      if (prefersReducedMotion()) return;
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.vibrate === "function"
      ) {
        navigator.vibrate(pattern != null ? pattern : 10);
      }
    } catch (_e) {
      /* ignore */
    }
  }

  /* =======================================================================
   * Audio — everything synthesized with Web Audio (no files, no fetch)
   * ===================================================================== */

  /**
   * Create (lazily) and resume the AudioContext. MUST be called from a user
   * gesture (autoplay policy). Safe to call repeatedly.
   */
  function unlockAudio() {
    try {
      const AC =
        typeof window !== "undefined" &&
        (window.AudioContext || window.webkitAudioContext);
      if (!AC) return;

      if (!audioCtx) {
        audioCtx = new AC();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = muted ? 0 : 0.9;
        masterGain.connect(audioCtx.destination);
      }
      if (audioCtx.state === "suspended" && audioCtx.resume) {
        audioCtx.resume();
      }
      audioReady = audioCtx.state === "running";
      // Some browsers report "suspended" until the resume promise settles;
      // treat a live context object as usable so the first sounds aren't lost.
      if (!audioReady && audioCtx.state !== "closed") audioReady = true;
    } catch (_e) {
      audioCtx = null;
      audioReady = false;
    }
  }

  /** Mute/unmute by riding the master gain (keeps the loop/context alive). */
  function setMuted(v) {
    muted = !!v;
    try {
      if (masterGain && audioCtx) {
        const g = masterGain.gain;
        g.cancelScheduledValues(audioCtx.currentTime);
        g.setValueAtTime(muted ? 0 : 0.9, audioCtx.currentTime);
      }
    } catch (_e) {
      /* ignore */
    }
  }

  /** True only when we actually have a context we can schedule on. */
  function canPlay() {
    return !!(audioCtx && masterGain && !muted && audioReady);
  }

  /**
   * Core voice: one oscillator through its own gain envelope into master.
   * Guarded and self-cleaning (nodes are short-lived and auto-GC'd on stop).
   *
   * @param {Object} o
   * @param {number} o.freq      start frequency (Hz)
   * @param {number} [o.freqEnd] optional glide target frequency
   * @param {string} [o.type]    oscillator type
   * @param {number} [o.dur]     total duration (s)
   * @param {number} [o.gain]    peak gain
   * @param {number} [o.attack]  attack time (s)
   * @param {number} [o.when]    start offset from now (s)
   * @param {AudioNode} [o.dest] destination node (defaults to master)
   */
  function tone(o) {
    if (!canPlay()) return;
    try {
      const t0 = audioCtx.currentTime + (o.when || 0);
      const dur = o.dur != null ? o.dur : 0.15;
      const peak = o.gain != null ? o.gain : 0.25;
      const attack = o.attack != null ? o.attack : 0.006;

      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.type = o.type || "sine";
      osc.frequency.setValueAtTime(o.freq, t0);
      if (o.freqEnd != null) {
        osc.frequency.exponentialRampToValueAtTime(
          Math.max(1, o.freqEnd),
          t0 + dur
        );
      }

      // Percussive AD envelope — quick attack, exponential decay to silence.
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      osc.connect(g);
      g.connect(o.dest || masterGain);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    } catch (_e) {
      /* ignore a single failed voice */
    }
  }

  /**
   * playReveal — pleasant short blip. Pitch rises with the combo level so the
   * player literally hears their streak climbing. Capped so it never gets
   * shrill.
   * @param {number} [comboLevel=0]
   */
  function playReveal(comboLevel) {
    if (!canPlay()) return;
    const lvl = clamp((comboLevel | 0) || 0, 0, 24); // cap the pitch climb
    const base = 440; // A4
    const freq = clamp(base * Math.pow(1.06, lvl), base, 1760); // hard ceiling ~A6
    // Two-osc blip: a sine body + a soft triangle sparkle a fifth up.
    tone({ freq, type: "sine", dur: 0.11, gain: 0.22, attack: 0.004 });
    tone({
      freq: freq * 1.5,
      type: "triangle",
      dur: 0.08,
      gain: 0.08,
      attack: 0.004,
    });
  }

  /** playFlag — short muted "tick" for placing/removing a flag. */
  function playFlag() {
    if (!canPlay()) return;
    tone({ freq: 320, freqEnd: 240, type: "square", dur: 0.07, gain: 0.12 });
  }

  /**
   * playExplosion — gritty low boom for hitting a mine. Built from a
   * pitch-diving oscillator plus a burst of filtered white noise, sent through
   * a lowpass so it stays a thud rather than a harsh hiss.
   */
  function playExplosion() {
    if (!canPlay()) return;
    try {
      const t0 = audioCtx.currentTime;
      const dur = 0.55;

      // --- Low body: sine diving from ~180Hz to ~40Hz ---
      tone({ freq: 180, freqEnd: 42, type: "sine", dur, gain: 0.5, attack: 0.005 });
      tone({ freq: 90, freqEnd: 30, type: "triangle", dur: dur * 0.9, gain: 0.35 });

      // --- Noise crack: short buffer of white noise through a lowpass ---
      const len = Math.floor(audioCtx.sampleRate * dur);
      const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        // Decaying noise so the crack sits at the front.
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
      }
      const noise = audioCtx.createBufferSource();
      noise.buffer = buf;

      const lp = audioCtx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(1400, t0);
      lp.frequency.exponentialRampToValueAtTime(180, t0 + dur);

      const ng = audioCtx.createGain();
      ng.gain.setValueAtTime(0.0001, t0);
      ng.gain.exponentialRampToValueAtTime(0.6, t0 + 0.01);
      ng.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      noise.connect(lp);
      lp.connect(ng);
      ng.connect(masterGain);
      noise.start(t0);
      noise.stop(t0 + dur + 0.02);
    } catch (_e) {
      /* ignore */
    }
  }

  /**
   * playWin — short cheerful major arpeggio fanfare (C-E-G-C), the last note
   * ringing a touch longer with a bright triangle sparkle on top.
   */
  function playWin() {
    if (!canPlay()) return;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    for (let i = 0; i < notes.length; i++) {
      const last = i === notes.length - 1;
      tone({
        freq: notes[i],
        type: "triangle",
        dur: last ? 0.42 : 0.16,
        gain: 0.22,
        attack: 0.005,
        when: i * 0.1,
      });
      // Octave shimmer on top.
      tone({
        freq: notes[i] * 2,
        type: "sine",
        dur: last ? 0.42 : 0.12,
        gain: 0.05,
        when: i * 0.1,
      });
    }
  }

  /**
   * playCombo — rising sparkle when the combo tier increases. Level nudges the
   * pitch up a little each tier so bigger combos feel higher/brighter.
   * @param {number} [level=1]
   */
  function playCombo(level) {
    if (!canPlay()) return;
    const lvl = clamp((level | 0) || 1, 1, 12);
    const start = clamp(660 * Math.pow(1.05, lvl), 660, 1600);
    // Quick two-note upward glide with a shimmer.
    tone({ freq: start, freqEnd: start * 1.5, type: "triangle", dur: 0.18, gain: 0.2 });
    tone({
      freq: start * 2,
      freqEnd: start * 3,
      type: "sine",
      dur: 0.16,
      gain: 0.06,
      when: 0.03,
    });
  }

  /* =======================================================================
   * Public API
   * ===================================================================== */

  window.Effects = {
    init,
    unlockAudio,
    setMuted,
    playReveal,
    playFlag,
    playExplosion,
    playWin,
    playCombo,
    burst,
    confetti,
    shake,
    haptic,
  };
})();

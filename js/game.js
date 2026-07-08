/**
 * MINE RUSH — Controller (game.js)
 * 엔진(engine.js) + 이펙트(effects.js) + DOM 을 연결하는 통합 컨트롤러.
 * 콤보/점수/타이머/난이도/기록(localStorage) 관리.
 */
(() => {
  'use strict';

  // ---- 난이도 정의 ----------------------------------------------------------
  const DIFFICULTY = {
    easy:   { rows: 9,  cols: 9,  mines: 10, label: '쉬움' },
    normal: { rows: 16, cols: 16, mines: 40, label: '보통' },
    hard:   { rows: 16, cols: 30, mines: 99, label: '어려움' },
  };

  // 인접 숫자별 파티클 색상 (CSS 컬러코딩과 정합)
  const NUM_COLORS = {
    1: '#22d3ee', 2: '#4ade80', 3: '#f472b6', 4: '#a78bfa',
    5: '#fbbf24', 6: '#2dd4bf', 7: '#e2e8f0', 8: '#f87171',
  };

  // ---- DOM 참조 -------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const boardEl   = $('board');
  const canvasEl  = $('fxCanvas');
  const mineCountEl = $('mineCount');
  const timerEl   = $('timer');
  const scoreEl   = $('score');
  const comboEl   = $('combo');
  const comboXEl  = $('comboX');
  const comboFillEl = $('comboFill');
  const overlayEl = $('overlay');
  const overlayEmoji = $('overlayEmoji');
  const overlayTitle = $('overlayTitle');
  const overlaySub   = $('overlaySub');
  const difficultyEl = $('difficulty');
  const flagToggleEl = $('flagToggle');
  const muteToggleEl = $('muteToggle');
  const bestScoreEl  = $('bestScore');
  const bestTimeEl   = $('bestTime');
  const streakEl     = $('streak');

  // ---- 상태 -----------------------------------------------------------------
  let engine = null;
  let cells = [];            // cells[r][c] = <button>
  let level = 'easy';
  let cfg = DIFFICULTY.easy;

  let score = 0;
  let combo = 0;             // 현재 콤보 수
  let comboTier = 0;         // 배율 티어
  let comboTimer = null;     // 콤보 유지 타이머
  const COMBO_WINDOW = 1500; // ms

  let seconds = 0;
  let tickInterval = null;
  let started = false;       // 첫 클릭으로 시작됐는지
  let flagMode = false;      // 모바일 깃발 모드
  let muted = false;
  let audioUnlocked = false;

  // ---- 유틸 -----------------------------------------------------------------
  const multiplierFor = (c) => Math.min(1 + Math.floor(c / 5), 10);

  function loadRecords() {
    try { return JSON.parse(localStorage.getItem('mineRush.records') || '{}'); }
    catch { return {}; }
  }
  function saveRecords(r) {
    try { localStorage.setItem('mineRush.records', JSON.stringify(r)); } catch { /* noop */ }
  }
  function getStreak() {
    const n = parseInt(localStorage.getItem('mineRush.streak') || '0', 10);
    return Number.isFinite(n) ? n : 0;
  }
  function setStreak(n) {
    try { localStorage.setItem('mineRush.streak', String(n)); } catch { /* noop */ }
  }

  function fmtTime(s) {
    if (s == null) return '–';
    const m = Math.floor(s / 60), sec = s % 60;
    return m > 0 ? `${m}:${String(sec).padStart(2, '0')}` : `${sec}s`;
  }

  function refreshBestStrip() {
    const rec = loadRecords()[level] || {};
    bestScoreEl.textContent = rec.bestScore || 0;
    bestTimeEl.textContent  = rec.bestTime != null ? fmtTime(rec.bestTime) : '–';
    streakEl.textContent    = getStreak();
  }

  // ---- 캔버스 좌표 계산 ------------------------------------------------------
  function cellCenterOnCanvas(r, c) {
    const cellEl = cells[r] && cells[r][c];
    if (!cellEl) return { x: 0, y: 0 };
    const cr = cellEl.getBoundingClientRect();
    const kr = canvasEl.getBoundingClientRect();
    return { x: cr.left - kr.left + cr.width / 2, y: cr.top - kr.top + cr.height / 2 };
  }

  // ---- 보드 생성 ------------------------------------------------------------
  function buildBoard() {
    engine = new MinesweeperEngine(cfg.rows, cfg.cols, cfg.mines);
    boardEl.style.setProperty('--cols', cfg.cols);
    boardEl.style.setProperty('--rows', cfg.rows);
    boardEl.innerHTML = '';
    cells = [];

    for (let r = 0; r < cfg.rows; r++) {
      const rowArr = [];
      for (let c = 0; c < cfg.cols; c++) {
        const btn = document.createElement('button');
        btn.className = 'cell';
        btn.type = 'button';
        btn.dataset.r = r;
        btn.dataset.c = c;
        btn.dataset.revealed = 'false';
        btn.dataset.flagged = 'false';
        btn.setAttribute('aria-label', `칸 ${r + 1},${c + 1}`);
        rowArr.push(btn);
        boardEl.appendChild(btn);
      }
      cells.push(rowArr);
    }
    // 캔버스 이펙트 좌표계 갱신
    if (window.Effects && Effects.init) Effects.init(canvasEl);
  }

  // ---- 셀 DOM 갱신 ----------------------------------------------------------
  function paintRevealed(list) {
    for (const { r, c, adjacent, mine } of list) {
      const el = cells[r][c];
      if (!el) continue;
      el.dataset.revealed = 'true';
      el.dataset.flagged = 'false';
      el.classList.add('cell--flip');
      if (mine) {
        el.dataset.mine = 'true';
        el.textContent = '💣';
      } else {
        el.dataset.adjacent = String(adjacent);
        el.textContent = adjacent > 0 ? String(adjacent) : '';
      }
    }
  }

  // ---- 콤보 -----------------------------------------------------------------
  function bumpCombo(openedCount) {
    combo += openedCount;
    const newTier = multiplierFor(combo);
    if (newTier > comboTier) {
      comboTier = newTier;
      if (window.Effects) Effects.playCombo(comboTier);
    }
    comboEl.dataset.active = 'true';
    comboXEl.textContent = `×${comboTier}`;
    // 게이지: 현재 티어 내 진행도
    const within = combo % 5;
    comboFillEl.style.width = `${(within / 5) * 100}%`;

    clearTimeout(comboTimer);
    comboTimer = setTimeout(resetCombo, COMBO_WINDOW);
  }
  function resetCombo() {
    combo = 0;
    comboTier = 0;
    comboEl.dataset.active = 'false';
    comboXEl.textContent = '×1';
    comboFillEl.style.width = '0%';
    clearTimeout(comboTimer);
  }

  function addScore(openedCount) {
    const gained = openedCount * 10 * multiplierFor(combo);
    score += gained;
    scoreEl.textContent = score;
    scoreEl.classList.remove('pop');
    void scoreEl.offsetWidth; // reflow to restart animation
    scoreEl.classList.add('pop');
  }

  // ---- 타이머 ---------------------------------------------------------------
  function startTimer() {
    if (started) return;
    started = true;
    seconds = 0;
    timerEl.textContent = seconds;
    tickInterval = setInterval(() => {
      seconds++;
      timerEl.textContent = seconds;
    }, 1000);
  }
  function stopTimer() { clearInterval(tickInterval); tickInterval = null; }

  // ---- 오디오 언락 ----------------------------------------------------------
  function ensureAudio() {
    if (audioUnlocked || !window.Effects) return;
    Effects.unlockAudio();
    audioUnlocked = true;
  }

  // ---- 이펙트 헬퍼 ----------------------------------------------------------
  function fxForReveals(list) {
    if (!window.Effects) return;
    // 너무 많은 칸이면 일부만 파티클 (성능)
    const sample = list.length > 24 ? list.filter((_, i) => i % Math.ceil(list.length / 24) === 0) : list;
    for (const { r, c, mine, adjacent } of sample) {
      if (mine) continue;
      const { x, y } = cellCenterOnCanvas(r, c);
      Effects.burst(x, y, { color: NUM_COLORS[adjacent] || '#8b5cf6', count: 6 });
    }
  }

  // ---- 게임 진행 처리 --------------------------------------------------------
  function updateMineCounter() {
    mineCountEl.textContent = engine.remainingMines;
  }

  function handleReveal(r, c) {
    if (engine.state === 'won' || engine.state === 'lost') return;
    const res = engine.reveal(r, c);
    if (!res.ok) return;
    startTimer();

    paintRevealed(res.revealed);

    if (res.state === 'lost') {
      onLose(res.hitMine);
      return;
    }

    // 안전 칸 열림 → 도파민
    const opened = res.revealed.length;
    bumpCombo(opened);
    addScore(opened);
    fxForReveals(res.revealed);
    if (window.Effects) {
      Effects.playReveal(comboTier);
      Effects.haptic(10);
    }

    if (res.state === 'won') onWin();
  }

  function handleFlag(r, c) {
    if (engine.state === 'won' || engine.state === 'lost') return;
    const res = engine.toggleFlag(r, c);
    if (!res.ok) return;
    const el = cells[r][c];
    el.dataset.flagged = String(res.flagged);
    el.textContent = res.flagged ? '🚩' : '';
    updateMineCounter();
    if (window.Effects) { Effects.playFlag(); Effects.haptic(res.flagged ? 15 : 8); }
  }

  function handleChord(r, c) {
    if (engine.state === 'won' || engine.state === 'lost') return;
    const res = engine.chord(r, c);
    if (!res.ok || res.revealed.length === 0) return;
    paintRevealed(res.revealed);
    if (res.state === 'lost') { onLose(res.hitMine); return; }
    const opened = res.revealed.length;
    bumpCombo(opened);
    addScore(opened);
    fxForReveals(res.revealed);
    if (window.Effects) Effects.playReveal(comboTier);
    if (res.state === 'won') onWin();
  }

  // ---- 승/패 ----------------------------------------------------------------
  function onLose(hitMine) {
    stopTimer();
    resetCombo();
    // 모든 지뢰 공개
    for (const { r, c } of engine.allMines()) {
      const el = cells[r][c];
      if (el.dataset.flagged === 'true') continue;
      el.dataset.revealed = 'true';
      el.dataset.mine = 'true';
      if (!el.textContent) el.textContent = '💣';
    }
    if (hitMine) {
      const el = cells[hitMine.r][hitMine.c];
      el.dataset.exploded = 'true';
    }
    if (window.Effects) {
      Effects.playExplosion();
      Effects.shake(1);
      Effects.haptic([40, 30, 60]);
    }
    setStreak(0);
    showOverlay('💥', 'BOOM!', `점수 ${score} · 시간 ${fmtTime(seconds)}`, false);
    refreshBestStrip();
  }

  function onWin() {
    stopTimer();
    resetCombo();
    // 승리 보너스: 남은 여유 + 난이도 가중
    const diffWeight = { easy: 1, normal: 2, hard: 3 }[level] || 1;
    const timeBonus = Math.max(0, 500 - seconds * 2) * diffWeight;
    score += timeBonus;
    scoreEl.textContent = score;

    // 기록 저장
    const records = loadRecords();
    const rec = records[level] || {};
    let newBestScore = false, newBestTime = false;
    if (score > (rec.bestScore || 0)) { rec.bestScore = score; newBestScore = true; }
    if (rec.bestTime == null || seconds < rec.bestTime) { rec.bestTime = seconds; newBestTime = true; }
    records[level] = rec;
    saveRecords(records);
    setStreak(getStreak() + 1);

    if (window.Effects) {
      Effects.playWin();
      Effects.confetti();
      Effects.haptic([20, 40, 20, 40, 60]);
    }
    const badges = [];
    if (newBestScore) badges.push('🏆 신기록 점수');
    if (newBestTime) badges.push('⚡ 신기록 시간');
    const sub = `점수 ${score} · 시간 ${fmtTime(seconds)} · +보너스 ${timeBonus}` +
      (badges.length ? `\n${badges.join('  ')}` : '');
    showOverlay('🎉', 'CLEAR!', sub, true);
    refreshBestStrip();
  }

  function showOverlay(emoji, title, sub, win) {
    overlayEmoji.textContent = emoji;
    overlayTitle.textContent = title;
    overlaySub.textContent = sub;
    overlayEl.dataset.result = win ? 'win' : 'lose';
    overlayEl.dataset.show = 'true';
  }
  function hideOverlay() { overlayEl.dataset.show = 'false'; }

  // ---- 새 게임 --------------------------------------------------------------
  function newGame() {
    stopTimer();
    resetCombo();
    hideOverlay();
    started = false;
    score = 0;
    seconds = 0;
    scoreEl.textContent = '0';
    timerEl.textContent = '0';
    buildBoard();
    updateMineCounter();
    refreshBestStrip();
  }

  // ---- 입력 바인딩 ----------------------------------------------------------
  function cellFromEvent(e) {
    const el = e.target.closest('.cell');
    if (!el) return null;
    return { r: parseInt(el.dataset.r, 10), c: parseInt(el.dataset.c, 10), el };
  }

  // 롱프레스(모바일 깃발) 지원
  let pressTimer = null;
  let longPressed = false;

  boardEl.addEventListener('pointerdown', (e) => {
    ensureAudio();
    const hit = cellFromEvent(e);
    if (!hit) return;
    longPressed = false;
    if (e.pointerType === 'touch') {
      pressTimer = setTimeout(() => {
        longPressed = true;
        handleFlag(hit.r, hit.c);
      }, 380);
    }
  });
  boardEl.addEventListener('pointerup', () => clearTimeout(pressTimer));
  boardEl.addEventListener('pointercancel', () => clearTimeout(pressTimer));

  boardEl.addEventListener('click', (e) => {
    ensureAudio();
    const hit = cellFromEvent(e);
    if (!hit) return;
    if (longPressed) { longPressed = false; return; } // 롱프레스로 이미 깃발 처리
    const { r, c, el } = hit;
    // 이미 열린 숫자칸 클릭 → 코드(chord)
    if (el.dataset.revealed === 'true') { handleChord(r, c); return; }
    if (flagMode) { handleFlag(r, c); return; }
    handleReveal(r, c);
  });

  // 우클릭 = 깃발
  boardEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const hit = cellFromEvent(e);
    if (!hit) return;
    ensureAudio();
    if (hit.el.dataset.revealed === 'true') { handleChord(hit.r, hit.c); return; }
    handleFlag(hit.r, hit.c);
  });

  // 더블클릭 = 코드
  boardEl.addEventListener('dblclick', (e) => {
    const hit = cellFromEvent(e);
    if (hit && hit.el.dataset.revealed === 'true') handleChord(hit.r, hit.c);
  });

  // ---- 컨트롤 바인딩 --------------------------------------------------------
  difficultyEl.addEventListener('change', () => {
    level = difficultyEl.value;
    cfg = DIFFICULTY[level] || DIFFICULTY.easy;
    newGame();
  });
  $('restart').addEventListener('click', () => { ensureAudio(); newGame(); });
  $('playAgain').addEventListener('click', () => { ensureAudio(); newGame(); });

  flagToggleEl.addEventListener('click', () => {
    flagMode = !flagMode;
    flagToggleEl.setAttribute('aria-pressed', String(flagMode));
    flagToggleEl.classList.toggle('is-on', flagMode);
  });
  muteToggleEl.addEventListener('click', () => {
    muted = !muted;
    if (window.Effects) Effects.setMuted(muted);
    muteToggleEl.setAttribute('aria-pressed', String(muted));
    muteToggleEl.textContent = muted ? '🔇' : '🔊';
  });

  window.addEventListener('resize', () => {
    if (window.Effects && Effects.init) Effects.init(canvasEl);
  });

  // ---- 시작 -----------------------------------------------------------------
  window.addEventListener('DOMContentLoaded', () => {
    level = difficultyEl.value || 'easy';
    cfg = DIFFICULTY[level];
    newGame();
  });
  // DOMContentLoaded 가 이미 지났을 경우 대비
  if (document.readyState !== 'loading') {
    level = difficultyEl.value || 'easy';
    cfg = DIFFICULTY[level];
    newGame();
  }
})();

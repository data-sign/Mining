/**
 * MINE RUSH (지뢰러시) — Game Engine
 * js/engine.js
 *
 * Pure minesweeper logic. No DOM, no globals besides `window.MinesweeperEngine`.
 * Loaded via <script> (NOT an ES module). Deterministic given board state.
 *
 * Public API contract — see docs/기획서.md §6.1
 */

class MinesweeperEngine {
  /**
   * @param {number} rows  board height (>=1)
   * @param {number} cols  board width (>=1)
   * @param {number} mineCount number of mines (clamped to a sane range)
   */
  constructor(rows, cols, mineCount) {
    this._rows = Math.max(1, rows | 0);
    this._cols = Math.max(1, cols | 0);
    const total = this._rows * this._cols;
    // Clamp mines to [0, total - 1] so at least one safe cell always exists.
    this._mineCount = Math.min(Math.max(0, mineCount | 0), total - 1);

    // Optional deterministic mine placement seam (used by self-tests).
    // When set to an array of [r, c] pairs, first reveal uses these instead
    // of random placement. Kept out of the public surface intentionally.
    this._forcedMines = null;

    this._init();
  }

  /** (Re)allocate the grid to a fresh, unplayed state. */
  _init() {
    this._state = 'ready';
    this._minesPlaced = false;
    this._flagsUsed = 0;
    this._revealedCount = 0;
    this._exploded = null; // {r,c} of the mine that was stepped on

    // Flat cell store; each cell is a small plain object.
    this._grid = [];
    for (let r = 0; r < this._rows; r++) {
      const row = [];
      for (let c = 0; c < this._cols; c++) {
        row.push({
          revealed: false,
          flagged: false,
          mine: false,
          adjacent: 0,
          exploded: false,
        });
      }
      this._grid.push(row);
    }
  }

  // ---- Getters -------------------------------------------------------------

  get rows() { return this._rows; }
  get cols() { return this._cols; }
  get mineCount() { return this._mineCount; }
  get state() { return this._state; }
  get flagsUsed() { return this._flagsUsed; }
  get remainingMines() { return this._mineCount - this._flagsUsed; } // may be negative
  get revealedCount() { return this._revealedCount; }

  // ---- Helpers -------------------------------------------------------------

  /** True when (r,c) is inside the board. */
  _inBounds(r, c) {
    return r >= 0 && r < this._rows && c >= 0 && c < this._cols;
  }

  /** Yield the in-bounds coordinates of the 8 neighbors of (r,c). */
  _neighbors(r, c) {
    const out = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (this._inBounds(nr, nc)) out.push([nr, nc]);
      }
    }
    return out;
  }

  /** True once the game has ended. */
  _isOver() {
    return this._state === 'won' || this._state === 'lost';
  }

  /**
   * Public read-only snapshot of a cell.
   * @returns {{revealed:boolean,flagged:boolean,mine:boolean,adjacent:number,exploded:boolean}|null}
   */
  cell(r, c) {
    if (!this._inBounds(r, c)) return null;
    const cell = this._grid[r][c];
    return {
      revealed: cell.revealed,
      flagged: cell.flagged,
      mine: cell.mine,
      adjacent: cell.adjacent,
      exploded: cell.exploded,
    };
  }

  // ---- Mine placement ------------------------------------------------------

  /**
   * Place mines on first reveal, keeping the first-clicked cell and its 8
   * neighbors mine-free. Then compute adjacency counts.
   *
   * Edge case: on tiny boards the safe zone (up to 9 cells) can be larger than
   * the number of cells left over after reserving mines. We shrink the safe
   * zone gracefully — the clicked cell itself is protected first, then as many
   * neighbors as we can afford — so mine placement never gets stuck.
   *
   * @param {number} safeR first-clicked row
   * @param {number} safeC first-clicked col
   */
  _placeMines(safeR, safeC) {
    // Deterministic seam for tests.
    if (this._forcedMines) {
      for (const [mr, mc] of this._forcedMines) {
        if (this._inBounds(mr, mc)) this._grid[mr][mc].mine = true;
      }
      this._minesPlaced = true;
      this._computeAdjacency();
      return;
    }

    const total = this._rows * this._cols;

    // Build the ideal safe set: clicked cell + neighbors.
    const idealSafe = [[safeR, safeC], ...this._neighbors(safeR, safeC)];

    // We need `total - mineCount` non-mine cells. If the safe set is too big to
    // coexist with the requested mines, trim it (clicked cell has top priority).
    const maxSafe = total - this._mineCount; // >= 1 because mineCount <= total-1
    const safeSet = new Set();
    for (const [sr, sc] of idealSafe) {
      if (safeSet.size >= maxSafe) break;
      safeSet.add(sr * this._cols + sc);
    }

    // Candidate cells for mines = everything not in the safe set.
    const candidates = [];
    for (let i = 0; i < total; i++) {
      if (!safeSet.has(i)) candidates.push(i);
    }

    // Fisher–Yates partial shuffle to pick `mineCount` mine positions.
    for (let i = 0; i < this._mineCount; i++) {
      const j = i + Math.floor(Math.random() * (candidates.length - i));
      const tmp = candidates[i];
      candidates[i] = candidates[j];
      candidates[j] = tmp;
      const idx = candidates[i];
      this._grid[(idx / this._cols) | 0][idx % this._cols].mine = true;
    }

    this._minesPlaced = true;
    this._computeAdjacency();
  }

  /** Precompute adjacent-mine counts for every non-mine cell. */
  _computeAdjacency() {
    for (let r = 0; r < this._rows; r++) {
      for (let c = 0; c < this._cols; c++) {
        if (this._grid[r][c].mine) continue;
        let count = 0;
        for (const [nr, nc] of this._neighbors(r, c)) {
          if (this._grid[nr][nc].mine) count++;
        }
        this._grid[r][c].adjacent = count;
      }
    }
  }

  // ---- Reveal --------------------------------------------------------------

  /**
   * Reveal a cell. Places mines on the very first reveal (first-click safe),
   * then flood-fills empty (adjacent==0) regions iteratively.
   *
   * @returns {{ok:boolean, revealed:Array<{r:number,c:number,adjacent:number,mine:boolean}>, state:string, hitMine:{r:number,c:number}|null, firstClick:boolean}}
   */
  reveal(r, c) {
    // Reject out-of-bounds, game-over, already-revealed, or flagged clicks.
    if (!this._inBounds(r, c) || this._isOver()) {
      return { ok: false, revealed: [], state: this._state, hitMine: null, firstClick: false };
    }
    const target = this._grid[r][c];
    if (target.revealed || target.flagged) {
      return { ok: false, revealed: [], state: this._state, hitMine: null, firstClick: false };
    }

    const firstClick = !this._minesPlaced;
    if (firstClick) {
      this._placeMines(r, c);
      this._state = 'playing';
    }

    // Stepping on a mine → immediate loss.
    if (target.mine) {
      target.revealed = true;
      target.exploded = true;
      this._exploded = { r, c };
      this._state = 'lost';
      return {
        ok: true,
        revealed: [{ r, c, adjacent: target.adjacent, mine: true }],
        state: this._state,
        hitMine: { r, c },
        firstClick,
      };
    }

    // Safe cell → flood-fill from here.
    const revealed = this._floodFill(r, c);

    // Win check: all non-mine cells opened.
    if (this._revealedCount === this._rows * this._cols - this._mineCount) {
      this._state = 'won';
    }

    return {
      ok: true,
      revealed,
      state: this._state,
      hitMine: null,
      firstClick,
    };
  }

  /**
   * Iterative flood-fill starting at a known-safe cell.
   * Opens the start cell and, for every opened empty (adjacent==0) cell, its
   * neighbors — cascading. Returns every newly opened cell.
   *
   * @returns {Array<{r:number,c:number,adjacent:number,mine:boolean}>}
   */
  _floodFill(startR, startC) {
    const opened = [];
    const stack = [[startR, startC]];

    while (stack.length) {
      const [r, c] = stack.pop();
      const cell = this._grid[r][c];

      // Skip anything already open, flagged, or a mine (mines are never
      // flood-opened — flood only starts from and expands through safe cells).
      if (cell.revealed || cell.flagged || cell.mine) continue;

      cell.revealed = true;
      this._revealedCount++;
      opened.push({ r, c, adjacent: cell.adjacent, mine: false });

      // Only empty cells (no adjacent mines) cascade to their neighbors.
      if (cell.adjacent === 0) {
        for (const [nr, nc] of this._neighbors(r, c)) {
          const n = this._grid[nr][nc];
          if (!n.revealed && !n.flagged && !n.mine) {
            stack.push([nr, nc]);
          }
        }
      }
    }

    return opened;
  }

  // ---- Flags ---------------------------------------------------------------

  /**
   * Toggle a flag on an unrevealed cell. No-op once the game is over or on a
   * revealed / out-of-bounds cell.
   * @returns {{flagged:boolean, ok:boolean}}
   */
  toggleFlag(r, c) {
    if (!this._inBounds(r, c) || this._isOver()) {
      return { flagged: false, ok: false };
    }
    const cell = this._grid[r][c];
    if (cell.revealed) {
      return { flagged: cell.flagged, ok: false };
    }

    // Flagging is the first interaction that transitions ready -> playing only
    // if mines are placed; keep state 'ready' until an actual reveal happens.
    cell.flagged = !cell.flagged;
    this._flagsUsed += cell.flagged ? 1 : -1;
    return { flagged: cell.flagged, ok: true };
  }

  // ---- Chord ---------------------------------------------------------------

  /**
   * Chord on a revealed numbered cell: if the number of flagged neighbors
   * equals the cell's adjacent count, reveal all non-flagged neighbors. This
   * can trigger flood-fill and/or step on a mine (→ loss).
   *
   * Same return shape as reveal(). If the condition is not met (unrevealed,
   * zero/empty cell, flag count mismatch, game over, out of bounds) returns
   * {ok:false, revealed:[]}.
   */
  chord(r, c) {
    const fail = { ok: false, revealed: [], state: this._state, hitMine: null, firstClick: false };
    if (!this._inBounds(r, c) || this._isOver()) return fail;

    const cell = this._grid[r][c];
    // Must be a revealed numbered cell.
    if (!cell.revealed || cell.mine || cell.adjacent === 0) return fail;

    // Count flagged neighbors; collect the non-flagged, unrevealed ones.
    const neighbors = this._neighbors(r, c);
    let flaggedNeighbors = 0;
    const toReveal = [];
    for (const [nr, nc] of neighbors) {
      const n = this._grid[nr][nc];
      if (n.flagged) flaggedNeighbors++;
      else if (!n.revealed) toReveal.push([nr, nc]);
    }

    if (flaggedNeighbors !== cell.adjacent) return fail;
    if (toReveal.length === 0) {
      // Condition met but nothing to open — treat as a valid no-op reveal.
      return { ok: true, revealed: [], state: this._state, hitMine: null, firstClick: false };
    }

    // Reveal each non-flagged neighbor. Reuse reveal() so mine hits and
    // flood-fill are handled consistently; aggregate results.
    const allRevealed = [];
    let hitMine = null;
    for (const [nr, nc] of toReveal) {
      // A prior reveal in this loop may have opened/ended things; guard.
      if (this._isOver() && this._state === 'lost') {
        // Still attempt remaining reveals? No — once lost, reveal() is a no-op.
        break;
      }
      const res = this.reveal(nr, nc);
      if (res.ok) {
        for (const cellRes of res.revealed) allRevealed.push(cellRes);
        if (res.hitMine) hitMine = res.hitMine;
      }
    }

    return {
      ok: true,
      revealed: allRevealed,
      state: this._state,
      hitMine,
      firstClick: false,
    };
  }

  // ---- Misc ----------------------------------------------------------------

  /** All mine positions (for reveal-all on game over). @returns {Array<{r,c}>} */
  allMines() {
    const out = [];
    for (let r = 0; r < this._rows; r++) {
      for (let c = 0; c < this._cols; c++) {
        if (this._grid[r][c].mine) out.push({ r, c });
      }
    }
    return out;
  }

  /** Start a fresh game with the same dimensions and mine count. */
  reset() {
    this._forcedMines = null;
    this._init();
  }

  // ---- Test-only seam ------------------------------------------------------

  /**
   * Force specific mine positions for the next first reveal, making tests
   * deterministic. Not part of the public gameplay API.
   * @param {Array<[number,number]>} positions
   */
  _forceMines(positions) {
    this._forcedMines = positions;
    this._mineCount = positions.length;
  }
}

// Expose as a global for <script> loading.
if (typeof window !== 'undefined') {
  window.MinesweeperEngine = MinesweeperEngine;
}

/* -------------------------------------------------------------------------- *
 * Self-tests — run at load, silently pass. console.assert only fires on
 * failure. These exercise the core contract on tiny deterministic boards.
 * -------------------------------------------------------------------------- */
(function selfTest() {
  // 1) Board dimensions & mine count.
  const a = new MinesweeperEngine(9, 9, 10);
  console.assert(a.rows === 9 && a.cols === 9 && a.mineCount === 10, 'dimensions/mineCount');
  console.assert(a.state === 'ready' && a.revealedCount === 0 && a.flagsUsed === 0, 'initial state');

  // 2) First-click safety: clicked cell + neighbors are never mines.
  const b = new MinesweeperEngine(9, 9, 20);
  const fr = 4, fc = 4;
  b.reveal(fr, fc);
  console.assert(!b.cell(fr, fc).mine, 'first click is safe');
  let neighborMines = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const nr = fr + dr, nc = fc + dc;
      if (nr >= 0 && nr < 9 && nc >= 0 && nc < 9 && b.cell(nr, nc).mine) neighborMines++;
    }
  }
  console.assert(neighborMines === 0, 'first-click neighbors are safe');
  console.assert(b.allMines().length === 20, 'all mines placed');

  // 3) Flood-fill opens multiple cells at once (deterministic board).
  //    5x5 with a single mine in the far corner — clicking the opposite
  //    corner should cascade across almost the whole board.
  const c = new MinesweeperEngine(5, 5, 1);
  c._forceMines([[0, 0]]);
  const floodRes = c.reveal(4, 4);
  console.assert(floodRes.ok && floodRes.firstClick, 'flood reveal ok & firstClick');
  console.assert(floodRes.revealed.length > 1, 'flood-fill opened multiple cells');
  // Every revealed entry must correspond to an actually-open cell.
  console.assert(
    floodRes.revealed.every((x) => c.cell(x.r, x.c).revealed),
    'revealed array matches board state'
  );
  console.assert(floodRes.revealed.length === c.revealedCount, 'revealedCount matches');

  // 4) Flag toggle mechanics.
  const d = new MinesweeperEngine(5, 5, 3);
  const t1 = d.toggleFlag(0, 0);
  console.assert(t1.ok && t1.flagged && d.flagsUsed === 1, 'flag on');
  console.assert(d.remainingMines === 2, 'remainingMines after flag');
  const t2 = d.toggleFlag(0, 0);
  console.assert(t2.ok && !t2.flagged && d.flagsUsed === 0, 'flag off');
  d.reveal(2, 2);
  console.assert(!d.toggleFlag(2, 2).ok, 'cannot flag a revealed cell');

  // 5) Win detection on a tiny board: 2x2 with one mine.
  const e = new MinesweeperEngine(2, 2, 1);
  e._forceMines([[0, 0]]);
  e.reveal(1, 1); // safe corner; flood may or may not cascade past the mine's number ring
  // Open remaining non-mine cells explicitly if still playing.
  if (e.state === 'playing') {
    if (!e.cell(0, 1).revealed) e.reveal(0, 1);
    if (!e.cell(1, 0).revealed) e.reveal(1, 0);
  }
  console.assert(e.state === 'won', 'win when all non-mine cells revealed');
  console.assert(e.revealedCount === 3, 'won board revealed count = rows*cols - mines');

  // 6) Lose detection: stepping on a mine.
  const f = new MinesweeperEngine(3, 3, 1);
  f._forceMines([[2, 2]]);
  f.reveal(1, 1);             // numbered cell (=1) — opens only itself, no auto-win
  const loseRes = f.reveal(2, 2); // step on the mine
  console.assert(loseRes.state === 'lost' && loseRes.hitMine && loseRes.hitMine.r === 2 && loseRes.hitMine.c === 2, 'lose + hitMine');
  console.assert(f.cell(2, 2).exploded === true, 'exploded flag set on hit mine');

  // 7) Reveal on already-revealed / flagged / out-of-bounds → ok:false, no state change.
  const g = new MinesweeperEngine(4, 4, 2);
  g._forceMines([[0, 0], [0, 3]]);
  g.reveal(3, 3);
  const already = g.reveal(3, 3);
  console.assert(!already.ok && already.revealed.length === 0, 'reveal already-open → ok:false');
  g.toggleFlag(1, 0);
  const onFlag = g.reveal(1, 0);
  console.assert(!onFlag.ok && onFlag.revealed.length === 0, 'reveal flagged → ok:false');
  const oob = g.reveal(99, 99);
  console.assert(!oob.ok, 'reveal out-of-bounds → ok:false');

  // 8) Chord behavior: a numbered cell with the right number of flags opens the rest.
  //    3x3, single mine at (0,0). Reveal (1,1) — it is a "1" adjacent to the mine.
  const h = new MinesweeperEngine(3, 3, 1);
  h._forceMines([[0, 0]]);
  h.reveal(1, 1); // numbered cell (=1) — opens only itself, keeps neighbors closed
  console.assert(h.cell(1, 1).adjacent === 1, 'chord target reads correct number');
  // Chord before flagging → condition not met.
  const noFlag = h.chord(1, 1);
  console.assert(!noFlag.ok, 'chord without matching flags → ok:false');
  // Flag the mine, then chord — should open remaining neighbors safely.
  h.toggleFlag(0, 0);
  const chordRes = h.chord(1, 1);
  console.assert(chordRes.ok, 'chord with matching flag count → ok:true');
  console.assert(chordRes.state !== 'lost', 'correct chord does not lose');

  // 9) Chord that hits a mine (wrong flag) loses the game.
  const k = new MinesweeperEngine(3, 3, 1);
  k._forceMines([[0, 0]]);
  k.reveal(1, 1); // numbered cell (=1), neighbors stay closed
  k.toggleFlag(0, 1); // wrong flag, but count matches the "1"
  const badChord = k.chord(1, 1);
  console.assert(badChord.ok && badChord.state === 'lost' && badChord.hitMine, 'chord onto mine loses');

  // 10) Small-board edge case: safe zone larger than available cells must not hang.
  const m = new MinesweeperEngine(3, 3, 8); // 9 cells, 8 mines → only 1 safe cell
  const edgeRes = m.reveal(1, 1);
  console.assert(edgeRes.ok && !m.cell(1, 1).mine, 'tiny board: clicked cell safe');
  console.assert(m.allMines().length === 8, 'tiny board: all mines placed');
  console.assert(m.state === 'won', 'tiny board: single safe cell wins immediately');
})();

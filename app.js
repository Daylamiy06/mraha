const PHASES = Object.freeze({ TSO: "TSO", NDRAZI: "NDRAZI" });
const DIRECTIONS = Object.freeze({ LEFT: "LEFT", RIGHT: "RIGHT" });
const MOVE_TYPES = Object.freeze({
  TSO_CAPTURE: "TSO_CAPTURE",
  TSO_MKAZO: "TSO_MKAZO",
  NDRAZI: "NDRAZI",
  NDRAZI_MKAZO: "NDRAZI_MKAZO",
});
const EVENTS = Object.freeze({
  RESERVE_DROP: "RESERVE_DROP",
  SOW: "SOW",
  CAPTURE: "CAPTURE",
  NYUMBA_LOST: "NYUMBA_LOST",
  PHASE_CHANGE: "PHASE_CHANGE",
  DEFEAT: "DEFEAT",
  VICTORY: "VICTORY",
  MKAZO_PENDING: "MKAZO_PENDING",
  MKAZO_CONFIRMED: "MKAZO_CONFIRMED",
  UDZA: "UDZA",
  NYUMBA_STOP: "NYUMBA_STOP",
  NYUMBA_CONTINUE: "NYUMBA_CONTINUE",
});
const NYUMBA_ACTIONS = Object.freeze({ STOP: "STOP", CONTINUE: "CONTINUE" });

const INITIAL_RESERVE = 22;
const INITIAL_UDZA = 2;
const NYUMBA_PIT = 5;
const RIGHT_CYCLE = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
const LEFT_CYCLE = Object.freeze([8, 7, 6, 5, 4, 3, 2, 1, 16, 15, 14, 13, 12, 11, 10, 9]);
const OPPOSITE_INNER = Object.freeze({ 1: 8, 2: 7, 3: 6, 4: 5, 5: 4, 6: 3, 7: 2, 8: 1 });
const ACTIVE_TO_DIRECTION = Object.freeze({ 1: DIRECTIONS.RIGHT, 8: DIRECTIONS.LEFT });

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createPlayer(inner, outer = Array(8).fill(0)) {
  return {
    inner: [...inner],
    outer: [...outer],
    reserve: INITIAL_RESERVE,
    nyumbaActive: true,
    udzaRemaining: INITIAL_UDZA,
  };
}

export class MrahaEngine {
  #state;
  #lastMoveResult = null;
  #pendingMkazo = null;
  #previousWinner = null;

  constructor(state) {
    this.#state = state ? this.#sanitizeImportedState(state) : this.#createInitialState();
    this.#lastMoveResult = state?.lastMoveResult ? deepClone(state.lastMoveResult) : null;
    this.#pendingMkazo = state?.pendingMkazo ? deepClone(state.pendingMkazo) : null;
    this.#previousWinner = state?.previousWinner ?? null;
  }

  getState() {
    return deepClone(this.#publicState());
  }

  exportState() {
    return deepClone({
      ...this.#state,
      pendingMkazo: this.#pendingMkazo,
      lastMoveResult: this.#lastMoveResult,
      previousWinner: this.#previousWinner,
    });
  }

  importState(state) {
    const imported = this.#sanitizeImportedState(state);
    this.#state = imported;
    this.#pendingMkazo = state?.pendingMkazo ? deepClone(state.pendingMkazo) : null;
    this.#lastMoveResult = state?.lastMoveResult ? deepClone(state.lastMoveResult) : null;
    this.#previousWinner = state?.previousWinner ?? null;
  }

  getCurrentPlayer() { return this.#state.currentPlayer; }
  getPhase() { return this.#state.phase; }
  isGameOver() { return this.#state.gameOver; }
  getWinner() { return this.#state.winner; }
  getHistory() { return deepClone(this.#state.history); }
  clearHistory() { this.#state.history = []; }
  getLastMoveResult() { return deepClone(this.#lastMoveResult); }
  isNyumbaActive(player) { return this.#player(player).nyumbaActive; }
  getRemainingUdza(player) { return this.#player(player).udzaRemaining; }
  checkVictory() { return this.#state.winner; }

  checkDefeat(player) {
    if (this.#state.gameOver && this.#state.winner === this.#opponent(player)) return true;
    return this.#detectDefeat(this.#state, player, { filterSelfDefeat: false });
  }

  reset() {
    this.#state = this.#createInitialState(this.#previousWinner);
    this.#lastMoveResult = null;
    this.#pendingMkazo = null;
  }

  getLegalMoves() {
    if (this.#state.gameOver || this.#pendingMkazo) return [];
    return this.#generateLegalMoves(this.#state, this.#state.currentPlayer, { filterSelfDefeat: true });
  }

  hasLegalMove() {
    return this.getLegalMoves().length > 0;
  }

  isMoveLegal(move) {
    return this.getLegalMoves().some((legal) => this.#sameMove(legal, move));
  }

  play(move) {
	if (this.#pendingMkazo) return this.#failedResult(move, "MKAZO_PENDING_DECISION");
    if (this.#state.gameOver) return this.#failedResult(move, "GAME_OVER");
    const legal = this.getLegalMoves().find((candidate) => this.#sameMove(candidate, move));
    if (!legal) return this.#failedResult(move, "ILLEGAL_MOVE");

    const beforeState = this.#snapshot();
    const beforeInternalState = this.#internalSnapshot();
    const events = [];
    const normalized = deepClone(legal);
    const isMkazo = normalized.type === MOVE_TYPES.TSO_MKAZO || normalized.type === MOVE_TYPES.NDRAZI_MKAZO;

    if (normalized.type === MOVE_TYPES.TSO_CAPTURE) this.#executeTsoCapture(this.#state, normalized, events);
    if (normalized.type === MOVE_TYPES.TSO_MKAZO) this.#executeTsoMkazo(this.#state, normalized, events);
    if (normalized.type === MOVE_TYPES.NDRAZI) this.#executeNdrazi(this.#state, normalized, events);
    if (normalized.type === MOVE_TYPES.NDRAZI_MKAZO) this.#executeNdraziMkazo(this.#state, normalized, events);
    
    if (isMkazo && this.#state.players[this.#state.currentPlayer].udzaRemaining > 0) {
      this.#pendingMkazo = { beforeState: beforeInternalState, move: normalized, afterState: this.#internalSnapshot() };
      events.push({ type: EVENTS.MKAZO_PENDING, player: this.#state.currentPlayer, udzaRemaining: this.#state.players[this.#state.currentPlayer].udzaRemaining });
    } else {
      this.#finishTurn(events);
    }

    const afterState = this.#snapshot();
    this.#state.history.push({ beforeState, move: normalized, afterState });
    this.#lastMoveResult = this.#moveResult(true, normalized, events);
    return deepClone(this.#lastMoveResult);
  }

  confirmMkazo() {
    if (!this.#pendingMkazo) return false;
    const events = [{ type: EVENTS.MKAZO_CONFIRMED, player: this.#state.currentPlayer }];
    this.#pendingMkazo = null;
    this.#finishTurn(events);
    if (this.#state.history.length > 0) {
      this.#state.history[this.#state.history.length - 1].afterState = this.#snapshot();
    }
    this.#lastMoveResult = this.#moveResult(true, null, events);
    return true;
  }

  canUndoMkazo() {
    return Boolean(this.#pendingMkazo && this.#state.players[this.#state.currentPlayer].udzaRemaining > 0);
  }

  undoMkazo() {
    if (!this.canUndoMkazo()) return false;
    const player = this.#state.currentPlayer;
    const remaining = this.#state.players[player].udzaRemaining - 1;
    this.#restoreInternalSnapshot(this.#pendingMkazo.beforeState);
    this.#state.players[player].udzaRemaining = remaining;
    const event = { type: EVENTS.UDZA, player, udzaRemaining: remaining };
    this.#pendingMkazo = null;
    this.#lastMoveResult = this.#moveResult(true, null, [event]);
    return true;
  }

  abandon() {
    if (this.#state.gameOver) return false;
    this.#declareDefeat(this.#state.currentPlayer, []);
    return true;
  }

  #createInitialState(firstPlayer = null) {
    const currentPlayer = firstPlayer ?? Math.floor(Math.random() * 2);
    return {
      players: [
        createPlayer([0, 0, 0, 0, 6, 2, 2, 0]),
        createPlayer([0, 2, 2, 6, 0, 0, 0, 0]),
      ],
      currentPlayer,
      phase: PHASES.TSO,
      winner: null,
      gameOver: false,
      history: [],
    };
  }

  #sanitizeImportedState(state) {
    const clone = deepClone(state);
    if (!Array.isArray(clone.players) || clone.players.length !== 2) throw new Error("Invalid state: players");
    clone.players = clone.players.map((player) => ({
      inner: this.#normalizeRow(player.inner),
      outer: this.#normalizeRow(player.outer),
      reserve: Math.max(0, Number(player.reserve ?? 0)),
      nyumbaActive: Boolean(player.nyumbaActive),
      udzaRemaining: Math.max(0, Math.min(2, Number(player.udzaRemaining ?? 0))),
    }));
    clone.currentPlayer = clone.currentPlayer === 1 ? 1 : 0;
    clone.phase = clone.phase === PHASES.NDRAZI ? PHASES.NDRAZI : PHASES.TSO;
    clone.winner = clone.winner === 0 || clone.winner === 1 ? clone.winner : null;
    clone.gameOver = Boolean(clone.gameOver);
    clone.history = Array.isArray(clone.history) ? clone.history : [];
    return clone;
  }

  #normalizeRow(row) {
    const normalized = Array.from({ length: 8 }, (_, index) => Math.max(0, Number(row?.[index] ?? 0)));
    return normalized;
  }

  #publicState() {
    return {
      players: this.#state.players,
      currentPlayer: this.#state.currentPlayer,
      phase: this.#state.phase,
      winner: this.#state.winner,
      gameOver: this.#state.gameOver,
    };
  }

  #snapshot() { return deepClone(this.#state); }
  #restoreSnapshot(snapshot) { this.#state = deepClone(snapshot); }
  #internalSnapshot() {
    return deepClone({
      state: this.#state,
      lastMoveResult: this.#lastMoveResult,
      pendingMkazo: this.#pendingMkazo,
      previousWinner: this.#previousWinner,
    });
  }
  #restoreInternalSnapshot(snapshot) {
    this.#state = deepClone(snapshot.state);
    this.#lastMoveResult = deepClone(snapshot.lastMoveResult);
    this.#pendingMkazo = deepClone(snapshot.pendingMkazo);
    this.#previousWinner = snapshot.previousWinner ?? null;
  }
  #player(player) { return this.#state.players[player]; }
  #opponent(player) { return player === 0 ? 1 : 0; }
  #isInner(pit) { return Number.isInteger(pit) && pit >= 1 && pit <= 8; }
  #isOuter(pit) { return Number.isInteger(pit) && pit >= 9 && pit <= 16; }
  #isNyumba(pit) { return pit === NYUMBA_PIT; }
  #pitIndex(pit) { return this.#isInner(pit) ? pit - 1 : pit - 9; }

  #getSeeds(state, player, pit) {
    const row = this.#isInner(pit) ? state.players[player].inner : state.players[player].outer;
    return row[this.#pitIndex(pit)];
  }

  #setSeeds(state, player, pit, seeds) {
    const row = this.#isInner(pit) ? state.players[player].inner : state.players[player].outer;
    row[this.#pitIndex(pit)] = seeds;
  }

  #addSeeds(state, player, pit, seeds) {
    this.#setSeeds(state, player, pit, this.#getSeeds(state, player, pit) + seeds);
  }

  #takeSeeds(state, player, pit) {
    const seeds = this.#getSeeds(state, player, pit);
    this.#setSeeds(state, player, pit, 0);
    return seeds;
  }

  #nextPit(pit, direction) {
    const cycle = direction === DIRECTIONS.RIGHT ? RIGHT_CYCLE : LEFT_CYCLE;
    return cycle[(cycle.indexOf(pit) + 1) % cycle.length];
  }

  #pitSequenceAfter(startPit, direction, count) {
    const path = [];
    let pit = startPit;
    for (let index = 0; index < count; index += 1) {
      pit = this.#nextPit(pit, direction);
      path.push(pit);
    }
    return path;
  }

  #sow(state, player, startPit, direction, count, events) {
    const path = this.#pitSequenceAfter(startPit, direction, count);
    for (const pit of path) this.#addSeeds(state, player, pit, 1);
    if (events && path.length) events.push({ type: EVENTS.SOW, player, path: [...path] });
    return path.at(-1) ?? startPit;
  }

  #activeStartPit(activeDirection) { return activeDirection === 1 ? 1 : 8; }
  #directionFromActive(activeDirection) { return ACTIVE_TO_DIRECTION[activeDirection]; }

  #activeFromTsoTarget(move) {
    if (move.targetPit <= 2) return 1;
    if (move.targetPit >= 7) return 8;
    return move.direction === DIRECTIONS.LEFT ? 8 : 1;
  }

  #activeFromDirection(direction) { return direction === DIRECTIONS.RIGHT ? 1 : 8; }

  #updateActiveAfterCapture(sourcePit, activeDirection) {
    if (sourcePit === 1 || sourcePit === 2) return 1;
    if (sourcePit === 7 || sourcePit === 8) return 8;
    return activeDirection;
  }

  #canCaptureAt(state, player, pit) {
    if (!this.#isInner(pit)) return false;
    if (this.#getSeeds(state, player, pit) < 2) return false;
    return this.#getSeeds(state, this.#opponent(player), OPPOSITE_INNER[pit]) > 0;
  }

  #executeCaptureAt(state, player, sourcePit, activeDirection, events) {
    activeDirection = this.#updateActiveAfterCapture(sourcePit, activeDirection);
    const opponentPit = OPPOSITE_INNER[sourcePit];
    const capturedSeeds = this.#getSeeds(state, this.#opponent(player), opponentPit);
    this.#setSeeds(state, this.#opponent(player), opponentPit, 0);
    events.push({ type: EVENTS.CAPTURE, player, sourcePit, opponentPit, capturedSeeds });
    const startPit = this.#activeStartPit(activeDirection);
    const lastPit = this.#sow(state, player, startPit, this.#directionFromActive(activeDirection), capturedSeeds, events);
    return { lastPit, activeDirection };
  }

  #continueCaptureTurn(state, player, lastPit, activeDirection, events) {
    while (true) {
      if (this.#getSeeds(state, player, lastPit) === 1) return;
      if (this.#canCaptureAt(state, player, lastPit)) {
        ({ lastPit, activeDirection } = this.#executeCaptureAt(state, player, lastPit, activeDirection, events));
      } else {
        const seeds = this.#takeSeeds(state, player, lastPit);
        lastPit = this.#sow(state, player, lastPit, this.#directionFromActive(activeDirection), seeds, events);
      }
    }
  }

  #executeTsoCapture(state, move, events) {
    const player = state.currentPlayer;
    state.players[player].reserve -= 1;
    this.#addSeeds(state, player, move.targetPit, 1);
    events.push({ type: EVENTS.RESERVE_DROP, player, pit: move.targetPit });
    let activeDirection = this.#activeFromTsoTarget(move);
    let { lastPit } = this.#executeCaptureAt(state, player, move.targetPit, activeDirection, events);
    activeDirection = this.#updateActiveAfterCapture(move.targetPit, activeDirection);
    this.#continueCaptureTurn(state, player, lastPit, activeDirection, events);
  }

  #executeNdrazi(state, move, events) {
    const player = state.currentPlayer;
    let activeDirection = this.#activeFromDirection(move.direction);
    const seeds = this.#takeSeeds(state, player, move.startPit);
    if (this.#isNyumba(move.startPit)) this.#loseNyumba(state, player, events);
    const lastPit = this.#sow(state, player, move.startPit, move.direction, seeds, events);
    const result = this.#executeCaptureAt(state, player, lastPit, activeDirection, events);
    activeDirection = result.activeDirection;
    this.#continueCaptureTurn(state, player, result.lastPit, activeDirection, events);
  }

  #executeTsoMkazo(state, move, events) {
    const player = state.currentPlayer;
    state.players[player].reserve -= 1;
    this.#addSeeds(state, player, move.targetPit, 1);
    events.push({ type: EVENTS.RESERVE_DROP, player, pit: move.targetPit });
    if (this.#isNyumba(move.targetPit) && this.#isNyumbaIsolated(state, player, true)) {
      this.#setSeeds(state, player, NYUMBA_PIT, this.#getSeeds(state, player, NYUMBA_PIT) - 2);
      this.#sow(state, player, NYUMBA_PIT, move.direction, 2, events);
      return;
    }
    this.#executeMkazoFrom(state, player, move.targetPit, move.direction, events, true, move.nyumbaAction);
  }

  #executeNdraziMkazo(state, move, events) {
    const player = state.currentPlayer;
    this.#executeMkazoFrom(state, player, move.startPit, move.direction, events, false);
  }

  #executeMkazoFrom(state, player, startPit, direction, events, isTso, nyumbaAction = NYUMBA_ACTIONS.STOP) {
    let pit = startPit;
    if (this.#isNyumba(pit)) this.#loseNyumba(state, player, events);
    while (true) {
      const seeds = this.#takeSeeds(state, player, pit);
      const lastPit = this.#sow(state, player, pit, direction, seeds, events);
      if (isTso && this.#isNyumba(lastPit) && state.players[player].nyumbaActive) {
        if (nyumbaAction !== NYUMBA_ACTIONS.CONTINUE) {
          events.push({ type: EVENTS.NYUMBA_STOP, player });
          return;
        }
        events.push({ type: EVENTS.NYUMBA_CONTINUE, player });
        this.#loseNyumba(state, player, events);
      } else if (this.#getSeeds(state, player, lastPit) === 1) {
        return;
      }
      pit = lastPit;
      if (this.#isNyumba(pit)) this.#loseNyumba(state, player, events);
    }
  }

  #loseNyumba(state, player, events) {
    if (state.players[player].nyumbaActive) {
      state.players[player].nyumbaActive = false;
      events.push({ type: EVENTS.NYUMBA_LOST, player });
    }
  }

  #finishTurn(events) {
    if (this.#state.gameOver) return;
    const mover = this.#state.currentPlayer;
    const opponent = this.#opponent(mover);
    if (this.#state.phase === PHASES.TSO && this.#isInnerRowEmpty(this.#state, opponent)) {
      this.#declareDefeat(opponent, events);
      return;
    }
    if (this.#state.phase === PHASES.TSO && this.#state.players[0].reserve === 0 && this.#state.players[1].reserve === 0) {
      this.#state.phase = PHASES.NDRAZI;
      events.push({ type: EVENTS.PHASE_CHANGE, phase: PHASES.NDRAZI });
    }
    this.#state.currentPlayer = opponent;
    this.#state.players[opponent].udzaRemaining = INITIAL_UDZA;
    if (this.#state.phase === PHASES.NDRAZI && this.#generateLegalMoves(this.#state, opponent, { filterSelfDefeat: true }).length === 0) {
      this.#declareDefeat(opponent, events);
    }
  }

  #declareDefeat(player, events) {
    const winner = this.#opponent(player);
    this.#state.gameOver = true;
    this.#state.winner = winner;
    this.#previousWinner = winner;
    events.push({ type: EVENTS.DEFEAT, player }, { type: EVENTS.VICTORY, player: winner });
  }

  #generateLegalMoves(state, player, options = { filterSelfDefeat: true }) {
    if (state.gameOver) return [];
    if (state.phase === PHASES.TSO) {
      const captures = this.#generateTsoCaptures(state, player);
      if (captures.length) return captures;
      return this.#filterMkazo(state, player, this.#generateTsoMkazo(state, player), options);
    }
    const ndrazi = this.#generateNdrazi(state, player);
    if (ndrazi.length) return ndrazi;
    const innerMkazo = this.#generateNdraziMkazo(state, player, true);
    if (innerMkazo.length) return this.#filterMkazo(state, player, innerMkazo, options);
    return this.#filterMkazo(state, player, this.#generateNdraziMkazo(state, player, false), options);
  }

  #generateTsoCaptures(state, player) {
    if (state.players[player].reserve <= 0) return [];
    const moves = [];
    for (let pit = 1; pit <= 8; pit += 1) {
      if (this.#getSeeds(state, player, pit) === 0) continue;
      const opponentPit = OPPOSITE_INNER[pit];
      if (this.#getSeeds(state, this.#opponent(player), opponentPit) === 0) continue;
      const directions = pit >= 3 && pit <= 6 ? [DIRECTIONS.LEFT, DIRECTIONS.RIGHT] : [pit <= 2 ? DIRECTIONS.RIGHT : DIRECTIONS.LEFT];
      for (const direction of directions) moves.push({ type: MOVE_TYPES.TSO_CAPTURE, targetPit: pit, direction });
    }
    return moves;
  }

  #generateTsoMkazo(state, player) {
    if (state.players[player].reserve <= 0) return [];
    const moves = [];
    const nyumbaIsolated = this.#isNyumbaIsolated(state, player, true);
    for (let pit = 1; pit <= 8; pit += 1) {
      if (this.#getSeeds(state, player, pit) === 0) continue;
      if (this.#isNyumba(pit) && state.players[player].nyumbaActive && !nyumbaIsolated) continue;
      for (const direction of [DIRECTIONS.LEFT, DIRECTIONS.RIGHT]) {
        const move = { type: MOVE_TYPES.TSO_MKAZO, targetPit: pit, direction };
        if (this.#requiresNyumbaChoice(state, player, move)) {
          moves.push({ ...move, nyumbaAction: NYUMBA_ACTIONS.STOP });
          moves.push({ ...move, nyumbaAction: NYUMBA_ACTIONS.CONTINUE });
        } else {
          moves.push(move);
        }
      }
    }
    return moves;
  }

  #generateNdrazi(state, player) {
    const moves = [];
    for (let pit = 1; pit <= 16; pit += 1) {
      if (this.#getSeeds(state, player, pit) < 2) continue;
      for (const direction of [DIRECTIONS.LEFT, DIRECTIONS.RIGHT]) {
        const sim = deepClone(state);
        const seeds = this.#takeSeeds(sim, player, pit);
        const lastPit = this.#sow(sim, player, pit, direction, seeds);
        if (this.#canCaptureAt(sim, player, lastPit)) moves.push({ type: MOVE_TYPES.NDRAZI, startPit: pit, direction });
      }
    }
    return moves;
  }

  #generateNdraziMkazo(state, player, innerOnly) {
    const moves = [];
    const start = innerOnly ? 1 : 9;
    const end = innerOnly ? 8 : 16;
    const nyumbaIsolated = this.#isNyumbaIsolated(state, player, false);
    for (let pit = start; pit <= end; pit += 1) {
      if (this.#getSeeds(state, player, pit) < 2) continue;
      if (this.#isNyumba(pit) && state.players[player].nyumbaActive && !nyumbaIsolated && innerOnly) {
        // The Nyumba can still be a normal NDRAZI Mkazo when no Ndrazi exists; playing it loses status.
      }
      for (const direction of [DIRECTIONS.LEFT, DIRECTIONS.RIGHT]) moves.push({ type: MOVE_TYPES.NDRAZI_MKAZO, startPit: pit, direction });
    }
    return moves;
  }

  #filterMkazo(state, player, moves, options) {
    if (!options.filterSelfDefeat) return moves;
    return moves.filter((move) => !this.#mkazoSelfDefeats(state, player, move));
  }

  #mkazoSelfDefeats(state, player, move) {
    const sim = deepClone(state);
    const events = [];
    if (move.type === MOVE_TYPES.TSO_MKAZO) this.#executeTsoMkazo(sim, move, events);
    if (move.type === MOVE_TYPES.NDRAZI_MKAZO) this.#executeNdraziMkazo(sim, move, events);
    if (this.#detectDefeat(sim, player, { filterSelfDefeat: false })) return true;
    if (sim.phase === PHASES.NDRAZI || move.type === MOVE_TYPES.NDRAZI_MKAZO) {
      const legalNext = this.#generateLegalMoves(sim, player, { filterSelfDefeat: false });
      return legalNext.length === 0;
    }
    return false;
  }

  #detectDefeat(state, player, options) {
    if (state.phase === PHASES.TSO) return this.#isInnerRowEmpty(state, player);
    return this.#generateLegalMoves(state, player, options).length === 0;
  }

  #isInnerRowEmpty(state, player) { return state.players[player].inner.every((seeds) => seeds === 0); }

  #isNyumbaIsolated(state, player, tso) {
    if (!state.players[player].nyumbaActive) return false;
    if (this.#getSeeds(state, player, NYUMBA_PIT) === 0) return false;
    const noOtherInnerSeeds = state.players[player].inner.every((seeds, index) => index === NYUMBA_PIT - 1 || seeds === 0);
    if (!noOtherInnerSeeds) return false;
    return tso ? this.#generateTsoCaptures(state, player).length === 0 : this.#generateNdrazi(state, player).length === 0;
  }

  #requiresNyumbaChoice(state, player, move) {
    if (move.type !== MOVE_TYPES.TSO_MKAZO) return false;
    if (!state.players[player].nyumbaActive) return false;
    if (this.#isNyumba(move.targetPit) && this.#isNyumbaIsolated(state, player, true)) return false;
    const sim = deepClone(state);
    const events = [];
    this.#executeTsoMkazo(sim, { ...move, nyumbaAction: NYUMBA_ACTIONS.STOP }, events);
    return events.some((event) => event.type === EVENTS.NYUMBA_STOP);
  }

  #sameMove(a, b) {
    return Boolean(
      a &&
      b &&
      a.type === b.type &&
      a.targetPit === b.targetPit &&
      a.startPit === b.startPit &&
      a.direction === b.direction &&
      a.nyumbaAction === b.nyumbaAction
    );
  }

  #moveResult(success, move, events) {
    return { success, move: move ? deepClone(move) : null, events: deepClone(events), finalState: this.getState(), gameOver: this.#state.gameOver, winner: this.#state.winner };
  }

  #failedResult(move, reason) {
    return { success: false, move: deepClone(move), reason, events: [], finalState: this.getState(), gameOver: this.#state.gameOver, winner: this.#state.winner };
  }
}

export { PHASES, DIRECTIONS, MOVE_TYPES, EVENTS, NYUMBA_ACTIONS };

if (typeof window !== "undefined") {
  window.MrahaEngine = MrahaEngine;
}

const PLAYERS = ["south", "north"];
const DIRECTIONS = { left: -1, right: 1 };
const INNER_CELLS = [1, 2, 3, 4, 5, 6, 7, 8];
const OUTER_CELLS = [16, 15, 14, 13, 12, 11, 10, 9];
const OPPOSITE = { 1: 8, 2: 7, 3: 6, 4: 5, 5: 4, 6: 3, 7: 2, 8: 1 };

class MrahaEngine {
  constructor(elements) {
    this.elements = elements;
    this.pendingMove = null;
    this.pendingDirectionMove = null;
    this.animationDelay = 105;
    this.initGame();
  }

  initGame() {
    this.state = {
      activePlayer: "south",
      phase: "TSO",
      winner: null,
      awaitingMkazoValidation: false,
      udzaRemaining: { south: 2, north: 2 },
      players: Object.fromEntries(PLAYERS.map((player) => [player, {
        reserve: 22,
        nyumba: 5,
        cells: this.createInitialCells()
      }]))
    };
    this.pendingMove = null;
    this.pendingDirectionMove = null;
    this.render();
  }

  createInitialCells() {
    const cells = {};
    for (let i = 1; i <= 16; i += 1) cells[i] = 0;
    cells[5] = 6;
    cells[6] = 2;
    cells[7] = 2;
    return cells;
  }

  cloneState() { return JSON.parse(JSON.stringify(this.state)); }

  getOpponent(player = this.state.activePlayer) {
    return player === "south" ? "north" : "south";
  }

  getTotalSeeds(player) {
    const p = this.state.players[player];
    return p.reserve + Object.values(p.cells).reduce((sum, seeds) => sum + seeds, 0);
  }

  isInner(cell) { return cell >= 1 && cell <= 8; }

  nextCell(cell, direction) {
    if (direction === "right") return cell === 16 ? 1 : cell + 1;
    return cell === 1 ? 16 : cell - 1;
  }

  directionStart(cell, direction, mode) {
    if (mode === "mkazo") return cell;
    if (cell <= 2) return 1;
    if (cell >= 7 && cell <= 8) return 8;
    if (!this.isInner(cell)) return direction === "left" ? 1 : 8;
    return direction === "left" ? 1 : 8;
  }

  isNyumba(player, cell) { return this.state.players[player].nyumba === cell; }

  releaseNyumbaIfTouched(player, cell) {
    if (this.isNyumba(player, cell)) this.state.players[player].nyumba = null;
  }

  wouldImmediateCapture(player, cell) {
    if (!this.isInner(cell)) return false;
    const own = this.state.players[player].cells[cell];
    const opposite = this.state.players[this.getOpponent(player)].cells[OPPOSITE[cell]];
    return own + 1 > 0 && opposite > 0;
  }

  isSpecialNyumbaTSO(player) {
    const p = this.state.players[player];
    if (!p.nyumba || p.reserve <= 0 || p.cells[p.nyumba] <= 0) return false;
    return Object.entries(p.cells).every(([cell, seeds]) => Number(cell) === p.nyumba || seeds === 0);
  }

  getLegalMoves(player = this.state.activePlayer) {
    if (this.state.winner || this.state.awaitingMkazoValidation) return [];
    this.updatePhase();
    if (this.state.phase === "TSO") return this.findTsoMoves(player);
    const ndrazi = this.findNdraziMoves(player);
    return ndrazi.length ? ndrazi : this.findMkazoMoves(player);
  }

  findTsoMoves(player = this.state.activePlayer) {
    const p = this.state.players[player];
    if (p.reserve <= 0) return [];
    const moves = [];
    for (const cell of INNER_CELLS) {
      if (p.cells[cell] <= 0) continue;
      if (this.isNyumba(player, cell) && !this.isSpecialNyumbaTSO(player) && !this.wouldImmediateCapture(player, cell)) continue;
      const directions = cell <= 2 ? ["right"] : cell >= 7 ? ["left"] : ["left", "right"];
      for (const direction of directions) moves.push({ type: "TSO", cell, direction, needsDirection: cell >= 3 && cell <= 6, specialNyumba: this.isSpecialNyumbaTSO(player) });
    }
    return moves;
  }

  findNdraziMoves(player = this.state.activePlayer) {
    const moves = [];
    for (let cell = 1; cell <= 16; cell += 1) {
      if (this.state.players[player].cells[cell] < 2) continue;
      const directions = this.isInner(cell) && cell >= 3 && cell <= 6 ? ["left", "right"] : ["left", "right"];
      for (const direction of directions) {
        const normalized = this.normalizeDirectionForCapturing(cell, direction);
        if (this.simulatesNdrazi(player, cell, normalized)) moves.push({ type: "NDRAZI", cell, direction: normalized, needsDirection: this.canChooseNdraziDirection(cell) });
      }
    }
    return this.uniqueMoves(moves);
  }

  canChooseNdraziDirection(cell) { return (cell >= 3 && cell <= 6) || !this.isInner(cell); }

  normalizeDirectionForCapturing(cell, direction) {
    if (cell <= 2) return "right";
    if (cell >= 7 && cell <= 8) return "left";
    return direction;
  }

  simulatesNdrazi(player, cell, direction) {
    const snapshot = this.cloneState();
    const seeds = snapshot.players[player].cells[cell];
    snapshot.players[player].cells[cell] = 0;
    let current = cell;
    for (let i = 0; i < seeds; i += 1) {
      current = this.nextCell(current, direction);
      snapshot.players[player].cells[current] += 1;
    }
    const own = snapshot.players[player].cells[current];
    const enemy = snapshot.players[this.getOpponent(player)].cells[OPPOSITE[current]] || 0;
    return this.isInner(current) && own > 1 && enemy > 0;
  }

  findMkazoMoves(player = this.state.activePlayer) {
    if (this.findNdraziMoves(player).length) return [];
    const moves = [];
    for (let cell = 1; cell <= 16; cell += 1) {
      if (this.state.players[player].cells[cell] > 0) {
        moves.push({ type: "MKAZO", cell, direction: "left", needsDirection: true });
        moves.push({ type: "MKAZO", cell, direction: "right", needsDirection: true });
      }
    }
    return moves;
  }

  uniqueMoves(moves) {
    return [...new Map(moves.map((move) => [`${move.type}-${move.cell}-${move.direction}`, move])).values()];
  }

  applyMove(move) {
    if (move.type === "TSO") return this.applyTSOMove(move);
    if (move.type === "NDRAZI") return this.applyNdraziMove(move);
    return this.applyMkazoMove(move);
  }

  async applyTSOMove(move) {
    const player = this.state.activePlayer;
    this.state.players[player].reserve -= 1;
    if (move.specialNyumba) {
      this.state.players[player].cells[move.cell] -= 1;
      this.releaseNyumbaIfTouched(player, move.cell);
      await this.performCaptureChain(player, 2, move.direction, this.directionStart(move.cell, move.direction, "tso"), true);
    } else {
      this.state.players[player].cells[move.cell] += 1;
      await this.flashCell(player, move.cell, "drop");
      const captured = this.performCapture(player, move.cell);
      const start = this.directionStart(move.cell, move.direction, "tso");
      if (captured > 0) {
        const captureDirection = move.cell <= 2 ? "right" : move.cell >= 7 ? "left" : move.direction;
        await this.performCaptureChain(player, captured, captureDirection, this.directionStart(move.cell, captureDirection, "capture"), true);
      } else {
        await this.performCaptureChain(player, this.state.players[player].cells[move.cell], move.direction, start, true, move.cell);
      }
    }
    this.finishTurn();
  }

  async applyNdraziMove(move) {
    const player = this.state.activePlayer;
    const seeds = this.state.players[player].cells[move.cell];
    this.state.players[player].cells[move.cell] = 0;
    this.releaseNyumbaIfTouched(player, move.cell);
    await this.performSowing(player, seeds, move.direction, move.cell, true);
    this.finishTurn();
  }

  async applyMkazoMove(move) {
    const player = this.state.activePlayer;
    this.pendingMove = { snapshot: this.cloneState(), player };
    const seeds = this.state.players[player].cells[move.cell];
    this.state.players[player].cells[move.cell] = 0;
    this.releaseNyumbaIfTouched(player, move.cell);
    await this.performSowing(player, seeds, move.direction, move.cell, false);
    if (this.state.udzaRemaining[player] > 0) {
      this.state.awaitingMkazoValidation = true;
      this.render();
    } else this.finishTurn();
  }

  async performSowing(player, seeds, direction, startCell, allowCapture) {
    let current = startCell;
    let hand = seeds;
    while (hand > 0) {
      current = this.nextCell(current, direction);
      this.state.players[player].cells[current] += 1;
      await this.flashCell(player, current, "drop");
      hand -= 1;
    }
    if (!allowCapture) {
      while (this.state.players[player].cells[current] > 1) {
        hand = this.state.players[player].cells[current];
        this.state.players[player].cells[current] = 0;
        this.releaseNyumbaIfTouched(player, current);
        while (hand > 0) {
          current = this.nextCell(current, direction);
          this.state.players[player].cells[current] += 1;
          await this.flashCell(player, current, "drop");
          hand -= 1;
        }
      }
      return current;
    }
    return this.resolveLanding(player, current, direction);
  }

  async performCaptureChain(player, seeds, direction, startFrom, allowCapture, clearCell = null) {
    if (clearCell) {
      this.state.players[player].cells[clearCell] = 0;
      this.releaseNyumbaIfTouched(player, clearCell);
    }
    return this.performSowing(player, seeds, direction, startFrom, allowCapture);
  }

  async resolveLanding(player, cell, direction) {
    while (this.state.players[player].cells[cell] > 1) {
      const captured = this.performCapture(player, cell);
      if (captured > 0) {
        direction = cell <= 2 ? "right" : cell >= 7 ? "left" : direction;
        const start = this.directionStart(cell, direction, "capture");
        this.render();
        await this.pause();
        cell = await this.performCaptureChain(player, captured, direction, start, true);
      } else {
        const seeds = this.state.players[player].cells[cell];
        this.state.players[player].cells[cell] = 0;
        this.releaseNyumbaIfTouched(player, cell);
        cell = await this.performSowing(player, seeds, direction, cell, true);
      }
    }
    return cell;
  }

  performCapture(player, cell) {
    if (!this.isInner(cell)) return 0;
    const opponent = this.getOpponent(player);
    const opposite = OPPOSITE[cell];
    const captured = this.state.players[opponent].cells[opposite];
    if (this.state.players[player].cells[cell] <= 0 || captured <= 0) return 0;
    this.state.players[opponent].cells[opposite] = 0;
    this.releaseNyumbaIfTouched(opponent, opposite);
    this.flashCell(opponent, opposite, "capture");
    return captured;
  }

  undoMkazo() {
    if (!this.state.awaitingMkazoValidation || !this.pendingMove) return;
    const player = this.pendingMove.player;
    this.state = this.pendingMove.snapshot;
    this.state.udzaRemaining[player] = Math.max(0, this.state.udzaRemaining[player] - 1);
    this.pendingMove = null;
    this.render();
  }

  validateMkazo() { if (this.state.awaitingMkazoValidation) this.finishTurn(); }

  finishTurn() {
    this.pendingMove = null;
    this.state.awaitingMkazoValidation = false;
    this.updatePhase();
    const loser = this.checkDefeat();
    if (!loser) this.switchPlayer();
    this.render();
  }

  switchPlayer() {
    this.state.activePlayer = this.getOpponent();
    this.state.udzaRemaining[this.state.activePlayer] = 2;
    this.elements.gameScreen.classList.add("turn-pulse");
    setTimeout(() => this.elements.gameScreen.classList.remove("turn-pulse"), 380);
  }

  updatePhase() {
    if (PLAYERS.every((player) => this.state.players[player].reserve === 0)) this.state.phase = "NDRAZI";
  }

  checkDefeat() {
    for (const player of PLAYERS) {
      const innerEmpty = INNER_CELLS.every((cell) => this.state.players[player].cells[cell] === 0);
      const noLegal = !this.findNdraziMoves(player).length && !this.findMkazoMoves(player).length;
      const noSeeds = this.getTotalSeeds(player) <= 0;
      if (innerEmpty || noLegal || noSeeds) {
        this.state.winner = this.getOpponent(player);
        return player;
      }
    }
    return null;
  }

  async flashCell(player, cell, className) {
    this.render();
    const node = this.elements.boardGrid.querySelector(`[data-player="${player}"][data-cell="${cell}"]`);
    if (node) {
      node.classList.add(className);
      setTimeout(() => node.classList.remove(className), this.animationDelay * 2);
    }
    await this.pause();
  }

  pause() { return new Promise((resolve) => setTimeout(resolve, this.animationDelay)); }

  render() {
    this.elements.boardGrid.innerHTML = "";
    this.renderRow("north", OUTER_CELLS);
    this.renderRow("north", INNER_CELLS);
    this.renderRow("south", INNER_CELLS.slice().reverse());
    this.renderRow("south", OUTER_CELLS.slice().reverse());
    this.renderReserve("north", this.elements.reserveTop);
    this.renderReserve("south", this.elements.reserveBottom);
    this.renderLegalHighlights();
    this.renderStatus();
  }

  renderRow(player, cells) {
    const row = document.createElement("div");
    row.className = `player-row ${player}`;
    for (const cell of cells) row.appendChild(this.createCell(player, cell));
    this.elements.boardGrid.appendChild(row);
  }

  createCell(player, cell) {
    const button = document.createElement("button");
    button.className = "cell";
    button.dataset.player = player;
    button.dataset.cell = cell;
    button.type = "button";
    button.setAttribute("aria-label", `${player} case ${cell}`);
    if (this.isNyumba(player, cell)) button.classList.add("nyumba");
    const label = document.createElement("span");
    label.className = "cell-number";
    label.textContent = cell;
    button.append(label, this.createSeeds(this.state.players[player].cells[cell]));
    button.addEventListener("click", () => this.handleCellClick(player, cell));
    return button;
  }

  createSeeds(count) {
    const cloud = document.createElement("span");
    cloud.className = "seed-cloud";
    const shown = Math.min(count, 18);
    for (let i = 0; i < shown; i += 1) {
      const seed = document.createElement("span");
      seed.className = "seed";
      const angle = (Math.PI * 2 * i) / Math.max(1, shown);
      const radius = 10 + (i % 3) * 12;
      seed.style.left = `${50 + Math.cos(angle) * radius}%`;
      seed.style.top = `${50 + Math.sin(angle) * radius * .72}%`;
      cloud.appendChild(seed);
    }
    if (count > shown) {
      const more = document.createElement("strong");
      more.textContent = count;
      cloud.appendChild(more);
    }
    return cloud;
  }

  renderReserve(player, node) {
    node.innerHTML = "";
    node.classList.toggle("active", this.state.activePlayer === player);
    for (let i = 0; i < Math.min(22, this.state.players[player].reserve); i += 1) node.appendChild(Object.assign(document.createElement("span"), { className: "seed" }));
  }

  renderLegalHighlights() {
    for (const move of this.getLegalMoves()) {
      const node = this.elements.boardGrid.querySelector(`[data-player="${this.state.activePlayer}"][data-cell="${move.cell}"]`);
      if (node) node.classList.add("clickable");
    }
  }

  renderStatus() {
    const { status, udzaControls } = this.elements;
    const active = this.state.activePlayer === "south" ? "Joueur bas" : "Joueur haut";
    status.textContent = this.state.winner ? `Victoire : ${this.state.winner === "south" ? "Joueur bas" : "Joueur haut"}` : `${active} · ${this.state.phase}`;
    udzaControls.classList.toggle("hidden", !this.state.awaitingMkazoValidation);
  }

  handleCellClick(player, cell) {
    if (player !== this.state.activePlayer || this.state.awaitingMkazoValidation) return;
    const moves = this.getLegalMoves().filter((move) => move.cell === cell);
    if (!moves.length) return;
    const needsChoice = moves.length > 1 || moves.some((move) => move.needsDirection);
    if (needsChoice) {
      this.pendingDirectionMove = moves;
      this.elements.directionChoice.classList.remove("hidden");
    } else this.applyMove(moves[0]);
  }

  chooseDirection(direction) {
    const move = (this.pendingDirectionMove || []).find((candidate) => candidate.direction === direction);
    this.pendingDirectionMove = null;
    this.elements.directionChoice.classList.add("hidden");
    if (move) this.applyMove(move);
  }
}

const elements = {
  menuScreen: document.getElementById("menuScreen"),
  gameScreen: document.getElementById("gameScreen"),
  startButton: document.getElementById("startButton"),
  backButton: document.getElementById("backButton"),
  boardGrid: document.getElementById("boardGrid"),
  reserveTop: document.getElementById("reserveTop"),
  reserveBottom: document.getElementById("reserveBottom"),
  directionChoice: document.getElementById("directionChoice"),
  status: document.getElementById("status"),
  udzaControls: document.getElementById("udzaControls"),
  validateMkazo: document.getElementById("validateMkazo"),
  undoMkazo: document.getElementById("undoMkazo")
};

let engine;
elements.startButton.addEventListener("click", () => {
  elements.menuScreen.classList.add("hidden");
  elements.gameScreen.classList.remove("hidden");
  engine = new MrahaEngine(elements);
});
elements.backButton.addEventListener("click", () => {
  elements.gameScreen.classList.add("hidden");
  elements.menuScreen.classList.remove("hidden");
});
elements.directionChoice.addEventListener("click", (event) => {
  const direction = event.target?.dataset?.direction;
  if (direction && engine) engine.chooseDirection(direction);
});
elements.validateMkazo.addEventListener("click", () => engine?.validateMkazo());
elements.undoMkazo.addEventListener("click", () => engine?.undoMkazo());

export { MrahaEngine };
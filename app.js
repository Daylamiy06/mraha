'use strict';

/**
 * MRAHA WA TSO — Moteur de jeu
 * ============================================================
 * Implémentation conforme à spécifications-mraha-v3.md.
 *
 * Architecture : un noyau pur (fonctions sans effet de bord, qui
 * opèrent sur un `state` explicite et le mutent directement) entouré
 * d'une fine coquille avec état (MrahaEngine) qui gère la persistance,
 * l'historique et la pause de décision (Mkazo à valider/annuler,
 * choix Nyumba). Toutes les méthodes publiques du chapitre 12 sont
 * exposées ; les ajouts au-delà de la lettre de la spec (nécessaires
 * au fonctionnement : resolveNyumbaChoice pour 7.8, resign pour 10.5)
 * sont signalés par "AJOUT DÉLIBÉRÉ" à l'endroit concerné.
 * ============================================================
 */

// ============================================================
// SECTION 1 — Constantes (chap. 1, 2, 3, 12.2, 12.3, 12.4, 12.5)
// ============================================================

const PHASE = Object.freeze({ TSO: 'TSO', NDRAZI: 'NDRAZI' });
const DIRECTION = Object.freeze({ LEFT: 'LEFT', RIGHT: 'RIGHT' });
const MOVE_TYPE = Object.freeze({
  TSO_CAPTURE: 'TSO_CAPTURE',
  TSO_MKAZO: 'TSO_MKAZO',
  NDRAZI: 'NDRAZI',
  NDRAZI_MKAZO: 'NDRAZI_MKAZO',
});
const EVENT_TYPE = Object.freeze({
  RESERVE_DROP: 'RESERVE_DROP',
  SOW: 'SOW',
  CAPTURE: 'CAPTURE',
  NYUMBA_LOST: 'NYUMBA_LOST',
  PHASE_CHANGE: 'PHASE_CHANGE',
  DEFEAT: 'DEFEAT',
  VICTORY: 'VICTORY',
});

const INNER_SIZE = 8;
const OUTER_SIZE = 8;
const TOTAL_SIZE = 16; // taille de la boucle circulaire propre à chaque joueur (2.2/2.3)
const NYUMBA_ABS_INDEX = 4; // case 5 => inner[4] (12.2.1)
const INITIAL_RESERVE = 22; // 3, 12.3.1
const MAX_UDZA = 2; // 9.5, 12.3.3

// Position initiale (chap. 3), exprimée en indices absolus 0..15
// (0..7 = inner, 8..15 = outer). Déduite par symétrie miroir des
// deux rangées imprimées dans la spec (cf. analyse fournie à
// l'utilisateur) : inner = [0,0,0,0,6,2,2,0], outer = [0]*8.
const INITIAL_INNER = Object.freeze([0, 0, 0, 0, 6, 2, 2, 0]);
const INITIAL_OUTER = Object.freeze([0, 0, 0, 0, 0, 0, 0, 0]);

// Garde-fou défensif contre une boucle de reprise infinie
// (mathématiquement improbable vu la conservation du nombre de
// graines, mais imposer une limite est une bonne pratique
// d'ingénierie qui ne change aucun comportement documenté).
const MAX_CHAIN_ITERATIONS = 100000;

// ============================================================
// SECTION 2 — Algèbre de position sur la boucle 16 cases (2.1-2.4, 12.2.1)
// ============================================================

/** Numéro officiel de case (1-16) -> indice absolu 0-15. */
function caseToAbsIndex(caseNumber) {
  return caseNumber - 1;
}

/** Indice absolu 0-15 -> numéro officiel de case (1-16). */
function absIndexToCase(absIndex) {
  return absIndex + 1;
}

/** Un pas dans la boucle 16-cases, selon la direction (2.2/2.3). */
function stepIndex(absIndex, direction) {
  if (direction === DIRECTION.RIGHT) return (absIndex + 1) % TOTAL_SIZE;
  return (absIndex + TOTAL_SIZE - 1) % TOTAL_SIZE;
}

/** true si l'indice absolu désigne une case intérieure (0-7). */
function isInnerAbsIndex(absIndex) {
  return absIndex >= 0 && absIndex < INNER_SIZE;
}

/**
 * Indice miroir (case adverse opposée) d'une case intérieure (2.1).
 * 1<->8, 2<->7, 3<->6, 4<->5 en numéros officiels => en indices
 * 0-based : mirror(i) = 7 - i.
 * N'est valide que pour des indices intérieurs (0-7).
 */
function mirrorInnerIndex(absIndex) {
  return (INNER_SIZE - 1) - absIndex;
}

/** Point de départ (indice absolu) correspondant à la direction active (4.5/6.9 : "depuis 1 ou 8"). */
function directionStartIndex(direction) {
  return direction === DIRECTION.RIGHT ? caseToAbsIndex(1) : caseToAbsIndex(8);
}

/**
 * Mise à jour de la direction active après une capture exécutée
 * sur `landingAbsIndex` (4.9 / 6.13). Inchangée si la capture a
 * eu lieu sur une case intérieure non extrême.
 */
function updateActiveDirection(landingAbsIndex, currentDirection) {
  const caseNum = absIndexToCase(landingAbsIndex);
  if (caseNum === 1 || caseNum === 2) return DIRECTION.RIGHT;
  if (caseNum === 7 || caseNum === 8) return DIRECTION.LEFT;
  return currentDirection;
}

// ============================================================
// SECTION 3 — Structures d'état pures (12.2, 12.3, 12.4)
// ============================================================

function createInitialPlayerState() {
  return {
    inner: INITIAL_INNER.slice(),
    outer: INITIAL_OUTER.slice(),
    reserve: INITIAL_RESERVE,
    nyumbaActive: true,
    udzaRemaining: MAX_UDZA,
  };
}

/**
 * Crée l'état initial complet d'une partie (12.14, 3, 11.3, 11.4).
 * @param {0|1} [startingPlayer] joueur qui commence ; tirage au sort si omis.
 */
function createInitialGameState(startingPlayer) {
  const first =
    startingPlayer === 0 || startingPlayer === 1
      ? startingPlayer
      : Math.random() < 0.5 ? 0 : 1; // 11.1 : tirage au sort
  return {
    players: [createInitialPlayerState(), createInitialPlayerState()],
    currentPlayer: first,
    phase: PHASE.TSO,
    winner: null,
    gameOver: false,
    history: [],
  };
}

/** Clone profond d'un état de partie complet (nécessaire pour Udza 9.4 et les snapshots 12.6). */
function cloneGameState(state) {
  return {
    players: [clonePlayerState(state.players[0]), clonePlayerState(state.players[1])],
    currentPlayer: state.currentPlayer,
    phase: state.phase,
    winner: state.winner,
    gameOver: state.gameOver,
    history: state.history.map(cloneHistoryEntry),
  };
}

function clonePlayerState(p) {
  return {
    inner: p.inner.slice(),
    outer: p.outer.slice(),
    reserve: p.reserve,
    nyumbaActive: p.nyumbaActive,
    udzaRemaining: p.udzaRemaining,
  };
}

function cloneHistoryEntry(entry) {
  return {
    beforeState: cloneStateView(entry.beforeState),
    move: { ...entry.move },
    afterState: cloneStateView(entry.afterState),
  };
}

/** Clone d'une "vue" d'état à 5 champs (forme de getState(), 12.15) utilisée dans l'historique. */
function cloneStateView(view) {
  return {
    players: [clonePlayerState(view.players[0]), clonePlayerState(view.players[1])],
    currentPlayer: view.currentPlayer,
    phase: view.phase,
    winner: view.winner,
    gameOver: view.gameOver,
  };
}

/** Extrait la vue publique à 5 champs (12.15) d'un état complet. */
function toStateView(state) {
  return {
    players: [clonePlayerState(state.players[0]), clonePlayerState(state.players[1])],
    currentPlayer: state.currentPlayer,
    phase: state.phase,
    winner: state.winner,
    gameOver: state.gameOver,
  };
}

// ============================================================
// SECTION 4 — Accès bas niveau au plateau (12.2.1)
// ============================================================

function getCell(playerState, absIndex) {
  return absIndex < INNER_SIZE ? playerState.inner[absIndex] : playerState.outer[absIndex - INNER_SIZE];
}

function setCell(playerState, absIndex, value) {
  if (absIndex < INNER_SIZE) playerState.inner[absIndex] = value;
  else playerState.outer[absIndex - INNER_SIZE] = value;
}

// ============================================================
// SECTION 5 — Primitives de semis et de capture (2.4, 4.5-4.10, 6.8-6.14, 8.6-8.7)
// ============================================================

/**
 * Sème `count` graines une par une à partir de `startAbsIndex`,
 * dans `direction`, sur le plateau de `player` (2.4 : une graine
 * par case traversée). Émet un événement SOW décrivant le chemin
 * exact parcouru (12.18.4).
 *
 * Retourne {lastIndex, preCountAtLast} où preCountAtLast est le
 * nombre de graines déjà présentes dans la case d'atterrissage
 * AVANT que la dernière graine de ce semis n'y tombe — c'est
 * cette valeur "déjà présente" que les règles de capture (1.6)
 * utilisent, jamais le total après dépôt.
 */
function sow(state, player, startAbsIndex, direction, count, events) {
  const ps = state.players[player];
  const path = [];
  let idx = startAbsIndex;
  let preCountAtLast = 0;
  for (let i = 0; i < count; i++) {
    const before = getCell(ps, idx);
    if (i === count - 1) preCountAtLast = before;
    setCell(ps, idx, before + 1);
    path.push(absIndexToCase(idx));
    if (i < count - 1) idx = stepIndex(idx, direction);
  }
  events.push({ type: EVENT_TYPE.SOW, player, path });
  return { lastIndex: idx, preCountAtLast };
}

/**
 * Une case intérieure atterrit-elle sur une capture (1.6) ?
 * preCount = graines déjà présentes dans la case du joueur AVANT
 * la graine qui vient d'y tomber (fournie par sow()).
 */
function isCapturingLanding(state, player, absIndex, preCount) {
  if (!isInnerAbsIndex(absIndex)) return false;
  if (preCount < 1) return false;
  const opponent = 1 - player;
  const mirrorIdx = mirrorInnerIndex(absIndex);
  return state.players[opponent].inner[mirrorIdx] > 0;
}

/**
 * Exécute une capture sur `sourceAbsIndex` (case intérieure du
 * joueur actif) : vide la case adverse en face, émet CAPTURE
 * (4.5/4.7, 6.8/6.11, 7.9). Retourne le nombre de graines capturées.
 * Les graines du joueur dans sourceAbsIndex NE sont PAS touchées
 * (1.6 : "les graines du joueur restent dans leur case").
 */
function executeCapture(state, player, sourceAbsIndex, events) {
  const opponent = 1 - player;
  const mirrorIdx = mirrorInnerIndex(sourceAbsIndex);
  const capturedSeeds = state.players[opponent].inner[mirrorIdx];
  state.players[opponent].inner[mirrorIdx] = 0;
  events.push({
    type: EVENT_TYPE.CAPTURE,
    player,
    sourcePit: absIndexToCase(sourceAbsIndex),
    opponentPit: absIndexToCase(mirrorIdx),
    capturedSeeds,
  });
  // 7.6 : le Nyumba participe aux captures comme n'importe quelle case — il peut
  // donc être vidé par une capture ADVERSE. Synchroniser le statut de l'ADVERSAIRE
  // si la case capturée était son Nyumba (0 graine => statut perdu, tout mécanisme confondu).
  if (mirrorIdx === NYUMBA_ABS_INDEX) syncNyumbaStatus(state.players[opponent], opponent, events);
  return capturedSeeds;
}

/**
 * Prend toutes les graines de `absIndex` et vide la case (4.8, 6.12, 8.7).
 * pickUpAll vide toujours intégralement la case : si c'est le Nyumba,
 * syncNyumbaStatus s'applique donc systématiquement.
 */
function pickUpAll(state, player, absIndex, events) {
  const ps = state.players[player];
  const count = getCell(ps, absIndex);
  setCell(ps, absIndex, 0);
  if (absIndex === NYUMBA_ABS_INDEX) syncNyumbaStatus(ps, player, events);
  return count;
}

/**
 * Statut du Nyumba : actif tant que la case contient au moins une graine ;
 * dès qu'elle atteint 0 (quel que soit le mécanisme — départ, capture
 * adverse, ou retrait partiel de 7.7), le statut est perdu définitivement
 * et ne peut plus redevenir actif. Prévaut sur la formulation littérale de
 * 7.3 ("perdu uniquement au départ") et sur "conservé" de 7.7 (qui décrit
 * le cas où il en reste, pas le cas limite où la dernière graine est prise).
 * N'émet NYUMBA_LOST qu'une fois (no-op si déjà perdu).
 */
function syncNyumbaStatus(playerState, player, events) {
  if (playerState.nyumbaActive && playerState.inner[NYUMBA_ABS_INDEX] === 0) {
    playerState.nyumbaActive = false;
    events.push({ type: EVENT_TYPE.NYUMBA_LOST, player });
  }
}

// ============================================================
// SECTION 6 — Résolution de chaîne unifiée (4.5-4.9, 6.9-6.13, 7.8, 7.9, 8.6-8.9)
// ============================================================

/**
 * Détermine la direction active initiale d'un dépôt TSO (4.4).
 * Cases 1/2 -> RIGHT forcé, 7/8 -> LEFT forcé, 3/4/5/6 -> libre choix.
 */
function determineInitialDirectionTso(targetCaseNum, chosenDirection) {
  if (targetCaseNum === 1 || targetCaseNum === 2) return DIRECTION.RIGHT;
  if (targetCaseNum === 7 || targetCaseNum === 8) return DIRECTION.LEFT;
  return chosenDirection;
}

/**
 * Boucle générique de résolution de chaîne, partagée par les quatre types
 * de coups. Mute `state` et pousse des événements dans `events`.
 *
 * allowCaptures=true  (TSO_CAPTURE, NDRAZI) : capture en chaîne obligatoire
 *   (4.7/6.11), y compris au Nyumba (7.9 : capture prioritaire, prime sur 7.8).
 * allowCaptures=false (TSO_MKAZO, NDRAZI_MKAZO) : capture absolument interdite
 *   (8.8) — un Mkazo qui atteint le Nyumba relève donc toujours de 7.8, jamais
 *   de 7.9 (qui ne s'applique qu'aux tours commencés par une capture).
 *
 * Retourne {status:'DONE'} ou {status:'AWAITING_NYUMBA', direction}.
 */
function runChain(state, events, player, direction, landingAbsIndex, preCountAtLanding, phase, allowCaptures) {
  let idx = landingAbsIndex;
  let preCount = preCountAtLanding;
  let dir = direction;
  let iterations = 0;

  while (true) {
    if (++iterations > MAX_CHAIN_ITERATIONS) {
      throw new Error('runChain: limite de sécurité anti-boucle infinie dépassée');
    }

    // Cas Nyumba (chap. 7), TSO uniquement, tant que son statut est actif — une
    // fois perdu la case redevient ordinaire (règles générales ci-dessous).
    // 7.9 : capture prioritaire si possible ; sinon 7.8 : pause (Arrêter/Continuer).
    if (phase === PHASE.TSO && idx === NYUMBA_ABS_INDEX && state.players[player].nyumbaActive) {
      if (allowCaptures && isCapturingLanding(state, player, idx, preCount)) {
        // 7.9 : capture prioritaire, l'arrêt volontaire n'est pas autorisé.
        dir = updateActiveDirection(idx, dir);
        const capturedCount = executeCapture(state, player, idx, events);
        const startIdx = directionStartIndex(dir);
        const r = sow(state, player, startIdx, dir, capturedCount, events);
        idx = r.lastIndex;
        preCount = r.preCountAtLast;
        continue;
      }
      // 7.8 : pause.
      return { status: 'AWAITING_NYUMBA', direction: dir };
    }

    // Cas 1 (4.6/6.10/8.7) : la case était vide avant cette graine => fin du tour.
    if (preCount === 0) {
      return { status: 'DONE' };
    }

    // Capture obligatoire (4.7/6.11) — jamais pour un Mkazo (8.8).
    if (allowCaptures && isCapturingLanding(state, player, idx, preCount)) {
      dir = updateActiveDirection(idx, dir);
      const capturedCount = executeCapture(state, player, idx, events);
      const startIdx = directionStartIndex(dir);
      const r = sow(state, player, startIdx, dir, capturedCount, events);
      idx = r.lastIndex;
      preCount = r.preCountAtLast;
      continue;
    }

    // Absence de capture générale (4.8/6.12/8.7) : reprise et poursuite dans le même sens.
    const pickedUp = pickUpAll(state, player, idx, events);
    const nextStart = stepIndex(idx, dir);
    const r2 = sow(state, player, nextStart, dir, pickedUp, events);
    idx = r2.lastIndex;
    preCount = r2.preCountAtLast;
  }
}

/**
 * Reprise après un choix "Continuer le semis" (7.8) : reprend toutes les
 * graines du Nyumba (perd définitivement le statut), reprend le semis dans
 * le MÊME sens, puis réintègre la boucle générique runChain.
 */
function resumeAfterNyumbaContinue(state, events, player, direction, phase, allowCaptures) {
  const pickedUp = pickUpAll(state, player, NYUMBA_ABS_INDEX, events); // statut perdu (pickUpAll vide toujours entièrement)
  const nextStart = stepIndex(NYUMBA_ABS_INDEX, direction);
  const r = sow(state, player, nextStart, direction, pickedUp, events);
  return runChain(state, events, player, direction, r.lastIndex, r.preCountAtLast, phase, allowCaptures);
}

// ------------------------------------------------------------
// Exécution par type de coup (12.5.1-12.5.4)
// ------------------------------------------------------------

/** TSO_CAPTURE (4.1-4.9) : dépôt réserve, capture garantie par la génération des coups. */
function executeTsoCaptureMove(state, move, events) {
  const player = state.currentPlayer;
  const ps = state.players[player];
  const targetIdx = caseToAbsIndex(move.targetPit);

  const preCount = getCell(ps, targetIdx); // "déjà présente" (1.6) avant le dépôt
  ps.reserve -= 1;
  setCell(ps, targetIdx, preCount + 1);
  events.push({ type: EVENT_TYPE.RESERVE_DROP, player, pit: move.targetPit });

  const direction = determineInitialDirectionTso(move.targetPit, move.direction);
  return runChain(state, events, player, direction, targetIdx, preCount, PHASE.TSO, true);
}

/**
 * TSO_MKAZO — cas général (4.1 + 8.5-8.9). Le cas spécial du Nyumba isolé
 * (7.7) est traité par une fonction dédiée, sélectionnée par le
 * dispatcher central en fonction de targetPit===5 (cf. executeMoveDispatch),
 * car un TSO_MKAZO "normal" n'a par construction jamais targetPit=5
 * (interdiction 7.4, seule l'exception 7.7 propose ce ciblage).
 */
function executeTsoMkazoMove(state, move, events) {
  const player = state.currentPlayer;
  const ps = state.players[player];
  const targetIdx = caseToAbsIndex(move.targetPit);

  const preDeposit = getCell(ps, targetIdx);
  ps.reserve -= 1;
  setCell(ps, targetIdx, preDeposit + 1);
  events.push({ type: EVENT_TYPE.RESERVE_DROP, player, pit: move.targetPit });

  const direction = move.direction; // 8.5 : libre choix, aucune règle de direction active
  const nextStart = stepIndex(targetIdx, direction);
  const pickedUp = pickUpAll(state, player, targetIdx, events);
  const r = sow(state, player, nextStart, direction, pickedUp, events);

  return runChain(state, events, player, direction, r.lastIndex, r.preCountAtLast, PHASE.TSO, false);
}

/**
 * TSO_MKAZO — cas spécial du Nyumba isolé, phase TSO (7.7). Retire une
 * seule graine du Nyumba (pas pickUpAll) et sème avec 1 graine de réserve
 * dans les deux cases adjacentes. Le statut suit la règle générale
 * (syncNyumbaStatus) : conservé s'il en reste, perdu si cette graine
 * était la dernière — 7.7 dit "conservé" pour le cas courant, pas ce
 * cas limite. Ne passe jamais par runChain : par condition d'entrée
 * (aucune capture possible), et la distribution fixe ne retombe jamais
 * sur le Nyumba lui-même ; le coup se termine donc toujours ici.
 * Aucun événement RESERVE_DROP : la graine de réserve rejoint un pool
 * avec celle du Nyumba avant d'être semée dans deux cases différentes,
 * ce qui ne correspond à aucun pit unique au sens de RESERVE_DROP{player,pit}.
 */
function executeTsoNyumbaIsolatedMove(state, move, events) {
  const player = state.currentPlayer;
  const ps = state.players[player];

  const nyumbaCount = getCell(ps, NYUMBA_ABS_INDEX);
  setCell(ps, NYUMBA_ABS_INDEX, nyumbaCount - 1); // retire UNE SEULE graine (pas pickUpAll)
  syncNyumbaStatus(ps, player, events); // perd le statut si cette graine était la dernière (0 atteint)
  ps.reserve -= 1;

  const targetCases = move.direction === DIRECTION.LEFT ? [4, 3] : [6, 7];
  const path = [];
  for (const c of targetCases) {
    const idx = caseToAbsIndex(c);
    setCell(ps, idx, getCell(ps, idx) + 1);
    path.push(c);
  }
  events.push({ type: EVENT_TYPE.SOW, player, path });

  return { status: 'DONE' };
}

/** NDRAZI (6.1-6.14) : capture garantie par la génération des coups. */
function executeNdraziMove(state, move, events) {
  const player = state.currentPlayer;
  const startIdx = caseToAbsIndex(move.startPit);
  const direction = move.direction; // 6.6 : le sens choisi détermine directement la direction active
  const nextStart = stepIndex(startIdx, direction);
  const pickedUp = pickUpAll(state, player, startIdx, events); // perd le Nyumba si startPit=5 (7.6)
  const r = sow(state, player, nextStart, direction, pickedUp, events);
  return runChain(state, events, player, direction, r.lastIndex, r.preCountAtLast, PHASE.NDRAZI, true);
}

/** NDRAZI_MKAZO (8.1-8.9) : jamais de capture. */
function executeNdraziMkazoMove(state, move, events) {
  const player = state.currentPlayer;
  const startIdx = caseToAbsIndex(move.startPit);
  const direction = move.direction;
  const nextStart = stepIndex(startIdx, direction);
  const pickedUp = pickUpAll(state, player, startIdx, events);
  const r = sow(state, player, nextStart, direction, pickedUp, events);
  return runChain(state, events, player, direction, r.lastIndex, r.preCountAtLast, PHASE.NDRAZI, false);
}

/**
 * Point d'entrée unique d'exécution d'un coup, utilisé par le jeu réel
 * et par le filtre d'auto-élimination (8.10), pour n'avoir jamais qu'une
 * seule implémentation de "ce que fait un coup".
 * TSO_MKAZO avec targetPit=5 : la procédure 7.7 ne s'applique que si le
 * Nyumba est encore actif (seule façon dont targetPit=5 est légal, 7.4) ;
 * une fois le statut perdu, targetPit=5 vient du générateur normal et
 * suit la procédure normale.
 */
function executeMoveDispatch(state, move, events) {
  switch (move.type) {
    case MOVE_TYPE.TSO_CAPTURE:
      return executeTsoCaptureMove(state, move, events);
    case MOVE_TYPE.TSO_MKAZO:
      return move.targetPit === 5 && state.players[state.currentPlayer].nyumbaActive
        ? executeTsoNyumbaIsolatedMove(state, move, events)
        : executeTsoMkazoMove(state, move, events);
    case MOVE_TYPE.NDRAZI:
      return executeNdraziMove(state, move, events);
    case MOVE_TYPE.NDRAZI_MKAZO:
      return executeNdraziMkazoMove(state, move, events);
    default:
      throw new Error('executeMoveDispatch: type de coup inconnu: ' + move.type);
  }
}

// ============================================================
// SECTION 7 — Génération des coups légaux (4.1-4.2, 6.2-6.5, 7.6-7.7, 8.1-8.4)
// ============================================================

/**
 * Simule (SANS mutation) l'atterrissage d'un semis de `count` graines
 * depuis `startAbsIndex` dans `direction`, sachant que `emptiedIndex`
 * (la case de départ réelle) est vidée avant ce semis — utile si le
 * semis boucle et repasse par cette case. Retourne {lastIndex, preCount}.
 * Utilisée uniquement pour la RECHERCHE de coups Ndrazi (6.2), jamais
 * pour l'exécution réelle (qui passe toujours par sow()).
 */
function simulateSowLanding(playerState, startAbsIndex, direction, count, emptiedIndex) {
  const working = new Array(TOTAL_SIZE);
  for (let i = 0; i < INNER_SIZE; i++) working[i] = playerState.inner[i];
  for (let i = 0; i < OUTER_SIZE; i++) working[INNER_SIZE + i] = playerState.outer[i];
  working[emptiedIndex] = 0;

  let idx = startAbsIndex;
  let preCount = 0;
  for (let i = 0; i < count; i++) {
    preCount = working[idx];
    working[idx] = preCount + 1;
    if (i < count - 1) idx = stepIndex(idx, direction);
  }
  return { lastIndex: idx, preCount };
}

/** 4.1-4.2 : candidats de capture TSO (dépôt réserve dans une case intérieure non vide capturante). */
function findTsoCaptureCandidates(state) {
  const player = state.currentPlayer;
  const ps = state.players[player];
  const opp = state.players[1 - player];
  const candidates = [];
  for (let idx = 0; idx < INNER_SIZE; idx++) {
    if (ps.inner[idx] < 1) continue; // 4.1 : case non vide requise
    if (opp.inner[mirrorInnerIndex(idx)] < 1) continue; // 4.2 : pas de capture possible ici
    const caseNum = absIndexToCase(idx);
    if (caseNum === 1 || caseNum === 2) {
      candidates.push({ type: MOVE_TYPE.TSO_CAPTURE, targetPit: caseNum, direction: DIRECTION.RIGHT });
    } else if (caseNum === 7 || caseNum === 8) {
      candidates.push({ type: MOVE_TYPE.TSO_CAPTURE, targetPit: caseNum, direction: DIRECTION.LEFT });
    } else {
      // 3, 4, 5, 6 : libre choix (4.4), y compris 5=Nyumba si la capture est immédiate (7.5).
      candidates.push({ type: MOVE_TYPE.TSO_CAPTURE, targetPit: caseNum, direction: DIRECTION.LEFT });
      candidates.push({ type: MOVE_TYPE.TSO_CAPTURE, targetPit: caseNum, direction: DIRECTION.RIGHT });
    }
  }
  return candidates;
}

/**
 * 7.4 : candidats de Mkazo TSO — exclut le Nyumba UNIQUEMENT tant que son
 * statut est actif ; une fois perdu, la case redevient ordinaire (4.1).
 * Filtré par 8.10 (auto-élimination), qui s'applique au Mkazo en général,
 * sans distinction de phase.
 */
function findTsoMkazoCandidates(state) {
  const player = state.currentPlayer;
  const ps = state.players[player];
  const candidates = [];
  for (let idx = 0; idx < INNER_SIZE; idx++) {
    if (idx === NYUMBA_ABS_INDEX && ps.nyumbaActive) continue; // 7.4 : interdit tant que Nyumba est actif
    if (ps.inner[idx] < 1) continue;
    const caseNum = absIndexToCase(idx);
    candidates.push({ type: MOVE_TYPE.TSO_MKAZO, targetPit: caseNum, direction: DIRECTION.LEFT });
    candidates.push({ type: MOVE_TYPE.TSO_MKAZO, targetPit: caseNum, direction: DIRECTION.RIGHT });
  }
  return candidates.filter((m) => !isSelfEliminating(state, m));
}

/**
 * 7.7 (branche TSO) : Nyumba isolé — seule case intérieure non vide.
 * Ne s'applique que si le Nyumba est encore actif : une fois le statut
 * perdu, ce n'est plus "le Nyumba" et l'exception n'a plus lieu d'être —
 * le générateur normal (findTsoMkazoCandidates) prend le relais de lui-même.
 */
function findTsoIsolatedNyumbaCandidate(state) {
  const player = state.currentPlayer;
  const ps = state.players[player];
  if (!ps.nyumbaActive) return [];
  for (let idx = 0; idx < INNER_SIZE; idx++) {
    if (idx === NYUMBA_ABS_INDEX) continue;
    if (ps.inner[idx] > 0) return []; // une autre case intérieure a des graines => pas isolé
  }
  if (ps.inner[NYUMBA_ABS_INDEX] < 1) return []; // rien à jouer, même via l'exception
  return [
    { type: MOVE_TYPE.TSO_MKAZO, targetPit: 5, direction: DIRECTION.LEFT },
    { type: MOVE_TYPE.TSO_MKAZO, targetPit: 5, direction: DIRECTION.RIGHT },
  ];
}

/** Orchestration complète des coups légaux en phase TSO (4.2, 7.4, 7.7). */
function generateTsoLegalMoves(state) {
  const captures = findTsoCaptureCandidates(state);
  if (captures.length > 0) return captures; // 4.2 : capture obligatoire, aucun Mkazo
  return findTsoMkazoCandidates(state).concat(findTsoIsolatedNyumbaCandidate(state));
}

/** 6.2-6.5 : candidats de Ndrazi (case de départ >=2 graines, coup qui capture). */
function findNdraziCandidates(state) {
  const player = state.currentPlayer;
  const ps = state.players[player];
  const opp = state.players[1 - player];
  const candidates = [];
  for (let startIdx = 0; startIdx < TOTAL_SIZE; startIdx++) {
    const seedCount = getCell(ps, startIdx);
    if (seedCount < 2) continue; // 6.2 : au moins deux graines
    for (const direction of [DIRECTION.LEFT, DIRECTION.RIGHT]) {
      const nextStart = stepIndex(startIdx, direction);
      const { lastIndex, preCount } = simulateSowLanding(ps, nextStart, direction, seedCount, startIdx);
      if (!isInnerAbsIndex(lastIndex)) continue; // capture uniquement sur case intérieure
      if (preCount < 1) continue; // 1.6 : doit déjà contenir au moins une graine du joueur
      if (opp.inner[mirrorInnerIndex(lastIndex)] < 1) continue; // case adverse opposée non vide
      candidates.push({ type: MOVE_TYPE.NDRAZI, startPit: absIndexToCase(startIdx), direction });
    }
  }
  return candidates;
}

/** 8.3-8.4, 8.10/10.4 : candidats de Mkazo NDRAZI, priorité intérieure, filtrés anti-auto-élimination. */
function findNdraziMkazoCandidates(state) {
  const player = state.currentPlayer;
  const ps = state.players[player];

  const innerCandidates = [];
  for (let idx = 0; idx < INNER_SIZE; idx++) {
    if (ps.inner[idx] < 2) continue; // 8.3 : au moins deux graines
    const caseNum = absIndexToCase(idx);
    innerCandidates.push({ type: MOVE_TYPE.NDRAZI_MKAZO, startPit: caseNum, direction: DIRECTION.LEFT });
    innerCandidates.push({ type: MOVE_TYPE.NDRAZI_MKAZO, startPit: caseNum, direction: DIRECTION.RIGHT });
  }
  const innerSafe = innerCandidates.filter((m) => !isSelfEliminating(state, m));
  if (innerSafe.length > 0) return innerSafe; // 8.4 : priorité intérieure absolue (sur les coups LÉGAUX)

  const outerCandidates = [];
  for (let i = 0; i < OUTER_SIZE; i++) {
    if (ps.outer[i] < 2) continue;
    const caseNum = absIndexToCase(INNER_SIZE + i);
    outerCandidates.push({ type: MOVE_TYPE.NDRAZI_MKAZO, startPit: caseNum, direction: DIRECTION.LEFT });
    outerCandidates.push({ type: MOVE_TYPE.NDRAZI_MKAZO, startPit: caseNum, direction: DIRECTION.RIGHT });
  }
  return outerCandidates.filter((m) => !isSelfEliminating(state, m));
}

/** Orchestration complète des coups légaux en phase NDRAZI (6.3, 8.2, 8.4). */
function generateNdraziLegalMoves(state) {
  const ndrazi = findNdraziCandidates(state);
  if (ndrazi.length > 0) return ndrazi; // 6.3 : Ndrazi obligatoire, aucun Mkazo
  return findNdraziMkazoCandidates(state);
}

/** Point d'entrée générique de génération des coups légaux, quelle que soit la phase. */
function generateLegalMoves(state) {
  if (state.gameOver) return [];
  return state.phase === PHASE.TSO ? generateTsoLegalMoves(state) : generateNdraziLegalMoves(state);
}

/**
 * Le joueur `player` dispose-t-il d'au moins un coup légal ? Indépendant
 * de state.currentPlayer (nécessaire pour 8.10 : évaluer un joueur
 * hypothétique sans avoir avancé currentPlayer). Lecture seule : la
 * génération de coups ne mute jamais l'état, donc une copie superficielle
 * (juste currentPlayer réaffecté) suffit et évite un clonage profond.
 */
function hasLegalMove(state, player) {
  const target = state.currentPlayer === player ? state : { ...state, currentPlayer: player };
  return generateLegalMoves(target).length > 0;
}

/**
 * Existence structurelle d'un coup pour `player`, sans re-filtrage
 * récursif par 8.10 (utilisée uniquement par isSelfEliminating, qui
 * doit vérifier "un coup légal au tour suivant" sans que ce coup
 * hypothétique redéclenche sa propre vérification d'auto-élimination —
 * 8.10 : "aucune anticipation des coups futurs n'est effectuée").
 * TSO : rangée intérieure non vide (10.1) — strictement équivalent à
 * "un coup existe", puisque tout dépôt TSO requiert une case
 * intérieure non vide, Nyumba inclus (l'exception 7.7 s'applique
 * justement quand seul le Nyumba est non vide). NDRAZI : un Ndrazi
 * capturant, ou une case (intérieure ou extérieure) >=2 graines (8.3).
 */
function hasRawMoveOption(state, player) {
  const target = state.currentPlayer === player ? state : { ...state, currentPlayer: player };
  if (target.gameOver) return false;
  if (target.phase === PHASE.TSO) return !isDefeatedTso(target, player);
  const ps = target.players[player];
  if (findNdraziCandidates(target).length > 0) return true;
  for (let i = 0; i < INNER_SIZE; i++) if (ps.inner[i] >= 2) return true;
  for (let i = 0; i < OUTER_SIZE; i++) if (ps.outer[i] >= 2) return true;
  return false;
}

/**
 * 8.10/10.3 — Interdiction d'auto-élimination : simule le Mkazo candidat
 * et vérifie si la position résultante laisse au joueur au moins un coup
 * à son prochain tour hypothétique. "L'exécution complète du Mkazo"
 * (8.10) n'a pas eu lieu si la chaîne s'arrête sur une pause Nyumba
 * (7.8) : ce candidat n'est alors pas considéré comme auto-éliminant —
 * le joueur garde la main sur Arrêter/Continuer, donc aucune défaite
 * n'est encore "immédiate" à ce stade.
 * Garde-fou : dans des positions extrêmes (graines très concentrées
 * dans une case, typiquement après de nombreux cycles Udza), le semis
 * en chaîne peut mathématiquement ne jamais retomber sur une case vide
 * (cf. MAX_CHAIN_ITERATIONS). Un coup qui ne termine jamais ne peut de
 * toute façon jamais être joué : il est alors traité comme auto-éliminant.
 */
function isSelfEliminating(state, move) {
  const player = state.currentPlayer;
  const s1 = cloneGameState(state);
  const events = [];
  let outcome;
  try {
    outcome = executeMoveDispatch(s1, move, events);
  } catch (e) {
    return true;
  }
  if (outcome.status === 'AWAITING_NYUMBA') return false;
  applyPhaseTransitionIfNeeded(s1, events);
  return !hasRawMoveOption(s1, player);
}

/** Comparaison structurelle de deux coups (champs officiels uniquement, 12.5). */
function movesEqual(a, b) {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.direction !== b.direction) return false;
  if (a.type === MOVE_TYPE.TSO_CAPTURE || a.type === MOVE_TYPE.TSO_MKAZO) {
    return a.targetPit === b.targetPit;
  }
  return a.startPit === b.startPit;
}

/** 12.9 : isMoveLegal(move). */
function isMoveLegal(state, move) {
  if (!move || typeof move.type !== 'string') return false;
  return generateLegalMoves(state).some((m) => movesEqual(m, move));
}

// ============================================================
// SECTION 8 — Défaite, transition de phase, finalisation (5.2-5.3, 10.1-10.4)
// ============================================================

/** 10.1 : défaite TSO — rangée intérieure totalement vide. */
function isDefeatedTso(state, player) {
  return state.players[player].inner.every((v) => v === 0);
}

/** 10.2 : défaite NDRAZI — aucun coup légal (Ndrazi, Mkazo intérieur, Mkazo extérieur). */
function isDefeatedNdrazi(state, player) {
  return !hasLegalMove(state, player);
}

function isDefeated(state, player) {
  return state.phase === PHASE.TSO ? isDefeatedTso(state, player) : isDefeatedNdrazi(state, player);
}

/** 5.2-5.3 : la phase passe à NDRAZI dès que les deux réserves sont vides. */
function applyPhaseTransitionIfNeeded(state, events) {
  if (state.phase === PHASE.TSO && state.players[0].reserve === 0 && state.players[1].reserve === 0) {
    state.phase = PHASE.NDRAZI;
    events.push({ type: EVENT_TYPE.PHASE_CHANGE, phase: PHASE.NDRAZI });
  }
}

/**
 * Finalise un coup entièrement résolu : transition de phase, détection de
 * défaite, passage de tour et réinitialisation Udza (9.7) si la partie
 * continue. Mute `state` et pousse les événements terminaux dans `events`.
 * 10.1 lie explicitement la vérification à "la fin du coup adverse" : seul
 * le joueur qui va jouer ensuite (l'adversaire de celui qui vient de jouer)
 * est vérifié — l'auto-élimination du joueur actif est prévenue en amont,
 * à la génération des coups (10.3, isSelfEliminating), pas constatée ici.
 */
function finalizeTurnAndAdvance(state, events) {
  applyPhaseTransitionIfNeeded(state, events);

  const justMoved = state.currentPlayer;
  const opponent = 1 - justMoved;

  if (isDefeated(state, opponent)) {
    state.gameOver = true;
    state.winner = justMoved;
    events.push({ type: EVENT_TYPE.DEFEAT, player: opponent });
    events.push({ type: EVENT_TYPE.VICTORY, player: justMoved });
    return;
  }

  state.currentPlayer = opponent;
  state.players[opponent].udzaRemaining = MAX_UDZA; // 9.7
}

// ============================================================
// SECTION 9 — Classe MrahaEngine (12.1-12.27) : coquille avec état
// ============================================================
//
// Le noyau (sections 1 à 8) est entièrement pur : chaque fonction reçoit
// un `state` explicite et le mute directement, sans jamais dépendre d'un
// état caché. MrahaEngine est la fine couche avec état qui : conserve
// `this.#state` (players, currentPlayer, phase, winner, gameOver,
// history), gère la pause de décision (`this.#pending`, Mkazo à
// valider/annuler OU choix Nyumba en attente), et mémorise le dernier
// résultat (`this.#lastMoveResult`). Aucune règle de jeu n'est
// réimplémentée ici : tout passe par les fonctions pures déjà testées.

/**
 * Reconstruit un état interne complet à partir d'un objet importé
 * (forme exportState(), éventuellement partielle). Utilisé par le
 * constructeur (12.14, "Constructeur avec état importé") et importState().
 */
function normalizeImportedState(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('MrahaEngine: état importé invalide.');
  }
  return {
    players: [clonePlayerState(raw.players[0]), clonePlayerState(raw.players[1])],
    currentPlayer: raw.currentPlayer,
    phase: raw.phase,
    winner: raw.winner,
    gameOver: raw.gameOver,
    history: Array.isArray(raw.history) ? raw.history.map(cloneHistoryEntry) : [],
  };
}

/** Copie profonde d'un événement (12.18.4) : `path` (SOW) est un tableau, pas un primitif. */
function cloneEvent(e) {
  const copy = { ...e };
  if (Array.isArray(e.path)) copy.path = e.path.slice();
  return copy;
}

/** Clone sérialisable d'une décision en attente (pour exportState, ajout délibéré). */
function clonePendingForExport(pending) {
  if (!pending) return null;
  return {
    kind: pending.kind,
    move: { ...pending.move },
    events: pending.events.map(cloneEvent),
    beforeView: cloneStateView(pending.beforeView),
    direction: pending.direction || null,
    isMkazoFamily: !!pending.isMkazoFamily,
  };
}

class MrahaEngine {
  #state;
  #pending;
  #lastMoveResult;

  /**
   * new MrahaEngine(state?) — 12.14 : sans argument, nouvelle partie
   * (tirage au sort, 11.1) ; avec un état exporté, reprise de partie.
   */
  constructor(state) {
    if (state !== undefined && state !== null) {
      this.#state = normalizeImportedState(state);
      this.#pending = state.pending ? this.#rehydratePending(state.pending) : null;
    } else {
      this.#state = createInitialGameState(); // 11.1 : tirage au sort (première partie)
      this.#pending = null;
    }
    this.#lastMoveResult = null;
  }

  #rehydratePending(p) {
    return {
      kind: p.kind,
      move: { ...p.move },
      events: (p.events || []).map(cloneEvent),
      beforeView: cloneStateView(p.beforeView),
      direction: p.direction || null,
      isMkazoFamily: !!p.isMkazoFamily,
    };
  }

  // ---- 12.15 : état public ----
  getState() {
    return toStateView(this.#state);
  }

  // ---- 12.14/12.16 : sérialisation complète ----
  exportState() {
    return {
      players: [clonePlayerState(this.#state.players[0]), clonePlayerState(this.#state.players[1])],
      currentPlayer: this.#state.currentPlayer,
      phase: this.#state.phase,
      winner: this.#state.winner,
      gameOver: this.#state.gameOver,
      history: this.#state.history.map(cloneHistoryEntry),
      // AJOUT DÉLIBÉRÉ : la décision en attente (s'il y en a une) est incluse pour une
      // fidélité complète d'un cycle exportState()/importState() — sans elle, sauvegarder
      // puis recharger la partie au milieu d'une pause Mkazo ou Nyumba perdrait cette pause.
      pending: clonePendingForExport(this.#pending),
    };
  }

  importState(state) {
    this.#state = normalizeImportedState(state);
    this.#pending = state && state.pending ? this.#rehydratePending(state.pending) : null;
    this.#lastMoveResult = null;
  }

  // ---- 12.6 : identité et phase ----
  getCurrentPlayer() {
    return this.#state.currentPlayer;
  }

  getPhase() {
    return this.#state.phase;
  }

  // ---- 12.8/12.9/12.17 : coups légaux ----
  // Aucun coup n'est légal tant qu'une décision (Mkazo ou Nyumba) est en
  // attente : le joueur doit d'abord la résoudre (confirmMkazo/undoMkazo
  // ou resolveNyumbaChoice) avant de pouvoir jouer un nouveau coup.
  getLegalMoves() {
    if (this.#pending || this.#state.gameOver) return [];
    return generateLegalMoves(this.#state);
  }

  hasLegalMove() {
    if (this.#pending || this.#state.gameOver) return false;
    return hasLegalMove(this.#state, this.#state.currentPlayer);
  }

  isMoveLegal(move) {
    if (this.#pending || this.#state.gameOver) return false;
    return isMoveLegal(this.#state, move);
  }

  // ---- 12.18 : exécution d'un coup ----
  play(move) {
    if (this.#pending) {
      return this.#failResult(move);
    }
    if (this.#state.gameOver) {
      return this.#failResult(move);
    }
    if (!isMoveLegal(this.#state, move)) {
      return this.#failResult(move);
    }

    const beforeView = toStateView(this.#state);
    const events = [];
    let outcome;
    try {
      outcome = executeMoveDispatch(this.#state, move, events);
    } catch (e) {
      // Filet de sécurité : un coup légal ne devrait jamais atteindre ce cas
      // (isSelfEliminating exclut déjà les Mkazo non-terminants), mais
      // TSO_CAPTURE/NDRAZI ne sont jamais filtrés (captures obligatoires).
      this.#state.players = [clonePlayerState(beforeView.players[0]), clonePlayerState(beforeView.players[1])];
      this.#state.currentPlayer = beforeView.currentPlayer;
      this.#state.phase = beforeView.phase;
      this.#state.winner = beforeView.winner;
      this.#state.gameOver = beforeView.gameOver;
      return this.#failResult(move);
    }
    const isMkazoFamily = move.type === MOVE_TYPE.TSO_MKAZO || move.type === MOVE_TYPE.NDRAZI_MKAZO;

    if (outcome.status === 'AWAITING_NYUMBA') {
      // 7.8 : pause, quel que soit le type de coup (capture ou Mkazo — cf. analyse).
      this.#pending = {
        kind: 'NYUMBA_CHOICE',
        move,
        events,
        beforeView,
        direction: outcome.direction,
        isMkazoFamily,
      };
      return this.#pauseResult(move, events, 'NYUMBA_CHOICE');
    }

    if (isMkazoFamily) {
      const player = this.#state.currentPlayer;
      if (this.#state.players[player].udzaRemaining > 0) {
        // 9.2 : la chaîne du Mkazo est terminée, offre Valider/Udza.
        this.#pending = { kind: 'MKAZO_CONFIRM', move, events, beforeView, isMkazoFamily: true };
        return this.#pauseResult(move, events, 'MKAZO_CONFIRM');
      }
      // 9.6 : troisième essai, Udza épuisé => validation automatique immédiate.
      return this.#finalizeMove(move, events, beforeView);
    }

    // TSO_CAPTURE / NDRAZI : jamais de confirmation (9.1), finalise immédiatement.
    return this.#finalizeMove(move, events, beforeView);
  }

  /** Copie profonde d'un MoveResult : aucune référence partagée avec l'état interne. */
  #cloneResult(r) {
    return {
      success: r.success,
      move: r.move ? { ...r.move } : null,
      events: r.events.map(cloneEvent),
      finalState: cloneStateView(r.finalState),
      gameOver: r.gameOver,
      winner: r.winner,
      awaitingDecision: r.awaitingDecision,
    };
  }

  #pauseResult(move, events, awaitingDecision) {
    const result = {
      success: true,
      move,
      events: events.slice(),
      finalState: toStateView(this.#state),
      gameOver: false,
      winner: null,
      // AJOUT DÉLIBÉRÉ : hors du schéma MoveResult (12.18.1), mais nécessaire — sans lui
      // l'appelant ne peut pas savoir s'il doit résoudre Valider/Udza ou Arrêter/Continuer.
      awaitingDecision,
    };
    this.#lastMoveResult = result;
    return this.#cloneResult(result);
  }

  #finalizeMove(move, events, beforeView) {
    finalizeTurnAndAdvance(this.#state, events);
    const afterView = toStateView(this.#state);
    this.#state.history.push({ beforeState: beforeView, move: { ...move }, afterState: afterView });
    const result = {
      success: true,
      move,
      events: events.slice(),
      finalState: afterView,
      gameOver: this.#state.gameOver,
      winner: this.#state.winner,
      awaitingDecision: null,
    };
    this.#lastMoveResult = result;
    this.#pending = null;
    return this.#cloneResult(result);
  }

  #failResult(move) {
    return {
      success: false,
      move: move || null,
      events: [],
      finalState: toStateView(this.#state),
      gameOver: this.#state.gameOver,
      winner: this.#state.winner,
    };
  }

  // ---- 12.19 : validation d'un Mkazo ----
  confirmMkazo() {
    if (!this.#pending || this.#pending.kind !== 'MKAZO_CONFIRM') return false;
    const { move, events, beforeView } = this.#pending;
    this.#finalizeMove(move, events, beforeView);
    return true;
  }

  // ---- 12.20 : Udza ----
  canUndoMkazo() {
    if (!this.#pending || this.#pending.kind !== 'MKAZO_CONFIRM') return false;
    return this.#state.players[this.#state.currentPlayer].udzaRemaining > 0;
  }

  undoMkazo() {
    if (!this.canUndoMkazo()) return false;
    const player = this.#state.currentPlayer;
    const restored = this.#pending.beforeView;
    this.#state.players = [clonePlayerState(restored.players[0]), clonePlayerState(restored.players[1])];
    this.#state.currentPlayer = restored.currentPlayer;
    this.#state.phase = restored.phase;
    this.#state.winner = restored.winner;
    this.#state.gameOver = restored.gameOver;
    this.#state.players[player].udzaRemaining -= 1; // 9.5
    this.#pending = null;
    return true;
  }

  /**
   * AJOUT DÉLIBÉRÉ : aucune méthode de la spec ne couvre la décision
   * "Arrêter le tour" / "Continuer le semis" de 7.8 — nécessaire pourtant,
   * puisqu'elle survient EN COURS de coup (après un atterrissage
   * imprévisible au Nyumba), donc impossible à encoder dans le Move initial.
   * choice: 'STOP' | 'CONTINUE'.
   */
  resolveNyumbaChoice(choice) {
    if (!this.#pending || this.#pending.kind !== 'NYUMBA_CHOICE') {
      return this.#failResult(this.#pending ? this.#pending.move : null);
    }
    if (choice !== 'STOP' && choice !== 'CONTINUE') {
      return this.#failResult(this.#pending.move);
    }

    const { move, events, beforeView, direction, isMkazoFamily } = this.#pending;

    if (choice === 'STOP') {
      // 7.8 "Arrêter le tour" : équivaut à un atterrissage normal sur case vide (4.6/8.7) —
      // le statut Nyumba est conservé (aucune graine n'est retirée de la case).
      this.#pending = null;
      if (isMkazoFamily && this.#state.players[this.#state.currentPlayer].udzaRemaining > 0) {
        this.#pending = { kind: 'MKAZO_CONFIRM', move, events, beforeView, isMkazoFamily: true };
        return this.#pauseResult(move, events, 'MKAZO_CONFIRM');
      }
      return this.#finalizeMove(move, events, beforeView);
    }

    // CONTINUE : reprend toutes les graines du Nyumba (perd le statut), poursuit le semis.
    const player = this.#state.currentPlayer;
    let outcome;
    try {
      outcome = resumeAfterNyumbaContinue(this.#state, events, player, direction, this.#state.phase, !isMkazoFamily);
    } catch (e) {
      // Filet de sécurité symétrique à play() : restaure l'état d'avant-coup si la
      // poursuite du semis tombe sur une position dégénérée non-terminante.
      this.#state.players = [clonePlayerState(beforeView.players[0]), clonePlayerState(beforeView.players[1])];
      this.#state.currentPlayer = beforeView.currentPlayer;
      this.#state.phase = beforeView.phase;
      this.#state.winner = beforeView.winner;
      this.#state.gameOver = beforeView.gameOver;
      this.#pending = null;
      return this.#failResult(move);
    }

    if (outcome.status === 'AWAITING_NYUMBA') {
      // Ne devrait pas se reproduire (le Nyumba concerné vient de perdre son statut),
      // mais la boucle reste correcte si un futur changement de règle réactivait ce cas.
      this.#pending = { kind: 'NYUMBA_CHOICE', move, events, beforeView, direction: outcome.direction, isMkazoFamily };
      return this.#pauseResult(move, events, 'NYUMBA_CHOICE');
    }

    this.#pending = null;
    if (isMkazoFamily && this.#state.players[player].udzaRemaining > 0) {
      this.#pending = { kind: 'MKAZO_CONFIRM', move, events, beforeView, isMkazoFamily: true };
      return this.#pauseResult(move, events, 'MKAZO_CONFIRM');
    }
    return this.#finalizeMove(move, events, beforeView);
  }

  /**
   * AJOUT DÉLIBÉRÉ : 10.5 ("Abandon") n'a aucune méthode dans le chapitre 12.
   * Confirmé par l'utilisateur : fonctionne comme dans tout jeu de société
   * (défaite immédiate, victoire adverse), même pendant une décision en attente.
   */
  resign(player) {
    if (player !== 0 && player !== 1) return false;
    if (this.#state.gameOver) return false;
    const winner = 1 - player;
    this.#pending = null;
    this.#state.gameOver = true;
    this.#state.winner = winner;
    const events = [
      { type: EVENT_TYPE.DEFEAT, player },
      { type: EVENT_TYPE.VICTORY, player: winner },
    ];
    this.#lastMoveResult = {
      success: true,
      move: null,
      events,
      finalState: toStateView(this.#state),
      gameOver: true,
      winner,
      awaitingDecision: null,
    };
    return true;
  }

  // ---- 12.21 : historique ----
  getHistory() {
    return this.#state.history.map(cloneHistoryEntry);
  }

  clearHistory() {
    this.#state.history = [];
  }

  // ---- 12.22 : dernier résultat ----
  getLastMoveResult() {
    return this.#lastMoveResult ? this.#cloneResult(this.#lastMoveResult) : null;
  }

  // ---- 12.23 : détection et vérifications ----
  // Recalculées activement (pas de simple lecture de state.winner/gameOver) afin que ces
  // méthodes servent aussi d'auto-vérification indépendante de la logique de finalisation.
  checkVictory() {
    for (const p of [0, 1]) {
      if (isDefeated(this.#state, p)) return 1 - p;
    }
    return null;
  }

  checkDefeat(player) {
    return isDefeated(this.#state, player);
  }

  // ---- 12.24 : informations Nyumba ----
  isNyumbaActive(player) {
    return this.#state.players[player].nyumbaActive;
  }

  // ---- 12.25 : informations Udza ----
  getRemainingUdza(player) {
    return this.#state.players[player].udzaRemaining;
  }

  // ---- getWinner / isGameOver ----
  getWinner() {
    return this.#state.winner;
  }

  isGameOver() {
    return this.#state.gameOver;
  }

  /**
   * 12.26/11.2 : tirage au sort (11.1) seulement à la toute première partie ;
   * pour toute partie suivante, le vainqueur de la précédente commence —
   * règle détaillée de 11.2, qui prévaut sur la formulation générique de
   * 12.26 ("nouveau tirage au sort").
   */
  reset() {
    const previousWinner = this.#state.winner;
    const nextStarter = previousWinner === 0 || previousWinner === 1 ? previousWinner : undefined;
    this.#state = createInitialGameState(nextStarter);
    this.#pending = null;
    this.#lastMoveResult = null;
  }
}

// Export conditionné : `module.exports = {...}` référencerait `module` sans garde et
// lèverait une ReferenceError dans un environnement sans CommonJS (navigateur).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MrahaEngine,
    PHASE, DIRECTION, MOVE_TYPE, EVENT_TYPE,
    INNER_SIZE, OUTER_SIZE, TOTAL_SIZE, NYUMBA_ABS_INDEX, INITIAL_RESERVE, MAX_UDZA,
    MAX_CHAIN_ITERATIONS,
    caseToAbsIndex, absIndexToCase, stepIndex, isInnerAbsIndex, mirrorInnerIndex,
    directionStartIndex, updateActiveDirection,
    createInitialPlayerState, createInitialGameState, cloneGameState, clonePlayerState,
    toStateView, cloneStateView,
    getCell, setCell,
    sow, isCapturingLanding, executeCapture, pickUpAll, syncNyumbaStatus,
    determineInitialDirectionTso, runChain, resumeAfterNyumbaContinue,
    executeTsoCaptureMove, executeTsoMkazoMove, executeTsoNyumbaIsolatedMove,
    executeNdraziMove, executeNdraziMkazoMove, executeMoveDispatch,
    simulateSowLanding, findTsoCaptureCandidates, findTsoMkazoCandidates,
    findTsoIsolatedNyumbaCandidate, generateTsoLegalMoves,
    findNdraziCandidates, findNdraziMkazoCandidates, generateNdraziLegalMoves,
    generateLegalMoves, hasLegalMove, hasRawMoveOption, isSelfEliminating, movesEqual, isMoveLegal,
    isDefeatedTso, isDefeatedNdrazi, isDefeated,
    applyPhaseTransitionIfNeeded, finalizeTurnAndAdvance,
  };
} else if (typeof window !== 'undefined') {
  window.MrahaEngine = MrahaEngine;
}

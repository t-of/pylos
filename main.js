'use strict';

// 試作のため、設定・効果音・共有の中身・対局記録は足さない（webapp-kit のボタンだけ標準で入っている）。
WebAppKit.init({ title: 'pylos', text: '試作 ピロス（ボードゲーム）。4段のピラミッド型の盤に玉を積み、正方形を作って玉を取り戻し、頂上を取るか相手を手詰まりにしたら勝ち。' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// ---- ここからアプリ本体 ----

const E = PylosEngine;

// state: engine のゲーム状態（white/black ビットボード・turn・winner）。
// ui: 画面だけが持つ、手番の途中経過（選択中の玉・取り戻し中かどうか・今回取った数）。
let state = null;
let ui = null;
let vsCpu = true;
let cpuSide = 1;      // CPU がどちらの色か（0 白 / 1 黒）
let difficulty = 'weak';
let worker = null;

function bit(i) { return 1 << i; }

function newGame() {
  state = E.initState();
  ui = { sel: null, phase: 'play', removedCount: 0 };
  render();
  maybeCpuTurn();
}

// ---- 手番の操作（人間） ----

function legalPlacements() {
  const occ = E.occOf(state);
  const out = [];
  if (E.handOf(state, state.turn) > 0) {
    for (let i = 0; i < 30; i++) if (E.canPlace(i, occ)) out.push(i);
  }
  return out;
}
function legalDestinationsFrom(from) {
  const occWithout = E.occOf(state) & ~bit(from);
  const fromLayer = E.layerOf(from);
  const out = [];
  for (let i = 0; i < 30; i++) if (E.layerOf(i) > fromLayer && E.canPlace(i, occWithout)) out.push(i);
  return out;
}
function movableOwnBalls() {
  const occ = E.occOf(state);
  const mine = E.ownBB(state);
  const out = [];
  for (let i = 0; i < 30; i++) if ((mine & bit(i)) && E.isFree(i, occ) && legalDestinationsFrom(i).length) out.push(i);
  return out;
}

function commit(action) {
  // action: { kind: 'place'|'move', from?, to }
  const color = state.turn === 0 ? 'white' : 'black';
  if (action.kind === 'move') state[color] &= ~bit(action.from);
  state[color] |= bit(action.to);
  ui.sel = null;

  if (action.to === E.TOP) {
    state.winner = state.turn;
    render();
    return;
  }
  if (E.squareFormedAt(action.to, E.ownBB(state))) {
    ui.phase = 'retrieve';
    ui.removedCount = 0;
    render();
  } else {
    finalizeTurn();
  }
}

function liftableNow() {
  const occ = E.occOf(state);
  const mine = E.ownBB(state);
  const out = [];
  for (let i = 0; i < 30; i++) if ((mine & bit(i)) && E.isFree(i, occ)) out.push(i);
  return out;
}

function retrieveTap(idx) {
  const color = state.turn === 0 ? 'white' : 'black';
  state[color] &= ~bit(idx);
  ui.removedCount += 1;
  if (ui.removedCount >= 2) finalizeTurn();
  else render();
}

function finalizeTurn() {
  ui.phase = 'play';
  ui.sel = null;
  ui.removedCount = 0;
  if (state.winner == null) {
    state.turn = 1 - state.turn;
    if (E.genMoves(state).length === 0) state.winner = 1 - state.turn; // 次の手番が手詰まり
  }
  render();
  maybeCpuTurn();
}

// ---- CPU ----

function maybeCpuTurn() {
  if (state.winner != null || !vsCpu || state.turn !== cpuSide) return;
  if (difficulty === 'weak' || difficulty === 'normal') {
    const m = E.pickByDifficulty(state, difficulty);
    if (m) state = E.applyMove(state, m);
    render();
    return;
  }
  $thinking.hidden = false;
  if (!worker) worker = new Worker('./worker.js');
  worker.onmessage = (e) => {
    $thinking.hidden = true;
    const m = e.data.move;
    if (m) state = E.applyMove(state, m);
    render();
  };
  worker.postMessage({ state: E.cloneState(state), difficulty });
}

// ---- 描画 ----

const $start = document.getElementById('start');
const $game = document.getElementById('game');
const $thinking = document.getElementById('thinking');
const $result = document.getElementById('result');
const $pyramid = document.getElementById('pyramid');
const $handTop = document.getElementById('handTop');
const $handBottom = document.getElementById('handBottom');
const $turnLabel = document.getElementById('turnLabel');
const $hint = document.getElementById('hint');
const $resultText = document.getElementById('resultText');
const $doneBtn = document.getElementById('doneBtn');

// 層・行・列から中心位置と大きさ（盤を 100 としたときの%）を計算する。
// 上の層ほど下 4 つの真ん中に少し大きく重なって見える。
function ballGeom(layer, r, c) {
  const cx = (c + (layer + 1) / 2) / 4 * 100;
  const cy = (r + (layer + 1) / 2) / 4 * 100;
  const size = (0.60 + layer * 0.07) / 4 * 100;
  return { cx, cy, size };
}

let liftableSet = new Set();
let movableSet = new Set();

function render() {
  const myTurn = !vsCpu || state.turn !== cpuSide;
  liftableSet = new Set(ui.phase === 'retrieve' ? liftableNow() : []);
  movableSet = new Set(ui.phase === 'play' ? movableOwnBalls() : []);
  $handTop.textContent = E.handOf(state, 1);
  $handBottom.textContent = E.handOf(state, 0);
  $turnLabel.textContent = state.winner != null ? '' :
    (vsCpu ? (state.turn === cpuSide ? 'CPU の番' : 'あなたの番') : (state.turn === 0 ? 'プレイヤー1の番' : 'プレイヤー2の番'));

  const occ = E.occOf(state);
  let html = '';
  for (let i = 0; i < 30; i++) {
    const has = occ & bit(i);
    if (!has) continue;
    const layer = E.layerOf(i), r = E.rowOf(i), c = E.colOf(i);
    const { cx, cy, size } = ballGeom(layer, r, c);
    const color = state.white & bit(i) ? 'white' : 'black';
    const classes = ['ball', color];
    if (ui.sel === i) classes.push('sel');
    if (myTurn && ui.phase === 'retrieve' && liftableSet.has(i)) classes.push('liftable');
    else if (myTurn && ui.phase === 'play' && movableSet.has(i)) classes.push('movable');
    html += `<div class="${classes.join(' ')}" style="left:${cx}%;top:${cy}%;width:${size}%;height:${size}%;z-index:${layer + 1}" data-i="${i}"></div>`;
  }
  // 置ける/動かせる先の薄い印
  if (myTurn && state.winner == null) {
    const slots = ui.phase === 'play' ? (ui.sel != null ? legalDestinationsFrom(ui.sel) : legalPlacements()) : [];
    for (const i of slots) {
      const layer = E.layerOf(i), r = E.rowOf(i), c = E.colOf(i);
      const { cx, cy, size } = ballGeom(layer, r, c);
      html += `<div class="slot" style="left:${cx}%;top:${cy}%;width:${size}%;height:${size}%;z-index:${layer + 1}" data-slot="${i}"></div>`;
    }
  }
  $pyramid.innerHTML = html;

  $doneBtn.hidden = !(myTurn && ui.phase === 'retrieve');
  if (ui.phase === 'retrieve') {
    $hint.textContent = `正方形ができた。取り戻す玉を選ぶ（残り${2 - ui.removedCount}個まで）`;
  } else if (!myTurn) {
    $hint.textContent = '';
  } else if (ui.sel != null) {
    $hint.textContent = '行き先をタップ（もう一度タップで取り消し）';
  } else {
    $hint.textContent = '空きをタップして置く／自分の玉をタップして動かす';
  }

  if (state.winner != null) {
    $resultText.textContent = vsCpu
      ? (state.winner === cpuSide ? 'CPU の勝ち' : 'あなたの勝ち！')
      : `プレイヤー${state.winner + 1}の勝ち！`;
    $result.hidden = false;
  } else {
    $result.hidden = true;
  }
}

// ---- 操作 ----

$pyramid.addEventListener('click', (e) => {
  if (!state || state.winner != null) return;
  const myTurn = !vsCpu || state.turn !== cpuSide;
  if (!myTurn) return;

  if (ui.phase === 'retrieve') {
    const el = e.target.closest('[data-i]');
    if (!el) return;
    const i = Number(el.dataset.i);
    if (liftableSet.has(i)) retrieveTap(i);
    return;
  }

  const slotEl = e.target.closest('[data-slot]');
  const ballEl = e.target.closest('[data-i]');
  if (slotEl) {
    const to = Number(slotEl.dataset.slot);
    if (ui.sel != null) commit({ kind: 'move', from: ui.sel, to });
    else commit({ kind: 'place', to });
  } else if (ballEl) {
    const i = Number(ballEl.dataset.i);
    if (!movableSet.has(i)) return;
    ui.sel = ui.sel === i ? null : i;
    render();
  }
});

$doneBtn.addEventListener('click', () => finalizeTurn());

document.querySelectorAll('[data-side]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-side]').forEach((b) => b.classList.toggle('is-on', b === btn));
    cpuSide = btn.dataset.side === '0' ? 1 : 0;
  });
});
document.querySelectorAll('[data-diff]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-diff]').forEach((b) => b.classList.toggle('is-on', b === btn));
    difficulty = btn.dataset.diff;
  });
});
document.querySelectorAll('[data-start]').forEach((btn) => {
  btn.addEventListener('click', () => {
    vsCpu = btn.dataset.start === 'cpu';
    $start.hidden = true;
    $game.hidden = false;
    $result.hidden = true;
    newGame();
  });
});
document.getElementById('againBtn').addEventListener('click', () => newGame());

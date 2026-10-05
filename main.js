import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// 試作のため、設定・効果音・共有の中身・対局記録は足さない（webapp-kit のボタンだけ標準で入っている）。
WebAppKit.init({ title: 'pylos', text: '試作 ピロス（ボードゲーム）。4段のピラミッド型の盤に玉を積み、正方形を作って玉を取り戻し、頂上を取るか相手を手詰まりにしたら勝ち。' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// ---- ここからアプリ本体（ルール部分は engine.js のまま。ここでは手番の進行と画面だけ） ----

const E = PylosEngine;

// state: engine のゲーム状態（white/black ビットボード・turn・winner）。null ならタイトル画面。
// ui: 画面だけが持つ、手番の途中経過（選択中の玉・取り戻し中かどうか・今回取った数）。
let state = null;
let ui = null;
let vsCpu = true;
let cpuSide = 1;      // CPU がどちらの色か（0 白 / 1 黒）
let difficulty = 'weak';
let worker = null;
let thinking = false;

function bit(i) { return 1 << i; }

function newGame() {
  state = E.initState();
  ui = { sel: null, phase: 'play', removedCount: 0 };
  thinking = false;
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
  thinking = true;
  render();
  if (!worker) worker = new Worker('./worker.js');
  worker.onmessage = (e) => {
    thinking = false;
    const m = e.data.move;
    if (m) state = E.applyMove(state, m);
    render();
  };
  worker.postMessage({ state: E.cloneState(state), difficulty });
}

// ---- 3D の盤（three.js）。ドラッグで回す、タップで置く・動かす・取り戻す ----

const canvas = document.createElement('canvas');
canvas.className = 'board3d__canvas';
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
camera.position.set(0, 6.4, 5.8);
const controls = new OrbitControls(camera, canvas);
controls.enablePan = false;
controls.minDistance = 4;
controls.maxDistance = 14;
controls.maxPolarAngle = Math.PI / 2 - 0.05; // 盤の下にはもぐらない
controls.target.set(0, 0.8, 0);
controls.update();
controls.addEventListener('change', draw);

// 影は付けない。環境光（RoomEnvironment）と弱い向きの光で質感を出す
scene.add(new THREE.HemisphereLight(0xfff4e0, 0x3a2e24, 0.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(3, 8, 4);
scene.add(sun);

// 木目（灰色の濃淡）。色はマテリアルの color で付ける。上下・左右につながるように周期を整数にする
function woodTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const t = (y + 9 * Math.sin((2 * Math.PI * x) / S * 2) + 3 * Math.sin((2 * Math.PI * x) / S * 7)) / S;
      const ring = Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * t * 14), 6);
      const v = 255 * (0.9 - 0.16 * ring + (Math.random() - 0.5) * 0.05);
      const p = (y * S + x) * 4;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
      img.data[p + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}
const GRAIN = woodTexture();
const wood = (color, o = {}) => new THREE.MeshPhysicalMaterial({
  color, map: GRAIN, roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.35, envMapIntensity: 0.7, side: THREE.DoubleSide, ...o,
});

const board = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.36, 4.8), wood(0x6a4329, { clearcoat: 0.5 }));
board.position.y = -0.18;
scene.add(board);

// 層・行・列から 3D の位置を求める。層0 を基準に、1 つ上の層ほど下 4 個の真ん中へ半マス寄る。
const BALL_R = 0.42;
// 上下の層が触れ合う高さ（半マス寄った分の水平距離と球の直径からピタゴラスで求める）
const H_STEP = Math.sqrt((2 * BALL_R) ** 2 - 0.5);
function cellWorldPos(i) {
  const layer = E.layerOf(i), r = E.rowOf(i), c = E.colOf(i), size = E.SIZE[layer];
  return { x: c - (size - 1) / 2, y: BALL_R + layer * H_STEP, z: r - (size - 1) / 2 };
}

// 層0 の 16 個は、盤に窪み（溝）を掘って玉の置き場所を示す
const CELL_COLOR = { base: 0x4a2e1c, open: 0xb08a3a };
const cellGeo = new THREE.CircleGeometry(0.42, 40);
const grooveGeo = new THREE.RingGeometry(0.42, 0.47, 40);
const GROOVE = new THREE.MeshStandardMaterial({ color: 0x24160d, roughness: 0.9 });
const cellMeshes = [...Array(16).keys()].map((i) => {
  const m = new THREE.Mesh(cellGeo, wood(CELL_COLOR.base, { roughness: 0.7, clearcoat: 0 }));
  m.rotation.x = -Math.PI / 2;
  const { x, z } = cellWorldPos(i);
  m.position.set(x, 0.004, z);
  const ring = new THREE.Mesh(grooveGeo, GROOVE);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.003, z);
  scene.add(m, ring);
  return m;
});

const WOOD = [wood(0xead3a8), wood(0x5a3820)]; // 白(明るい木) / 黒(暗い木)
const ballGeo = new THREE.SphereGeometry(BALL_R, 32, 24);
const ringGeo = new THREE.RingGeometry(BALL_R * 1.05, BALL_R * 1.3, 32);
const RING_COLOR = { sel: 0xffd35c, liftable: 0x78dc8c, movable: 0xffffff };

function pieceMesh(colorIdx) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(ballGeo, WOOD[colorIdx]));
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: RING_COLOR.movable, transparent: true, opacity: 0, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -BALL_R + 0.01;
  ring.visible = false;
  g.add(ring);
  g.userData.ring = ring;
  return g;
}

const SLOT_MAT = new THREE.MeshBasicMaterial({ color: 0xffd35c, transparent: true, opacity: 0.35, side: THREE.DoubleSide });
const slotGeo = new THREE.CircleGeometry(BALL_R * 0.85, 32);
let slotMeshes = [];

const ballMeshes = new Map(); // マス番号 → コマのグループ
let liftableSet = new Set();
let movableSet = new Set();

function syncScene() {
  const occ = E.occOf(state);
  for (let i = 0; i < 30; i++) {
    const has = occ & bit(i);
    if (has && !ballMeshes.has(i)) {
      const colorIdx = state.white & bit(i) ? 0 : 1;
      const m = pieceMesh(colorIdx);
      const { x, y, z } = cellWorldPos(i);
      m.position.set(x, y, z);
      m.traverse((o) => { o.userData.cell = i; o.userData.kind = 'ball'; });
      scene.add(m);
      ballMeshes.set(i, m);
    } else if (!has && ballMeshes.has(i)) {
      scene.remove(ballMeshes.get(i));
      ballMeshes.delete(i);
    }
  }

  const myTurn = !vsCpu || state.turn !== cpuSide;
  ballMeshes.forEach((m, i) => {
    const ring = m.userData.ring;
    if (myTurn && ui.phase === 'retrieve' && liftableSet.has(i)) {
      ring.visible = true; ring.material.color.setHex(RING_COLOR.liftable); ring.material.opacity = 0.9;
    } else if (ui.sel === i) {
      ring.visible = true; ring.material.color.setHex(RING_COLOR.sel); ring.material.opacity = 0.9;
    } else if (myTurn && ui.phase === 'play' && movableSet.has(i)) {
      ring.visible = true; ring.material.color.setHex(RING_COLOR.movable); ring.material.opacity = 0.25;
    } else {
      ring.visible = false;
    }
  });

  slotMeshes.forEach((m) => scene.remove(m));
  slotMeshes = [];
  if (myTurn && state.winner == null) {
    const slots = ui.phase === 'play' ? (ui.sel != null ? legalDestinationsFrom(ui.sel) : legalPlacements()) : [];
    for (const i of slots) {
      const { x, y, z } = cellWorldPos(i);
      const m = new THREE.Mesh(slotGeo, SLOT_MAT);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, y - BALL_R + 0.01, z);
      m.userData.cell = i;
      m.userData.kind = 'slot';
      scene.add(m);
      slotMeshes.push(m);
    }
  }
  draw();
}

function draw() { renderer.render(scene, camera); }
new ResizeObserver(() => {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // 縦長の画面でも盤の横が切れないように、縦の画角を広げる
  camera.fov = w < h ? (2 * Math.atan(Math.tan((19 * Math.PI) / 180) * (h / w)) * 180) / Math.PI : 38;
  camera.updateProjectionMatrix();
  draw();
}).observe(canvas);

// 動かさずに離したらタップ（ドラッグは回転）
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
  downAt = null;
  onTap(e);
});

function onTap(e) {
  if (!state || state.winner != null) return;
  const myTurn = !vsCpu || state.turn !== cpuSide;
  if (!myTurn) return;
  const r = canvas.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObjects([...slotMeshes, ...[...ballMeshes.values()]], true)[0];
  if (!hit) return;
  const { cell, kind } = hit.object.userData;

  if (ui.phase === 'retrieve') {
    if (kind === 'ball' && liftableSet.has(cell)) retrieveTap(cell);
    return;
  }
  if (kind === 'slot') {
    if (ui.sel != null) commit({ kind: 'move', from: ui.sel, to: cell });
    else commit({ kind: 'place', to: cell });
  } else if (kind === 'ball') {
    if (!movableSet.has(cell)) return;
    ui.sel = ui.sel === cell ? null : cell;
    render();
  }
}

// ---- 画面 ----

function render() {
  const stage = document.getElementById('stage');
  if (!state) { stage.innerHTML = titleHTML(); bindTitle(); return; }

  const myTurn = !vsCpu || state.turn !== cpuSide;
  liftableSet = new Set(ui.phase === 'retrieve' ? liftableNow() : []);
  movableSet = new Set(ui.phase === 'play' ? movableOwnBalls() : []);

  stage.innerHTML = gameHTML(myTurn);
  document.getElementById('board3d').appendChild(canvas);
  syncScene();
  bindGame();
}

function titleHTML() {
  return `
    <div class="title">
      <h2>pylos</h2>
      <p class="hint">正方形を作って玉を取り戻し、頂上を取るか相手を手詰まりにする</p>
      <div class="choice" id="startSide">
        <span class="choice__label">先手・後手</span>
        <button class="chip${cpuSide === 1 ? ' is-on' : ''}" data-side="0">自分が先手</button>
        <button class="chip${cpuSide === 0 ? ' is-on' : ''}" data-side="1">自分が後手</button>
      </div>
      <div class="choice" id="startDiff">
        <span class="choice__label">CPU の強さ</span>
        <button class="chip${difficulty === 'weak' ? ' is-on' : ''}" data-diff="weak">よわい</button>
        <button class="chip${difficulty === 'normal' ? ' is-on' : ''}" data-diff="normal">ふつう</button>
        <button class="chip${difficulty === 'strong' ? ' is-on' : ''}" data-diff="strong">つよい</button>
        <button class="chip${difficulty === 'strongest' ? ' is-on' : ''}" data-diff="strongest">さいきょう</button>
      </div>
      <button class="pill pill--big" data-start="cpu">CPU と対戦</button>
      <button class="pill pill--big" data-start="pvp">2人で対戦（同じ端末）</button>
    </div>`;
}
function bindTitle() {
  document.querySelectorAll('[data-side]').forEach((btn) => {
    btn.addEventListener('click', () => {
      cpuSide = btn.dataset.side === '0' ? 1 : 0;
      render();
    });
  });
  document.querySelectorAll('[data-diff]').forEach((btn) => {
    btn.addEventListener('click', () => {
      difficulty = btn.dataset.diff;
      render();
    });
  });
  document.querySelectorAll('[data-start]').forEach((btn) => {
    btn.addEventListener('click', () => { vsCpu = btn.dataset.start === 'cpu'; newGame(); });
  });
}

function gameHTML(myTurn) {
  let status;
  if (state.winner != null) {
    status = vsCpu
      ? (state.winner === cpuSide ? 'CPU の勝ち' : 'あなたの勝ち！')
      : `プレイヤー${state.winner + 1}の勝ち！`;
  } else if (thinking) {
    status = 'CPU が考え中…';
  } else {
    const turnLabel = vsCpu ? (state.turn === cpuSide ? 'CPU' : 'あなた') : `プレイヤー${state.turn + 1}`;
    status = ui.phase === 'retrieve'
      ? `${turnLabel} の番：正方形ができた。光っている玉をタップで取り戻す（残り${2 - ui.removedCount}個まで）`
      : `${turnLabel} の番：${myTurn ? (ui.sel != null ? '行き先をタップ（もう一度タップで取り消し）' : '空きをタップして置く／自分の玉をタップして動かす') : ''}`;
  }

  const done = (myTurn && ui.phase === 'retrieve' && state.winner == null)
    ? `<button class="pill pill--big" id="doneBtn">おわり（これ以上は取らない）</button>` : '';
  const again = state.winner != null
    ? `<div class="result"><button class="pill pill--big" data-again>もう一度</button><button class="pill" data-title>モードを選び直す</button></div>` : '';

  return `
    <div class="game">
      <div class="info">
        <span>手持ち <b>${E.handOf(state, 0)}</b>（白）</span>
        <span>手持ち <b>${E.handOf(state, 1)}</b>（黒）</span>
      </div>
      <p class="status">${status}</p>
      <div class="board3d" id="board3d"></div>
      <p class="hint">ドラッグで回す・ピンチで寄る</p>
      ${done}
      ${again}
    </div>`;
}

function bindGame() {
  const doneBtn = document.getElementById('doneBtn');
  if (doneBtn) doneBtn.addEventListener('click', () => finalizeTurn());
  const again = document.querySelector('[data-again]');
  if (again) again.addEventListener('click', () => newGame());
  const title = document.querySelector('[data-title]');
  if (title) title.addEventListener('click', () => { state = null; render(); });
}

render();

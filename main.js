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
let watching = false; // 観戦中（両方の手番を CPU が打つ）
let difficulty = 'weak';
let worker = null;
let thinking = false;

function isCpuTurn() { return watching || (vsCpu && state.turn === cpuSide); }
function playerLabel(p) {
  if (watching) return p === 0 ? 'CPU 1' : 'CPU 2';
  if (vsCpu) return p === cpuSide ? 'CPU' : 'あなた';
  return `プレイヤー${p + 1}`;
}

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
  if (action.kind === 'move') { state[color] &= ~bit(action.from); moveFrom = action.from; }
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
  if (state.winner != null || !isCpuTurn()) return;
  const game = state; // 観戦をやめた・やり直したあとに古い答えが届いても使わない
  const wait = watching ? 900 : 0; // 観戦中は、目で追えるようにひと呼吸あける
  if (difficulty === 'weak' || difficulty === 'normal') {
    const run = () => {
      if (state !== game) return;
      const m = E.pickByDifficulty(state, difficulty);
      if (m) { state = E.applyMove(state, m); moveFrom = m.from ?? null; }
      render();
      maybeCpuTurn(); // 観戦中は、次も CPU の番なら続けて打つ
    };
    if (wait) setTimeout(run, wait); else run();
    return;
  }
  thinking = true;
  render();
  if (!worker) worker = new Worker('./worker.js');
  worker.onmessage = (e) => {
    if (state !== game) return;
    thinking = false;
    const m = e.data.move;
    const apply = () => {
      if (state !== game) return;
      if (m) { state = E.applyMove(state, m); moveFrom = m.from ?? null; }
      render();
      maybeCpuTurn();
    };
    if (wait) setTimeout(apply, wait); else apply();
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
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 2000);
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

// 玉は直径 1（マスの間隔と同じ）なので、隣どうし・上下の層どうしがぴったり触れ合う
const BALL_R = 0.5;
// 層0 の 16 マスは、盤に玉と同じ半径の球面の窪みを DIMPLE の深さで掘る。玉はその窪みにはまる
const DIMPLE = 0.16;
const DIMPLE_RIM = Math.sqrt(BALL_R ** 2 - (BALL_R - DIMPLE) ** 2);
// 盤の上面を細かく割り、マスの近くの頂点を球面に沿って下げる
const boardGeo = new THREE.BoxGeometry(4.8, 0.36, 4.8, 192, 1, 192);
{
  const pos = boardGeo.attributes.position;
  for (let k = 0; k < pos.count; k++) {
    if (pos.getY(k) < 0.17) continue;
    const x = pos.getX(k), z = pos.getZ(k);
    const cx = Math.min(3, Math.max(0, Math.round(x + 1.5))) - 1.5;
    const cz = Math.min(3, Math.max(0, Math.round(z + 1.5))) - 1.5;
    const rho = Math.hypot(x - cx, z - cz);
    if (rho < DIMPLE_RIM) pos.setY(k, pos.getY(k) - (Math.sqrt(BALL_R ** 2 - rho ** 2) - (BALL_R - DIMPLE)));
  }
  boardGeo.computeVertexNormals();
}
const board = new THREE.Mesh(boardGeo, wood(0x6a4329, { clearcoat: 0.5 }));
board.position.y = -0.18;
scene.add(board);

const DESK = new THREE.Group(); // 机の天板と盤の影。ホームでは消す
scene.add(DESK);
// ---- 机の天板。盤の下に木の板を敷き、地平線まで続ける ----
{
  const box = new THREE.Box3().setFromObject(board);
  const w = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
  const S = 1024, PLANK = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  ['#4b3121', '#432b1c', '#503524', '#472f1f'].forEach((col, i) => {
    for (let y = i * PLANK; y < S; y += PLANK * 4) {
      g.save();
      g.beginPath(); g.rect(0, y, S, PLANK); g.clip();
      g.fillStyle = col; g.fillRect(0, y, S, PLANK);
      for (let k = 0; k < 36; k++) { // 木目の線
        const y0 = y + Math.random() * PLANK, a = 2 + Math.random() * 4, f = 60 + Math.random() * 120;
        g.strokeStyle = `rgba(24, 12, 4, ${0.06 + Math.random() * 0.14})`;
        g.lineWidth = 0.5 + Math.random() * 2;
        g.beginPath();
        for (let x = 0; x <= S; x += 16) g.lineTo(x, y0 + a * Math.sin(x / f + k));
        g.stroke();
      }
      g.restore();
      g.fillStyle = 'rgba(0, 0, 0, 0.45)'; g.fillRect(0, y, S, 2); // 板のすき間
    }
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const FAR = 1500; // 地平線まで続いて見える広さ
  tex.repeat.set(FAR / (w * 3.2), FAR / (w * 3.2));
  const table = new THREE.Mesh(new THREE.PlaneGeometry(FAR, FAR),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, envMapIntensity: 0.4 }));
  table.rotation.x = -Math.PI / 2;
  table.position.y = box.min.y - 0.01;
  table.renderOrder = -1;
  DESK.add(table);
  // 盤の落とす影
  const sc = document.createElement('canvas');
  sc.width = sc.height = 256;
  const sg = sc.getContext('2d');
  const shade = sg.createRadialGradient(128, 128, 0, 128, 128, 128 * 0.48);
  shade.addColorStop(0, 'rgba(0, 0, 0, 0.55)'); shade.addColorStop(0.55, 'rgba(0, 0, 0, 0.4)'); shade.addColorStop(1, 'rgba(0, 0, 0, 0)');
  sg.fillStyle = shade; sg.fillRect(0, 0, 256, 256);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(w * 3.2, w * 3.2),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = box.min.y - 0.005;
  DESK.add(shadow);
}

// ホーム画面では盤を斜め上からの向きで止め、机を消して宙に浮かべる。対局に入ったら机を戻す
{
  const HOME_CAM = camera.position.clone();
  let wasHome = false;
  const watch = () => {
    const home = !!canvas.offsetParent && !!canvas.closest('.title, #homeBoard');
    if (home !== wasHome) {
      DESK.visible = controls.enabled = !home;
      camera.position.copy(HOME_CAM); controls.update(); draw();
      wasHome = home;
    }
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
}

// 層・行・列から 3D の位置を求める。層0 を基準に、1 つ上の層ほど下 4 個の真ん中へ半マス寄る。
// 上下の層が触れ合う高さ（半マス寄った分の水平距離と球の直径からピタゴラスで求める）
const H_STEP = Math.sqrt((2 * BALL_R) ** 2 - 0.5);
function cellWorldPos(i) {
  const layer = E.layerOf(i), r = E.rowOf(i), c = E.colOf(i), size = E.SIZE[layer];
  return { x: c - (size - 1) / 2, y: BALL_R - DIMPLE + layer * H_STEP, z: r - (size - 1) / 2 };
}

const WOOD = [wood(0xead3a8), wood(0x5a3820)]; // 白(明るい木) / 黒(暗い木)
const ballGeo = new THREE.SphereGeometry(BALL_R, 40, 28);
// 操作できる玉は、色をにじませて示す（玉どうしが触れているので足元の輪は隠れて見えない）
const GLOW = { sel: [0xffd35c, 0.55], liftable: [0x78dc8c, 0.5], movable: [0xffffff, 0.12] };

function pieceMesh(colorIdx) {
  const m = new THREE.Mesh(ballGeo, WOOD[colorIdx].clone());
  m.material.emissive = new THREE.Color(0);
  return m;
}

// 置ける場所は、半透明の玉で示す
const SLOT_MAT = new THREE.MeshBasicMaterial({ color: 0xffd35c, transparent: true, opacity: 0.32, depthWrite: false });
let slotMeshes = [];

const ballMeshes = new Map(); // マス番号 → コマ
let liftableSet = new Set();
let movableSet = new Set();

// ---- 動き。置いた玉は落ちて弾み、動かした玉は弧を描いて移り、取り戻した玉は持ち上がって消える ----
const GRAVITY = 30;      // 重力の強さ（1 マス = 1 として）
const RESTITUTION = 0.3; // 弾むときに残る速さの割合
const anims = new Set();
let lastSynced = null;
let moveFrom = null; // 直前の手で動かした玉の元のマス（動きの見分けに使う）
let animating = false;
function tick() {
  const now = performance.now();
  for (const a of anims) if (a.step(now)) anims.delete(a);
  draw();
  if (anims.size) requestAnimationFrame(tick); else animating = false;
}
function animate(a) {
  anims.add(a);
  if (!animating) { animating = true; requestAnimationFrame(tick); }
}
// 着地の弾み。v0 の下向きの速さで target に届いたところから、弾みが小さくなるまで
function bounce(m, target, v0, t0) {
  let y = target, v = v0 * RESTITUTION, last = t0;
  return (now) => {
    const dt = Math.min(0.033, (now - last) / 1000); last = now;
    v -= GRAVITY * dt; y += v * dt;
    if (y <= target) { y = target; v = -v * RESTITUTION; if (v < 0.4) { m.position.y = target; return true; } }
    m.position.y = y;
    return false;
  };
}
function dropIn(m, to) {
  const h = 2.2, t0 = performance.now(), T = Math.sqrt((2 * h) / GRAVITY);
  m.position.set(to.x, to.y + h, to.z);
  let land = null;
  animate({ step(now) {
    if (land) return land(now);
    const t = (now - t0) / 1000;
    if (t < T) { m.position.y = to.y + h - 0.5 * GRAVITY * t * t; return false; }
    land = bounce(m, to.y, GRAVITY * T, now);
    return land(now);
  } });
}
function moveArc(m, from, to) {
  const t0 = performance.now(), T = 0.55, lift = 1.2 + Math.max(0, to.y - from.y);
  let land = null;
  animate({ step(now) {
    if (land) return land(now);
    const u = Math.min(1, (now - t0) / 1000 / T);
    m.position.set(from.x + (to.x - from.x) * u, from.y + (to.y - from.y) * u + lift * 4 * u * (1 - u), from.z + (to.z - from.z) * u);
    if (u < 1) return false;
    land = bounce(m, to.y, (4 * lift) / T, now); // 弧の終わりの下向きの速さで着地する
    return land(now);
  } });
}
function liftOut(m) {
  const t0 = performance.now(), y0 = m.position.y;
  m.material.transparent = true;
  animate({ step(now) {
    const u = Math.min(1, (now - t0) / 450);
    m.position.y = y0 + 1.6 * u * u;
    m.material.opacity = 1 - u;
    if (u < 1) return false;
    scene.remove(m);
    return true;
  } });
}

// s: 映す局面（タイトル画面では見本の局面 DEMO）。操作の印は対局中の自分の番だけ出す
function syncScene(s = state) {
  // 対局の続きのときだけ動かす（見本と対局の切り替えでは動かさない）
  const live = s !== DEMO && lastSynced != null && lastSynced !== DEMO;
  lastSynced = s;
  const occ = E.occOf(s);
  const gone = [], added = [];
  for (let i = 0; i < 30; i++) {
    const has = occ & bit(i);
    const colorIdx = s.white & bit(i) ? 0 : 1;
    // 見本と対局を行き来すると同じマスで色が変わるので、そのときは作り直す
    if (has && ballMeshes.has(i) && ballMeshes.get(i).userData.color !== colorIdx) {
      scene.remove(ballMeshes.get(i));
      ballMeshes.delete(i);
    }
    if (has && !ballMeshes.has(i)) {
      const m = pieceMesh(colorIdx);
      m.userData = { color: colorIdx, cell: i, kind: 'ball' };
      const to = cellWorldPos(i);
      m.position.set(to.x, to.y, to.z);
      scene.add(m);
      ballMeshes.set(i, m);
      added.push(m);
    } else if (!has && ballMeshes.has(i)) {
      gone.push(ballMeshes.get(i));
      ballMeshes.delete(i);
    }
  }
  if (live) {
    for (const m of added) {
      const k = gone.findIndex((g) => g.userData.cell === moveFrom);
      const to = cellWorldPos(m.userData.cell);
      if (k >= 0) {
        const [g] = gone.splice(k, 1);
        scene.remove(g);
        moveArc(m, g.position.clone(), to);
      } else dropIn(m, to);
    }
    gone.forEach(liftOut);
  } else gone.forEach((g) => scene.remove(g));
  moveFrom = null;

  const myTurn = s === state && !isCpuTurn();
  ballMeshes.forEach((m, i) => {
    let glow = null;
    if (myTurn && ui.phase === 'retrieve' && liftableSet.has(i)) glow = GLOW.liftable;
    else if (myTurn && ui.sel === i) glow = GLOW.sel;
    else if (myTurn && ui.phase === 'play' && movableSet.has(i)) glow = GLOW.movable;
    m.material.emissive.setHex(glow ? glow[0] : 0);
    m.material.emissiveIntensity = glow ? glow[1] : 0;
  });

  slotMeshes.forEach((m) => scene.remove(m));
  slotMeshes = [];
  if (myTurn && s.winner == null) {
    const slots = ui.phase === 'play' ? (ui.sel != null ? legalDestinationsFrom(ui.sel) : legalPlacements()) : [];
    for (const i of slots) {
      const { x, y, z } = cellWorldPos(i);
      const m = new THREE.Mesh(ballGeo, SLOT_MAT);
      m.scale.setScalar(0.92);
      m.position.set(x, y, z);
      m.userData = { cell: i, kind: 'slot' };
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
  const myTurn = !isCpuTurn();
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
  if (!state) {
    stage.innerHTML = titleHTML();
    document.getElementById('board3d').appendChild(canvas);
    syncScene(DEMO);
    bindTitle();
    return;
  }

  const myTurn = !isCpuTurn();
  liftableSet = new Set(ui.phase === 'retrieve' ? liftableNow() : []);
  movableSet = new Set(ui.phase === 'play' ? movableOwnBalls() : []);

  stage.innerHTML = gameHTML(myTurn);
  document.getElementById('board3d').appendChild(canvas);
  syncScene();
  bindGame();
}

// タイトル画面に出す見本の局面（1 段目が埋まり、2 段目を積みはじめたところ）
const DEMO = (() => {
  const s = E.initState();
  [0, 2, 5, 7, 8, 10, 13, 15, 16, 20].forEach((i) => { s.white |= bit(i); });
  [1, 3, 4, 6, 9, 11, 12, 14, 18].forEach((i) => { s.black |= bit(i); });
  return s;
})();

function titleHTML() {
  return `
    <div class="title">
      <h2>pylos</h2>
      <p class="hint">正方形を作って玉を取り戻し、頂上を取るか相手を手詰まりにする</p>
      <div class="preview">
        <div class="info">
          <span>手持ち <b>${E.handOf(DEMO, 0)}</b>（白）</span>
          <span>手持ち <b>${E.handOf(DEMO, 1)}</b>（黒）</span>
        </div>
        <div class="board3d" id="board3d"></div>
      </div>
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
      <button class="pill pill--big" data-start="watch">CPU 同士の対戦を見る</button>
      ${rulesHTML()}
    </div>`;
}

// ---- ルール説明の図 ----
const FU = 24; // 図の 1 マスの大きさ
function figBall(x, y, k) {
  return `<circle class="fig__${k}" cx="${x}" cy="${y}" r="${FU * 0.45}"/>`;
}
// 上から見た盤。n: 見せるマスの数（n×n）。balls: [段, 行, 列, 種類]。種類は w 白 / b 黒 / slot 置ける所 / lock 動かせない印。
// arrow: [[段, 行, 列], [段, 行, 列]] を結ぶ矢印。
function figTop(n, balls, arrow) {
  const pos = (l, r, c) => [4 + (c + 0.5 + l * 0.5) * FU, 4 + (r + 0.5 + l * 0.5) * FU];
  const w = n * FU + 8;
  let svg = `<rect class="fig__board" width="${w}" height="${w}" rx="6"/>`;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) svg += `<circle class="fig__hole" cx="${pos(0, r, c)[0]}" cy="${pos(0, r, c)[1]}" r="${FU * 0.3}"/>`;
  svg += balls.map(([l, r, c, k]) => figBall(...pos(l, r, c), k)).join('');
  if (arrow) {
    const [a, b] = arrow.map((p) => pos(...p));
    svg += `<line class="fig__arrow" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" marker-end="url(#figArrow)"/>`;
  }
  return `<svg class="fig" viewBox="0 0 ${w} ${w}" width="${w * 1.5}" aria-hidden="true">${svg}</svg>`;
}
// 横から見た盤。balls: [段, 列, 種類]。
function figSide(n, balls) {
  const w = n * FU + 8, h = 4 * FU * 0.8 + 18;
  const pos = (l, c) => [4 + (c + 0.5 + l * 0.5) * FU, h - 10 - FU * 0.45 - l * FU * 0.8];
  let svg = `<rect class="fig__board" y="${h - 10}" width="${w}" height="10" rx="3"/>`;
  svg += balls.map(([l, c, k]) => figBall(...pos(l, c), k)).join('');
  return `<svg class="fig" viewBox="0 0 ${w} ${h}" width="${w * 1.5}" aria-hidden="true">${svg}</svg>`;
}
function figItem(svg, text) {
  return `<figure class="figs__item">${svg}<figcaption>${text}</figcaption></figure>`;
}

function rulesHTML() {
  const pyramid = [];
  for (let l = 0; l < 4; l++) for (let c = 0; c < 4 - l; c++) pyramid.push([l, c, l === 3 ? 'top' : 'slot']);
  return `
    <details class="rules">
      <summary>ルール</summary>
      <svg width="0" height="0" style="position:absolute"><defs><marker id="figArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z" fill="#ffd35c"/></marker></defs></svg>
      <h3>1. 盤と玉</h3>
      <div class="figs">
        ${figItem(figSide(4, pyramid), '4×4 の上に 3×3、2×2、頂上の 1 マスと積む 4 段のピラミッド。玉は白・黒 15 個ずつ。白が先手')}
      </div>
      <h3>2. 置く</h3>
      <div class="figs">
        ${figItem(figTop(2, [[0, 0, 0, 'w'], [0, 0, 1, 'b'], [0, 1, 0, 'b'], [0, 1, 1, 'w'], [1, 0, 0, 'slot']]), '自分の番に手持ちの玉を 1 個置く。2 段目からは、下の 4 つがそろった真ん中に置ける（色は関係ない）')}
      </div>
      <h3>3. 正方形で取り戻す</h3>
      <div class="figs">
        ${figItem(figTop(2, [[0, 0, 0, 'w'], [0, 0, 1, 'w'], [0, 1, 0, 'w'], [0, 1, 1, 'w']]), '○ 自分の色だけで 2×2 の正方形を作ったら、自分の玉を 1〜2 個盤から取って手持ちに戻せる（取らなくてもよい）')}
        ${figItem(figTop(2, [[0, 0, 0, 'w'], [0, 0, 1, 'w'], [0, 1, 0, 'b'], [0, 1, 1, 'w']]), '× 色が混ざると正方形にならない')}
      </div>
      <h3>4. 上の段へ動かす</h3>
      <div class="figs">
        ${figItem(figTop(3, [[0, 0, 0, 'b'], [0, 0, 1, 'w'], [0, 1, 0, 'w'], [0, 1, 1, 'b'], [0, 2, 2, 'w'], [1, 0, 0, 'slot']], [[0, 2, 2], [1, 0, 0]]), '置く代わりに、盤の上の自分の玉を 1 段以上上へ動かしてもよい。手持ちが 1 個浮く')}
      </div>
      <h3>5. 支えている玉は動かせない</h3>
      <div class="figs">
        ${figItem(figSide(3, [[0, 0, 'w'], [0, 1, 'b'], [0, 2, 'w'], [1, 0, 'b'], [0, 0, 'lock'], [0, 1, 'lock']]), '上に玉が乗っている玉（赤い点線）は、動かすことも取り戻すこともできない')}
      </div>
      <h3>6. 勝ち負け</h3>
      <ul>
        <li>頂上に玉を置いた人の勝ち。</li>
        <li>自分の番に置くことも動かすこともできなくなったら負け（手持ちを使い切ると起きる）。</li>
        <li>手持ちを節約するのがコツ。正方形を作り、上へ動かして、相手より玉を残す。</li>
      </ul>
    </details>`;
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
    btn.addEventListener('click', () => {
      watching = btn.dataset.start === 'watch';
      vsCpu = btn.dataset.start === 'cpu';
      newGame();
    });
  });
}

function gameHTML(myTurn) {
  let status;
  if (state.winner != null) {
    status = `${playerLabel(state.winner)} の勝ち！`;
  } else if (thinking) {
    status = `${playerLabel(state.turn)} が考え中…`;
  } else {
    const turnLabel = playerLabel(state.turn);
    status = ui.phase === 'retrieve'
      ? `${turnLabel} の番：正方形ができた。光っている玉をタップで取り戻す（残り${2 - ui.removedCount}個まで）`
      : `${turnLabel} の番：${myTurn ? (ui.sel != null ? '行き先をタップ（もう一度タップで取り消し）' : '空きをタップして置く／自分の玉をタップして動かす') : ''}`;
  }

  const done = (myTurn && ui.phase === 'retrieve' && state.winner == null)
    ? `<button class="pill pill--big" id="doneBtn">おわり（これ以上は取らない）</button>` : '';
  const again = state.winner != null
    ? `<div class="result"><button class="pill pill--big" data-again>もう一度</button><button class="pill" data-title>モードを選び直す</button></div>`
    : '';

  return `
    <div class="game">
      ${state.winner == null ? `<button class="pill game__home" data-title>${watching ? '見るのをやめる' : 'ホームに戻る'}</button>` : ''}
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
  if (title) title.addEventListener('click', () => {
    // 対局の途中なら、押し間違いで消えないように確かめる
    if (!watching && state.winner == null && E.occOf(state) && !confirm('対局をやめてホームに戻りますか？')) return;
    state = null;
    render();
  });
}

render();

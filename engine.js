// pylos のルールと探索（純粋な JS。DOM に触れない。ブラウザからも node からも使う）。
//
// 盤は 30 マスのピラミッド。層ごとに連番を振る。
//   層0: 4x4 (0..15)   層1: 3x3 (16..24)   層2: 2x2 (25..28)   層3: 1 (29, 頂上)
// 白・黒それぞれをビットボード（30 ビットの数値）で持つ。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PylosEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIZE = [4, 3, 2, 1];
  const OFFSET = [0, 16, 25, 29];
  const TOP = 29;

  function idx(layer, r, c) { return OFFSET[layer] + r * SIZE[layer] + c; }
  function layerOf(i) { return i < 16 ? 0 : i < 25 ? 1 : i < 29 ? 2 : 3; }
  function rowOf(i) { const l = layerOf(i); return Math.floor((i - OFFSET[l]) / SIZE[l]); }
  function colOf(i) { const l = layerOf(i); return (i - OFFSET[l]) % SIZE[l]; }

  // BELOW[i]: 1 段下で i を支える 4 マス（層0 は null）。ABOVE[i]: i の上に乗りうる、i が支えるマス一覧。
  const BELOW = new Array(30).fill(null);
  const ABOVE = new Array(30).fill(null).map(() => []);
  for (let i = 0; i < 30; i++) {
    const l = layerOf(i), r = rowOf(i), c = colOf(i);
    if (l > 0) BELOW[i] = [idx(l - 1, r, c), idx(l - 1, r, c + 1), idx(l - 1, r + 1, c), idx(l - 1, r + 1, c + 1)];
  }
  for (let i = 0; i < 30; i++) {
    const l = layerOf(i), r = rowOf(i), c = colOf(i);
    if (l === 3) continue;
    const n = SIZE[l];
    for (const rr of [r - 1, r]) {
      if (rr < 0 || rr > n - 2) continue;
      for (const cc of [c - 1, c]) {
        if (cc < 0 || cc > n - 2) continue;
        ABOVE[i].push(idx(l + 1, rr, cc));
      }
    }
  }

  // 正方形の一覧（層0: 3x3=9 個、層1: 2x2=4 個、層2: 1 個）と、各マスが属する正方形の索引。
  const SQUARES = [];
  for (let l = 0; l <= 2; l++) {
    const n = SIZE[l];
    for (let r = 0; r <= n - 2; r++) {
      for (let c = 0; c <= n - 2; c++) {
        SQUARES.push([idx(l, r, c), idx(l, r, c + 1), idx(l, r + 1, c), idx(l, r + 1, c + 1)]);
      }
    }
  }
  const CELL_SQUARES = new Array(30).fill(null).map(() => []);
  SQUARES.forEach((sq, si) => sq.forEach((i) => CELL_SQUARES[i].push(si)));

  function bit(i) { return 1 << i; }
  function popcount(x) { let n = 0; while (x) { x &= x - 1; n++; } return n; }

  function canPlace(i, occ) {
    if (occ & bit(i)) return false;
    const b = BELOW[i];
    if (!b) return true;
    return b.every((k) => occ & bit(k));
  }
  // i の上に何も乗っていない（何も支えていない）か。
  function isFree(i, occ) {
    return ABOVE[i].every((k) => !(occ & bit(k)));
  }
  function squareFormedAt(i, colorBB) {
    return CELL_SQUARES[i].some((si) => SQUARES[si].every((k) => colorBB & bit(k)));
  }

  // 自分の玉で「取り戻せる組」を列挙（0 個も含む）。戻り値は取り除くビット集合の一覧（重複なし）。
  // 1 個目を取ったことで支えがなくなった玉も 2 個目に選べるので、取った後の盤で再度探す。
  function enumerateRemovals(ownBB, occ) {
    const out = new Set([0]);
    let a = ownBB;
    while (a) {
      const lsb = a & -a;
      a ^= lsb;
      const ai = Math.log2(lsb) | 0;
      if (!isFree(ai, occ)) continue;
      out.add(bit(ai));
      const occ2 = occ & ~bit(ai);
      const own2 = ownBB & ~bit(ai);
      let b = own2;
      while (b) {
        const lsb2 = b & -b;
        b ^= lsb2;
        const bi = Math.log2(lsb2) | 0;
        if (isFree(bi, occ2)) out.add(bit(ai) | bit(bi));
      }
    }
    return [...out];
  }

  function initState() {
    return { white: 0, black: 0, turn: 0, winner: null };
  }
  function cloneState(s) { return { white: s.white, black: s.black, turn: s.turn, winner: s.winner }; }
  function occOf(s) { return s.white | s.black; }
  function ownBB(s) { return s.turn === 0 ? s.white : s.black; }
  function handOf(s, player) { return 15 - popcount(player === 0 ? s.white : s.black); }

  // 手番の「置く／動かす」基本アクション一覧（取り戻しの前段階）。
  function baseActions(s) {
    const occ = occOf(s);
    const mine = ownBB(s);
    const out = [];
    if (handOf(s, s.turn) > 0) {
      for (let i = 0; i < 30; i++) if (canPlace(i, occ)) out.push({ kind: 'place', to: i });
    }
    let m = mine;
    while (m) {
      const lsb = m & -m;
      m ^= lsb;
      const from = Math.log2(lsb) | 0;
      if (!isFree(from, occ)) continue;
      const occWithout = occ & ~bit(from);
      const fl = layerOf(from);
      for (let to = OFFSET[fl + 1] || 30; to < 30; to++) {
        if (layerOf(to) <= fl) continue;
        if (canPlace(to, occWithout)) out.push({ kind: 'move', from, to });
      }
    }
    return out;
  }

  // 完全な 1 手（置く/動かす＋取り戻し）の一覧。各要素は { kind, from?, to, remove(bitmask), apply(state) }。
  function genMoves(s) {
    if (s.winner != null) return [];
    const moves = [];
    for (const act of baseActions(s)) {
      if (act.to === TOP) {
        moves.push({ ...act, remove: 0, win: true });
        continue;
      }
      const occAfter = (act.kind === 'move' ? occOf(s) & ~bit(act.from) : occOf(s)) | bit(act.to);
      const mineAfter = (act.kind === 'move' ? ownBB(s) & ~bit(act.from) : ownBB(s)) | bit(act.to);
      if (squareFormedAt(act.to, mineAfter)) {
        for (const rm of enumerateRemovals(mineAfter, occAfter)) {
          moves.push({ ...act, remove: rm, win: false });
        }
      } else {
        moves.push({ ...act, remove: 0, win: false });
      }
    }
    return moves;
  }

  function applyMove(s, m) {
    const ns = cloneState(s);
    const color = s.turn === 0 ? 'white' : 'black';
    if (m.kind === 'move') ns[color] &= ~bit(m.from);
    ns[color] |= bit(m.to);
    if (m.remove) ns[color] &= ~m.remove;
    if (m.win || m.to === TOP) {
      ns.winner = s.turn;
    } else {
      ns.turn = 1 - s.turn;
      if (genMoves(ns).length === 0) ns.winner = s.turn; // 相手が手詰まり
    }
    return ns;
  }

  // ---- 評価（さいきょう/つよい/ふつう 共通。手持ち差 + 作りかけの正方形 + 動かせる玉の数） ----
  function evalState(s) {
    if (s.winner === 0) return 100000;
    if (s.winner === 1) return -100000;
    const occ = occOf(s);
    let score = (handOf(s, 0) - handOf(s, 1)) * 10;
    for (const sq of SQUARES) {
      const w = sq.filter((i) => s.white & bit(i)).length;
      const b = sq.filter((i) => s.black & bit(i)).length;
      const empty = sq.filter((i) => !(occ & bit(i))).length;
      if (w === 3 && empty === 1) score += 6;
      if (b === 3 && empty === 1) score -= 6;
    }
    let whiteMobile = 0, blackMobile = 0;
    for (let i = 0; i < 30; i++) {
      if (!isFree(i, occ)) continue;
      if (s.white & bit(i)) whiteMobile++;
      else if (s.black & bit(i)) blackMobile++;
    }
    score += (whiteMobile - blackMobile) * 1.5;
    return score;
  }

  // ---- 探索（反復深化 + ネガマックス + αβ + 置換表） ----
  function stateKey(s) {
    // 衝突しない厳密なキー（BigInt）。白 30bit・黒 30bit・手番 1bit。
    return (BigInt(s.white) << 31n) | (BigInt(s.black) << 1n) | BigInt(s.turn);
  }

  function orderMoves(moves, ttMove) {
    moves.sort((a, b) => {
      const av = (ttMove && a.to === ttMove.to && a.from === ttMove.from && a.remove === ttMove.remove) ? 1000 : popcount(a.remove) * 10 + (a.win ? 500 : 0);
      const bv = (ttMove && b.to === ttMove.to && b.from === ttMove.from && b.remove === ttMove.remove) ? 1000 : popcount(b.remove) * 10 + (b.win ? 500 : 0);
      return bv - av;
    });
    return moves;
  }

  function search(rootState, timeMs, maxDepth) {
    maxDepth = maxDepth || 40;
    const deadline = Date.now() + timeMs;
    const tt = new Map(); // key -> { depth, score, move }
    const perspective = rootState.turn === 0 ? 1 : -1;

    function negamax(s, depth, alpha, beta) {
      if (s.winner != null) return (s.winner === s.turn ? -1 : 1) * (99000 + depth); // 手番側が負け
      const moves = genMoves(s);
      if (moves.length === 0) return -(99000 + depth);
      if (depth === 0) return (s.turn === 0 ? 1 : -1) * evalState(s);

      const key = stateKey(s);
      const hit = tt.get(key);
      let ttMove = null;
      if (hit && hit.depth >= depth) return hit.score;
      if (hit) ttMove = hit.move;

      orderMoves(moves, ttMove);
      let best = -Infinity, bestMove = moves[0];
      for (const m of moves) {
        if (Date.now() > deadline) break;
        const val = -negamax(applyMove(s, m), depth - 1, -beta, -alpha);
        if (val > best) { best = val; bestMove = m; }
        if (val > alpha) alpha = val;
        if (alpha >= beta) break;
      }
      tt.set(key, { depth, score: best, move: bestMove });
      return best;
    }

    const rootMoves = genMoves(rootState);
    if (rootMoves.length === 0) return null;
    if (rootMoves.length === 1) return rootMoves[0];

    let bestMove = rootMoves[0];
    for (let depth = 1; depth <= maxDepth; depth++) {
      let alpha = -Infinity, beta = Infinity, localBest = null, localScore = -Infinity;
      const key = stateKey(rootState);
      const hit = tt.get(key);
      orderMoves(rootMoves, hit ? hit.move : null);
      let timedOut = false;
      for (const m of rootMoves) {
        if (Date.now() > deadline) { timedOut = true; break; }
        const val = -negamax(applyMove(rootState, m), depth - 1, -beta, -alpha);
        if (val > localScore) { localScore = val; localBest = m; }
        if (val > alpha) alpha = val;
      }
      if (localBest) { bestMove = localBest; tt.set(key, { depth, score: localScore, move: localBest }); }
      if (timedOut) break;
      if (Math.abs(localScore) > 90000) break; // 勝敗が見えた
      if (Date.now() > deadline) break;
    }
    return bestMove;
  }

  // ---- 弱い CPU 向け: 1 手読み + ランダム ----
  function pickWeak(rootState) {
    const moves = genMoves(rootState);
    if (!moves.length) return null;
    const scored = moves.map((m) => ({ m, v: (rootState.turn === 0 ? 1 : -1) * evalState(applyMove(rootState, m)) }));
    scored.sort((a, b) => b.v - a.v);
    if (Math.random() < 0.5) return scored[0].m;
    return scored[Math.floor(Math.random() * scored.length)].m;
  }

  function pickByDifficulty(rootState, difficulty) {
    if (difficulty === 'weak') return pickWeak(rootState);
    if (difficulty === 'normal') return search(rootState, 500, 3);
    if (difficulty === 'strong') return search(rootState, 300, 40);
    return search(rootState, 2000, 40); // strongest
  }

  return {
    SIZE, OFFSET, TOP, layerOf, rowOf, colOf, idx,
    initState, cloneState, occOf, ownBB, handOf,
    canPlace, isFree, squareFormedAt, enumerateRemovals,
    genMoves, applyMove, evalState, search,
    pickWeak, pickByDifficulty,
  };
});

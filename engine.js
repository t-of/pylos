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
  const W = { hand: 10, threatNow: 10, threatLater: 2, mobile: 4, tempo: 9 };
  function evalState(s) {
    if (s.winner === 0) return 100000;
    if (s.winner === 1) return -100000;
    const occ = occOf(s);
    let score = (handOf(s, 0) - handOf(s, 1)) * W.hand;
    let nowW = 0, nowB = 0;
    for (const sq of SQUARES) {
      let w = 0, b = 0, hole = -1;
      for (const i of sq) { if (s.white & bit(i)) w++; else if (s.black & bit(i)) b++; else hole = i; }
      if (w + b !== 3 || (w && b)) continue;
      const now = canPlace(hole, occ);
      if (w) { score += now ? W.threatNow : W.threatLater; if (now) nowW++; }
      else { score -= now ? W.threatNow : W.threatLater; if (now) nowB++; }
    }
    // 手番側が今すぐ正方形を作れるなら、ほぼ玉 1 個ぶん得
    if (s.turn === 0 && nowW) score += W.tempo;
    if (s.turn === 1 && nowB) score -= W.tempo;
    let whiteMobile = 0, blackMobile = 0;
    for (let i = 0; i < 30; i++) {
      if (!isFree(i, occ)) continue;
      if (s.white & bit(i)) whiteMobile++;
      else if (s.black & bit(i)) blackMobile++;
    }
    score += (whiteMobile - blackMobile) * W.mobile;
    return score;
  }

  // ---- 探索（反復深化 PVS + 置換表 + キラー/ヒストリー） ----
  const MATE = 100000;
  const TT_BITS = 20, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;
  const ttW = new Int32Array(TT_SIZE), ttB = new Int32Array(TT_SIZE), ttT = new Int8Array(TT_SIZE).fill(-1);
  const ttDepth = new Int8Array(TT_SIZE), ttFlag = new Int8Array(TT_SIZE), ttScore = new Float64Array(TT_SIZE);
  const ttMoveA = new Int32Array(TT_SIZE), ttMoveB = new Int32Array(TT_SIZE);
  const EXACT = 0, LOWER = 1, UPPER = 2;
  function ttIndex(w, b, t) {
    let h = Math.imul(w ^ 0x5bd1e995, 0x9e3779b1) ^ Math.imul(b ^ 0x27d4eb2d, 0x85ebca77) ^ t;
    h ^= h >>> 15; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 13;
    return h & TT_MASK;
  }
  function moveA(m) { return m.to | ((m.kind === 'move' ? m.from + 1 : 0) << 5); }
  function mateScore(ply) { return MATE - ply; }

  // 探索用の軽い applyMove（手詰まりの判定は親の探索で genMoves が空になったときに行う）。
  function play(s, m) {
    const ns = { white: s.white, black: s.black, turn: 1 - s.turn, winner: null };
    const color = s.turn === 0 ? 'white' : 'black';
    if (m.kind === 'move') ns[color] &= ~bit(m.from);
    ns[color] |= bit(m.to);
    if (m.remove) ns[color] &= ~m.remove;
    if (m.win || m.to === TOP) ns.winner = s.turn;
    return ns;
  }

  function search(rootState, timeMs, maxDepth) {
    maxDepth = maxDepth || 60;
    const deadline = Date.now() + timeMs;
    const killers = [];
    const history = new Float64Array(32 * 32 * 2);
    let nodes = 0;
    const STOP = {};
    ttT.fill(-1);

    function orderScore(m, ply, hA, hB) {
      if (m.win) return 1e9;
      if (hA >= 0 && moveA(m) === hA && m.remove === hB) return 1e8;
      let v = popcount(m.remove) * 1e6;
      const k = killers[ply];
      if (k && k.some((x) => x && moveA(x) === moveA(m) && x.remove === m.remove)) v += 5e5;
      if (m.kind === 'move') v += 2e5; // 手持ちを節約する手
      return v + history[(moveA(m) & 1023) * 2 + (m.remove ? 1 : 0)];
    }

    function negamax(s, depth, alpha, beta, ply) {
      if (s.winner != null) return -mateScore(ply); // 直前の手で相手が勝った
      if ((++nodes & 1023) === 0 && Date.now() > deadline) throw STOP;
      const moves = genMoves(s);
      if (moves.length === 0) return -mateScore(ply); // 手詰まり＝負け
      if (depth <= 0) return (s.turn === 0 ? 1 : -1) * evalState(s);

      const ti = ttIndex(s.white, s.black, s.turn);
      let hA = -1, hB = 0;
      if (ttT[ti] === s.turn && ttW[ti] === s.white && ttB[ti] === s.black) {
        hA = ttMoveA[ti]; hB = ttMoveB[ti];
        if (ttDepth[ti] >= depth) {
          let sc = ttScore[ti];
          if (sc > MATE - 1000) sc -= ply; else if (sc < -MATE + 1000) sc += ply;
          const f = ttFlag[ti];
          if (f === EXACT) return sc;
          if (f === LOWER && sc >= beta) return sc;
          if (f === UPPER && sc <= alpha) return sc;
        }
      }

      const scores = new Map(moves.map((m) => [m, orderScore(m, ply, hA, hB)]));
      moves.sort((a, b) => scores.get(b) - scores.get(a));
      const alpha0 = alpha;
      let best = -Infinity, bestMove = moves[0], first = true;
      for (const m of moves) {
        const child = play(s, m);
        let val;
        if (first) val = -negamax(child, depth - 1, -beta, -alpha, ply + 1);
        else {
          val = -negamax(child, depth - 1, -alpha - 1, -alpha, ply + 1);
          if (val > alpha && val < beta) val = -negamax(child, depth - 1, -beta, -alpha, ply + 1);
        }
        first = false;
        if (val > best) { best = val; bestMove = m; }
        if (val > alpha) alpha = val;
        if (alpha >= beta) {
          if (!m.remove && !m.win) {
            const k = killers[ply] || (killers[ply] = [null, null]);
            if (!k[0] || moveA(k[0]) !== moveA(m)) { k[1] = k[0]; k[0] = m; }
          }
          history[(moveA(m) & 1023) * 2 + (m.remove ? 1 : 0)] += depth * depth;
          break;
        }
      }
      let st = best;
      if (st > MATE - 1000) st += ply; else if (st < -MATE + 1000) st -= ply;
      ttW[ti] = s.white; ttB[ti] = s.black; ttT[ti] = s.turn; ttDepth[ti] = depth; ttScore[ti] = st;
      ttFlag[ti] = best <= alpha0 ? UPPER : best >= beta ? LOWER : EXACT;
      ttMoveA[ti] = moveA(bestMove); ttMoveB[ti] = bestMove.remove;
      return best;
    }

    const rootMoves = genMoves(rootState);
    if (rootMoves.length === 0) return null;
    if (rootMoves.length === 1) return rootMoves[0];
    const win = rootMoves.find((m) => m.win);
    if (win) return win;

    let bestMove = rootMoves[0];
    for (let depth = 1; depth <= maxDepth; depth++) {
      // 前の深さの最善手を先頭に
      rootMoves.sort((a, b) => (b === bestMove) - (a === bestMove));
      let alpha = -Infinity, localBest = null, localScore = -Infinity, first = true;
      try {
        for (const m of rootMoves) {
          const child = play(rootState, m);
          let val;
          if (first) val = -negamax(child, depth - 1, -Infinity, -alpha, 1);
          else {
            val = -negamax(child, depth - 1, -alpha - 1, -alpha, 1);
            if (val > alpha) val = -negamax(child, depth - 1, -Infinity, -alpha, 1);
          }
          first = false;
          if (val > localScore) { localScore = val; localBest = m; }
          if (val > alpha) alpha = val;
        }
      } catch (e) {
        if (e !== STOP) throw e;
        // 途中で時間切れ: この深さで先に読み終えた最善手が前より良ければ使う（先頭は前の最善手なので安全）
        if (localBest && localScore > -Infinity) bestMove = localBest;
        break;
      }
      bestMove = localBest;
      if (Math.abs(localScore) > MATE - 1000) break; // 勝敗を読み切った
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
    if (difficulty === 'normal') return search(rootState, 500, 2);
    if (difficulty === 'strong') return search(rootState, 300, 40);
    return search(rootState, 2000, 40); // strongest
  }

  const api = {
    SIZE, OFFSET, TOP, layerOf, rowOf, colOf, idx,
    initState, cloneState, occOf, ownBB, handOf,
    canPlace, isFree, squareFormedAt, enumerateRemovals,
    genMoves, applyMove, evalState, search,
    pickWeak, pickByDifficulty, W,
  };
  return api;
});

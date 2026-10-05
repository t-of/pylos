// さいきょう・つよい の CPU 思考を別スレッドで行う（メインスレッドを固めないため）。
'use strict';
importScripts('./engine.js');

self.onmessage = (e) => {
  const { state, difficulty } = e.data;
  const move = PylosEngine.pickByDifficulty(state, difficulty);
  self.postMessage({ move });
};

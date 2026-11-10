// `node:async_hooks` for the browser demo. raw-body wraps callbacks in an
// AsyncResource only to keep async context, which has no meaning here; run them as is.
class AsyncResource {
  constructor(type) {
    this.type = type;
  }
  static bind(fn) {
    return fn;
  }
  bind(fn) {
    return fn;
  }
  runInAsyncScope(fn, thisArg, ...args) {
    return fn.apply(thisArg, args);
  }
  emitDestroy() {
    return this;
  }
  asyncId() {
    return 0;
  }
  triggerAsyncId() {
    return 0;
  }
}

// A single-threaded AsyncLocalStorage: correct for synchronous `run` callbacks only.
class AsyncLocalStorage {
  getStore() {
    return this.store;
  }
  run(store, fn, ...args) {
    const prev = this.store;
    this.store = store;
    try {
      return fn(...args);
    } finally {
      this.store = prev;
    }
  }
  enterWith(store) {
    this.store = store;
  }
  disable() {
    this.store = undefined;
  }
}

module.exports = {
  AsyncResource,
  AsyncLocalStorage,
  executionAsyncId: () => 0,
  triggerAsyncId: () => 0,
  createHook: () => ({ enable() {}, disable() {} }),
};

// `node:perf_hooks` for the browser demo: the browser's own performance object (the
// jspm polyfill copies its methods unbound, so `performance.now()` throws).
module.exports = { performance: globalThis.performance, PerformanceObserver: globalThis.PerformanceObserver };

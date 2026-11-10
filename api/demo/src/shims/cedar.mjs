// `@cedar-policy/cedar-wasm/nodejs` for the browser demo: the same Cedar build for the
// web. Nothing happens at load time; the worker calls `demoInitCedar()` while it boots,
// which fetches and compiles the WebAssembly asynchronously. (Compiling 4 MB
// synchronously during script evaluation made Firefox abort the worker when DevTools
// was attached.) Cedar is only called from request handling, after boot.
import init from '../../../node_modules/@cedar-policy/cedar-wasm/web/cedar_wasm.js';

export async function demoInitCedar() {
  await init({ module_or_path: new URL('./cedar_wasm_bg.wasm', self.location.href) });
}

export * from '../../../node_modules/@cedar-policy/cedar-wasm/web/cedar_wasm.js';

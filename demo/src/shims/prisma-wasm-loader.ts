/**
 * Stands in for the generated client's `#wasm-engine-loader` import: fetch the Prisma
 * query engine's WebAssembly from next to the service worker.
 */
const engine = (async () => ({
  default: await WebAssembly.compileStreaming(fetch(new URL('./query_engine_bg.wasm', self.location.href))),
}))();
export default engine;

const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function loadWithCloudflareWorkersShim(request, parent, isMain) {
  if (request === "cloudflare:workers") {
    return {
      DurableObject: class DurableObject {
        constructor(ctx, env) {
          this.ctx = ctx;
          this.env = env;
        }
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

for (const constructorName of ["HTMLFormElement", "HTMLInputElement", "HTMLSelectElement"]) {
  if (constructorName in globalThis) continue;
  Object.defineProperty(globalThis, constructorName, {
    configurable: true,
    get() {
      return globalThis.window?.[constructorName];
    },
  });
}

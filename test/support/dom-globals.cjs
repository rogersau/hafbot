// DOM constructors follow each test's active JSDOM window.
for (const name of ["HTMLFormElement", "HTMLInputElement", "HTMLSelectElement"]) {
  if (name in globalThis) continue;
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      return globalThis.window?.[name];
    },
  });
}

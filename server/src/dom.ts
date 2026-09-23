import { JSDOM } from 'jsdom';

/**
 * jsdom bridge for headless Mermaid.
 *
 * Mermaid is a browser library. To validate diagrams on the server we give it a real
 * DOM. Two things are needed beyond jsdom's defaults:
 *
 *  1. A broad bridge of `window` globals onto `globalThis`, because Mermaid reaches for
 *     `CSSStyleSheet`, `DOMParser`, `MutationObserver` and friends by bare name.
 *  2. SVG layout stubs. jsdom has no layout engine, so `getBBox()` /
 *     `getComputedTextLength()` throw. Mermaid's dagre layout calls them while placing
 *     nodes. Stubbing them to fixed metrics lets layout complete; geometry is not what
 *     we are verifying, the parser and renderer are.
 *
 * `navigator` is a getter-only global in modern Node, so every assignment here goes
 * through `Object.defineProperty`.
 */

const SKIP = new Set([
  'undefined', 'NaN', 'Infinity', 'globalThis', 'eval', 'Function', 'Object', 'Array',
  'String', 'Number', 'Boolean', 'Symbol', 'Math', 'JSON', 'Date', 'RegExp', 'Error',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Intl', 'Buffer',
  'process', 'console', 'global', 'require', 'module', 'exports', '__dirname',
  '__filename', 'structuredClone', 'fetch', 'Headers', 'Request', 'Response', 'FormData',
  'Blob', 'File', 'URL', 'URLSearchParams', 'AbortController', 'AbortSignal',
  'TextEncoder', 'TextDecoder', 'WebSocket', 'EventTarget', 'MessageChannel',
  'MessagePort', 'BroadcastChannel', 'performance', 'crypto', 'queueMicrotask',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate',
  'clearImmediate', 'atob', 'btoa', 'navigator', 'window', 'document',
]);

function define(target: object, key: string, value: unknown): void {
  try {
    Object.defineProperty(target, key, { value, writable: true, configurable: true });
  } catch {
    /* non-configurable global: leave Node's own binding in place */
  }
}

let ready: Promise<typeof import('mermaid').default> | null = null;

/**
 * Boot the DOM, then import Mermaid. The import MUST come after the globals exist:
 * `dompurify` and friends capture `window` at module-evaluation time.
 */
export function ensureMermaid(): Promise<typeof import('mermaid').default> {
  if (ready) return ready;

  ready = (async () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      pretendToBeVisual: true,
      url: 'http://localhost/',
    });

    const win = dom.window as unknown as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(dom.window)) {
      if (SKIP.has(key)) continue;
      define(globalThis, key, win[key]);
    }
    define(globalThis, 'window', dom.window);
    define(globalThis, 'document', dom.window.document);
    define(globalThis, 'navigator', dom.window.navigator);

    // SVG text metrics: fixed values, because we verify syntax and render success,
    // not pixel geometry.
    const svgProto = dom.window.SVGElement.prototype as unknown as Record<string, unknown>;
    svgProto.getBBox = function getBBox() {
      return { x: 0, y: 0, width: 120, height: 24 };
    };
    svgProto.getComputedTextLength = function getComputedTextLength() {
      return 120;
    };
    svgProto.getScreenCTM = function getScreenCTM() {
      const m = {
        a: 1, b: 0, c: 0, d: 1, e: 0, f: 0,
        inverse() { return m; },
        multiply() { return m; },
      };
      return m;
    };

    const mermaid = (await import('mermaid')).default;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      // Fonts are irrelevant headlessly and their absence can warn.
      fontFamily: 'sans-serif',
      theme: 'default',
    });
    return mermaid;
  })();

  return ready;
}

/**
 * Mermaid keeps process-wide diagram state and renders through a shared temp node,
 * so concurrent renders in one jsdom are not safe. Validation is cheap next to the
 * model call, so we serialise it. Model calls themselves stay concurrent.
 */
let chain: Promise<unknown> = Promise.resolve();

export function withMermaidLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
// Several console pages in ONE browser, for tests of what one tab's action does to another.
//
// A browser gives every page of an origin the same localStorage and each TAB its own sessionStorage (kept across that
// tab's reloads), and it tells every OTHER page of the origin about a localStorage write with a `storage` event, queued
// as a task: never the page that wrote, and not at all when the write changed nothing. The happy-dom test environment
// has one window, so it cannot show any of that. Here each page is its own happy-dom Window running the real app.js,
// and the storage is modelled as above:
//
//   const browser = new Browser();
//   const a = browser.tab("A"), b = browser.tab("B");
//   const pageA = a.open(fetchMock, RETURNS);    // a page load in tab A
//   const pageB = b.open(fetchMock, RETURNS);
//   pageB2 = b.open(fetchMock, RETURNS);          // tab B reloads: pageB is gone, B's sessionStorage stays
//
// A page that is reloaded or closed stops for good, as in a browser: its timers never fire again, a request it still
// has out never answers it, and it hears no more storage events. (Otherwise an old page would keep a retry loop going
// and a test would count requests from pages that no longer exist.)
//
// Timers are the test's own (so vi.useFakeTimers() drives every page, and the storage events queued between them);
// every other browser global app.js reaches for comes from the page's Window.
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vi, type Mock } from "vitest";

/** A plain in-memory Storage. */
export class MemoryStorage {
  protected data = new Map<string, string>();
  get length() { return this.data.size; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  getItem(key: string) { return this.data.has(key) ? this.data.get(key)! : null; }
  setItem(key: string, value: string) { this.data.set(key, String(value)); }
  removeItem(key: string) { this.data.delete(key); }
  clear() { this.data.clear(); }
  /** Everything stored, for assertions. */
  entries() { return [...this.data.entries()]; }
}

type Listener = { win: Window; alive: () => boolean };

/** One origin's localStorage, shared by every page of the browser. */
class SharedStorage extends MemoryStorage {
  private pages = new Set<Listener>();
  attach(page: Listener) { this.pages.add(page); }
  detach(page: Listener) { this.pages.delete(page); }
  /** The view one page has: the same data, and its writes reach the other pages as `storage` events. */
  viewFor(writer: Listener) {
    const change = (key: string | null, oldValue: string | null, newValue: string | null) => {
      for (const page of this.pages) {
        if (page === writer) continue;
        // A task per receiving page, as a browser queues it: after the writer's current synchronous step.
        setTimeout(() => {
          if (!page.alive()) return;
          const event = new page.win.StorageEvent("storage", { key, oldValue, newValue, url: page.win.location.href });
          page.win.dispatchEvent(event);
        }, 0);
      }
    };
    const shared = this;
    return {
      get length() { return shared.length; },
      key: (i: number) => shared.key(i),
      getItem: (key: string) => shared.getItem(key),
      setItem: (key: string, value: string) => {
        const old = shared.getItem(key);
        shared.setItem(key, value);
        if (old !== String(value)) change(key, old, String(value));
      },
      removeItem: (key: string) => {
        const old = shared.getItem(key);
        shared.removeItem(key);
        if (old !== null) change(key, old, null);
      },
      clear: () => {
        const had = shared.length > 0;
        shared.clear();
        if (had) change(null, null, null);
      },
    };
  }
}

export type Page<T> = {
  name: string;
  win: Window;
  document: Document;
  app: T;
  /** location.replace, recorded instead of navigating. */
  replace: Mock;
  $: (id: string) => HTMLElement;
  shown: (id: string) => boolean;
  /** The page is gone: its timers, pending requests and storage events stop. */
  close: () => void;
};

const appJs = () => readFileSync(resolve(process.cwd(), "public/app/app.js"), "utf8");
const pageHtml = () => readFileSync(resolve(process.cwd(), "public/app/index.html"), "utf8")
  .replace(/<link[^>]*>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");

export class Tab {
  /** This tab's sessionStorage: its own, and kept across its reloads. */
  readonly sessionStorage = new MemoryStorage();
  current: Page<unknown> | null = null;
  constructor(readonly browser: Browser, readonly name: string) {}

  /** A page load in this tab (a reload when one is already open): the previous page is gone. `returns` is the
   * expression app.js's scope hands back to the test, e.g. `{ signOut, whoIsIn: () => me?.orgId ?? null }`. */
  open<T>(fetchMock: (path: string, init?: RequestInit) => Promise<unknown>, returns: string, { url = "http://localhost/app/", webSocket, navigator }: { url?: string; webSocket?: unknown; navigator?: unknown } = {}): Page<T> {
    this.current?.close();
    let closed = false;
    const win = new Window({ url });
    const document = win.document as unknown as Document;
    document.documentElement.innerHTML = pageHtml();
    const listener: Listener = { win, alive: () => !closed };
    this.browser.localStorage.attach(listener);

    // Timers owned by this page, so they die with it.
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const intervals = new Set<ReturnType<typeof setInterval>>();
    const pageSetTimeout = (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const id = setTimeout(() => { timers.delete(id); if (!closed) fn(...args); }, ms);
      timers.add(id);
      return id;
    };
    const pageClearTimeout = (id: ReturnType<typeof setTimeout>) => { timers.delete(id); clearTimeout(id); };
    const pageSetInterval = (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const id = setInterval(() => { if (!closed) fn(...args); }, ms);
      intervals.add(id);
      return id;
    };
    const pageClearInterval = (id: ReturnType<typeof setInterval>) => { intervals.delete(id); clearInterval(id); };
    // A request still out when the page goes never answers it.
    const pageFetch = async (path: string, init?: RequestInit) => {
      if (closed) return new Promise(() => {});
      const res = await fetchMock(path, init);
      return closed ? new Promise(() => {}) : res;
    };
    const replace = vi.fn();
    const location = new Proxy(win.location, {
      get(target, key) {
        if (key === "replace") return replace;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    // Every name the Window defines that Node does not (DOM constructors, getComputedStyle, MutationObserver...), so
    // the real app.js runs unmodified; names Node already has (timers, Promise, JSON, crypto) stay Node's.
    const scope: Record<string, unknown> = {};
    const IDENT = /^[A-Za-z_$][\w$]*$/;
    const UNBINDABLE = new Set(["eval", "arguments", "undefined", "NaN", "Infinity"]);
    for (let o: object | null = win; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const name of Object.getOwnPropertyNames(o)) {
        if (!IDENT.test(name) || UNBINDABLE.has(name) || name in globalThis || name in scope) continue;
        try { scope[name] = (win as unknown as Record<string, unknown>)[name]; } catch { /* not a page global */ }
      }
    }
    Object.assign(scope, {
      window: win, document, location, history: win.history, navigator: navigator ?? win.navigator,
      localStorage: this.browser.localStorage.viewFor(listener), sessionStorage: this.sessionStorage,
      fetch: pageFetch, WebSocket: webSocket ?? class { readyState = 0; close() {} },
      setTimeout: pageSetTimeout, clearTimeout: pageClearTimeout, setInterval: pageSetInterval, clearInterval: pageClearInterval,
      requestAnimationFrame: (cb: (t: number) => void) => pageSetTimeout(() => cb(Date.now()), 16),
      cancelAnimationFrame: pageClearTimeout,
    });
    const names = Object.keys(scope);
    const app = new Function(...names, `${appJs()}; return (${returns});`)(...names.map((n) => scope[n])) as T;

    const $ = (id: string) => document.getElementById(id) as HTMLElement;
    const page: Page<T> = {
      name: this.name, win, document, app, replace, $,
      shown: (id) => !$(id).hidden,
      close: () => {
        if (closed) return;
        closed = true;
        this.browser.localStorage.detach(listener);
        for (const id of timers) clearTimeout(id);
        for (const id of intervals) clearInterval(id);
        void win.happyDOM.abort().catch(() => {});
      },
    };
    this.current = page as Page<unknown>;
    return page;
  }

  close() { this.current?.close(); this.current = null; }
}

/** One browser profile: its localStorage is shared by every tab. */
export class Browser {
  readonly localStorage = new SharedStorage();
  private tabs: Tab[] = [];
  tab(name: string) {
    const tab = new Tab(this, name);
    this.tabs.push(tab);
    return tab;
  }
  /** Every tab closed (end of test). */
  closeAll() { for (const tab of this.tabs) tab.close(); }
}

// OpenCadre console service worker. Installable (required for iOS Web Push, which only fires inside
// an installed PWA) and handles the two events Web Push needs: showing a notification, and opening
// the console when it's tapped. Never caches app.js/index.html -- this is not an offline app, and a
// stale cached script would be worse than a network request.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    return; // not the JSON payload src/push.ts sends; nothing sensible to show
  }
  if (!data.title) return;
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body || "",
      tag: data.tag || "opencadre",
      data: { url: data.url || "/app/" },
      icon: "/app/icons/icon-192.png",
      badge: "/app/icons/badge-96.png",
    }),
  );
});

// ---------- notification click: one console window, never another ----------
// A tap on an approval notification must reach the console window the person already has, controlled by this worker or
// not. It used to call client.navigate(), which rejects for a window this worker does not control (one opened before
// the worker activated), and then fell back to openWindow(): every tap added another installed-app window.
// Now: pick the best existing console window, focus it and tell the page where to go (postMessage works for any window
// of this origin). navigate() is only the fallback for a page that never acknowledges the message (an old app.js with
// no listener). openWindow() is called only when no console window exists at all. Closing the windows already piled up
// is the person's job; nothing here closes one.
const CONSOLE_PATH = "/app/";
const ACK_MS = 1500;
const TASK_MS = 30000;
const OPEN_WAIT_MS = 20000; // how long a tap waits for a window another tap is still opening

/** The notification's target: same origin and under /app/, else the console's front page. Credentials never survive. */
function consoleUrl(raw) {
  const fallback = new URL(CONSOLE_PATH, self.location.origin).href;
  try {
    const url = new URL(String(raw ?? CONSOLE_PATH), self.location.origin);
    if (url.origin !== self.location.origin || !url.pathname.startsWith(CONSOLE_PATH)) return fallback;
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return fallback;
  }
}

/** A console window is exactly a window of this origin under /app/: the public site's pages (/pricing, /) are not. */
function isConsoleWindow(client) {
  try {
    const url = new URL(client.url);
    return url.origin === self.location.origin && url.pathname.startsWith(CONSOLE_PATH);
  } catch {
    return false;
  }
}

/** Focused first, then visible, then the order matchAll gave (most recently used first). */
function bestWindow(clients) {
  const rank = (c) => (c.focused ? 0 : c.visibilityState === "visible" ? 1 : 2);
  return clients
    .map((client, index) => ({ client, index }))
    .sort((a, b) => rank(a.client) - rank(b.client) || a.index - b.index)[0]?.client ?? null;
}

// The window this worker opened last. A window that openWindow() has just created may not be in matchAll() yet, and
// a second tap right behind the first must find it, not open another.
let openedId = null;
// The openWindow() call in flight, if any. It is tracked apart from the tap queue, whose hang release (TASK_MS) does not
// cancel it: while it is unresolved no other openWindow() may start, or a slow one plus a released queue makes two windows.
let opening = null;

/** The console windows there are now, controlled by this worker or not. */
async function consoleWindows() {
  const all = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).filter(isConsoleWindow);
  if (all.length === 0 && openedId) {
    let opened = null;
    try { opened = await self.clients.get(openedId); } catch { /* gone */ }
    if (opened && isConsoleWindow(opened)) return [opened];
    openedId = null;
  }
  return all;
}

/** Tells the page to open `url`; resolves true if its listener acknowledged within ACK_MS. */
function askToOpen(client, url) {
  return new Promise((resolve) => {
    let channel;
    let timer;
    const done = (ok) => {
      clearTimeout(timer);
      try { channel?.port1.close(); } catch { /* already closed */ }
      resolve(ok);
    };
    try {
      channel = new MessageChannel();
      channel.port1.onmessage = () => done(true);
      timer = setTimeout(() => done(false), ACK_MS);
      client.postMessage({ type: "opencadre:open", url }, [channel.port2]);
    } catch {
      done(false);
    }
  });
}

// Each tap takes the next number on arrival; only the latest may focus, message or navigate. Every await below is followed
// by a check, so a tap whose enumeration stalled past the queue release cannot post its old url to a window a newer tap
// opened. A superseded tap that already asked for a window is not cancelled: `opening` still clears when that open settles.
let clickSeq = 0;

async function openConsole(url, mine) {
  const latest = () => mine === clickSeq;
  if (!latest()) return;
  let target = bestWindow(await consoleWindows());
  if (!latest()) return;
  if (!target && opening) {
    // Another tap's window is still being created: wait for it (bounded), then use it.
    let timer;
    await Promise.race([opening, new Promise((r) => { timer = setTimeout(r, OPEN_WAIT_MS); })]);
    clearTimeout(timer);
    if (!latest()) return;
    target = bestWindow(await consoleWindows());
    if (!latest()) return;
  }
  if (!target) {
    if (opening) return; // still unresolved: never a second window; the person taps again once it appears
    const started = self.clients.openWindow(url);
    const tracked = Promise.resolve(started).then(
      (opened) => { if (opened?.id) openedId = opened.id; },
      () => {},
    ).finally(() => { if (opening === tracked) opening = null; });
    opening = tracked;
    await started;
    return;
  }
  // From here a window exists, so nothing below opens another, whatever fails. focus() first, while the click's user
  // activation is fresh; a refusal must not stop the message, nor a refused message the focus.
  const focusing = "focus" in target ? Promise.resolve().then(() => target.focus()).catch(() => {}) : Promise.resolve();
  const acknowledged = await askToOpen(target, url);
  await focusing;
  if (!latest()) return;
  if (!acknowledged && "navigate" in target) {
    // No listener answered: an old page. navigate() reloads it onto the link, but rejects for a window this worker does
    // not control, and then the focused window is all we can give.
    try { await target.navigate(url); } catch { /* focused already */ }
  }
}

// Taps are handled one at a time. Two taps in quick succession (a burst of approvals) would otherwise each see "no
// window yet" and each open one. A task that never settles is released after TASK_MS so it cannot block the next tap.
let queue = Promise.resolve();
function serialized(task) {
  const run = queue.then(() => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, TASK_MS);
    task().then(resolve, reject).finally(() => clearTimeout(timer));
  }));
  queue = run.catch(() => {});
  return run;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = consoleUrl(event.notification.data?.url);
  const mine = ++clickSeq;
  event.waitUntil(serialized(() => openConsole(url, mine)));
});

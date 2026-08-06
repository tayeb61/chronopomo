// Chronopomo Capture — Service Worker
//
// Only job: when the phone regains connectivity while this PWA isn't
// even open, a registered 'flush-queue' background sync wakes this
// worker up and it drains the IndexedDB queue on its own. It has no
// access to the page's CONFIG object (separate JS context), so it
// reads the ntfy topic from the same IndexedDB 'meta' store the page
// writes to on every load — that keeps this file topic-agnostic and
// self-updating if the topic ever changes, instead of hardcoding a
// second copy of the secret here.
//
// Deliberately does NOT implement a fetch handler / offline page cache
// — this app has nothing worth caching (one HTML file, always fetched
// fresh), so adding cache logic here would be complexity with no
// payoff for this use case.

const DB_NAME = 'chronopomo-capture';
const DB_VERSION = 1;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('pending')) {
        db.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readMeta(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readonly');
    const req = tx.objectStore('meta').get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}

async function getPending() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending', 'readonly');
    const req = tx.objectStore('pending').getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.createdAt - b.createdAt));
    req.onerror = () => reject(req.error);
  });
}

async function deletePending(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending', 'readwrite');
    tx.objectStore('pending').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function flushQueueInBackground() {
  const topic = await readMeta('ntfyTopic');
  if (!topic) return; // page has never loaded/written it yet — nothing to do
  const items = await getPending();
  for (const item of items) {
    try {
      const res = await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body: item.text });
      if (!res.ok) throw new Error('ntfy request failed: ' + res.status);
      await deletePending(item.id);
    } catch (err) {
      // Still offline, or ntfy briefly down — stop and let the next
      // sync attempt (the browser retries with backoff on its own)
      // pick up the rest.
      break;
    }
  }
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'flush-queue') {
    event.waitUntil(flushQueueInBackground());
  }
});

// Небольшое key-value хранилище в IndexedDB (картинка-референс) + настройки в localStorage.
const DB = 'artcam', STORE = 'kv';

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); res(req && req.result); };
    t.onerror = () => { db.close(); rej(t.error); };
  });
}

export const idbGet = (k) => tx('readonly', (s) => s.get(k)).catch(() => undefined);
export const idbSet = (k, v) => tx('readwrite', (s) => s.put(v, k)).catch((e) => console.warn(e));
export const idbDel = (k) => tx('readwrite', (s) => s.delete(k)).catch(() => {});

const LS = 'artcam.settings.v1';
export function loadSettings(defaults) {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(LS) || '{}') }; } catch { return { ...defaults }; }
}
export function saveSettings(s) {
  try { localStorage.setItem(LS, JSON.stringify(s)); } catch { /* приватный режим и т.п. */ }
}

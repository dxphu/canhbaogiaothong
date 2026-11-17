// Lưu dữ liệu trên máy bằng IndexedDB (dữ liệu đường có thể vài MB, quá giới hạn localStorage).
const DB = 'canhbao-bienbao', STORE = 'kv';
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}

function run(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export const get = (k) => run('readonly', (s) => s.get(k)).catch(() => undefined);
export const set = (k, v) => run('readwrite', (s) => s.put(v, k)).catch(() => {});
export const del = (k) => run('readwrite', (s) => s.delete(k)).catch(() => {});

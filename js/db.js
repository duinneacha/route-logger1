const DB_NAME = "route-notes";
const DB_VERSION = 1;

let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("rounds")) {
          db.createObjectStore("rounds", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("notes")) {
          const notes = db.createObjectStore("notes", { keyPath: "id" });
          notes.createIndex("roundId", "roundId", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

function withStore(storeName, mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        let output;
        const request = run(tx.objectStore(storeName));
        if (request) {
          request.onsuccess = () => {
            output = request.result;
          };
          request.onerror = () => reject(request.error);
        }
        tx.oncomplete = () => resolve(output);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
      })
  );
}

export function putRound(round) {
  return withStore("rounds", "readwrite", (store) => store.put(round));
}

export function putNote(note) {
  return withStore("notes", "readwrite", (store) => store.put(note));
}

export function deleteNote(id) {
  return withStore("notes", "readwrite", (store) => store.delete(id));
}

export async function allRounds() {
  const rounds = (await withStore("rounds", "readonly", (store) => store.getAll())) || [];
  return rounds.sort((a, b) => b.startedAt - a.startedAt);
}

export async function allNotes() {
  return (await withStore("notes", "readonly", (store) => store.getAll())) || [];
}

export async function notesForRound(roundId) {
  const notes = (await withStore("notes", "readonly", (store) => store.index("roundId").getAll(roundId))) || [];
  return notes.sort((a, b) => a.at - b.at);
}

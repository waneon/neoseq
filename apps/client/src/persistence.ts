const DATABASE = "neoseq-step-1";
const STORE = "snapshots";
const KEY = "fixture";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveSnapshot(payload: ArrayBuffer): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(payload, KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function loadSnapshot(): Promise<ArrayBuffer> {
  const database = await openDatabase();
  const value = await new Promise<ArrayBuffer>((resolve, reject) => {
    const transaction = database.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).get(KEY);
    request.onsuccess = () => resolve(request.result as ArrayBuffer);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return value;
}


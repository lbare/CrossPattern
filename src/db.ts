/** The project library, kept in the browser's IndexedDB (roomier than localStorage, so photos fit). */

export interface ProjectRecord {
  id: string;
  name: string;
  updatedAt: number;
  width: number;
  height: number;
  /** Small preview image as a data URL. */
  thumb: string;
  /** The serialized pattern. */
  data: string;
}

const STORE = 'projects';
let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  return (opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('crosspattern', 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export const putProject = (r: ProjectRecord) => run('readwrite', (s) => s.put(r));
export const getProject = (id: string) => run<ProjectRecord | undefined>('readonly', (s) => s.get(id));
export const deleteProject = (id: string) => run('readwrite', (s) => s.delete(id));
export const listProjects = () =>
  run<ProjectRecord[]>('readonly', (s) => s.getAll()).then((all) => all.sort((a, b) => b.updatedAt - a.updatedAt));

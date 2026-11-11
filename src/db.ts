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

/**
 * Everything needed to pick a picture conversion back up: the photo, the crop, the marks and the
 * settings. Stored under 'draft' while in progress and under the project's id once a pattern is made.
 */
export interface ConversionRecord {
  photo: Blob;
  name: string;
  w: number;
  h: number;
  crop: { x: number; y: number; w: number; h: number };
  step: 'crop' | 'areas';
  labels: { w: number; h: number; data: Uint8Array; crop: { x: number; y: number; w: number; h: number } } | null;
  settings: Record<string, unknown>;
  updatedAt: number;
}

const PROJECTS = 'projects', CONVERSIONS = 'conversions';
let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  return (opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('crosspattern', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(CONVERSIONS)) db.createObjectStore(CONVERSIONS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export const putProject = (r: ProjectRecord) => run(PROJECTS, 'readwrite', (s) => s.put(r));
export const getProject = (id: string) => run<ProjectRecord | undefined>(PROJECTS, 'readonly', (s) => s.get(id));
export const deleteProject = (id: string) =>
  run(PROJECTS, 'readwrite', (s) => s.delete(id)).then(() => deleteConversion(id).catch(() => {}));
export const listProjects = () =>
  run<ProjectRecord[]>(PROJECTS, 'readonly', (s) => s.getAll()).then((all) => all.sort((a, b) => b.updatedAt - a.updatedAt));

/** The key for a conversion that has not been turned into a pattern yet. */
export const DRAFT = 'draft';
export const putConversion = (key: string, r: ConversionRecord) => run(CONVERSIONS, 'readwrite', (s) => s.put(r, key));
export const getConversion = (key: string) => run<ConversionRecord | undefined>(CONVERSIONS, 'readonly', (s) => s.get(key));
export const deleteConversion = (key: string) => run(CONVERSIONS, 'readwrite', (s) => s.delete(key));

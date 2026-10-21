import type { DocumentSession, RecentDocument } from '../types'

const DATABASE_NAME = 'folio-reader'
let databasePromise: Promise<IDBDatabase> | undefined

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('此浏览器不支持本地文档存储。'))
      return
    }
    const request = indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      database.createObjectStore('sessions', { keyPath: 'id' })
      const recents = database.createObjectStore('recents', { keyPath: 'id' })
      recents.createIndex('updatedAt', 'updatedAt')
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => {
        database.close()
        databasePromise = undefined
      }
      resolve(database)
    }
    request.onerror = () => reject(request.error ?? new Error('无法打开本地文档存储。'))
    request.onblocked = () => reject(new Error('本地存储正在升级，请关闭其他阅读器标签页后重试。'))
  }).catch((error: unknown) => {
    databasePromise = undefined
    throw error
  })
  return databasePromise
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('保存文档失败。'))
    transaction.onabort = () => reject(transaction.error ?? new Error('文档存储操作已中止。'))
  })
}

export async function saveSession(session: DocumentSession): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(['sessions', 'recents'], 'readwrite')
  const done = transactionDone(transaction)
  transaction.objectStore('sessions').put(session)
  const recent: RecentDocument = {
    id: session.id,
    name: session.name,
    updatedAt: session.updatedAt,
    lastPage: session.lastPage,
  }
  transaction.objectStore('recents').put(recent)
  await done
}

export async function loadSession(id: string): Promise<DocumentSession | undefined> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const request = database.transaction('sessions', 'readonly').objectStore('sessions').get(id)
    request.onsuccess = () => resolve(request.result as DocumentSession | undefined)
    request.onerror = () => reject(request.error ?? new Error('无法读取本地文档。'))
  })
}

export async function listRecentDocuments(): Promise<RecentDocument[]> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const documents: RecentDocument[] = []
    const request = database.transaction('recents', 'readonly')
      .objectStore('recents').index('updatedAt').openCursor(null, 'prev')
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve(documents)
        return
      }
      documents.push(cursor.value as RecentDocument)
      cursor.continue()
    }
    request.onerror = () => reject(request.error ?? new Error('无法读取最近文档。'))
  })
}

export async function getDocumentId(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function deleteSession(id: string): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(['sessions', 'recents'], 'readwrite')
  const done = transactionDone(transaction)
  transaction.objectStore('sessions').delete(id)
  transaction.objectStore('recents').delete(id)
  await done
}

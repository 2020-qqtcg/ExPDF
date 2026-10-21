import type { FontAsset, FontDescriptor, TextStyle } from '../types'

export function fontCssFamily(id: string): string {
  return `FolioFont_${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

const bundledFont: FontDescriptor = {
  id: 'bundled-noto-sans-cjk-sc', family: 'Noto Sans CJK SC', fullName: 'Noto Sans CJK SC Regular',
  localizedFullName: 'Noto Sans CJK SC 常规体', aliases: ['思源黑体', 'Noto 黑体', '简体中文'],
  postscriptName: 'NotoSansCJKsc-Regular', style: 'Regular', weight: 400, italic: false, source: 'bundled',
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontId: bundledFont.id, fontFamily: bundledFont.family, fontName: bundledFont.fullName,
  fontSize: 18, bold: false, italic: false, underline: false,
  align: 'left', lineHeight: 1.4, width: 280, rotation: 0,
}

interface BrowserFont {
  family: string
  fullName: string
  postscriptName: string
  style: string
  blob(): Promise<Blob>
}
interface StoredDescriptor extends FontDescriptor { fileId: string }
interface RuntimeFont {
  familyName?: string
  fullName?: string
  postscriptName?: string
  subfamilyName?: string
  italicAngle?: number
  'OS/2'?: { usWeightClass?: number }
  head?: { macStyle?: { italic?: boolean } }
  stream?: { buffer: Uint8Array }
  fonts?: RuntimeFont[]
  name?: { records?: Record<string, Record<string, string>> }
}

export function fontLabel(font: FontDescriptor): string {
  return font.localizedFullName && font.localizedFullName !== font.fullName ? `${font.localizedFullName} · ${font.fullName}` : font.fullName
}

export function matchesFontSearch(font: FontDescriptor, query: string): boolean {
  return [font.family, font.fullName, font.localizedFullName, font.postscriptName, ...(font.aliases ?? [])].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
}

function localizedNames(face: RuntimeFont): Pick<FontDescriptor, 'localizedFullName' | 'aliases'> {
  const records = face.name?.records ?? {}
  const fullNames = records.fullName ?? {}
  const localizedFullName = ['zh', 'zh-CN', 'zh-Hans', 'zh-TW', 'zh-Hant', 'zh-HK'].map(language => fullNames[language]).find(Boolean)
  const aliases = [...new Set(['fullName', 'fontFamily', 'preferredFamily', 'compatibleFull', 'postscriptName'].flatMap(key => Object.values(records[key] ?? {})).filter(value => typeof value === 'string' && value.trim()))]
  return { localizedFullName, aliases }
}

const descriptors = new Map<string, FontDescriptor>([[bundledFont.id, bundledFont]])
const browserFonts = new Map<string, BrowserFont>()
const assets = new Map<string, Promise<FontAsset>>()
let databasePromise: Promise<IDBDatabase> | undefined

function database(): Promise<IDBDatabase> {
  if (!databasePromise) databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('此浏览器不支持保存字体，请使用支持 IndexedDB 的浏览器。'))
    const request = indexedDB.open('folio-fonts', 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('descriptors', { keyPath: 'id' })
      request.result.createObjectStore('files', { keyPath: 'id' })
    }
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); databasePromise = undefined }
      resolve(request.result)
    }
    request.onerror = () => reject(request.error ?? new Error('无法打开字体存储。'))
    request.onblocked = () => reject(new Error('字体存储正在升级，请关闭其他阅读器标签页后重试。'))
  }).catch((error: unknown) => { databasePromise = undefined; throw error })
  return databasePromise
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('读取已保存字体失败。'))
  })
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('')
}

async function persistFonts(fonts: FontDescriptor[], bytes: Uint8Array): Promise<void> {
  const fileId = await digest(bytes)
  const db = await database()
  const transaction = db.transaction(['descriptors', 'files'], 'readwrite')
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('字体保存失败，可能是本地存储空间不足。'))
    transaction.onabort = () => reject(transaction.error ?? new Error('字体保存已中止。'))
  })
  transaction.objectStore('files').put({ id: fileId, bytes })
  for (const font of fonts) transaction.objectStore('descriptors').put({ ...font, fileId })
  await done
}

async function savedFont(id: string): Promise<FontAsset | undefined> {
  const db = await database()
  const descriptor = await requestValue<StoredDescriptor | undefined>(db.transaction('descriptors').objectStore('descriptors').get(id))
  if (!descriptor) return undefined
  const file = await requestValue<{ id: string; bytes: Uint8Array } | undefined>(db.transaction('files').objectStore('files').get(descriptor.fileId))
  if (!file) return undefined
  const { fileId: _fileId, ...metadata } = descriptor
  return { ...metadata, bytes: file.bytes }
}

async function localFontList(refresh = false): Promise<FontDescriptor[] | null> {
  return fetch(`/api/fonts${refresh ? '?refresh=1' : ''}`, { signal: AbortSignal.timeout(30_000), cache: 'no-store' }).then(async response => {
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return null
    const value: unknown = await response.json()
    return Array.isArray(value) ? value as FontDescriptor[] : null
  }).catch(() => null)
}

/** Never prompts for browser font permission; the local Vite server supplies OS font metadata. */
export async function getAvailableFonts(): Promise<FontDescriptor[]> {
  const [local, saved] = await Promise.all([
    localFontList(),
    database().then((db) => requestValue<StoredDescriptor[]>(db.transaction('descriptors').objectStore('descriptors').getAll())).catch(() => [] as StoredDescriptor[]),
  ])
  // Fresh OS names take precedence over old metadata cached before localized names were supported.
  for (const descriptor of [...saved, ...(local ?? [])]) {
    if (descriptor.id && descriptor.family && descriptor.fullName) {
      const { id, family, fullName, localizedFullName, aliases, postscriptName, style, weight, italic, source } = descriptor
      descriptors.set(id, { id, family, fullName, localizedFullName, aliases, postscriptName, style, weight, italic, source })
    }
  }
  return [...descriptors.values()].sort((a, b) => a.source === 'bundled' ? -1 : b.source === 'bundled' ? 1 : a.family.localeCompare(b.family) || a.fullName.localeCompare(b.fullName))
}

/** Refresh the local service first; a static deployment can request browser permission explicitly. */
export async function requestBrowserFonts(): Promise<FontDescriptor[]> {
  const local = await localFontList(true)
  if (local) {
    for (const descriptor of local) descriptors.set(descriptor.id, descriptor)
    return local
  }
  const query = (window as unknown as { queryLocalFonts?: () => Promise<BrowserFont[]> }).queryLocalFonts
  if (!query) throw new Error('此浏览器不支持系统字体访问，请本地运行阅读器，或导入 OTF / TTF 字体文件。')
  let available: BrowserFont[]
  try { available = await query.call(window) } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') throw new Error('未获得系统字体访问权限。你仍可以使用内置字体或导入字体文件。')
    throw new Error('浏览器无法读取系统字体，请重试或导入字体文件。')
  }
  const result: FontDescriptor[] = []
  for (const font of available) {
    const id = `browser-${await digest(new TextEncoder().encode(font.postscriptName || font.fullName))}`
    const descriptor: FontDescriptor = {
      id, family: font.family, fullName: font.fullName, postscriptName: font.postscriptName, style: font.style,
      weight: /bold|heavy|black/i.test(font.style) ? 700 : /light|thin/i.test(font.style) ? 300 : 400,
      italic: /italic|oblique/i.test(font.style), source: 'browser',
    }
    browserFonts.set(id, font)
    descriptors.set(id, descriptor)
    result.push(descriptor)
  }
  return result
}

async function parsedFonts(bytes: Uint8Array): Promise<RuntimeFont[]> {
  const fontkit = (await import('@pdf-lib/fontkit')).default
  const parsed = fontkit.create(bytes) as unknown as RuntimeFont
  return parsed.fonts ?? [parsed]
}

export async function importFont(file: File): Promise<FontDescriptor[]> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let faces: RuntimeFont[]
  try { faces = await parsedFonts(bytes) } catch {
    throw new Error('无法解析此字体。请导入有效的 TTF、OTF、TTC、OTC、WOFF 或 WOFF2 文件。')
  }
  const hash = await digest(bytes)
  const imported: FontDescriptor[] = faces.map((face, index) => {
    const style = face.subfamilyName || 'Regular'
    return {
      id: `imported-${hash}-${index}`, family: face.familyName || file.name,
      fullName: face.fullName || face.postscriptName || file.name,
      ...localizedNames(face),
      postscriptName: face.postscriptName || '', style,
      weight: face['OS/2']?.usWeightClass || (/bold/i.test(style) ? 700 : 400),
      italic: Boolean(face.italicAngle || face.head?.macStyle?.italic || /italic|oblique/i.test(style)), source: 'imported',
    }
  })
  if (!imported.length) throw new Error('此字体集合没有可用的字体。')
  await persistFonts(imported, bytes)
  for (const descriptor of imported) descriptors.set(descriptor.id, descriptor)
  return imported
}

function quoted(value: string): string { return JSON.stringify(value) }

/** Extract a standalone sfnt from a TTC/OTC face; browsers cannot reliably choose a collection face. */
function standaloneSfnt(bytes: Uint8Array, offset: number): Uint8Array {
  const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = input.getUint16(offset + 4)
  const headerSize = 12 + count * 16
  let length = headerSize
  const tables: { source: number; target: number; length: number; tag: number }[] = []
  for (let index = 0; index < count; index++) {
    const record = offset + 12 + index * 16
    const tableLength = input.getUint32(record + 12)
    tables.push({ source: input.getUint32(record + 8), target: length, length: tableLength, tag: input.getUint32(record) })
    length += (tableLength + 3) & ~3
  }
  const output = new Uint8Array(length)
  output.set(bytes.subarray(offset, offset + headerSize))
  const view = new DataView(output.buffer)
  let headOffset = -1
  for (const [index, table] of tables.entries()) {
    if (table.source + table.length > bytes.length) throw new Error('字体集合的字表数据不完整。')
    output.set(bytes.subarray(table.source, table.source + table.length), table.target)
    view.setUint32(12 + index * 16 + 8, table.target)
    if (table.tag === 0x68656164) { headOffset = table.target; view.setUint32(headOffset + 8, 0) }
    let checksum = 0
    for (let position = table.target; position < table.target + table.length; position += 4) checksum = (checksum + view.getUint32(position)) >>> 0
    view.setUint32(12 + index * 16 + 4, checksum)
  }
  if (headOffset >= 0) {
    let checksum = 0
    for (let position = 0; position < output.length; position += 4) checksum = (checksum + view.getUint32(position)) >>> 0
    view.setUint32(headOffset + 8, (0xb1b0afba - checksum) >>> 0)
  }
  return output
}

async function browserBytes(asset: FontAsset): Promise<Uint8Array> {
  const bytes = asset.bytes
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length >= 12 && view.getUint32(0) === 0x74746366) {
    const faces = await parsedFonts(bytes)
    const index = faces.findIndex((face) => face.postscriptName === asset.postscriptName)
    if (index < 0) throw new Error('字体集合中找不到所选字体。')
    return standaloneSfnt(bytes, view.getUint32(12 + index * 4))
  }
  // Datafork fontkit exposes a face-local sfnt buffer, which can also be used by FontFace.
  if (bytes.length >= 4 && ![0x00010000, 0x4f54544f, 0x74727565, 0x774f4646, 0x774f4632].includes(view.getUint32(0))) {
    const faces = await parsedFonts(bytes)
    const face = faces.find((candidate) => candidate.postscriptName === asset.postscriptName)
    if (face?.stream?.buffer) return standaloneSfnt(face.stream.buffer, 0)
  }
  return bytes
}

async function registerFont(asset: FontAsset): Promise<void> {
  const alias = fontCssFamily(asset.id)
  const faceStyle: FontFaceDescriptors = { weight: String(asset.weight), style: asset.italic ? 'italic' : 'normal' }
  let face: FontFace | undefined
  if (asset.source === 'system' || asset.source === 'browser') {
    const names = [...new Set([asset.postscriptName, asset.fullName].filter(Boolean))]
    if (names.length) {
      try { face = await new FontFace(alias, names.map((name) => `local(${quoted(name)})`).join(', '), faceStyle).load() } catch { /* Use persisted bytes when the original OS font is unavailable. */ }
    }
  }
  if (!face) {
    try { face = await new FontFace(alias, Uint8Array.from(await browserBytes(asset)).buffer, faceStyle).load() } catch {
      throw new Error(`字体“${asset.fullName}”可读取，但浏览器无法渲染此字体格式。请选择其他字体或导入 TTF / OTF 文件。`)
    }
  }
  document.fonts.add(face)
}

/** Loads, persists and registers the exact selected face before layout or PDF export. */
export async function ensureFont(id: string): Promise<FontAsset> {
  const cached = assets.get(id)
  if (cached) return cached
  const pending = (async () => {
    let asset = await savedFont(id)
    let refreshDescriptor: FontDescriptor | undefined
    if (asset) {
      try {
        await registerFont(asset)
        const { bytes: _bytes, ...metadata } = asset
        descriptors.set(asset.id, metadata)
        return asset
      } catch (error) {
        if (asset.source !== 'bundled' && asset.source !== 'system') throw error
        // Repair only this unreadable cache entry. Valid saved fonts never require network access.
        const { bytes: _bytes, ...metadata } = asset
        refreshDescriptor = metadata
        asset = undefined
      }
    }
    if (!asset) {
      if (!descriptors.has(id)) await getAvailableFonts()
      const descriptor = refreshDescriptor ?? descriptors.get(id)
      if (!descriptor) throw new Error('找不到所选字体。请重新选择或导入此字体。')
      let bytes: Uint8Array
      if (descriptor.source === 'browser') {
        const browserFont = browserFonts.get(id)
        if (!browserFont) throw new Error('此浏览器字体尚未保存，请点击“授权系统字体”重新授权。')
        bytes = new Uint8Array(await (await browserFont.blob()).arrayBuffer())
      } else if (descriptor.source === 'imported') {
        throw new Error('已导入字体的数据不存在，请重新导入原字体文件。')
      } else {
        const url = descriptor.source === 'bundled' ? `${import.meta.env.BASE_URL}fonts/NotoSansCJKsc-Regular.otf` : `/api/fonts/${encodeURIComponent(id)}`
        const response = await fetch(url, refreshDescriptor ? { cache: 'reload' } : undefined)
        if (!response.ok) throw new Error(`无法加载字体“${descriptor.fullName}”，请重新导入字体或使用内置字体。`)
        bytes = new Uint8Array(await response.arrayBuffer())
      }
      asset = { ...descriptor, bytes }
      await registerFont(asset)
      await persistFonts([descriptor], bytes)
    }
    const { bytes: _bytes, ...metadata } = asset
    descriptors.set(asset.id, metadata)
    return asset
  })().catch((error: unknown) => { assets.delete(id); throw error })
  assets.set(id, pending)
  return pending
}

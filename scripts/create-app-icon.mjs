import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'

if (process.platform !== 'darwin') throw new Error('Generating the macOS app icon requires macOS and iconutil.')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resources = path.join(root, 'desktop/resources')
const temporary = await mkdtemp(path.join(tmpdir(), 'expdf-icon-'))
try {
  const iconset = path.join(temporary, 'ExPDF.iconset')
  await mkdir(iconset)
  await mkdir(resources, { recursive: true })
  const source = await readFile(path.join(root, 'assets/brand/expdf-icon.png'))
  const image = await loadImage(source)
  const master = createCanvas(1024, 1024)
  const context = master.getContext('2d')
  context.imageSmoothingQuality = 'high'
  // Preserve the selected artwork and alpha, with breathing room for the Dock.
  context.drawImage(image, 32, 32, 960, 960)
  await writeFile(path.join(resources, 'icon.png'), await master.encode('png'))
  const favicon = createCanvas(256, 256)
  const faviconContext = favicon.getContext('2d')
  faviconContext.imageSmoothingQuality = 'high'
  faviconContext.drawImage(image, 0, 0, 256, 256)
  await writeFile(path.join(root, 'public/favicon.png'), await favicon.encode('png'))
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = size * scale
      const canvas = createCanvas(pixels, pixels)
      const drawing = canvas.getContext('2d')
      drawing.imageSmoothingQuality = 'high'
      drawing.drawImage(master, 0, 0, pixels, pixels)
      await writeFile(path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`), await canvas.encode('png'))
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', '-o', path.join(resources, 'icon.icns'), iconset])
  console.log('Created desktop/resources/icon.icns, icon.png and public/favicon.png from assets/brand/expdf-icon.png')
} finally {
  await rm(temporary, { recursive: true, force: true })
}

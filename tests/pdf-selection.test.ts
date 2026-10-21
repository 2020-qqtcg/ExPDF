import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeSelectionRects } from '../src/lib/pdf-selection'

test('merges overlapping, duplicate and adjacent selection fragments on each native PDF line', () => {
  assert.deepEqual(mergeSelectionRects([
    { x: 10, y: 50, width: 35, height: 12 },
    { x: 10, y: 50, width: 35, height: 12 },
    { x: 40, y: 50.2, width: 30, height: 11.8 },
    { x: 71, y: 50, width: 20, height: 12 },
    { x: 10, y: 30, width: 60, height: 12 },
  ]), [{ x: 10, y: 50, width: 81, height: 12 }, { x: 10, y: 30, width: 60, height: 12 }])
})

test('preserves separate columns and lines while leaving original geometry untouched', () => {
  const rects = [{ x: 10, y: 50, width: 35, height: 12 }, { x: 80, y: 50, width: 20, height: 12 }, { x: 10, y: 37, width: 35, height: 12 }]
  const copy = structuredClone(rects)
  assert.deepEqual(mergeSelectionRects(rects), copy)
  assert.deepEqual(rects, copy)
})

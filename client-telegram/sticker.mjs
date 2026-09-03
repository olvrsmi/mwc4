// sticker.mjs - a still turned into something Telegram will not stretch.
//
// Scene art is people and places cut out of their background, and a photo is
// the wrong envelope for that: Telegram fits a photo to the width of the
// message column, so a portrait either stretches or gets a blurred copy of
// itself painted in behind it, and the cut-out is exactly what that destroys.
// A sticker is the one kind Telegram neither scales to the column nor pads,
// and it keeps the alpha channel.
//
// The conversion is not optional. sendSticker takes ".WEBP, .TGS or .WEBM" on
// upload - PNG is allowed when building a sticker SET, not when sending one -
// and the format wants one side exactly 512 with the other 512 or less. Every
// piece of art here is 1024 square, so all of it needs resizing regardless.

import { createCanvas, loadImage } from '@napi-rs/canvas'
import { statSync } from 'node:fs'

export const STICKER_SIDE = 512

/** A gif goes through sendAnimation; a still becomes a sticker. */
export const isAnimation = (file) => /\.gif$/i.test(file || '')

const canvasOf = (w, h) => {
  const c = createCanvas(w, h)
  return { canvas: c, ctx: c.getContext('2d') }
}

/**
 * Resample with nearest neighbour, written out rather than left to
 * `imageSmoothingEnabled = false` - what that flag does to a 4x upscale is
 * skia's business, and this has to be the same on every machine. The hard
 * pixel edge is the point, not an artefact to be tolerated.
 *
 * The source column index is computed once per destination column rather than
 * once per pixel, and every index is clamped so the last row and column cannot
 * read past the buffer.
 */
export function nearest (image, w, h) {
  const { ctx } = canvasOf(image.width, image.height)
  ctx.drawImage(image, 0, 0)
  const src = ctx.getImageData(0, 0, image.width, image.height).data
  const out = canvasOf(w, h)
  const dst = out.ctx.createImageData(w, h)
  const xs = new Uint32Array(w)
  for (let x = 0; x < w; x++) xs[x] = Math.min(image.width - 1, (x * image.width / w) | 0)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(image.height - 1, (y * image.height / h) | 0)
    const srow = sy * image.width * 4
    const drow = y * w * 4
    for (let x = 0; x < w; x++) {
      const s = srow + xs[x] * 4
      const t = drow + x * 4
      dst.data[t] = src[s]
      dst.data[t + 1] = src[s + 1]
      dst.data[t + 2] = src[s + 2]
      dst.data[t + 3] = src[s + 3]
    }
  }
  out.ctx.putImageData(dst, 0, 0)
  return out.canvas
}

/**
 * Async because canvas's own loadImage is, and the synchronous Image cannot be
 * trusted here: assigning a Buffer to `src` reports complete = true and draws
 * correctly into a small canvas, then draws NOTHING at 512, which comes back
 * as a valid, correctly sized, entirely empty sticker. The only tell is weight,
 * about 1KB against 17KB for the same picture, which is why the selftest
 * weighs the output rather than only measuring it.
 */
async function buildSticker (file) {
  const img = await loadImage(file)
  const scale = STICKER_SIDE / Math.max(img.width, img.height)
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))
  // The long side has to land on exactly 512, and rounding the short one can
  // leave the long one a pixel out on an odd aspect ratio.
  const [tw, th] = img.width >= img.height
    ? [STICKER_SIDE, Math.min(STICKER_SIDE, h)]
    : [Math.min(STICKER_SIDE, w), STICKER_SIDE]

  // Shrinking a drawing wants the averaging; blowing up something small enough
  // to need it (tower.png is 128) wants its edges kept rather than guessed at.
  if (scale > 1) return nearest(img, tw, th).toBuffer('image/webp')
  const { canvas, ctx } = canvasOf(tw, th)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, tw, th)
  return canvas.toBuffer('image/webp')
}

/**
 * The sticker for a file, converted once and kept against its mtime - so a
 * redrawn picture is picked up without a restart, and a second send is free.
 *
 * In memory rather than on disk: at ~17KB a piece there is no reason to want a
 * disk cache, and on a deployed box the app directory is not ours to write.
 */
const stickers = new Map()

export async function stickerOf (file) {
  const stamp = statSync(file).mtimeMs
  const had = stickers.get(file)
  if (had && had.stamp === stamp) return had.webp
  const webp = await buildSticker(file)
  stickers.set(file, { stamp, webp })
  return webp
}

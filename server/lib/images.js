import crypto from 'node:crypto'
import sharp from 'sharp'
import { config } from '../config.js'
import { AppError, badRequest } from './errors.js'

/** Detect the real format from magic bytes — never trust the filename or the MIME header. */
export function sniff(buf) {
  if (buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp'
  return null
}

export const cleanName = (n) =>
  String(n || 'image').normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\.{2,}/g, '.').slice(0, 80) || 'image'

/**
 * Validate and re-encode an uploaded image. Re-encoding through sharp strips metadata (EXIF/GPS) and
 * any appended payloads, so a polyglot file cannot be served back as something else.
 */
export async function processImage(file) {
  if (!file?.buffer?.length) throw badRequest('Empty file', undefined, 'IMAGE_INVALID')
  if (file.size > config.maxImageBytes) throw new AppError(413, 'IMAGE_TOO_LARGE', `Image is larger than ${Math.round(config.maxImageBytes / 1048576)} MB`)
  const kind = sniff(file.buffer)
  if (!kind) throw badRequest(`"${cleanName(file.originalname)}" is not a JPEG, PNG or WebP image`, undefined, 'IMAGE_TYPE')
  let meta
  try {
    meta = await sharp(file.buffer, { limitInputPixels: 64_000_000, failOn: 'error' }).metadata()
  } catch {
    throw badRequest(`"${cleanName(file.originalname)}" is corrupt or not a valid image`, undefined, 'IMAGE_INVALID')
  }
  const { width = 0, height = 0 } = meta
  if (width < config.minImageWidth || height < config.minImageHeight)
    throw badRequest(`Image is too small (${width}×${height}). Minimum is ${config.minImageWidth}×${config.minImageHeight}`, undefined, 'IMAGE_DIMENSIONS')
  if (width > config.maxImageDimension || height > config.maxImageDimension)
    throw badRequest(`Image is too large (${width}×${height}). Maximum is ${config.maxImageDimension}px on either side`, undefined, 'IMAGE_DIMENSIONS')

  const pipeline = () => sharp(file.buffer, { limitInputPixels: 64_000_000 }).rotate() // honour EXIF orientation, then drop it
  const main = await pipeline().resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true })
  const thumb = await pipeline().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp({ quality: 74 }).toBuffer()
  const id = crypto.randomUUID()
  return {
    key: `halls/${id}.webp`,
    main: main.data,
    thumb,
    width: main.info.width,
    height: main.info.height,
    size: main.data.length,
    originalName: cleanName(file.originalname),
  }
}

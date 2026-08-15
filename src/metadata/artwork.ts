import type { ArtworkRecord } from '../types'

export async function normalizeArtwork(albumId: string, input: Blob): Promise<ArtworkRecord> {
  const id = `art:${albumId}`
  if (!('createImageBitmap' in window)) {
    return { id, albumId, blob: input, mimeType: input.type || 'image/jpeg' }
  }

  try {
    const bitmap = await createImageBitmap(input)
    const max = 1024
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    if (scale === 1) {
      bitmap.close()
      return { id, albumId, blob: input, mimeType: input.type || 'image/jpeg', width, height }
    }

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas unavailable')
    context.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Artwork conversion failed')), 'image/webp', 0.9)
    })
    return { id, albumId, blob, mimeType: blob.type || 'image/webp', width, height }
  } catch {
    return { id, albumId, blob: input, mimeType: input.type || 'image/jpeg' }
  }
}

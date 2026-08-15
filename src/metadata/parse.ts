import { parseBlob, selectCover } from 'music-metadata'
import type { TrackRecord } from '../types'
import { extractLyrics } from './lyrics'

export interface ParsedTrackResult {
  track: TrackRecord
  cover?: Blob
}

function safeNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function stripExtension(name: string): string {
  return name.replace(/\.flac$/i, '')
}

function parseTrackNumberFromFilename(name: string): number | undefined {
  const match = stripExtension(name).match(/^\s*(\d{1,3})(?:\s*[-._)]|\s+)/)
  return match ? safeNumber(match[1]) : undefined
}

function parseDiscFromPath(relativePath: string): number | undefined {
  const segments = relativePath.split('/')
  for (const segment of segments.slice(2, -1)) {
    const match = segment.match(/^(?:disc|disk|cd)\s*[-_. ]?(\d{1,2})$/i)
    if (match) return safeNumber(match[1])
  }
  return undefined
}

function sourceFallbacks(relativePath: string): { artist: string; album: string } {
  const segments = relativePath.split('/')
  return {
    artist: segments[0] || 'Unknown Artist',
    album: segments[1] || 'Unknown Album'
  }
}

export async function parseFlac(file: File, relativePath: string, sourceAlbumPath: string): Promise<ParsedTrackResult> {
  const metadata = await parseBlob(file, { duration: true })
  const common = metadata.common
  const fallback = sourceFallbacks(relativePath)
  const lyrics = extractLyrics(metadata)
  const trackNo = common.track?.no ?? parseTrackNumberFromFilename(file.name)
  const discNo = common.disk?.no ?? parseDiscFromPath(relativePath) ?? 1

  const track: TrackRecord = {
    id: relativePath,
    relativePath,
    sourceAlbumPath,
    fileName: file.name,
    fileSize: file.size,
    lastModified: file.lastModified,
    title: common.title?.trim() || stripExtension(file.name),
    artist: common.artist?.trim() || fallback.artist,
    album: common.album?.trim() || fallback.album,
    albumArtist: common.albumartist?.trim() || fallback.artist,
    trackNumber: safeNumber(trackNo),
    trackTotal: safeNumber(common.track?.of),
    discNumber: safeNumber(discNo) ?? 1,
    discTotal: safeNumber(common.disk?.of),
    durationSeconds: safeNumber(metadata.format.duration),
    lyricsKind: lyrics.syncedLyrics?.length ? 'synced' : lyrics.plainLyrics ? 'plain' : 'none',
    rawLyrics: lyrics.rawLyrics,
    plainLyrics: lyrics.plainLyrics,
    syncedLyrics: lyrics.syncedLyrics
  }

  const picture = selectCover(common.picture)
  let cover: Blob | undefined
  if (picture?.data?.byteLength) {
    const data = new Uint8Array(picture.data)
    cover = new Blob([data], { type: picture.format || 'image/jpeg' })
  }

  return { track, cover }
}

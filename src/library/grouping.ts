import type { AlbumRecord, TrackRecord } from '../types'

function compareTracks(a: TrackRecord, b: TrackRecord): number {
  return a.discNumber - b.discNumber
    || (a.trackNumber ?? Number.MAX_SAFE_INTEGER) - (b.trackNumber ?? Number.MAX_SAFE_INTEGER)
    || a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: 'base' })
}

function mostCommon(values: Array<string | undefined>, fallback: string): string {
  const counts = new Map<string, number>()
  for (const value of values) {
    const cleaned = value?.trim()
    if (!cleaned) continue
    counts.set(cleaned, (counts.get(cleaned) ?? 0) + 1)
  }
  let best = fallback
  let bestCount = -1
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}

export function sourceAlbumPathFor(relativePath: string): string {
  const parts = relativePath.split('/').filter(Boolean)
  if (parts.length >= 3) return `${parts[0]}/${parts[1]}`
  if (parts.length === 2) return parts[0]
  return '.'
}

export function buildAlbums(tracks: TrackRecord[], artworkAlbumIds: Set<string>): AlbumRecord[] {
  const groups = new Map<string, TrackRecord[]>()
  for (const track of tracks) {
    const list = groups.get(track.sourceAlbumPath) ?? []
    list.push(track)
    groups.set(track.sourceAlbumPath, list)
  }

  return [...groups.entries()].map(([sourceAlbumPath, group]) => {
    group.sort(compareTracks)
    const pathParts = sourceAlbumPath.split('/')
    const fallbackArtist = pathParts[0] || 'Unknown Artist'
    const fallbackAlbum = pathParts[1] || 'Unknown Album'
    const title = mostCommon(group.map((track) => track.album), fallbackAlbum)
    const albumArtist = mostCommon(group.map((track) => track.albumArtist), fallbackArtist)
    const artist = mostCommon(group.map((track) => track.artist), albumArtist)
    const discCount = Math.max(1, ...group.map((track) => track.discNumber || 1))
    return {
      id: sourceAlbumPath,
      sourceAlbumPath,
      title,
      artist,
      albumArtist,
      artworkId: artworkAlbumIds.has(sourceAlbumPath) ? `art:${sourceAlbumPath}` : undefined,
      trackIds: group.map((track) => track.id),
      discCount,
      sortTitle: title.toLocaleLowerCase()
    }
  }).sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }))
}

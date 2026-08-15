import { db } from '../db/db'
import { normalizeArtwork } from '../metadata/artwork'
import { parseFlac } from '../metadata/parse'
import type { DirectoryHandleLike, ScanProgress, TrackRecord } from '../types'
import { buildAlbums, sourceAlbumPathFor } from './grouping'

interface FoundFile {
  relativePath: string
  handle: { getFile(): Promise<File> }
  file: File
  sourceAlbumPath: string
}

async function enumerateFlacs(root: DirectoryHandleLike, onDiscovered: (count: number, path: string) => void): Promise<FoundFile[]> {
  const files: FoundFile[] = []

  async function walk(directory: DirectoryHandleLike, prefix: string): Promise<void> {
    for await (const [name, handle] of directory.entries()) {
      const relativePath = prefix ? `${prefix}/${name}` : name
      if (handle.kind === 'directory') {
        await walk(handle, relativePath)
        continue
      }
      if (!/\.flac$/i.test(name)) continue
      const file = await handle.getFile()
      files.push({
        relativePath,
        handle,
        file,
        sourceAlbumPath: sourceAlbumPathFor(relativePath)
      })
      onDiscovered(files.length, relativePath)
    }
  }

  await walk(root, '')
  return files
}

export async function scanLibrary(
  root: DirectoryHandleLike,
  mode: 'initial' | 'rescan',
  onProgress: (progress: ScanProgress) => void
): Promise<ScanProgress> {
  const progress: ScanProgress = {
    phase: 'enumerating',
    discovered: 0,
    processed: 0,
    added: 0,
    updated: 0,
    removed: 0,
    warnings: []
  }
  const emit = () => onProgress({ ...progress, warnings: [...progress.warnings] })
  emit()

  const ignored = new Set((await db.ignoredAlbums.toArray()).map((record) => record.sourceAlbumPath))
  const existingTracks = new Map((await db.tracks.toArray()).map((track) => [track.relativePath, track]))

  let found: FoundFile[]
  try {
    found = await enumerateFlacs(root, (count, path) => {
      progress.discovered = count
      progress.currentPath = path
      emit()
    })
  } catch (error) {
    throw new Error(`Library enumeration failed before reconciliation: ${error instanceof Error ? error.message : String(error)}`)
  }

  progress.phase = 'parsing'
  emit()
  const visited = new Set<string>()

  for (const entry of found) {
    if (ignored.has(entry.sourceAlbumPath)) continue
    visited.add(entry.relativePath)
    progress.currentPath = entry.relativePath
    const previous = existingTracks.get(entry.relativePath)
    const unchanged = previous
      && previous.fileSize === entry.file.size
      && previous.lastModified === entry.file.lastModified

    if (unchanged) {
      progress.processed += 1
      emit()
      continue
    }

    try {
      const parsed = await parseFlac(entry.file, entry.relativePath, entry.sourceAlbumPath)
      await db.tracks.put(parsed.track)
      if (parsed.cover) {
        const existingArtwork = await db.artwork.get(`art:${entry.sourceAlbumPath}`)
        if (!existingArtwork || previous) {
          const artwork = await normalizeArtwork(entry.sourceAlbumPath, parsed.cover)
          await db.artwork.put(artwork)
        }
      }
      if (previous) progress.updated += 1
      else progress.added += 1
    } catch (error) {
      const message = `${entry.relativePath}: ${error instanceof Error ? error.message : String(error)}`
      progress.warnings.push(message)
      if (previous) {
        await db.tracks.update(previous.id, { parseWarning: message })
      }
    }
    progress.processed += 1
    emit()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }

  progress.phase = 'reconciling'
  progress.currentPath = undefined
  emit()

  // Only after enumeration completed successfully do we interpret absence as deletion.
  if (mode === 'rescan') {
    const missing = [...existingTracks.values()].filter((track) => !ignored.has(track.sourceAlbumPath) && !visited.has(track.relativePath))
    if (missing.length) {
      const missingIds = new Set(missing.map((track) => track.id))
      await db.transaction('rw', db.tracks, db.playlists, db.playback, async () => {
        await db.tracks.bulkDelete([...missingIds])
        const playlists = await db.playlists.toArray()
        for (const playlist of playlists) {
          const next = playlist.trackIds.filter((id) => !missingIds.has(id))
          if (next.length !== playlist.trackIds.length) {
            await db.playlists.put({ ...playlist, trackIds: next, updatedAt: Date.now() })
          }
        }
        const playback = await db.playback.get('global')
        if (playback) {
          const baseQueueTrackIds = playback.baseQueueTrackIds.filter((id) => !missingIds.has(id))
          const playOrderTrackIds = playback.playOrderTrackIds.filter((id) => !missingIds.has(id))
          const oldCurrent = playback.currentTrackId
          const currentTrackId = oldCurrent && !missingIds.has(oldCurrent)
            ? oldCurrent
            : playOrderTrackIds[Math.min(playback.currentIndex, Math.max(0, playOrderTrackIds.length - 1))]
          const currentIndex = currentTrackId ? Math.max(0, playOrderTrackIds.indexOf(currentTrackId)) : 0
          await db.playback.put({
            ...playback,
            baseQueueTrackIds,
            playOrderTrackIds,
            currentTrackId,
            currentIndex,
            positionSeconds: currentTrackId === oldCurrent ? playback.positionSeconds : 0,
            updatedAt: Date.now()
          })
        }
      })
      progress.removed = missing.length
    }
  }

  const tracks = await db.tracks.toArray()
  const artwork = await db.artwork.toArray()
  const artworkAlbumIds = new Set(artwork.map((item) => item.albumId))
  const albums = buildAlbums(tracks, artworkAlbumIds)
  const albumIds = new Set(albums.map((album) => album.id))
  const orphanArtwork = artwork.filter((item) => !albumIds.has(item.albumId)).map((item) => item.id)

  await db.transaction('rw', db.albums, db.artwork, db.sources, async () => {
    await db.albums.clear()
    if (albums.length) await db.albums.bulkPut(albums)
    if (orphanArtwork.length) await db.artwork.bulkDelete(orphanArtwork)
    await db.sources.put({
      id: 'primary',
      rootHandle: root,
      rootName: root.name,
      connectedAt: (await db.sources.get('primary'))?.connectedAt ?? Date.now(),
      lastSuccessfulScanAt: Date.now(),
      scanVersion: 1
    })
  })

  try {
    await navigator.storage?.persist?.()
  } catch {
    // Persistence is opportunistic; lack of it is not fatal.
  }

  progress.phase = 'done'
  progress.currentPath = undefined
  emit()
  return progress
}

export async function removeAlbumFromLibrary(albumId: string): Promise<void> {
  const album = await db.albums.get(albumId)
  if (!album) return
  const trackIds = new Set(album.trackIds)
  await db.transaction(
    'rw',
    [db.albums, db.tracks, db.artwork, db.playlists, db.playback, db.ignoredAlbums],
    async () => {
      await db.albums.delete(album.id)
      await db.tracks.bulkDelete([...trackIds])
      if (album.artworkId) await db.artwork.delete(album.artworkId)
      await db.ignoredAlbums.put({ sourceAlbumPath: album.sourceAlbumPath, ignoredAt: Date.now() })

      const playlists = await db.playlists.toArray()
      for (const playlist of playlists) {
        const next = playlist.trackIds.filter((id) => !trackIds.has(id))
        if (next.length !== playlist.trackIds.length) {
          await db.playlists.put({ ...playlist, trackIds: next, updatedAt: Date.now() })
        }
      }

      const playback = await db.playback.get('global')
      if (playback) {
        const baseQueueTrackIds = playback.baseQueueTrackIds.filter((id) => !trackIds.has(id))
        const playOrderTrackIds = playback.playOrderTrackIds.filter((id) => !trackIds.has(id))
        const currentTrackId = playback.currentTrackId && !trackIds.has(playback.currentTrackId)
          ? playback.currentTrackId
          : playOrderTrackIds[Math.min(playback.currentIndex, Math.max(0, playOrderTrackIds.length - 1))]
        await db.playback.put({
          ...playback,
          baseQueueTrackIds,
          playOrderTrackIds,
          currentTrackId,
          currentIndex: currentTrackId ? Math.max(0, playOrderTrackIds.indexOf(currentTrackId)) : 0,
          positionSeconds: currentTrackId === playback.currentTrackId ? playback.positionSeconds : 0,
          updatedAt: Date.now()
        })
      }
    }
  )
}

export async function restoreIgnoredAlbum(sourceAlbumPath: string): Promise<void> {
  await db.ignoredAlbums.delete(sourceAlbumPath)
}

import { db } from './db'
import type { AppState, AppView, PlaylistRecord } from '../types'

export async function saveView(view: AppView, patch: Partial<AppState> = {}): Promise<void> {
  const current = await db.appState.get('global')
  await db.appState.put({
    id: 'global',
    lastView: view,
    librarySearch: current?.librarySearch ?? '',
    activeAlbumId: current?.activeAlbumId,
    activePlaylistId: current?.activePlaylistId,
    ...patch
  })
}

export async function saveLibrarySearch(librarySearch: string): Promise<void> {
  const current = await db.appState.get('global')
  await db.appState.put({
    id: 'global',
    lastView: current?.lastView ?? 'library',
    activeAlbumId: current?.activeAlbumId,
    activePlaylistId: current?.activePlaylistId,
    librarySearch
  })
}

export async function createPlaylist(name: string): Promise<PlaylistRecord> {
  const now = Date.now()
  const playlist: PlaylistRecord = {
    id: crypto.randomUUID(),
    name: name.trim() || 'Untitled Playlist',
    trackIds: [],
    createdAt: now,
    updatedAt: now
  }
  await db.playlists.put(playlist)
  return playlist
}

export async function addTracksToPlaylist(playlistId: string, trackIds: string[]): Promise<void> {
  const playlist = await db.playlists.get(playlistId)
  if (!playlist) return
  await db.playlists.put({ ...playlist, trackIds: [...playlist.trackIds, ...trackIds], updatedAt: Date.now() })
}

export async function renamePlaylist(playlistId: string, name: string): Promise<void> {
  const playlist = await db.playlists.get(playlistId)
  if (!playlist || !name.trim()) return
  await db.playlists.put({ ...playlist, name: name.trim(), updatedAt: Date.now() })
}

export async function deletePlaylist(playlistId: string): Promise<void> {
  await db.playlists.delete(playlistId)
}

export async function removePlaylistTrack(playlistId: string, index: number): Promise<void> {
  const playlist = await db.playlists.get(playlistId)
  if (!playlist || index < 0 || index >= playlist.trackIds.length) return
  const trackIds = [...playlist.trackIds]
  trackIds.splice(index, 1)
  await db.playlists.put({ ...playlist, trackIds, updatedAt: Date.now() })
}

export async function movePlaylistTrack(playlistId: string, index: number, direction: -1 | 1): Promise<void> {
  const playlist = await db.playlists.get(playlistId)
  if (!playlist) return
  const target = index + direction
  if (index < 0 || target < 0 || index >= playlist.trackIds.length || target >= playlist.trackIds.length) return
  const trackIds = [...playlist.trackIds]
  ;[trackIds[index], trackIds[target]] = [trackIds[target], trackIds[index]]
  await db.playlists.put({ ...playlist, trackIds, updatedAt: Date.now() })
}

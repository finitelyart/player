export type AppView = 'library' | 'album' | 'now-playing' | 'playlists'
export type RepeatMode = 'off' | 'one' | 'all'
export type LyricsKind = 'synced' | 'plain' | 'none'

export interface DirectoryHandleLike {
  kind: 'directory'
  name: string
  entries(): AsyncIterableIterator<[string, FileHandleLike | DirectoryHandleLike]>
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
}

export interface FileHandleLike {
  kind: 'file'
  name: string
  getFile(): Promise<File>
}

export interface LibrarySource {
  id: 'primary'
  rootHandle: DirectoryHandleLike
  rootName: string
  connectedAt: number
  lastSuccessfulScanAt?: number
  scanVersion: number
}

export interface LyricLine {
  timeMs: number
  text: string
}

export interface TrackRecord {
  id: string
  relativePath: string
  sourceAlbumPath: string
  fileName: string
  fileSize: number
  lastModified: number
  title: string
  artist: string
  album: string
  albumArtist?: string
  trackNumber?: number
  trackTotal?: number
  discNumber: number
  discTotal?: number
  durationSeconds?: number
  lyricsKind: LyricsKind
  rawLyrics?: string
  plainLyrics?: string
  syncedLyrics?: LyricLine[]
  parseWarning?: string
}

export interface AlbumRecord {
  id: string
  sourceAlbumPath: string
  title: string
  artist: string
  albumArtist?: string
  artworkId?: string
  trackIds: string[]
  discCount: number
  sortTitle: string
}

export interface ArtworkRecord {
  id: string
  albumId: string
  blob: Blob
  mimeType: string
  width?: number
  height?: number
}

export interface PlaylistRecord {
  id: string
  name: string
  trackIds: string[]
  createdAt: number
  updatedAt: number
}

export interface PlaybackState {
  id: 'global'
  baseQueueTrackIds: string[]
  playOrderTrackIds: string[]
  currentIndex: number
  currentTrackId?: string
  positionSeconds: number
  shuffle: boolean
  repeatMode: RepeatMode
  updatedAt: number
}

export interface AppState {
  id: 'global'
  lastView: AppView
  activeAlbumId?: string
  activePlaylistId?: string
  librarySearch: string
}

export interface IgnoredAlbum {
  sourceAlbumPath: string
  ignoredAt: number
}

export interface AppSettings {
  id: 'global'
  libraryIndexVersion: number
  metadataParserVersion: number
}

export interface ScanProgress {
  phase: 'enumerating' | 'parsing' | 'reconciling' | 'done'
  discovered: number
  processed: number
  added: number
  updated: number
  removed: number
  warnings: string[]
  currentPath?: string
}

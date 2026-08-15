import Dexie, { type Table } from 'dexie'
import type {
  AlbumRecord,
  AppSettings,
  AppState,
  ArtworkRecord,
  IgnoredAlbum,
  LibrarySource,
  PlaybackState,
  PlaylistRecord,
  TrackRecord
} from '../types'

export class MusicDB extends Dexie {
  sources!: Table<LibrarySource, string>
  tracks!: Table<TrackRecord, string>
  albums!: Table<AlbumRecord, string>
  artwork!: Table<ArtworkRecord, string>
  playlists!: Table<PlaylistRecord, string>
  playback!: Table<PlaybackState, string>
  appState!: Table<AppState, string>
  ignoredAlbums!: Table<IgnoredAlbum, string>
  settings!: Table<AppSettings, string>

  constructor() {
    super('local-flac-player')
    this.version(1).stores({
      sources: 'id',
      tracks: 'id, relativePath, sourceAlbumPath, [fileSize+lastModified]',
      albums: 'id, sourceAlbumPath, sortTitle',
      artwork: 'id, albumId',
      playlists: 'id, name, updatedAt',
      playback: 'id',
      appState: 'id',
      ignoredAlbums: 'sourceAlbumPath, ignoredAt',
      settings: 'id'
    })
  }
}

export const db = new MusicDB()

export async function ensureDefaults(): Promise<void> {
  await db.transaction('rw', db.playback, db.appState, db.settings, async () => {
    if (!(await db.playback.get('global'))) {
      await db.playback.put({
        id: 'global',
        baseQueueTrackIds: [],
        playOrderTrackIds: [],
        currentIndex: 0,
        positionSeconds: 0,
        shuffle: false,
        repeatMode: 'off',
        updatedAt: Date.now()
      })
    }
    if (!(await db.appState.get('global'))) {
      await db.appState.put({
        id: 'global',
        lastView: 'library',
        librarySearch: ''
      })
    }
    if (!(await db.settings.get('global'))) {
      await db.settings.put({
        id: 'global',
        libraryIndexVersion: 1,
        metadataParserVersion: 1
      })
    }
  })
}

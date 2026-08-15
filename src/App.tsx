import { useEffect, useMemo, useState } from 'preact/hooks'
import { AlbumCover } from './components/AlbumCover'
import { Lyrics } from './components/Lyrics'
import { db, ensureDefaults } from './db/db'
import {
  addTracksToPlaylist,
  createPlaylist,
  deletePlaylist,
  movePlaylistTrack,
  removePlaylistTrack,
  renamePlaylist,
  saveLibrarySearch,
  saveView
} from './db/operations'
import { chooseMusicRoot, getSavedRoot, queryReadPermission, requestReadPermission, supportsDirectoryPicker } from './library/filesystem'
import { removeAlbumFromLibrary, restoreIgnoredAlbum, scanLibrary } from './library/scan'
import { player, type PlayerSnapshot } from './playback/player'
import type { AlbumRecord, AppState, AppView, IgnoredAlbum, PlaylistRecord, ScanProgress, TrackRecord } from './types'

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

function initialPlayerSnapshot(): PlayerSnapshot {
  return {
    state: {
      id: 'global',
      baseQueueTrackIds: [],
      playOrderTrackIds: [],
      currentIndex: 0,
      positionSeconds: 0,
      shuffle: false,
      repeatMode: 'off',
      updatedAt: Date.now()
    },
    playing: false,
    duration: 0,
    position: 0
  }
}

export function App() {
  const [ready, setReady] = useState(false)
  const [albums, setAlbums] = useState<AlbumRecord[]>([])
  const [tracks, setTracks] = useState<Map<string, TrackRecord>>(new Map())
  const [playlists, setPlaylists] = useState<PlaylistRecord[]>([])
  const [ignored, setIgnored] = useState<IgnoredAlbum[]>([])
  const [view, setView] = useState<AppView>('library')
  const [activeAlbumId, setActiveAlbumId] = useState<string>()
  const [activePlaylistId, setActivePlaylistId] = useState<string>()
  const [search, setSearch] = useState('')
  const [playerSnapshot, setPlayerSnapshot] = useState<PlayerSnapshot>(initialPlayerSnapshot())
  const [permission, setPermission] = useState<PermissionState | 'missing'>('missing')
  const [sourceName, setSourceName] = useState<string>()
  const [scan, setScan] = useState<ScanProgress>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const [playlistPickerTrackIds, setPlaylistPickerTrackIds] = useState<string[]>()

  async function refreshData(): Promise<void> {
    const [nextAlbums, nextTracks, nextPlaylists, nextIgnored] = await Promise.all([
      db.albums.orderBy('sortTitle').toArray(),
      db.tracks.toArray(),
      db.playlists.orderBy('name').toArray(),
      db.ignoredAlbums.orderBy('ignoredAt').reverse().toArray()
    ])
    setAlbums(nextAlbums)
    setTracks(new Map(nextTracks.map((track) => [track.id, track])))
    setPlaylists(nextPlaylists)
    setIgnored(nextIgnored)
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await ensureDefaults()
        await player.init()
        const appState = (await db.appState.get('global')) as AppState | undefined
        const source = await db.sources.get('primary')
        if (source) {
          setSourceName(source.rootName)
          setPermission(await queryReadPermission(source.rootHandle))
        }
        await refreshData()
        if (cancelled) return
        if (appState) {
          setView(appState.lastView)
          setActiveAlbumId(appState.activeAlbumId)
          setActivePlaylistId(appState.activePlaylistId)
          setSearch(appState.librarySearch)
        }
        setPlayerSnapshot(player.snapshot())
        setReady(true)
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError))
        setReady(true)
      }
    })()
    const unsubscribe = player.subscribe(() => setPlayerSnapshot(player.snapshot()))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const filteredAlbums = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    if (!query) return albums
    return albums.filter((album) => `${album.title} ${album.artist} ${album.albumArtist ?? ''}`.toLocaleLowerCase().includes(query))
  }, [albums, search])

  const activeAlbum = activeAlbumId ? albums.find((album) => album.id === activeAlbumId) : undefined
  const activePlaylist = activePlaylistId ? playlists.find((playlist) => playlist.id === activePlaylistId) : undefined

  async function navigate(nextView: AppView, patch: { albumId?: string; playlistId?: string } = {}): Promise<void> {
    setView(nextView)
    if (patch.albumId !== undefined) setActiveAlbumId(patch.albumId)
    if (patch.playlistId !== undefined) setActivePlaylistId(patch.playlistId)
    await saveView(nextView, {
      activeAlbumId: patch.albumId ?? activeAlbumId,
      activePlaylistId: patch.playlistId ?? activePlaylistId
    })
  }

  async function runScan(mode: 'initial' | 'rescan', rootOverride?: Awaited<ReturnType<typeof chooseMusicRoot>>): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      const root = rootOverride ?? await getSavedRoot()
      if (!root) throw new Error('No music folder is connected.')
      if (!rootOverride) {
        const granted = await requestReadPermission(root)
        setPermission(granted)
        if (granted !== 'granted') throw new Error('Read permission for the Music folder was not granted.')
      }
      await scanLibrary(root, mode, setScan)
      setPermission('granted')
      setSourceName(root.name)
      await refreshData()
      await player.reloadPersistedState()
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : String(scanError))
    } finally {
      setBusy(false)
    }
  }

  async function connectFolder(): Promise<void> {
    if (!supportsDirectoryPicker()) {
      setError('Directory selection is unavailable in this browser. Use a current Chrome/Chromium browser with File System Access support.')
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const root = await chooseMusicRoot()
      await db.sources.put({ id: 'primary', rootHandle: root, rootName: root.name, connectedAt: Date.now(), scanVersion: 1 })
      setSourceName(root.name)
      setPermission('granted')
      await runScan('initial', root)
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : String(connectError))
      setBusy(false)
    }
  }

  async function reconnect(): Promise<void> {
    const root = await getSavedRoot()
    if (!root) return connectFolder()
    try {
      const result = await requestReadPermission(root)
      setPermission(result)
      if (result !== 'granted') setError('Music folder permission was not granted.')
      else setError(undefined)
    } catch (permissionError) {
      setError(permissionError instanceof Error ? permissionError.message : String(permissionError))
    }
  }

  async function handleRemoveAlbum(album: AlbumRecord): Promise<void> {
    if (!confirm(`Remove “${album.title}” from this app? The FLAC files in ${album.sourceAlbumPath} will not be changed.`)) return
    await removeAlbumFromLibrary(album.id)
    await refreshData()
    await player.reloadPersistedState()
    setActiveAlbumId(undefined)
    await navigate('library')
  }

  async function handleCreatePlaylist(): Promise<PlaylistRecord | undefined> {
    const name = prompt('Playlist name')
    if (!name?.trim()) return undefined
    const created = await createPlaylist(name)
    await refreshData()
    return created
  }

  async function pickPlaylist(playlistId?: string): Promise<void> {
    if (!playlistPickerTrackIds?.length) return
    let target = playlistId
    if (!target) target = (await handleCreatePlaylist())?.id
    if (!target) return
    await addTracksToPlaylist(target, playlistPickerTrackIds)
    setPlaylistPickerTrackIds(undefined)
    await refreshData()
  }

  if (!ready) return <main class="loading">Opening library…</main>

  return (
    <div class="app-shell">
      <header class="topbar">
        <button class="brand" type="button" onClick={() => void navigate('library')}>Local FLAC</button>
        <div class="top-actions">
          <button type="button" onClick={() => void navigate('playlists')}>Playlists</button>
          <button type="button" aria-label="Settings" onClick={() => setSettingsOpen(true)}>⋯</button>
        </div>
      </header>

      {error && <div class="error-banner">{error}<button type="button" onClick={() => setError(undefined)}>×</button></div>}
      {playerSnapshot.error && <div class="error-banner">{playerSnapshot.error}</div>}

      {busy && scan && (
        <div class="scan-banner">
          <strong>{scan.phase === 'enumerating' ? 'Finding FLAC files' : scan.phase === 'reconciling' ? 'Updating library' : 'Reading metadata'}</strong>
          <span>{scan.discovered} found · {scan.processed} processed</span>
          {scan.currentPath && <small>{scan.currentPath}</small>}
        </div>
      )}

      <main class={playerSnapshot.track && view !== 'now-playing' ? 'main with-mini-player' : 'main'}>
        {view === 'library' && (
          <LibraryView
            albums={filteredAlbums}
            search={search}
            sourceName={sourceName}
            permission={permission}
            busy={busy}
            onSearch={(value) => {
              setSearch(value)
              void saveLibrarySearch(value)
            }}
            onAlbum={(id) => void navigate('album', { albumId: id })}
            onConnect={() => void connectFolder()}
            onReconnect={() => void reconnect()}
          />
        )}

        {view === 'album' && activeAlbum && (
          <AlbumView
            album={activeAlbum}
            tracks={activeAlbum.trackIds.map((id) => tracks.get(id)).filter((track): track is TrackRecord => Boolean(track))}
            onBack={() => void navigate('library')}
            onPlay={(index) => void player.startQueue(activeAlbum.trackIds, index, false).then(() => navigate('now-playing'))}
            onShuffle={() => void player.startQueue(activeAlbum.trackIds, 0, true).then(() => navigate('now-playing'))}
            onQueue={() => void player.addToQueue(activeAlbum.trackIds)}
            onPlaylist={() => setPlaylistPickerTrackIds(activeAlbum.trackIds)}
            onTrackPlaylist={(trackId) => setPlaylistPickerTrackIds([trackId])}
            onRemove={() => void handleRemoveAlbum(activeAlbum)}
          />
        )}

        {view === 'album' && !activeAlbum && (
          <EmptyState title="Album unavailable" action="Back to library" onAction={() => void navigate('library')} />
        )}

        {view === 'now-playing' && (
          <NowPlayingView
            snapshot={playerSnapshot}
            album={playerSnapshot.track ? albums.find((album) => album.id === playerSnapshot.track?.sourceAlbumPath) : undefined}
            onBack={() => void navigate('library')}
            onQueue={() => setQueueOpen(true)}
          />
        )}

        {view === 'playlists' && (
          <PlaylistsView
            playlists={playlists}
            activePlaylist={activePlaylist}
            tracks={tracks}
            onSelect={(id) => {
              setActivePlaylistId(id)
              void saveView('playlists', { activePlaylistId: id })
            }}
            onCreate={() => void handleCreatePlaylist()}
            onRename={async (playlist) => {
              const name = prompt('Playlist name', playlist.name)
              if (name) {
                await renamePlaylist(playlist.id, name)
                await refreshData()
              }
            }}
            onDelete={async (playlist) => {
              if (!confirm(`Delete playlist “${playlist.name}”?`)) return
              await deletePlaylist(playlist.id)
              setActivePlaylistId(undefined)
              await refreshData()
            }}
            onPlay={(playlist) => void player.startQueue(playlist.trackIds, 0, false).then(() => navigate('now-playing'))}
            onQueue={(playlist) => void player.addToQueue(playlist.trackIds)}
            onRemoveTrack={async (playlistId, index) => {
              await removePlaylistTrack(playlistId, index)
              await refreshData()
            }}
            onMoveTrack={async (playlistId, index, direction) => {
              await movePlaylistTrack(playlistId, index, direction)
              await refreshData()
            }}
          />
        )}
      </main>

      {playerSnapshot.track && view !== 'now-playing' && (
        <MiniPlayer snapshot={playerSnapshot} album={albums.find((album) => album.id === playerSnapshot.track?.sourceAlbumPath)} onOpen={() => void navigate('now-playing')} />
      )}

      {settingsOpen && (
        <SettingsSheet
          sourceName={sourceName}
          permission={permission}
          ignored={ignored}
          scan={scan}
          busy={busy}
          onClose={() => setSettingsOpen(false)}
          onConnect={() => void connectFolder()}
          onReconnect={() => void reconnect()}
          onRescan={() => void runScan((scan || albums.length) ? 'rescan' : 'initial')}
          onRestore={async (path) => {
            await restoreIgnoredAlbum(path)
            await refreshData()
            await runScan('rescan')
          }}
        />
      )}

      {queueOpen && (
        <QueueSheet snapshot={playerSnapshot} tracks={tracks} onClose={() => setQueueOpen(false)} />
      )}

      {playlistPickerTrackIds && (
        <PlaylistPicker playlists={playlists} onPick={(id) => void pickPlaylist(id)} onCreate={() => void pickPlaylist()} onClose={() => setPlaylistPickerTrackIds(undefined)} />
      )}
    </div>
  )
}

interface LibraryViewProps {
  albums: AlbumRecord[]
  search: string
  sourceName?: string
  permission: PermissionState | 'missing'
  busy: boolean
  onSearch: (value: string) => void
  onAlbum: (id: string) => void
  onConnect: () => void
  onReconnect: () => void
}

function LibraryView({ albums, search, sourceName, permission, busy, onSearch, onAlbum, onConnect, onReconnect }: LibraryViewProps) {
  if (!sourceName) {
    return <EmptyState title="Your FLAC collection, without copying it" body="Select the Music folder on this phone. Audio stays where it is; only metadata and app state are indexed." action="Connect Music Folder" onAction={onConnect} disabled={busy} />
  }
  return (
    <section class="library-view">
      <div class="library-heading">
        <div>
          <h1>Albums</h1>
          <p class="muted">{albums.length} albums · {sourceName}</p>
        </div>
        {permission !== 'granted' && <button type="button" onClick={onReconnect}>Reconnect</button>}
      </div>
      <label class="search-box">
        <span class="sr-only">Search albums or artists</span>
        <input type="search" value={search} placeholder="Search album or artist" onInput={(event) => onSearch(event.currentTarget.value)} />
      </label>
      {albums.length ? (
        <div class="album-grid">
          {albums.map((album) => (
            <button type="button" class="album-tile" onClick={() => onAlbum(album.id)}>
              <AlbumCover artworkId={album.artworkId} alt={`${album.title} cover`} />
              <strong>{album.title}</strong>
              <span>{album.albumArtist || album.artist}</span>
            </button>
          ))}
        </div>
      ) : (
        <EmptyState
          title={search.trim() ? 'No matching albums' : 'No albums indexed'}
          body={search.trim() ? 'Try a different album or artist name.' : 'Run Rescan Library from the menu if the Music folder contains FLAC files.'}
        />
      )}
    </section>
  )
}

interface AlbumViewProps {
  album: AlbumRecord
  tracks: TrackRecord[]
  onBack: () => void
  onPlay: (index: number) => void
  onShuffle: () => void
  onQueue: () => void
  onPlaylist: () => void
  onTrackPlaylist: (trackId: string) => void
  onRemove: () => void
}

function AlbumView({ album, tracks, onBack, onPlay, onShuffle, onQueue, onPlaylist, onTrackPlaylist, onRemove }: AlbumViewProps) {
  let previousDisc = 0
  return (
    <section class="album-view">
      <button type="button" class="back-button" onClick={onBack}>‹ Albums</button>
      <div class="album-hero">
        <AlbumCover artworkId={album.artworkId} alt={`${album.title} cover`} className="album-hero-cover" />
        <div>
          <h1>{album.title}</h1>
          <p>{album.albumArtist || album.artist}</p>
        </div>
      </div>
      <div class="button-row wrap">
        <button class="primary" type="button" onClick={() => onPlay(0)}>Play Album</button>
        <button type="button" onClick={onShuffle}>Shuffle</button>
        <button type="button" onClick={onQueue}>Add to Queue</button>
        <button type="button" onClick={onPlaylist}>Add to Playlist</button>
      </div>
      <div class="track-list">
        {tracks.map((track, index) => {
          const showDisc = album.discCount > 1 && track.discNumber !== previousDisc
          previousDisc = track.discNumber
          return (
            <div>
              {showDisc && <h2 class="disc-heading">Disc {track.discNumber}</h2>}
              <div class="track-row">
                <button type="button" class="track-main" onClick={() => onPlay(index)}>
                  <span class="track-number">{track.trackNumber ?? '–'}</span>
                  <span><strong>{track.title}</strong>{track.artist !== (album.albumArtist || album.artist) && <small>{track.artist}</small>}</span>
                  <span class="track-duration">{track.durationSeconds ? formatTime(track.durationSeconds) : ''}</span>
                </button>
                <button type="button" class="icon-button" aria-label={`Add ${track.title} to playlist`} onClick={() => onTrackPlaylist(track.id)}>＋</button>
              </div>
            </div>
          )
        })}
      </div>
      <button type="button" class="danger-text" onClick={onRemove}>Remove from Library</button>
      <p class="muted small">This only removes the local app index. Source FLAC files are never deleted.</p>
    </section>
  )
}

function NowPlayingView({ snapshot, album, onBack, onQueue }: { snapshot: PlayerSnapshot; album?: AlbumRecord; onBack: () => void; onQueue: () => void }) {
  const track = snapshot.track
  if (!track) return <EmptyState title="Nothing queued" action="Browse albums" onAction={onBack} />
  const duration = snapshot.duration || track.durationSeconds || 0
  return (
    <section class="now-playing">
      <div class="now-playing-top"><button type="button" onClick={onBack}>‹ Library</button><button type="button" onClick={onQueue}>Queue</button></div>
      <AlbumCover artworkId={album?.artworkId} alt={`${track.album} cover`} className="now-cover" />
      <div class="now-meta"><h1>{track.title}</h1><p>{track.artist}</p><small>{track.album}</small></div>
      <div class="seek-block">
        <input
          aria-label="Playback position"
          type="range"
          min="0"
          max={Math.max(1, duration)}
          step="0.1"
          value={Math.min(snapshot.position, Math.max(1, duration))}
          onInput={(event) => void player.seek(Number(event.currentTarget.value))}
        />
        <div class="time-row"><span>{formatTime(snapshot.position)}</span><span>-{formatTime(Math.max(0, duration - snapshot.position))}</span></div>
      </div>
      <div class="transport">
        <button type="button" class={snapshot.state.shuffle ? 'active-control' : ''} aria-label="Shuffle" onClick={() => void player.toggleShuffle()}>⇄</button>
        <button type="button" aria-label="Previous track" onClick={() => void player.previous()}>◀</button>
        <button type="button" class="play-button" aria-label={snapshot.playing ? 'Pause' : 'Play'} onClick={() => void player.togglePlay()}>{snapshot.playing ? 'Ⅱ' : '▶'}</button>
        <button type="button" aria-label="Next track" onClick={() => void player.next()}>▶</button>
        <button type="button" class={snapshot.state.repeatMode !== 'off' ? 'active-control' : ''} aria-label={`Repeat ${snapshot.state.repeatMode}`} onClick={() => void player.cycleRepeat()}>↻<small>{snapshot.state.repeatMode === 'one' ? '1' : ''}</small></button>
      </div>
      <Lyrics track={track} positionSeconds={snapshot.position} onSeek={(seconds) => void player.seek(seconds)} />
    </section>
  )
}

function MiniPlayer({ snapshot, album, onOpen }: { snapshot: PlayerSnapshot; album?: AlbumRecord; onOpen: () => void }) {
  if (!snapshot.track) return null
  return (
    <div class="mini-player">
      <button class="mini-main" type="button" onClick={onOpen}>
        <AlbumCover artworkId={album?.artworkId} alt="" className="mini-cover" />
        <span><strong>{snapshot.track.title}</strong><small>{snapshot.track.artist}</small></span>
      </button>
      <button type="button" class="mini-play" aria-label={snapshot.playing ? 'Pause' : 'Play'} onClick={() => void player.togglePlay()}>{snapshot.playing ? 'Ⅱ' : '▶'}</button>
    </div>
  )
}

interface PlaylistsViewProps {
  playlists: PlaylistRecord[]
  activePlaylist?: PlaylistRecord
  tracks: Map<string, TrackRecord>
  onSelect: (id: string) => void
  onCreate: () => void
  onRename: (playlist: PlaylistRecord) => void
  onDelete: (playlist: PlaylistRecord) => void
  onPlay: (playlist: PlaylistRecord) => void
  onQueue: (playlist: PlaylistRecord) => void
  onRemoveTrack: (playlistId: string, index: number) => void
  onMoveTrack: (playlistId: string, index: number, direction: -1 | 1) => void
}

function PlaylistsView(props: PlaylistsViewProps) {
  const { playlists, activePlaylist, tracks } = props
  if (activePlaylist) {
    return (
      <section class="playlist-view">
        <button type="button" class="back-button" onClick={() => props.onSelect('')}>‹ Playlists</button>
        <div class="library-heading"><div><h1>{activePlaylist.name}</h1><p class="muted">{activePlaylist.trackIds.length} tracks</p></div><button type="button" onClick={() => props.onRename(activePlaylist)}>Rename</button></div>
        <div class="button-row"><button class="primary" type="button" disabled={!activePlaylist.trackIds.length} onClick={() => props.onPlay(activePlaylist)}>Play</button><button type="button" disabled={!activePlaylist.trackIds.length} onClick={() => props.onQueue(activePlaylist)}>Add to Queue</button></div>
        <div class="track-list">
          {activePlaylist.trackIds.map((id, index) => {
            const track = tracks.get(id)
            if (!track) return null
            return (
              <div class="playlist-track">
                <span class="track-number">{index + 1}</span>
                <span class="grow"><strong>{track.title}</strong><small>{track.artist} · {track.album}</small></span>
                <button type="button" aria-label="Move up" disabled={index === 0} onClick={() => props.onMoveTrack(activePlaylist.id, index, -1)}>↑</button>
                <button type="button" aria-label="Move down" disabled={index === activePlaylist.trackIds.length - 1} onClick={() => props.onMoveTrack(activePlaylist.id, index, 1)}>↓</button>
                <button type="button" aria-label="Remove track" onClick={() => props.onRemoveTrack(activePlaylist.id, index)}>×</button>
              </div>
            )
          })}
        </div>
        <button class="danger-text" type="button" onClick={() => props.onDelete(activePlaylist)}>Delete Playlist</button>
      </section>
    )
  }

  return (
    <section class="playlists-list-view">
      <div class="library-heading"><div><h1>Playlists</h1><p class="muted">Manual playlists stored on this device</p></div><button class="primary" type="button" onClick={props.onCreate}>New</button></div>
      {playlists.length ? <div class="simple-list">{playlists.map((playlist) => <button type="button" onClick={() => props.onSelect(playlist.id)}><span><strong>{playlist.name}</strong><small>{playlist.trackIds.length} tracks</small></span><span>›</span></button>)}</div> : <EmptyState title="No playlists yet" body="Create one, then add tracks or whole albums." />}
    </section>
  )
}

function SettingsSheet({ sourceName, permission, ignored, scan, busy, onClose, onConnect, onReconnect, onRescan, onRestore }: {
  sourceName?: string
  permission: PermissionState | 'missing'
  ignored: IgnoredAlbum[]
  scan?: ScanProgress
  busy: boolean
  onClose: () => void
  onConnect: () => void
  onReconnect: () => void
  onRescan: () => void
  onRestore: (path: string) => void
}) {
  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <section class="sheet" onClick={(event) => event.stopPropagation()}>
        <div class="sheet-heading"><h2>Library</h2><button type="button" onClick={onClose}>×</button></div>
        <dl class="status-list"><div><dt>Folder</dt><dd>{sourceName ?? 'Not connected'}</dd></div><div><dt>Permission</dt><dd>{permission}</dd></div>{scan?.phase === 'done' && <div><dt>Last scan</dt><dd>{scan.added} added · {scan.updated} changed · {scan.removed} removed</dd></div>}</dl>
        <div class="stack-actions">
          {!sourceName && <button class="primary" type="button" disabled={busy} onClick={onConnect}>Connect Music Folder</button>}
          {sourceName && permission !== 'granted' && <button class="primary" type="button" onClick={onReconnect}>Reconnect Music Folder</button>}
          {sourceName && <button type="button" disabled={busy} onClick={onRescan}>{busy ? 'Scanning…' : 'Rescan Library'}</button>}
        </div>
        {ignored.length > 0 && <><h3>Ignored Albums</h3><div class="simple-list compact">{ignored.map((item) => <button type="button" disabled={busy} onClick={() => onRestore(item.sourceAlbumPath)}><span>{item.sourceAlbumPath}</span><span>Restore</span></button>)}</div></>}
        <p class="muted small">The app requests read access only. Removing an album from the library never deletes or changes its FLAC files.</p>
      </section>
    </div>
  )
}

function QueueSheet({ snapshot, tracks, onClose }: { snapshot: PlayerSnapshot; tracks: Map<string, TrackRecord>; onClose: () => void }) {
  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <section class="sheet queue-sheet" onClick={(event) => event.stopPropagation()}>
        <div class="sheet-heading"><h2>Queue</h2><button type="button" onClick={onClose}>×</button></div>
        <div class="queue-list">
          {snapshot.state.playOrderTrackIds.map((id, index) => {
            const track = tracks.get(id)
            if (!track) return null
            return <div class={id === snapshot.state.currentTrackId ? 'queue-row current' : 'queue-row'}><span>{index + 1}</span><span class="grow"><strong>{track.title}</strong><small>{track.artist}</small></span><button type="button" aria-label={`Remove ${track.title}`} onClick={() => void player.removeQueueIndex(index)}>×</button></div>
          })}
        </div>
        {snapshot.state.playOrderTrackIds.length > 0 && <button class="danger-text" type="button" onClick={() => void player.clearQueue()}>Clear Queue</button>}
      </section>
    </div>
  )
}

function PlaylistPicker({ playlists, onPick, onCreate, onClose }: { playlists: PlaylistRecord[]; onPick: (id: string) => void; onCreate: () => void; onClose: () => void }) {
  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <section class="sheet" onClick={(event) => event.stopPropagation()}>
        <div class="sheet-heading"><h2>Add to playlist</h2><button type="button" onClick={onClose}>×</button></div>
        <button class="primary full" type="button" onClick={onCreate}>New Playlist</button>
        <div class="simple-list compact">{playlists.map((playlist) => <button type="button" onClick={() => onPick(playlist.id)}><span>{playlist.name}</span><span>{playlist.trackIds.length}</span></button>)}</div>
      </section>
    </div>
  )
}

function EmptyState({ title, body, action, onAction, disabled = false }: { title: string; body?: string; action?: string; onAction?: () => void; disabled?: boolean }) {
  return <section class="empty-state"><div class="empty-icon">♪</div><h1>{title}</h1>{body && <p>{body}</p>}{action && onAction && <button class="primary" type="button" disabled={disabled} onClick={onAction}>{action}</button>}</section>
}

import { db } from '../db/db'
import { getTrackFile } from '../library/filesystem'
import type { PlaybackState, RepeatMode, TrackRecord } from '../types'

export interface PlayerSnapshot {
  state: PlaybackState
  track?: TrackRecord
  playing: boolean
  duration: number
  position: number
  error?: string
}

function emptyPlayback(): PlaybackState {
  return {
    id: 'global',
    baseQueueTrackIds: [],
    playOrderTrackIds: [],
    currentIndex: 0,
    positionSeconds: 0,
    shuffle: false,
    repeatMode: 'off',
    updatedAt: Date.now()
  }
}

function shuffle<T>(values: T[]): T[] {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1))
    ;[result[index], result[swap]] = [result[swap], result[index]]
  }
  return result
}

class PlayerService extends EventTarget {
  readonly audio = new Audio()
  private state: PlaybackState = emptyPlayback()
  private track?: TrackRecord
  private sourceUrl?: string
  private mediaArtworkUrl?: string
  private error?: string
  private lastCheckpointAt = 0
  private initialized = false

  constructor() {
    super()
    this.audio.preload = 'metadata'
    this.audio.addEventListener('play', () => {
      this.error = undefined
      this.updateMediaState()
      this.emit()
    })
    this.audio.addEventListener('pause', () => {
      void this.checkpoint(true)
      this.updateMediaState()
      this.emit()
    })
    this.audio.addEventListener('timeupdate', () => {
      void this.checkpoint(false)
      this.updatePositionState()
      this.emit()
    })
    this.audio.addEventListener('ended', () => void this.onEnded())
    this.audio.addEventListener('error', () => {
      this.error = 'This track could not be played. Check folder permission and FLAC support.'
      this.emit()
    })

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.checkpoint(true)
    })
    window.addEventListener('pagehide', () => void this.checkpoint(true))
  }

  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    this.state = (await db.playback.get('global')) ?? emptyPlayback()
    if (this.state.currentTrackId) this.track = await db.tracks.get(this.state.currentTrackId)
    this.installMediaSessionHandlers()
    await this.updateMediaMetadata()
    this.emit()
  }

  subscribe(callback: () => void): () => void {
    const handler = () => callback()
    this.addEventListener('change', handler)
    return () => this.removeEventListener('change', handler)
  }

  snapshot(): PlayerSnapshot {
    return {
      state: { ...this.state, baseQueueTrackIds: [...this.state.baseQueueTrackIds], playOrderTrackIds: [...this.state.playOrderTrackIds] },
      track: this.track,
      playing: !this.audio.paused,
      duration: Number.isFinite(this.audio.duration) ? this.audio.duration : this.track?.durationSeconds ?? 0,
      position: Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : this.state.positionSeconds,
      error: this.error
    }
  }

  async reloadPersistedState(): Promise<void> {
    const loadedTrackId = this.track?.id
    this.state = (await db.playback.get('global')) ?? emptyPlayback()
    const nextTrack = this.state.currentTrackId ? await db.tracks.get(this.state.currentTrackId) : undefined
    if (this.sourceUrl && loadedTrackId !== nextTrack?.id) {
      this.audio.pause()
      this.clearSource()
    }
    this.track = nextTrack
    await this.updateMediaMetadata()
    this.emit()
  }

  async startQueue(trackIds: string[], startIndex = 0, shuffled = false): Promise<void> {
    if (!trackIds.length) return
    const base = [...trackIds]
    const playOrder = shuffled ? shuffle(base) : [...base]
    const requestedId = base[Math.max(0, Math.min(startIndex, base.length - 1))]
    let currentIndex = shuffled ? playOrder.indexOf(requestedId) : Math.max(0, Math.min(startIndex, playOrder.length - 1))
    if (shuffled && currentIndex > 0) {
      ;[playOrder[0], playOrder[currentIndex]] = [playOrder[currentIndex], playOrder[0]]
      currentIndex = 0
    }
    this.state = {
      id: 'global',
      baseQueueTrackIds: base,
      playOrderTrackIds: playOrder,
      currentIndex,
      currentTrackId: playOrder[currentIndex],
      positionSeconds: 0,
      shuffle: shuffled,
      repeatMode: this.state.repeatMode,
      updatedAt: Date.now()
    }
    await this.persistState()
    await this.loadCurrent(true)
  }

  async addToQueue(trackIds: string[]): Promise<void> {
    if (!trackIds.length) return
    if (!this.state.currentTrackId) {
      await this.startQueue(trackIds, 0, false)
      return
    }
    this.state.baseQueueTrackIds.push(...trackIds)
    this.state.playOrderTrackIds.push(...(this.state.shuffle ? shuffle(trackIds) : trackIds))
    await this.persistState()
    this.emit()
  }

  async togglePlay(): Promise<void> {
    if (!this.state.currentTrackId) return
    if (this.audio.src && this.track?.id === this.state.currentTrackId) {
      if (this.audio.paused) await this.audio.play()
      else this.audio.pause()
      return
    }
    await this.loadCurrent(true)
  }

  async next(forcePlay?: boolean): Promise<void> {
    if (!this.state.playOrderTrackIds.length) return
    const shouldPlay = forcePlay ?? !this.audio.paused
    let nextIndex = this.state.currentIndex + 1
    if (nextIndex >= this.state.playOrderTrackIds.length) {
      if (this.state.repeatMode === 'all') nextIndex = 0
      else {
        this.audio.pause()
        this.audio.currentTime = 0
        this.state.positionSeconds = 0
        await this.persistState()
        this.emit()
        return
      }
    }
    this.state.currentIndex = nextIndex
    this.state.currentTrackId = this.state.playOrderTrackIds[nextIndex]
    this.state.positionSeconds = 0
    await this.persistState()
    await this.loadCurrent(shouldPlay)
  }

  async previous(): Promise<void> {
    const shouldPlay = !this.audio.paused
    if (this.audio.currentTime > 3) {
      await this.seek(0)
      return
    }
    if (!this.state.playOrderTrackIds.length) return
    let previousIndex = this.state.currentIndex - 1
    if (previousIndex < 0) previousIndex = this.state.repeatMode === 'all' ? this.state.playOrderTrackIds.length - 1 : 0
    this.state.currentIndex = previousIndex
    this.state.currentTrackId = this.state.playOrderTrackIds[previousIndex]
    this.state.positionSeconds = 0
    await this.persistState()
    await this.loadCurrent(shouldPlay)
  }

  async seek(positionSeconds: number): Promise<void> {
    const duration = Number.isFinite(this.audio.duration) ? this.audio.duration : this.track?.durationSeconds ?? 0
    const clamped = Math.max(0, Math.min(positionSeconds, duration || positionSeconds))
    if (this.audio.src) this.audio.currentTime = clamped
    this.state.positionSeconds = clamped
    await this.persistState()
    this.emit()
  }

  async toggleShuffle(): Promise<void> {
    const current = this.state.currentTrackId
    this.state.shuffle = !this.state.shuffle
    if (current) {
      if (this.state.shuffle) {
        const others = this.state.baseQueueTrackIds.filter((id) => id !== current)
        this.state.playOrderTrackIds = [current, ...shuffle(others)]
        this.state.currentIndex = 0
      } else {
        this.state.playOrderTrackIds = [...this.state.baseQueueTrackIds]
        this.state.currentIndex = Math.max(0, this.state.playOrderTrackIds.indexOf(current))
      }
    }
    await this.persistState()
    this.emit()
  }

  async cycleRepeat(): Promise<void> {
    const next: Record<RepeatMode, RepeatMode> = { off: 'all', all: 'one', one: 'off' }
    this.state.repeatMode = next[this.state.repeatMode]
    await this.persistState()
    this.emit()
  }

  async removeQueueIndex(index: number): Promise<void> {
    if (index < 0 || index >= this.state.playOrderTrackIds.length) return
    const removed = this.state.playOrderTrackIds[index]
    this.state.playOrderTrackIds.splice(index, 1)
    const baseIndex = this.state.baseQueueTrackIds.indexOf(removed)
    if (baseIndex >= 0) this.state.baseQueueTrackIds.splice(baseIndex, 1)

    if (!this.state.playOrderTrackIds.length) {
      await this.clearQueue()
      return
    }

    if (index < this.state.currentIndex) this.state.currentIndex -= 1
    if (removed === this.state.currentTrackId) {
      this.state.currentIndex = Math.min(index, this.state.playOrderTrackIds.length - 1)
      this.state.currentTrackId = this.state.playOrderTrackIds[this.state.currentIndex]
      this.state.positionSeconds = 0
      await this.persistState()
      await this.loadCurrent(!this.audio.paused)
      return
    }
    await this.persistState()
    this.emit()
  }

  async clearQueue(): Promise<void> {
    this.audio.pause()
    this.clearSource()
    this.track = undefined
    this.state = { ...emptyPlayback(), repeatMode: this.state.repeatMode, shuffle: false }
    await this.persistState()
    await this.updateMediaMetadata()
    this.emit()
  }

  private async onEnded(): Promise<void> {
    if (this.state.repeatMode === 'one') {
      await this.seek(0)
      await this.audio.play()
      return
    }
    await this.next(true)
  }

  private async loadCurrent(autoPlay: boolean): Promise<void> {
    const id = this.state.currentTrackId
    if (!id) return
    const track = await db.tracks.get(id)
    if (!track) {
      this.error = 'The queued track is no longer in the library.'
      await this.next(autoPlay)
      return
    }

    try {
      const file = await getTrackFile(track.relativePath)
      this.clearSource()
      this.track = track
      this.sourceUrl = URL.createObjectURL(file)
      this.audio.src = this.sourceUrl
      this.audio.load()
      await new Promise<void>((resolve, reject) => {
        if (this.audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
          resolve()
          return
        }
        const cleanup = () => {
          this.audio.removeEventListener('loadedmetadata', onLoaded)
          this.audio.removeEventListener('error', onError)
        }
        const onLoaded = () => {
          cleanup()
          resolve()
        }
        const onError = () => {
          cleanup()
          reject(new Error('The browser could not read this FLAC file.'))
        }
        this.audio.addEventListener('loadedmetadata', onLoaded, { once: true })
        this.audio.addEventListener('error', onError, { once: true })
      })
      if (this.state.positionSeconds > 0 && this.state.positionSeconds < this.audio.duration) {
        this.audio.currentTime = this.state.positionSeconds
      }
      await this.updateMediaMetadata()
      this.updatePositionState()
      this.emit()
      if (autoPlay) await this.audio.play()
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.emit()
      throw error
    }
  }

  private clearSource(): void {
    this.audio.removeAttribute('src')
    this.audio.load()
    if (this.sourceUrl) URL.revokeObjectURL(this.sourceUrl)
    this.sourceUrl = undefined
    if (this.mediaArtworkUrl) URL.revokeObjectURL(this.mediaArtworkUrl)
    this.mediaArtworkUrl = undefined
  }

  private async checkpoint(force: boolean): Promise<void> {
    if (!this.state.currentTrackId) return
    const now = Date.now()
    if (!force && now - this.lastCheckpointAt < 5000) return
    this.lastCheckpointAt = now
    if (this.audio.src && Number.isFinite(this.audio.currentTime)) {
      this.state.positionSeconds = this.audio.currentTime
    }
    await this.persistState()
  }

  private async persistState(): Promise<void> {
    this.state.updatedAt = Date.now()
    await db.playback.put({
      ...this.state,
      baseQueueTrackIds: [...this.state.baseQueueTrackIds],
      playOrderTrackIds: [...this.state.playOrderTrackIds]
    })
  }

  private installMediaSessionHandlers(): void {
    if (!('mediaSession' in navigator)) return
    const set = (action: string, handler: ((details: any) => void) | null) => {
      try { (navigator.mediaSession.setActionHandler as any)(action, handler) } catch { /* action unsupported */ }
    }
    set('play', () => void this.togglePlay())
    set('pause', () => void this.togglePlay())
    set('previoustrack', () => void this.previous())
    set('nexttrack', () => void this.next())
    set('seekto', (details) => {
      if (typeof details.seekTime === 'number') void this.seek(details.seekTime)
    })
    set('seekbackward', (details) => void this.seek(Math.max(0, this.audio.currentTime - (details.seekOffset ?? 10))))
    set('seekforward', (details) => void this.seek(this.audio.currentTime + (details.seekOffset ?? 10)))
  }

  private async updateMediaMetadata(): Promise<void> {
    if (!('mediaSession' in navigator)) return
    if (!this.track) {
      navigator.mediaSession.metadata = null
      return
    }
    if (this.mediaArtworkUrl) URL.revokeObjectURL(this.mediaArtworkUrl)
    this.mediaArtworkUrl = undefined
    const album = await db.albums.get(this.track.sourceAlbumPath)
    const artwork = album?.artworkId ? await db.artwork.get(album.artworkId) : undefined
    if (artwork) this.mediaArtworkUrl = URL.createObjectURL(artwork.blob)
    navigator.mediaSession.metadata = new MediaMetadata({
      title: this.track.title,
      artist: this.track.artist,
      album: this.track.album,
      artwork: this.mediaArtworkUrl ? [{ src: this.mediaArtworkUrl, sizes: '1024x1024', type: artwork?.mimeType }] : []
    })
  }

  private updateMediaState(): void {
    if (!('mediaSession' in navigator)) return
    try { navigator.mediaSession.playbackState = this.audio.paused ? 'paused' : 'playing' } catch { /* noop */ }
  }

  private updatePositionState(): void {
    if (!('mediaSession' in navigator)) return
    const duration = this.audio.duration
    if (!Number.isFinite(duration) || duration <= 0) return
    const position = Math.max(0, Math.min(this.audio.currentTime || 0, duration))
    try {
      navigator.mediaSession.setPositionState({ duration, playbackRate: this.audio.playbackRate || 1, position })
    } catch {
      // Position state is optional platform integration.
    }
  }

  private emit(): void {
    this.dispatchEvent(new Event('change'))
  }
}

export const player = new PlayerService()

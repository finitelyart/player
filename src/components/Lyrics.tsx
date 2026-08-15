import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { TrackRecord } from '../types'

interface Props {
  track: TrackRecord
  positionSeconds: number
  onSeek: (seconds: number) => void
}

export function Lyrics({ track, positionSeconds, onSeek }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [manualUntil, setManualUntil] = useState(0)
  const activeIndex = useMemo(() => {
    if (!track.syncedLyrics?.length) return -1
    const positionMs = positionSeconds * 1000
    let result = -1
    for (let index = 0; index < track.syncedLyrics.length; index += 1) {
      if (track.syncedLyrics[index].timeMs <= positionMs) result = index
      else break
    }
    return result
  }, [track.syncedLyrics, positionSeconds])

  useEffect(() => {
    if (activeIndex < 0 || Date.now() < manualUntil) return
    const element = containerRef.current?.querySelector<HTMLElement>(`[data-lyric-index="${activeIndex}"]`)
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [activeIndex, manualUntil])

  if (track.syncedLyrics?.length) {
    return (
      <section class="lyrics-section" aria-label="Synchronized lyrics">
        <h2>Lyrics</h2>
        <div
          class="lyrics synced"
          ref={containerRef}
          onScroll={() => setManualUntil(Date.now() + 4000)}
        >
          {track.syncedLyrics.map((line, index) => (
            <button
              type="button"
              class={index === activeIndex ? 'lyric-line active' : 'lyric-line'}
              data-lyric-index={index}
              onClick={() => onSeek(line.timeMs / 1000)}
            >
              {line.text || '…'}
            </button>
          ))}
        </div>
      </section>
    )
  }

  if (track.plainLyrics) {
    return (
      <section class="lyrics-section" aria-label="Lyrics">
        <h2>Lyrics</h2>
        <div class="lyrics plain">{track.plainLyrics}</div>
      </section>
    )
  }

  return <p class="muted centered">No embedded lyrics.</p>
}

import type { LyricLine } from '../types'

function stringifyValue(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value === 'number') return [String(value)]
  if (Array.isArray(value)) return value.flatMap(stringifyValue)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string') return [record.text]
    if (Array.isArray(record.text)) return record.text.flatMap(stringifyValue)
    if (typeof record.value === 'string') return [record.value]
    if (Array.isArray(record.value)) return record.value.flatMap(stringifyValue)
    if (Array.isArray(record.syncText)) return record.syncText.flatMap(stringifyValue)
  }
  return []
}

function parseTimestamp(rawMinutes: string, rawSeconds: string, rawFraction?: string): number {
  const minutes = Number(rawMinutes)
  const seconds = Number(rawSeconds)
  const fraction = rawFraction ? Number(`0.${rawFraction}`) : 0
  return Math.round((minutes * 60 + seconds + fraction) * 1000)
}

export function parseLrc(text: string): LyricLine[] {
  const result: LyricLine[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const stamps = [...rawLine.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)]
    if (!stamps.length) continue
    const lyricText = rawLine.replace(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g, '').trim()
    for (const stamp of stamps) {
      result.push({
        timeMs: parseTimestamp(stamp[1], stamp[2], stamp[3]),
        text: lyricText
      })
    }
  }
  return result.sort((a, b) => a.timeMs - b.timeMs)
}

function parseLineObject(value: unknown, timestampIsMilliseconds = false): LyricLine | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const text = typeof record.text === 'string' ? record.text : typeof record.value === 'string' ? record.value : ''
  const rawTime = record.timeMs ?? record.timestamp ?? record.time ?? record.timeStamp ?? record.start ?? record.offset
  if (!text || typeof rawTime !== 'number' || !Number.isFinite(rawTime)) return undefined

  // music-metadata SYLT syncText timestamps are milliseconds. Generic `time` values
  // used by other parsers are commonly seconds, so only apply the heuristic there.
  const explicitMilliseconds = timestampIsMilliseconds || 'timeMs' in record || 'timestamp' in record
  const timeMs = explicitMilliseconds
    ? Math.round(rawTime)
    : rawTime >= 1000
      ? Math.round(rawTime)
      : Math.round(rawTime * 1000)
  return { timeMs: Math.max(0, timeMs), text }
}

function parseStructuredLyrics(value: unknown): LyricLine[] {
  if (!Array.isArray(value)) return []
  const lines: LyricLine[] = []

  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>

    // music-metadata exposes ID3 SYLT as an ILyricsTag whose syncText array has
    // { text, timestamp } entries. The timestamp is already in milliseconds.
    if (Array.isArray(record.syncText)) {
      for (const syncLine of record.syncText) {
        const parsed = parseLineObject(syncLine, true)
        if (parsed) lines.push(parsed)
      }
      continue
    }

    const parsed = parseLineObject(record)
    if (parsed) lines.push(parsed)
  }

  return lines.sort((a, b) => a.timeMs - b.timeMs)
}

export interface ParsedLyrics {
  rawLyrics?: string
  plainLyrics?: string
  syncedLyrics?: LyricLine[]
}

export function extractLyrics(metadata: unknown): ParsedLyrics {
  const root = (metadata ?? {}) as Record<string, unknown>
  const common = (root.common ?? {}) as Record<string, unknown>
  const native = (root.native ?? {}) as Record<string, unknown>

  const structuredCandidates = [
    common.syncedLyrics,
    common.synchronizedLyrics,
    common.syncLyrics,
    common.lyrics
  ]
  for (const candidate of structuredCandidates) {
    const parsed = parseStructuredLyrics(candidate)
    if (parsed.length) {
      const raw = stringifyValue(candidate).join('\n').trim() || undefined
      return { rawLyrics: raw, plainLyrics: parsed.map((line) => line.text).join('\n'), syncedLyrics: parsed }
    }
  }

  const textCandidates: string[] = []
  for (const candidate of [
    common.lyrics,
    common.unsynchronizedLyrics,
    common.synchronizedLyrics,
    common.syncLyrics
  ]) {
    textCandidates.push(...stringifyValue(candidate))
  }

  for (const tags of Object.values(native)) {
    if (!Array.isArray(tags)) continue
    for (const tag of tags) {
      if (!tag || typeof tag !== 'object') continue
      const record = tag as Record<string, unknown>
      const id = String(record.id ?? record.name ?? '').toUpperCase()
      if (!/(LYRIC|SYLT|USLT)/.test(id)) continue

      const structured = parseStructuredLyrics([record.value])
      if (structured.length) {
        return {
          rawLyrics: stringifyValue(record.value).join('\n').trim() || undefined,
          plainLyrics: structured.map((line) => line.text).join('\n'),
          syncedLyrics: structured
        }
      }
      textCandidates.push(...stringifyValue(record.value))
    }
  }

  const unique = [...new Set(textCandidates.map((value) => value.trim()).filter(Boolean))]
  if (!unique.length) return {}

  const rawLyrics = unique.join('\n\n')
  const syncedLyrics = parseLrc(rawLyrics)
  if (syncedLyrics.length) {
    return {
      rawLyrics,
      plainLyrics: syncedLyrics.map((line) => line.text).join('\n'),
      syncedLyrics
    }
  }

  return { rawLyrics, plainLyrics: rawLyrics }
}

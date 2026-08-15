import { db } from '../db/db'
import type { DirectoryHandleLike, FileHandleLike } from '../types'

export function supportsDirectoryPicker(): boolean {
  return typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
}

export async function chooseMusicRoot(): Promise<DirectoryHandleLike> {
  const picker = (window as Window & {
    showDirectoryPicker?: (options?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: string }) => Promise<DirectoryHandleLike>
  }).showDirectoryPicker
  if (!picker) throw new Error('This browser does not support selecting a persistent music folder.')
  return picker({ id: 'music-library', mode: 'read', startIn: 'music' })
}

export async function getSavedRoot(): Promise<DirectoryHandleLike | undefined> {
  return (await db.sources.get('primary'))?.rootHandle
}

export async function queryReadPermission(handle: DirectoryHandleLike): Promise<PermissionState> {
  if (!handle.queryPermission) return 'prompt'
  return handle.queryPermission({ mode: 'read' })
}

export async function requestReadPermission(handle: DirectoryHandleLike): Promise<PermissionState> {
  const existing = await queryReadPermission(handle)
  if (existing === 'granted') return 'granted'
  if (!handle.requestPermission) return existing
  return handle.requestPermission({ mode: 'read' })
}

export async function resolveFileHandle(root: DirectoryHandleLike, relativePath: string): Promise<FileHandleLike> {
  const segments = relativePath.split('/').filter(Boolean)
  if (!segments.length) throw new Error('Invalid track path')
  let directory = root
  for (const segment of segments.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(segment, { create: false })
  }
  return directory.getFileHandle(segments[segments.length - 1], { create: false })
}

export async function getTrackFile(relativePath: string): Promise<File> {
  const root = await getSavedRoot()
  if (!root) throw new Error('Music folder is not connected.')
  if (await queryReadPermission(root) !== 'granted') {
    throw new Error('Music folder permission is required. Reconnect the folder first.')
  }
  const handle = await resolveFileHandle(root, relativePath)
  return handle.getFile()
}

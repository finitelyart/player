# Local FLAC Player

A local-first, album-oriented FLAC player designed primarily for an installed Chrome PWA on Android.

The application indexes an existing `Music/Artist/Album/*.flac` tree, reads embedded FLAC metadata/artwork/lyrics, and plays the original files directly. It **does not copy the audio library into IndexedDB and does not modify source music files**.

## What is implemented

- Select one local Music root directory through the File System Access API.
- Recursive FLAC indexing with path + file size + modified-time change detection.
- Album grid sorted alphabetically, with instant album/artist search.
- Embedded artist/album/title/track/disc metadata with folder/filename fallbacks.
- Embedded cover art cached once per album in IndexedDB and normalized to at most 1024px.
- Multi-disc ordering using embedded disc tags, with `Disc N` / `CDN` directory fallback.
- Embedded synchronized lyrics, LRC timestamp parsing, tap-a-line-to-seek, and plain-text fallback.
- Persistent queue, current track, approximate playback checkpoint, shuffle, repeat-one, repeat-all.
- Manual playlists with add/remove/reorder.
- Artwork-first Now Playing screen and compact browsing mini-player.
- Media Session integration for Android/system play, pause, next, previous, seek, metadata, and artwork where the platform exposes them.
- Manual incremental Rescan Library.
- Safe local-only Remove from Library with an ignored-album list; original FLACs remain untouched.
- PWA shell/offline caching through `vite-plugin-pwa`.
- GitHub Pages workflow with project-repository base-path handling.

## Expected library layout

```text
Music/
  Artist/
    Album/
      01 - Track.flac
      02 - Track.flac
```

Multi-disc folders are also tolerated:

```text
Music/
  Artist/
    Album/
      Disc 1/
        01 - Track.flac
      Disc 2/
        01 - Track.flac
```

The selected `Music` directory is the canonical audio source. The first directory level is used as the artist fallback and the second as the album fallback.

## Architecture

### Filesystem

The File System Access API is used read-only. The selected directory handle is persisted in IndexedDB. Playback resolves a queued track's saved relative path back to a `File`, creates a temporary object URL, and gives that URL to one long-lived `HTMLAudioElement`.

The app never requests write access during normal operation.

### IndexedDB / Dexie

IndexedDB stores:

- persisted root directory handle
- normalized track and album index
- resized album artwork
- parsed/raw lyrics
- manual playlists
- persistent queue and playback checkpoint
- navigation/search state
- ignored album paths
- schema/index version metadata

IndexedDB does **not** contain FLAC audio payloads.

### Metadata

`music-metadata` parses FLAC `File`/`Blob` objects in the browser. Embedded tags are display-authoritative when valid. Folder and filename structure provide conservative fallbacks.

Track ordering is:

1. disc number
2. track number
3. filename

Lyrics parsing first looks for structured synchronized lyric data, then common/native lyric fields, then parses LRC timestamps. If timestamps cannot be normalized but lyric text exists, the text is shown without synchronization rather than rejecting the track.

### Rescan Library

Rescan first completes a recursive enumeration. Each file is classified using:

```text
relative path + file size + last modified timestamp
```

Unchanged files are not reparsed. New/changed files are reparsed sequentially. Only after root enumeration succeeds are indexed-but-unseen tracks treated as deleted. This avoids a killed/failed scan falsely deleting everything it had not reached yet.

### Remove from Library

"Remove from Library" removes only app-owned index/artwork state and reconciles playlists/queue. The album path is added to `ignoredAlbums`, so a later rescan does not immediately re-add it. Restore the album under **Ignored Albums**, then rescan.

## Development

Requirements: Node.js 20.19+ or a supported Node 22 release.

```bash
npm install
npm run dev
```

Typecheck:

```bash
npm run typecheck
```

Production build:

```bash
npm run build
```

Preview:

```bash
npm run preview
```

For a strict clean install/build:

```bash
rm -rf node_modules
npm ci
npm run build
```

## GitHub Pages deployment

1. Create a GitHub repository and put these files at the repository root.
2. In **Settings → Pages**, choose **GitHub Actions** as the source.
3. Push to `main` or manually run **Build and deploy GitHub Pages** from the Actions tab.

The included workflow sets `VITE_BASE_PATH` to `/<repository-name>/`, so project Pages URLs such as `https://username.github.io/repository-name/` resolve JS, CSS, manifest and service-worker assets correctly.

If you deploy to a user/organization root site or a custom domain, change `VITE_BASE_PATH` appropriately (normally `/`).

## Android usage

1. Open the deployed HTTPS site in current Chrome on Android.
2. Install it as a PWA.
3. Tap **Connect Music Folder** and choose the `Music` root directory.
4. Let the initial scan complete.
5. Browse albums and start playback.

If filesystem permission is later unavailable, cached metadata/artwork/playlists remain browsable. Tap **Reconnect** before playback or rescanning.

Android background/screen-off playback and exact system media-control presentation are browser/OS behaviors and must be verified on the target physical phone. If Android terminates the PWA process, the app restores the queue/current track/recent checkpoint but intentionally does not autoplay after restart.

## Database model

Dexie schema version 1 contains:

```text
sources
tracks
albums
artwork
playlists
playback
appState
ignoredAlbums
settings
```

`relativePath` is the V1 track identity. Renaming a source FLAC outside the app may therefore appear as one removed track plus one new track on the next rescan.

## Storage and quota

After a successful scan the app opportunistically calls `navigator.storage.persist()`. Failure does not block use. Artwork is the main browser-owned binary data; source FLACs remain outside browser storage.

## Major dependencies

- Vite
- Preact
- TypeScript
- Dexie
- music-metadata
- vite-plugin-pwa

## V1 exclusions

Not implemented in V1:

- source FLAC deletion/rename/tag writing
- metadata editing
- cloud accounts/sync/backend
- online artwork or metadata lookup
- listening statistics
- smart playlists
- ReplayGain processing
- equalizer/DSP
- crossfade
- guaranteed gapless playback
- Chromecast
- backup/restore
- multiple library roots
- automatic filesystem watching
- MP3 as a guaranteed library format

## Important limitations

- The app depends on persistent directory-access support; non-Chromium browsers are not a V1 target.
- Background audio can be interrupted if Android actually terminates the browser/PWA process.
- Playback checkpoints are periodic (about every five seconds), so crash restoration is approximate.
- Source-file renames are not identity-preserving in V1.
- A full 200 GB library is never copied or hashed, but initial metadata parsing across thousands of tracks can still take time.
- Real-device Android verification is required before treating the product as finished.

## Delivery verification note

The generation environment used for this repository could not reach the npm registry, so a real `npm ci` / production build could not be executed there. Source TS/TSX syntax-transpilation, relative imports, JSON/YAML, icon dimensions, and lyric-parser smoke cases were checked successfully, but those checks are **not** a substitute for a clean build.

Because the registry was unavailable, the included lockfile contains the pinned direct dependency set but has not been populated by npm with the full transitive resolution tree. In Codespaces, run this once before relying on CI:

```bash
npm install
npm run build
git add package-lock.json
git commit -m "Resolve dependency lockfile"
```

Then verify the clean path:

```bash
rm -rf node_modules
npm ci
npm run build
```

Do not mark the Android PWA behavior complete until the real-device smoke test in the product specification has been performed.

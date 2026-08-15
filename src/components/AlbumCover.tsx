import { useEffect, useRef, useState } from 'preact/hooks'
import { db } from '../db/db'

interface Props {
  artworkId?: string
  alt: string
  className?: string
}

export function AlbumCover({ artworkId, alt, className = '' }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [url, setUrl] = useState<string>()

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true)
        observer.disconnect()
      }
    }, { rootMargin: '300px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible || !artworkId) return
    let active = true
    let objectUrl: string | undefined
    void db.artwork.get(artworkId).then((artwork) => {
      if (!active || !artwork) return
      objectUrl = URL.createObjectURL(artwork.blob)
      setUrl(objectUrl)
    })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [visible, artworkId])

  return (
    <div ref={ref} class={`cover ${className}`}>
      {url ? <img src={url} alt={alt} /> : <div class="cover-placeholder" aria-label={alt}>♪</div>}
    </div>
  )
}

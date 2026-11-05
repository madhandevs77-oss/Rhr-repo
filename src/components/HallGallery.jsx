import { useEffect, useRef } from 'react'

export default function HallGallery({ hall, start = 0, onClose }) {
  const box = useRef(null)
  useEffect(() => {
    box.current?.children[start]?.scrollIntoView({ inline: 'center', block: 'nearest' })
    const h = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [start, onClose])
  return (
    <div className="hall-gallery-ov" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="hall-gallery-box">
        <div className="hall-gallery-top">
          <span>{hall.name}</span>
          <button onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <div className="hall-gallery-imgs" ref={box}>
          {hall.photos.map((s, i) => (
            <img key={i} src={s} alt={`${hall.name} photo ${i + 1}`} />
          ))}
        </div>
      </div>
    </div>
  )
}

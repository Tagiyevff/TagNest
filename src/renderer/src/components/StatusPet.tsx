import { useEffect, useRef, useState, type JSX } from 'react'

export type PetState = 'idle' | 'typing' | 'thinking' | 'working' | 'waiting' | 'sad' | 'offline'

/**
 * The little blob that lives in the status pill.
 *
 * It is a real character, not a status light: it smiles when the workspace is
 * ready, blinks while it waits, looks toward the pointer while you type, looks
 * up and thinks while the agent plans, scans the screen while it works, looks
 * surprised when it needs your approval, frowns when a task failed, and sleeps
 * with its eyes shut when Linux is not running.
 *
 * Purely decorative (`aria-hidden`), no text, honours reduced motion.
 */
export function StatusPet({ state }: { state: PetState }): JSX.Element {
  const [blinking, setBlinking] = useState(false)
  const ref = useRef<SVGSVGElement>(null)
  const sleepy = state === 'offline'
  const canBlink = state === 'idle' || state === 'typing' || state === 'waiting'

  useEffect(() => {
    if (!canBlink) {
      // A blink that was already in flight must not leak into the next phase.
      // Deferred so this effect never sets state synchronously.
      const reset = window.setTimeout(() => setBlinking(false), 0)
      return () => window.clearTimeout(reset)
    }
    let timers: number[] = []
    let disposed = false
    const schedule = (): void => {
      const wait = 1900 + Math.random() * 4200
      timers.push(
        window.setTimeout(() => {
          if (disposed) return
          setBlinking(true)
          timers.push(
            window.setTimeout(() => {
              if (disposed) return
              setBlinking(false)
              // Now and then a quick double blink feels more alive.
              if (Math.random() > 0.78) {
                timers.push(window.setTimeout(() => !disposed && setBlinking(true), 130))
                timers.push(window.setTimeout(() => !disposed && setBlinking(false), 260))
              }
              schedule()
            }, 130)
          )
        }, wait)
      )
    }
    schedule()
    return () => {
      disposed = true
      timers.forEach((id) => window.clearTimeout(id))
      timers = []
    }
  }, [canBlink])

  useEffect(() => {
    if (state !== 'typing') {
      ref.current?.style.setProperty('--look-x', '0px')
      ref.current?.style.setProperty('--look-y', '0px')
      return
    }
    const onMove = (event: MouseEvent): void => {
      const node = ref.current
      if (!node) return
      const rect = node.getBoundingClientRect()
      const dx = (event.clientX - (rect.left + rect.width / 2)) / Math.max(220, window.innerWidth / 2)
      const dy = (event.clientY - (rect.top + rect.height / 2)) / Math.max(220, window.innerHeight / 2)
      node.style.setProperty('--look-x', `${Math.max(-1, Math.min(1, dx)) * 1.6}px`)
      node.style.setProperty('--look-y', `${Math.max(-1, Math.min(1, dy)) * 1.3}px`)
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [state])

  return (
    <svg
      ref={ref}
      className={`status-pet ${state}${blinking && !sleepy ? ' blinking' : ''}`}
      viewBox="0 0 40 40"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="pet-body"
        d="M20 4.6c9.1 0 15.2 6.4 15.2 15.8 0 9.2-6 15-15.2 15s-15.2-5.8-15.2-15C4.8 11 10.9 4.6 20 4.6Z"
      />

      <ellipse className="pet-blush" cx="8.9" cy="23.6" rx="2.8" ry="1.7" />
      <ellipse className="pet-blush" cx="31.1" cy="23.6" rx="2.8" ry="1.7" />

      {/* Open eyes: dark, glossy, and able to look around. */}
      <g className="pet-eyes">
        <ellipse className="pet-eye" cx="14.6" cy="18.4" rx="3.5" ry="4.1" />
        <circle className="pet-glint" cx="13.3" cy="16.9" r="1.3" />
        <circle className="pet-glint small" cx="15.9" cy="20" r="0.66" />
        <ellipse className="pet-eye" cx="25.4" cy="18.4" rx="3.5" ry="4.1" />
        <circle className="pet-glint" cx="24.1" cy="16.9" r="1.3" />
        <circle className="pet-glint small" cx="26.7" cy="20" r="0.66" />
      </g>

      {/* Closed eyes: a blink, or sleeping. */}
      <g className="pet-lids">
        <path d="M11.3 19.5q3.3 1.7 6.6 0" />
        <path d="M22.1 19.5q3.3 1.7 6.6 0" />
      </g>

      <path className="pet-mouth smile" d="M17.5 25.2q2.5 2.7 5 0" />
      <path className="pet-mouth flat" d="M18.1 26.6h3.8" />
      <path className="pet-mouth frown" d="M17.6 27.4q2.4-2.6 4.8 0" />
      <g className="pet-mouth o">
        <ellipse cx="20" cy="26.4" rx="1.8" ry="2.1" />
        <ellipse className="pet-tongue" cx="20" cy="27.3" rx="0.95" ry="0.62" />
      </g>

      {/* Working: a little spark, because it is getting things done. */}
      <path className="pet-spark" d="M31.8 6.4l1 2.2 2.2 1-2.2 1-1 2.2-1-2.2-2.2-1 2.2-1z" />
      <path className="pet-spark small" d="M35.4 12.4l.6 1.3 1.3.6-1.3.6-.6 1.3-.6-1.3-1.3-.6 1.3-.6z" />

      {/* Thinking: three dots drifting up. */}
      <g className="pet-think">
        <circle cx="28.6" cy="7.6" r="0.95" />
        <circle cx="31.4" cy="5.2" r="1.05" />
        <circle cx="34.4" cy="3.4" r="1.15" />
      </g>
    </svg>
  )
}

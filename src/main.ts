import type { PreparedTextWithSegments, LayoutCursor } from '@chenglou/pretext'
import { prepareWithSegments, layoutNextLine } from '@chenglou/pretext'

// ── Style ───────────────────────────────────────────────────────────
const TEXT_COLOR = '#15102E'
const BLOB_STROKE = '#008E75'
const BLOB_FILL = 'rgba(0, 142, 117, 0.04)'
const HANDLE_FILL = '#CFF0E9'
const DASH = [6, 4]
const HANDLE_R = 5
const HANDLE_HIT = 14

// ── Canvas ──────────────────────────────────────────────────────────
const canvas = document.getElementById('c') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!
let W = 0, H = 0

function resize(): void {
  const wrap = canvas.parentElement!
  W = wrap.clientWidth; H = wrap.clientHeight
  const dpr = devicePixelRatio || 1
  canvas.width = W * dpr; canvas.height = H * dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  dirty = true
}
resize()
addEventListener('resize', () => { resize(); kick() })

// ── DOM ─────────────────────────────────────────────────────────────
const searchInput = document.getElementById('search') as HTMLInputElement
const goBtn = document.getElementById('go-btn')!
const statusEl = document.getElementById('status')!
const emptyEl = document.getElementById('empty')!
const inSize = document.getElementById('in-size') as HTMLInputElement
const inLh = document.getElementById('in-lh') as HTMLInputElement
const inSpeed = document.getElementById('in-speed') as HTMLInputElement
const vSize = document.getElementById('v-size')!
const vLh = document.getElementById('v-lh')!
const vSpeed = document.getElementById('v-speed')!
const btnReset = document.getElementById('btn-reset')!
const infoEl = document.getElementById('info')!
const articleTitle = document.getElementById('article-title')!
const articleDesc = document.getElementById('article-desc')!

// ── Config ──────────────────────────────────────────────────────────
let fontSize = 14
let lineHeightMul = 1.4
let reflowSpeed = 1.0
let articleText = ''

function font(): string { return `500 ${fontSize}px "Plus Jakarta Sans", sans-serif` }
function boldFont(): string { return `700 ${Math.round(fontSize * 1.4)}px "Plus Jakarta Sans", sans-serif` }

// ═══════════════════════════════════════════════════════════════════
// BLOB SHAPE — browser-window silhouette, fully malleable
// ═══════════════════════════════════════════════════════════════════
type V = { x: number; y: number }

let cp: V[] = []
let cachedOutline: V[] | null = null

function initBlob(): void {
  const pad = 40
  const left = pad + 20
  const right = W - pad - 20
  const top = pad + 10
  const bottom = H - pad - 10
  const w = right - left
  const h = bottom - top
  const r = 18

  cp = [
    { x: left,         y: top + r },
    { x: left + r,     y: top },
    { x: left + w * 0.25, y: top },
    { x: left + w * 0.5,  y: top },
    { x: left + w * 0.75, y: top },
    { x: right - r,    y: top },
    { x: right,        y: top + r },
    { x: right,        y: top + h * 0.3 },
    { x: right,        y: top + h * 0.55 },
    { x: right,        y: top + h * 0.8 },
    { x: right,        y: bottom - r },
    { x: right - r,    y: bottom },
    { x: left + w * 0.75, y: bottom },
    { x: left + w * 0.5,  y: bottom },
    { x: left + w * 0.25, y: bottom },
    { x: left + r,     y: bottom },
    { x: left,         y: bottom - r },
    { x: left,         y: top + h * 0.8 },
    { x: left,         y: top + h * 0.55 },
    { x: left,         y: top + h * 0.3 },
  ]

  cachedOutline = null; dirty = true
}

function getTitleBarY(): number {
  let sumY = 0, count = 0
  for (let i = 0; i < 7; i++) { sumY += cp[i]!.y; count++ }
  return sumY / count
}

// Catmull-Rom
function cr(p0: V, p1: V, p2: V, p3: V, t: number): V {
  const t2 = t * t, t3 = t2 * t
  return {
    x: .5*(2*p1.x+(-p0.x+p2.x)*t+(2*p0.x-5*p1.x+4*p2.x-p3.x)*t2+(-p0.x+3*p1.x-3*p2.x+p3.x)*t3),
    y: .5*(2*p1.y+(-p0.y+p2.y)*t+(2*p0.y-5*p1.y+4*p2.y-p3.y)*t2+(-p0.y+3*p1.y-3*p2.y+p3.y)*t3),
  }
}

const SUB = 12

function outline(): V[] {
  if (cachedOutline) return cachedOutline
  const n = cp.length, out: V[] = []
  for (let i = 0; i < n; i++) {
    const p0 = cp[(i-1+n)%n]!, p1 = cp[i]!, p2 = cp[(i+1)%n]!, p3 = cp[(i+2)%n]!
    for (let j = 0; j < SUB; j++) out.push(cr(p0, p1, p2, p3, j / SUB))
  }
  cachedOutline = out
  return out
}

// ═══════════════════════════════════════════════════════════════════
// GEOMETRY
// ═══════════════════════════════════════════════════════════════════
type Span = { left: number; right: number }

function getSpansAtY(poly: V[], y: number, pad: number): Span[] {
  const xs: number[] = []
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const a = poly[i]!, b = poly[(i+1)%n]!
    if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y))
      xs.push(a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x))
  }
  if (xs.length < 2) return []
  xs.sort((a, b) => a - b)
  const spans: Span[] = []
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const l = xs[i]! + pad, r = xs[i+1]! - pad
    if (r - l > fontSize) spans.push({ left: l, right: r })
  }
  return spans
}

// ═══════════════════════════════════════════════════════════════════
// TEXT LAYOUT
// ═══════════════════════════════════════════════════════════════════
type AnimLine = {
  text: string
  x: number; y: number
  tx: number; ty: number
  vx: number; vy: number
  w: number
  isTitle: boolean
}

let animLines: AnimLine[] = []
let dirty = true
let titlePrepared: PreparedTextWithSegments | null = null
let bodyPrepared: PreparedTextWithSegments | null = null
let lastTitleFont = ''
let lastBodyFont = ''
let lastTitle = ''
let lastBody = ''

function layoutText(): void {
  if (!articleText) { animLines = []; dirty = false; return }

  const titleFont = boldFont()
  const bodyFont = font()
  const titleLh = Math.round(fontSize * 1.4 * 1.2)
  const bodyLh = Math.round(fontSize * lineHeightMul)

  const titleStr = currentTitle || ''
  const bodyBase = articleText
  const repeatCount = Math.max(1, Math.ceil(5000 / Math.max(bodyBase.length, 1)))
  const bodyStr = Array.from({ length: repeatCount }, () => bodyBase).join(' ')

  try {
    if (!titlePrepared || lastTitleFont !== titleFont || lastTitle !== titleStr) {
      titlePrepared = prepareWithSegments(titleStr, titleFont)
      lastTitleFont = titleFont; lastTitle = titleStr
    }
    if (!bodyPrepared || lastBodyFont !== bodyFont || lastBody !== bodyStr) {
      bodyPrepared = prepareWithSegments(bodyStr, bodyFont)
      lastBodyFont = bodyFont; lastBody = bodyStr
    }
  } catch (err) {
    console.error('Pretext prepare error:', err)
    dirty = false
    return
  }

  const poly = outline()
  let minY = Infinity, maxY = -Infinity
  for (const p of poly) { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y }

  const pad = 8
  const newLines: Array<{ text: string; x: number; y: number; w: number; isTitle: boolean }> = []

  const barY = getTitleBarY()
  const barH = 34

  let y = barY + barH + pad + 4
  let titleCursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 }
  let titleDone = false

  while (!titleDone && y + titleLh <= maxY - pad) {
    const mid = y + titleLh * 0.5
    const spans = getSpansAtY(poly, mid, pad)
    if (spans.length === 0) { y += titleLh; continue }
    const span = spans[0]!
    const sw = span.right - span.left
    if (sw < fontSize * 2) { y += titleLh; continue }

    const line = layoutNextLine(titlePrepared, titleCursor, sw)
    if (!line) { titleDone = true; break }
    newLines.push({ text: line.text, x: span.left, y, w: line.width, isTitle: true })
    titleCursor = line.end
    y += titleLh
    if (line.text.length === 0) titleDone = true
  }

  y += Math.round(fontSize * 0.6)

  let bodyCursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 }

  while (y + bodyLh <= maxY - pad) {
    const mid = y + bodyLh * 0.5
    const spans = getSpansAtY(poly, mid, pad)
    for (const span of spans) {
      const sw = span.right - span.left
      if (sw < fontSize) continue
      let line = layoutNextLine(bodyPrepared, bodyCursor, sw)
      if (!line) {
        bodyCursor = { segmentIndex: 0, graphemeIndex: 0 }
        line = layoutNextLine(bodyPrepared, bodyCursor, sw)
        if (!line) continue
      }
      newLines.push({ text: line.text, x: span.left, y, w: line.width, isTitle: false })
      bodyCursor = line.end
    }
    y += bodyLh
  }

  const next: AnimLine[] = []
  for (let i = 0; i < newLines.length; i++) {
    const nl = newLines[i]!
    const old = animLines[i]
    if (old) {
      next.push({ ...old, text: nl.text, tx: nl.x, ty: nl.y, w: nl.w, isTitle: nl.isTitle })
    } else {
      next.push({
        text: nl.text, x: nl.x, y: nl.y,
        tx: nl.x, ty: nl.y, vx: 0, vy: 0,
        w: nl.w, isTitle: nl.isTitle,
      })
    }
  }
  animLines = next
  dirty = false
}

function animTick(dt: number): boolean {
  const stiffness = 300 * reflowSpeed
  const damp = 22 * Math.sqrt(reflowSpeed)
  let moving = false
  for (const l of animLines) {
    const fx = (l.tx - l.x) * stiffness, fy = (l.ty - l.y) * stiffness
    l.vx += (fx - damp * l.vx) * dt; l.vy += (fy - damp * l.vy) * dt
    l.x += l.vx * dt; l.y += l.vy * dt
    if (Math.abs(l.tx-l.x) > 0.1 || Math.abs(l.ty-l.y) > 0.1 ||
        Math.abs(l.vx) > 0.5 || Math.abs(l.vy) > 0.5) moving = true
    else { l.x = l.tx; l.y = l.ty; l.vx = 0; l.vy = 0 }
  }
  return moving
}

// ═══════════════════════════════════════════════════════════════════
// DRAWING
// ═══════════════════════════════════════════════════════════════════

function drawBlob(): void {
  const o = outline()
  if (o.length < 3) return

  ctx.beginPath()
  ctx.moveTo(o[0]!.x, o[0]!.y)
  for (let i = 1; i < o.length; i++) ctx.lineTo(o[i]!.x, o[i]!.y)
  ctx.closePath()
  ctx.fillStyle = '#fff'
  ctx.fill()
  ctx.strokeStyle = BLOB_STROKE
  ctx.lineWidth = 1.5
  ctx.setLineDash(DASH)
  ctx.stroke()
  ctx.setLineDash([])

  const barY = getTitleBarY()
  const barH = 34
  const spans = getSpansAtY(o, barY + barH * 0.5, 0)
  if (spans.length === 0) return
  const span = spans[0]!
  const bLeft = span.left + 6
  const bRight = span.right - 6
  const bWidth = bRight - bLeft
  const barMidY = barY + barH * 0.5

  ctx.save()
  ctx.beginPath()
  ctx.moveTo(o[0]!.x, o[0]!.y)
  for (let i = 1; i < o.length; i++) ctx.lineTo(o[i]!.x, o[i]!.y)
  ctx.closePath()
  ctx.clip()

  ctx.fillStyle = 'rgba(0, 142, 117, 0.04)'
  ctx.fillRect(bLeft - 10, barY - 10, bWidth + 20, barH + 6)

  ctx.beginPath()
  ctx.moveTo(bLeft, barY + barH - 1)
  ctx.lineTo(bRight, barY + barH - 1)
  ctx.strokeStyle = 'rgba(0, 142, 117, 0.15)'
  ctx.lineWidth = 1
  ctx.setLineDash([])
  ctx.stroke()

  const dotR = 5
  const dotY = barMidY
  const dotStartX = bLeft + 14
  const dotColors = ['#FF6058', '#FFBD2E', '#27CA40']
  for (let i = 0; i < 3; i++) {
    ctx.beginPath()
    ctx.arc(dotStartX + i * 18, dotY, dotR, 0, Math.PI * 2)
    ctx.fillStyle = dotColors[i]!
    ctx.fill()
  }

  const abLeft = dotStartX + 3 * 18 + 16
  const abRight2 = bRight - 12
  const abW = abRight2 - abLeft
  if (abW > 60) {
    const abH = 22
    const abY2 = dotY - abH / 2
    ctx.beginPath()
    ctx.roundRect(abLeft, abY2, abW, abH, 6)
    ctx.fillStyle = 'rgba(0, 142, 117, 0.06)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(0, 142, 117, 0.12)'
    ctx.lineWidth = 1
    ctx.stroke()

    const urlText = currentTitle ? `en.wikipedia.org/wiki/${currentTitle.replace(/ /g, '_')}` : 'en.wikipedia.org'
    ctx.font = `400 ${Math.min(11, abW * 0.04)}px "Plus Jakarta Sans", sans-serif`
    ctx.fillStyle = 'rgba(0, 142, 117, 0.5)'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.save()
    ctx.beginPath()
    ctx.rect(abLeft + 8, abY2, abW - 16, abH)
    ctx.clip()
    ctx.fillText(urlText, abLeft + 8, dotY)
    ctx.restore()
    ctx.textAlign = 'left'
  }

  ctx.restore()
}

function drawHandles(): void {
  for (const h of cp) {
    ctx.beginPath()
    ctx.arc(h.x, h.y, HANDLE_R, 0, Math.PI * 2)
    ctx.fillStyle = HANDLE_FILL
    ctx.fill()
    ctx.strokeStyle = BLOB_STROKE
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
}

function drawText(): void {
  ctx.globalAlpha = 0.88
  for (const l of animLines) {
    if (l.isTitle) {
      ctx.font = boldFont()
      ctx.fillStyle = '#008E75'
    } else {
      ctx.font = font()
      ctx.fillStyle = TEXT_COLOR
    }
    ctx.textBaseline = 'top'
    ctx.fillText(l.text, l.x, l.y)
  }
  ctx.globalAlpha = 1
}

// ═══════════════════════════════════════════════════════════════════
// INTERACTION
// ═══════════════════════════════════════════════════════════════════

let dragIdx = -1

function hitHandle(mx: number, my: number): number {
  for (let i = 0; i < cp.length; i++) {
    if (Math.hypot(mx - cp[i]!.x, my - cp[i]!.y) < HANDLE_HIT) return i
  }
  return -1
}

canvas.addEventListener('pointerdown', (e) => {
  const r = canvas.getBoundingClientRect()
  const mx = e.clientX - r.left, my = e.clientY - r.top
  dragIdx = hitHandle(mx, my)
  if (dragIdx >= 0) {
    canvas.setPointerCapture(e.pointerId)
    canvas.style.cursor = 'grabbing'
  }
})

canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect()
  const mx = e.clientX - r.left, my = e.clientY - r.top
  if (dragIdx >= 0) {
    cp[dragIdx]!.x = mx; cp[dragIdx]!.y = my
    cachedOutline = null; dirty = true; kick()
  } else {
    canvas.style.cursor = hitHandle(mx, my) >= 0 ? 'grab' : 'default'
  }
})

canvas.addEventListener('pointerup', () => { dragIdx = -1; canvas.style.cursor = 'default' })

canvas.addEventListener('wheel', (e) => {
  e.preventDefault()
  let cx = 0, cy = 0
  for (const p of cp) { cx += p.x; cy += p.y }
  cx /= cp.length; cy /= cp.length
  const s = e.deltaY > 0 ? 0.96 : 1.04
  for (const p of cp) { p.x = cx + (p.x - cx) * s; p.y = cy + (p.y - cy) * s }
  cachedOutline = null; dirty = true; kick()
}, { passive: false })

// ═══════════════════════════════════════════════════════════════════
// WIKIPEDIA FETCH
// ═══════════════════════════════════════════════════════════════════

let currentTitle = ''

async function searchWikipedia(query: string): Promise<void> {
  if (!query.trim()) return

  statusEl.textContent = 'Searching…'
  emptyEl.classList.add('hidden')

  try {
    const searchUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`
    const res = await fetch(searchUrl)

    if (!res.ok) {
      const searchRes = await fetch(
        `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=1&format=json&origin=*`
      )
      const data = await searchRes.json()
      if (data[1] && data[1].length > 0) {
        const title = data[1][0]
        const summaryRes = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`)
        if (!summaryRes.ok) throw new Error('Not found')
        const summary = await summaryRes.json()
        applyArticle(summary)
      } else {
        throw new Error('No results')
      }
    } else {
      const summary = await res.json()
      applyArticle(summary)
    }
  } catch {
    statusEl.textContent = 'Not found — try another search'
    articleTitle.textContent = ''
    articleDesc.textContent = ''
  }
}

function applyArticle(data: { title: string; extract: string; description?: string }): void {
  currentTitle = data.title
  articleText = data.extract || ''
  statusEl.textContent = `${currentTitle}`

  articleTitle.textContent = data.title
  articleDesc.textContent = data.description || ''

  titlePrepared = null; bodyPrepared = null
  dirty = true
  kick()
}

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchWikipedia(searchInput.value)
})
goBtn.addEventListener('click', () => searchWikipedia(searchInput.value))

// ═══════════════════════════════════════════════════════════════════
// CONTROLS
// ═══════════════════════════════════════════════════════════════════

inSize.addEventListener('input', () => {
  fontSize = Number(inSize.value); vSize.textContent = fontSize + 'px'
  titlePrepared = null; bodyPrepared = null; dirty = true; kick()
})
inLh.addEventListener('input', () => {
  lineHeightMul = Number(inLh.value); vLh.textContent = lineHeightMul.toFixed(1)
  dirty = true; kick()
})
inSpeed.addEventListener('input', () => {
  reflowSpeed = Number(inSpeed.value); vSpeed.textContent = reflowSpeed.toFixed(1) + '×'
})
btnReset.addEventListener('click', () => { initBlob(); kick() })

// ═══════════════════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════════════════

let prevT = 0, running = false

function frame(now: number): void {
  const dt = Math.min((now - prevT) / 1000, 0.033)
  prevT = now

  if (dirty) layoutText()
  const moving = animTick(dt)

  ctx.clearRect(0, 0, W, H)
  drawBlob()
  drawText()
  drawHandles()

  const chars = animLines.reduce((s, l) => s + l.text.length, 0)
  infoEl.textContent = `Lines: ${animLines.length} · Chars: ${chars}`

  if (moving || dirty || dragIdx >= 0) requestAnimationFrame(frame)
  else running = false
}

function kick(): void {
  if (running) return
  running = true
  prevT = performance.now()
  requestAnimationFrame(frame)
}

// ═══════════════════════════════════════════════════════════════════
async function boot(): Promise<void> {
  try {
    await document.fonts.ready
  } catch {
    // fonts.ready can fail in some environments, proceed anyway
  }
  initBlob()
  kick()
  searchInput.value = 'Origami'
  await searchWikipedia('Origami')
}

boot().catch((err) => {
  console.error('Boot error:', err)
  statusEl.textContent = 'Error loading — check console'
})

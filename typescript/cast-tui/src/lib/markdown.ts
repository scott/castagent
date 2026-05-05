import {StyledText, stringToStyledText, TextChunk, white, brightWhite, brightCyan, brightBlue, cyan, brightYellow, dim, bold, italic, underline, fg} from '@opentui/core'

type Segment = {text: string; style: SegmentStyle}
type SegmentStyle = {
  fg?: string
  bg?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  dim?: boolean
}

// Terminal color palette for markdown elements
const PALETTE = {
  h1: {fg: '#00FFFF', bold: true, underline: true},      // Bright cyan + bold + underline
  h2: {fg: '#5C9CFF', bold: true},                       // Soft blue + bold
  h3: {fg: '#00CCCC', bold: true},                       // Medium cyan + bold
  bold: {fg: '#FFFFFF', bold: true},                     // Bright white + bold
  italic: {fg: '#DDDDDD', italic: true},                 // Light gray + italic
  code: {fg: '#FFD700'},                                  // Gold/yellow
  codeBlock: {fg: '#FFD700', dim: true},                 // Dim gold
  blockquote: {fg: '#AAAAAA', italic: true},             // Gray + italic
  link: {fg: '#5C9CFF', underline: true},                // Soft blue + underline
  normal: {fg: '#FFFFFF'},                                // White
  bullet: {fg: '#00CCCC'},                               // Cyan bullets
}

function toChunks(segments: Segment[]): TextChunk[] {
  const chunks: TextChunk[] = []
  for (const seg of segments) {
    // Build the styled chunk by composing style functions
    let styled: any = seg.text
    if (seg.style.bold) styled = bold(styled)
    if (seg.style.italic) styled = italic(styled)
    if (seg.style.underline) styled = underline(styled)
    if (seg.style.dim) styled = dim(styled)
    if (seg.style.fg) styled = fg(seg.style.fg)(styled)
    // bg support could be added via bg() if needed
    chunks.push(styled)
  }
  return chunks
}

function parseInline(text: string, baseStyle: SegmentStyle = PALETTE.normal): Segment[] {
  const segments: Segment[] = []
  let remaining = text

  const patterns = [
    // Code spans: `code`
    {regex: /`([^`]+)`/g, style: PALETTE.code},
    // Bold: **text**
    {regex: /\*\*([^*]+)\*\*/g, style: PALETTE.bold},
    // Bold: __text__
    {regex: /__([^_]+)__/g, style: PALETTE.bold},
    // Italic: *text*
    {regex: /(?<!\*)\*([^*]+)\*(?!\*)/g, style: PALETTE.italic},
    // Italic: _text_
    {regex: /(?<!_)_([^_]+)_(?!_)/g, style: PALETTE.italic},
    // Links: [text](url)
    {regex: /\[([^\]]+)\]\(([^)]+)\)/g, style: PALETTE.link},
  ]

  // Simple approach: find the earliest match across all patterns
  while (remaining.length > 0) {
    let earliest: {index: number; match: RegExpMatchArray; style: SegmentStyle; fullLength: number; contentIndex: number; contentLength: number} | null = null

    for (const pat of patterns) {
      pat.regex.lastIndex = 0
      const m = pat.regex.exec(remaining)
      if (m && m.index !== undefined) {
        if (!earliest || m.index < earliest.index) {
          earliest = {
            index: m.index,
            match: m,
            style: pat.style,
            fullLength: m[0].length,
            contentIndex: m.index + m[0].indexOf(m[1]),
            contentLength: m[1].length,
          }
        }
      }
    }

    if (!earliest) {
      // No more patterns matched - add remaining as plain text
      if (remaining.length > 0) {
        segments.push({text: remaining, style: baseStyle})
      }
      break
    }

    // Add text before the match
    if (earliest.index > 0) {
      segments.push({text: remaining.slice(0, earliest.index), style: baseStyle})
    }

    // Add the matched content with its style
    segments.push({text: earliest.match[1], style: earliest.style})

    // Continue after the match
    remaining = remaining.slice(earliest.index + earliest.fullLength)
  }

  return segments
}

export function markdownToStyledText(markdown: string): StyledText {
  const lines = markdown.split('\n')
  const allSegments: Segment[] = []

  let inCodeBlock = false
  let codeBlockLines: string[] = []
  let codeBlockLang = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Code blocks
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true
        codeBlockLang = line.slice(3).trim()
        codeBlockLines = []
      } else {
        inCodeBlock = false
        const codeText = codeBlockLines.join('\n')
        allSegments.push({text: codeText, style: PALETTE.codeBlock})
        if (i < lines.length - 1) {
          allSegments.push({text: '\n', style: PALETTE.normal})
        }
      }
      continue
    }

    if (inCodeBlock) {
      codeBlockLines.push(line)
      continue
    }

    // Empty line
    if (line.trim() === '') {
      if (allSegments.length > 0) {
        allSegments.push({text: '\n', style: PALETTE.normal})
      }
      continue
    }

    // Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headerMatch) {
      const level = headerMatch[1].length
      const content = headerMatch[2]
      let style: SegmentStyle
      if (level === 1) style = PALETTE.h1
      else if (level === 2) style = PALETTE.h2
      else style = PALETTE.h3
      allSegments.push(...parseInline(content, style))
      if (i < lines.length - 1) {
        allSegments.push({text: '\n', style: PALETTE.normal})
      }
      continue
    }

    // Blockquote
    const bqMatch = line.match(/^>(\s*)(.*)$/)
    if (bqMatch) {
      const content = bqMatch[2]
      allSegments.push({text: '┃ ', style: PALETTE.blockquote})
      allSegments.push(...parseInline(content, PALETTE.blockquote))
      if (i < lines.length - 1) {
        allSegments.push({text: '\n', style: PALETTE.normal})
      }
      continue
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/)
    if (ulMatch) {
      const indent = ulMatch[1]
      const content = ulMatch[2]
      allSegments.push({text: indent + '• ', style: PALETTE.bullet})
      allSegments.push(...parseInline(content, PALETTE.normal))
      if (i < lines.length - 1) {
        allSegments.push({text: '\n', style: PALETTE.normal})
      }
      continue
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/)
    if (olMatch) {
      const indent = olMatch[1]
      const content = olMatch[2]
      allSegments.push({text: indent + '  ', style: PALETTE.bullet})
      allSegments.push(...parseInline(content, PALETTE.normal))
      if (i < lines.length - 1) {
        allSegments.push({text: '\n', style: PALETTE.normal})
      }
      continue
    }

    // Horizontal rule
    if (/^(---|___|\*\*\*)\s*$/.test(line)) {
      allSegments.push({text: '─'.repeat(40), style: {...PALETTE.normal, dim: true}})
      if (i < lines.length - 1) {
        allSegments.push({text: '\n', style: PALETTE.normal})
      }
      continue
    }

    // Regular paragraph
    allSegments.push(...parseInline(line, PALETTE.normal))
    if (i < lines.length - 1) {
      allSegments.push({text: '\n', style: PALETTE.normal})
    }
  }

  // Handle unclosed code block
  if (inCodeBlock && codeBlockLines.length > 0) {
    const codeText = codeBlockLines.join('\n')
    allSegments.push({text: codeText, style: PALETTE.codeBlock})
  }

  const chunks = toChunks(allSegments)
  return new StyledText(chunks)
}

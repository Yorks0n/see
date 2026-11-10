export type MarkdownInline = string | { text: string; href: string; auto: boolean }
export type MarkdownBlock = { type: 'line'; text: string } | { type: 'heading'; level: number; text: string } | { type: 'list'; items: string[] }

export function markdownInline(text: string): MarkdownInline[] {
  const parts: MarkdownInline[] = []
  const links = /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)(?:[^\s()<>]|\([^\s()<>]*\))+)\)|(https?:\/\/[^\s<>\[\]"，。！？、；：“”‘’]+)/g
  let start = 0
  for (const match of text.matchAll(links)) {
    let href = match[2] ?? match[3]
    if (!match[2]) {
      href = href.replace(/[.,!?;:]+$/, '')
      while (href.endsWith(')') && href.split(')').length > href.split('(').length) href = href.slice(0, -1)
    }
    parts.push(text.slice(start, match.index))
    parts.push({ text: match[1] ?? href, href, auto: !match[2] })
    start = match.index! + (match[2] ? match[0].length : href.length)
  }
  parts.push(text.slice(start))
  return parts
}

export function markdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^ {0,3}(#{1,3})[ \t]+(.*?)(?:[ \t]+#+[ \t]*)?$/)
    const item = lines[i].match(/^ {0,3}-[ \t]+(.*)$/)
    if (heading) blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
    else if (item) {
      const items = [item[1]]
      while (i + 1 < lines.length) {
        const next = lines[i + 1].match(/^ {0,3}-[ \t]+(.*)$/)
        if (!next) break
        items.push(next[1]); i++
      }
      blocks.push({ type: 'list', items })
    } else blocks.push({ type: 'line', text: lines[i] })
  }
  return blocks
}

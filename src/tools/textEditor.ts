import { Schema, type Node as TextNode } from 'prosemirror-model'
import { Plugin } from 'prosemirror-state'
import { baseKeymap, chainCommands, setBlockType } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { InputRule, inputRules, textblockTypeInputRule, undoInputRule, wrappingInputRule } from 'prosemirror-inputrules'
import { keymap } from 'prosemirror-keymap'
import { liftListItem, splitListItem } from 'prosemirror-schema-list'
import { markdownBlocks, markdownInline } from '../render/markdown'

export const textSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block', toDOM: () => ['div', { class: 'markdown-line' }, 0], parseDOM: [{ tag: 'div' }, { tag: 'p' }] },
    heading: { attrs: { level: { default: 1 } }, content: 'text*', group: 'block', defining: true, toDOM: (node) => [`h${node.attrs.level}`, 0], parseDOM: [1, 2, 3].map((level) => ({ tag: `h${level}`, attrs: { level } })) },
    bullet_list: { content: 'list_item+', group: 'block', toDOM: () => ['ul', 0], parseDOM: [{ tag: 'ul' }] },
    list_item: { content: 'paragraph+', defining: true, toDOM: () => ['li', 0], parseDOM: [{ tag: 'li' }] },
    text: { group: 'inline' },
  },
  marks: {
    link: {
      attrs: { href: {}, auto: { default: false } }, inclusive: false,
      toDOM: (mark) => ['a', { href: mark.attrs.href, target: '_blank', rel: 'noopener noreferrer', draggable: 'false' }, 0],
    },
  },
})

function inlineNodes(text: string) {
  return markdownInline(text).flatMap((part) => typeof part === 'string'
    ? part ? [textSchema.text(part)] : []
    : [textSchema.text(part.text, [textSchema.marks.link.create({ href: part.href, auto: part.auto })])])
}

export function textDocument(text: string): TextNode {
  const { paragraph, heading, bullet_list, list_item } = textSchema.nodes
  return textSchema.nodes.doc.create(null, markdownBlocks(text).map((block) => {
    if (block.type === 'heading') return heading.create({ level: block.level }, inlineNodes(block.text))
    if (block.type === 'list') return bullet_list.create(null, block.items.map((item) => list_item.create(null, paragraph.create(null, inlineNodes(item)))))
    return paragraph.create(null, inlineNodes(block.text))
  }))
}

function inlineText(node: TextNode) {
  let text = ''
  node.forEach((child) => {
    const link = child.marks.find((mark) => mark.type === textSchema.marks.link)
    text += link && !link.attrs.auto ? `[${child.text}](${link.attrs.href})` : child.text ?? ''
  })
  return text
}

export function textMarkdown(doc: TextNode): string {
  if (doc.firstChild?.isInline) return inlineText(doc)
  const lines: string[] = []
  doc.forEach((node) => {
    if (node.type === textSchema.nodes.bullet_list) node.forEach((item) => item.forEach((paragraph) => lines.push(`- ${inlineText(paragraph)}`)))
    else if (node.type === textSchema.nodes.list_item) node.forEach((paragraph) => lines.push(`- ${inlineText(paragraph)}`))
    else lines.push(`${node.type === textSchema.nodes.heading ? '#'.repeat(node.attrs.level) + ' ' : ''}${inlineText(node)}`)
  })
  return lines.join('\n')
}

export function textPlugins() {
  const { heading, bullet_list, list_item } = textSchema.nodes
  return [
    inputRules({ rules: [
      textblockTypeInputRule(/^ {0,3}(#{1,3}) $/, heading, (match) => ({ level: match[1].length })),
      wrappingInputRule(/^ {0,3}- $/, bullet_list),
      new InputRule(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s]+)\)$/, (state, match, start, end) =>
        state.tr.replaceWith(start, end, textSchema.text(match[1], [textSchema.marks.link.create({ href: match[2] })]))),
    ] }),
    keymap({
      'Mod-z': undo, 'Shift-Mod-z': redo, 'Mod-y': redo,
      Enter: chainCommands(splitListItem(list_item), liftListItem(list_item), baseKeymap.Enter),
      Backspace: chainCommands(undoInputRule, (state, dispatch) => state.selection.empty && state.selection.$from.parentOffset === 0
        && state.selection.$from.parent.type === heading && setBlockType(textSchema.nodes.paragraph)(state, dispatch), baseKeymap.Backspace),
    }),
    keymap(baseKeymap),
    history(),
    new Plugin({
      appendTransaction(transactions, _old, state) {
        if (!transactions.some((tr) => tr.docChanged) || transactions.some((tr) => tr.getMeta('composition') != null)) return null
        const tr = state.tr, link = textSchema.marks.link
        state.doc.descendants((node, pos) => {
          if (!node.isTextblock) return
          let run = '', from = pos + 1
          const markRun = () => {
            if (!run) return
            tr.removeMark(from, from + run.length, link)
            let offset = from
            for (const part of markdownInline(run)) {
              if (typeof part === 'string') offset += part.length
              else if (part.auto) { tr.addMark(offset, offset + part.text.length, link.create({ href: part.href, auto: true })); offset += part.text.length }
              else offset += `[${part.text}](${part.href})`.length
            }
            run = ''
          }
          node.forEach((child, offset) => {
            if (child.marks.some((mark) => mark.type === link && !mark.attrs.auto)) { markRun(); from = pos + 1 + offset + child.nodeSize }
            else run += child.text ?? ''
          })
          markRun()
        })
        return tr.doc.eq(state.doc) ? null : tr
      },
    }),
  ]
}

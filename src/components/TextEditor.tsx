import { useLayoutEffect, useRef } from 'react'
import { Slice } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { documentStore } from '../store/document'
import { textDocument, textMarkdown, textPlugins } from '../tools/textEditor'

export function TextEditor({ text, editing, style, onChange, onDone }: {
  text: string; editing: boolean; style: React.CSSProperties
  onChange: (text: string) => void; onDone: (text: string) => void
}) {
  const container = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null)
  const initial = useRef(text), draft = useRef(text)
  const latest = useRef({ text, editing, onChange, onDone })
  latest.current = { text, editing, onChange, onDone }
  useLayoutEffect(() => {
    const editor: EditorView = new EditorView(container.current!, {
      state: EditorState.create({ doc: textDocument(latest.current.text), plugins: textPlugins() }),
      editable: () => latest.current.editing,
      attributes: { class: 'text-editor', role: 'textbox', 'aria-label': '文本块内容', 'aria-multiline': 'true' },
      dispatchTransaction(transaction) {
        editor.updateState(editor.state.applyTransaction(transaction).state)
        if (!transaction.docChanged) return
        draft.current = textMarkdown(editor.state.doc)
        latest.current.onChange(draft.current)
      },
      clipboardTextParser: (text) => new Slice(textDocument(text).content, 0, 0),
      clipboardTextSerializer: (slice) => textMarkdown(slice.content.size ? editor.state.schema.nodes.doc.create(null, slice.content) : textDocument('')),
      handleKeyDown(_view, event) {
        event.stopPropagation()
        if (event.isComposing) return false
        if (event.key === 'Escape') {
          draft.current = initial.current
          editor.updateState(EditorState.create({ doc: textDocument(draft.current), plugins: textPlugins() }))
          documentStore.cancelInteraction()
          editor.dom.blur()
          return true
        }
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { editor.dom.blur(); return true }
        return false
      },
      handleDOMEvents: {
        blur() {
          if (latest.current.editing) { latest.current.onDone(draft.current); documentStore.endInteraction() }
          return false
        },
        pointerdown(_view, event) {
          const link = (event.target as Element).closest('a')
          if (!link || event.button !== 0 || (!event.metaKey && !event.ctrlKey)) return false
          event.preventDefault(); event.stopPropagation()
          window.open(link.href, '_blank', 'noopener,noreferrer')
          return true
        },
        click(_view, event) { if ((event.target as Element).closest('a')) event.preventDefault(); return false },
        contextmenu(_view, event) { if (event.ctrlKey && (event.target as Element).closest('a')) event.preventDefault(); return false },
      },
    })
    view.current = editor
    return () => { editor.destroy(); view.current = null }
  }, [])
  useLayoutEffect(() => {
    const editor = view.current!
    if (text === draft.current) return
    draft.current = text
    editor.updateState(EditorState.create({ doc: textDocument(text), plugins: textPlugins() }))
  }, [text])
  useLayoutEffect(() => {
    const editor = view.current!
    editor.setProps({ editable: () => editing })
    if (!editing) return
    initial.current = text
    documentStore.beginInteraction()
    const doc = editor.state.doc
    editor.updateState(EditorState.create({ doc, selection: TextSelection.atEnd(doc), plugins: textPlugins() }))
    editor.focus()
  }, [editing])
  return <div ref={container} className={`card-text markdown-text ${editing ? 'editing' : ''}`} style={style}
    onPointerDown={(e) => { if (editing) e.stopPropagation() }} onPointerMove={(e) => { if (editing) e.stopPropagation() }} onPointerUp={(e) => { if (editing) e.stopPropagation() }} />
}

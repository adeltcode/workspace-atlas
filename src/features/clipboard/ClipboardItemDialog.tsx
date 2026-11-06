import { useEffect, useState } from 'react'
import { Copy, Trash2, X } from 'lucide-react'
import ModalShell from '../../components/ModalShell'
import { Button, ErrorBanner, Tag } from '../../components/ui'
import * as api from './api'
import type { ClipboardItem } from './api'
import { canCopyAsPlainText, countLabel, formatJson, isCut, KIND_LABEL, kindOf, looksSecret, textStats } from './rules'

function ItemImage({ id }: { id: string }) {
  const [source, setSource] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let cancelled = false
    api.clipboardItemImage(id)
      .then(bytes => new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        // Windows hands over a BMP or a PNG, and the page's content rules allow data: images.
        reader.readAsDataURL(new Blob([bytes], { type: new Uint8Array(bytes)[0] === 0x42 ? 'image/bmp' : 'image/png' }))
      }))
      .then(url => { if (!cancelled) setSource(url) })
      .catch(e => { if (!cancelled) setError(e) })
    return () => { cancelled = true }
  }, [id])

  if (error != null) return <ErrorBanner className="error-banner--flush" title="Could not show this image" error={error} />
  return source
    ? <img className="clipboard-image" src={source} alt="The copied image" />
    : <div className="img-loading">Loading image…</div>
}

export function ClipboardItemDialog({ item, onCopy, onCopyText, onDelete, onClose }: {
  item: ClipboardItem
  onCopy: () => void
  /** Puts plain text on the clipboard, without the item's formatting. */
  onCopyText: (text: string, done: string) => void
  onDelete: () => void
  onClose: () => void
}) {
  const kind = kindOf(item)
  const stats = item.text === null ? null : textStats(item.text)
  const formatted = item.text === null ? null : formatJson(item.text)

  return (
    <ModalShell className="modal-overlay" label={`${KIND_LABEL[kind]} from clipboard history`} onClose={onClose}>
      <div className="modal modal--wide clipboard-dialog">
        <div className="modal-header">
          <h2 className="modal-title">{KIND_LABEL[kind]}</h2>
          {looksSecret(item) && <Tag tone="warn">Possible secret</Tag>}
        </div>

        <p className="clipboard-facts">
          Copied {new Date(item.copied_at).toLocaleString()}
          {stats && !isCut(item) && `. ${countLabel(stats.characters, 'character')}, ${countLabel(stats.words, 'word')}, ${countLabel(stats.lines, 'line')}.`}
          {isCut(item) && `. ${countLabel(item.text_length ?? 0, 'character')}, showing the first ${(item.text?.length ?? 0).toLocaleString()}.`}
        </p>

        {item.text !== null && <pre className="clipboard-text">{item.text}</pre>}
        {item.text === null && item.has_image && <ItemImage id={item.id} />}
        {item.text === null && !item.has_image && <p className="modal-body">Windows has no plain text for this item. Copy it to paste it with its formatting.</p>}

        <p className="clipboard-facts">Formats: {item.formats.join(', ') || 'None'}</p>

        <div className="modal-actions">
          <Button variant="danger-outline" onClick={onDelete}><Trash2 size={12} /> Delete</Button>
          <span className="toolbar-spacer" />
          {canCopyAsPlainText(item) && item.text !== null && (
            <Button onClick={() => onCopyText(item.text as string, 'Copied as plain text')}>Copy as plain text</Button>
          )}
          {formatted !== null && <Button onClick={() => onCopyText(formatted, 'Copied formatted JSON')}>Copy formatted JSON</Button>}
          <Button data-autofocus variant="primary" onClick={onCopy}><Copy size={12} /> Copy</Button>
          <Button onClick={onClose}><X size={12} /> Close</Button>
        </div>
      </div>
    </ModalShell>
  )
}

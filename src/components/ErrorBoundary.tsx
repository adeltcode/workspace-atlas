import { Component, type ReactNode } from 'react'
import { useAppStore } from '../store/appStore'
import { AppError } from '../utils/errors'
import { Button, ErrorBanner } from './ui'

/** Without one of these, a single render error blanks the whole window. Around a page, it keeps the
 *  sidebar and the other pages usable. */
export default class ErrorBoundary extends Component<
  { title: string; children: ReactNode; wholeApp?: boolean },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    if (!this.props.wholeApp) useAppStore.getState().addTerminalLine(`  ✗ ${this.props.title}: ${error.message}`, 'error')
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const { title, wholeApp } = this.props
    return (
      <div className="view-container" style={wholeApp ? { height: '100%' } : undefined}>
        <div className="page-scroll">
          <ErrorBanner
            title={title}
            error={new AppError('unknown', error.message, undefined, error.stack)}
            action={(
              <>
                {!wholeApp && <Button size="sm" onClick={() => this.setState({ error: null })}>Reload page</Button>}
                {/* Reloading the page alone cannot help when the bad value is in the store. */}
                <Button size="sm" onClick={() => location.reload()}>Reload app</Button>
              </>
            )}
          />
        </div>
      </div>
    )
  }
}

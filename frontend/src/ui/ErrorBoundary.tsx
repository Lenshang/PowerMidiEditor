// Top-level error boundary: a render crash shows the error instead of
// unmounting the tree (which looked like a black screen inside the webview).
import React from 'react';
import { useStore } from '../state/store';
import { t } from '../i18n';

export class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError (error: Error) {
    return { error };
  }

  componentDidCatch (error: Error, info: React.ErrorInfo) {
    console.error('PME UI crash:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, color: '#ff5d5d', fontFamily: 'sans-serif', fontSize: 13 }}>
          <h3 style={{ margin: '0 0 12px' }}>{t('app.uiCrashed')}</h3>
          <pre style={{
            whiteSpace: 'pre-wrap', color: '#e9e9ee',
            background: 'rgba(255,255,255,0.05)', padding: 12, borderRadius: 8,
          }}>{String(this.state.error?.message ?? this.state.error)}</pre>
          <button
            className="mini-btn primary"
            style={{ marginTop: 12 }}
            onClick={() => this.setState({ error: null })}
          >
            {t('app.recover')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

void useStore;

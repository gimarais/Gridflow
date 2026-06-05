import { Component, ErrorInfo, ReactNode } from 'react';

interface State { error: Error | null }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[GridFlow] render error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 20, fontFamily: 'monospace', color: '#f48771' }}>
          <b>GridFlow render error</b>
          <pre style={{ marginTop: 8, fontSize: 11, whiteSpace: 'pre-wrap' }}>
            {this.state.error.stack ?? this.state.error.message}
          </pre>
          <small>Open <i>Developer: Open Webview Developer Tools</i> for details.</small>
        </div>
      );
    }
    return this.props.children;
  }
}

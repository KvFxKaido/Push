import { Component, type ErrorInfo, type ReactNode } from 'react';
import { MAX_COMPONENT_STACK_CHARS, reportError } from '@/lib/error-reporting';

interface RootErrorBoundaryProps {
  children: ReactNode;
  /** Optional custom fallback. Defaults to a minimal full-screen panel. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface RootErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Top-level React error boundary. Catches render-time crashes anywhere in the
 * tree, reports them through the OTel error pipeline, and renders a minimal
 * fallback UI so users see something other than a white screen.
 *
 * The fallback is intentionally vanilla — it doesn't depend on the design
 * system because the design system itself might be the thing that crashed.
 */
export class RootErrorBoundary extends Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const stack = info.componentStack ?? '';
    reportError({
      source: 'react-render',
      error,
      attributes: stack
        ? { 'push.error.component_stack': stack.slice(0, MAX_COMPONENT_STACK_CHARS) }
        : undefined,
    });
  }

  reset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (!this.state.hasError || !this.state.error) {
      return this.props.children;
    }

    if (this.props.fallback) {
      return this.props.fallback(this.state.error, this.reset);
    }

    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          background: '#0b0d12',
          color: '#e6edf3',
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        }}
      >
        <div style={{ maxWidth: 480, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 12 }}>
            Push hit an unexpected error
          </h1>
          <p
            style={{
              fontSize: 14,
              color: '#9ba8b8',
              marginBottom: 20,
              wordBreak: 'break-word',
            }}
          >
            {this.state.error.message || 'An unknown error occurred while rendering the app.'}
          </p>
          <button
            type="button"
            onClick={() => {
              this.reset();
              if (typeof window !== 'undefined') window.location.reload();
            }}
            style={{
              padding: '8px 16px',
              borderRadius: 6,
              border: '1px solid #30363d',
              background: '#161b22',
              color: '#e6edf3',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Reload Push
          </button>
        </div>
      </div>
    );
  }
}

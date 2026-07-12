import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { Box, SilveryErrorBoundary, Text } from 'silvery';

// Emergency reset for terminal modes the silvery path can own. Keep this
// literal and exported: the fault-path test pins the exact recovery contract.
export const TERMINAL_RESTORE_SEQUENCE =
  '\x1b[?2026l' + // synchronized output off
  '\x1b[0m' + // attributes reset
  '\x1b[?2004l' + // bracketed paste off
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l' + // mouse tracking off
  '\x1b[?1006l\x1b[?1015l\x1b[?1016l' + // mouse encodings off
  '\x1b[?25h' + // cursor visible
  '\x1b[?1049l'; // leave alternate screen

type Writable = Pick<NodeJS.WriteStream, 'write'>;

export interface TerminalRestorer {
  readonly restored: boolean;
  restore(): void;
}

export function createTerminalRestorer(stdout: Writable = process.stdout): TerminalRestorer {
  let restored = false;
  return {
    get restored() {
      return restored;
    },
    restore() {
      if (restored) return;
      restored = true;
      stdout.write(TERMINAL_RESTORE_SEQUENCE);
    },
  };
}

type ProcessEventName = 'uncaughtException' | 'unhandledRejection';

interface ProcessEventTarget {
  on(event: ProcessEventName, listener: (reason: unknown) => void): unknown;
  off(event: ProcessEventName, listener: (reason: unknown) => void): unknown;
}

interface Unmountable {
  unmount(): void;
}

export interface ProcessWatchdogOptions {
  getInstance: () => Unmountable | undefined;
  events?: ProcessEventTarget;
  stdout?: Writable;
  stderr?: Writable;
  exit?: (code: number) => void;
}

export interface ProcessWatchdog {
  readonly restorer: TerminalRestorer;
  dispose(): void;
  handleFatal(kind: string, error: unknown): void;
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

export function installProcessWatchdog(options: ProcessWatchdogOptions): ProcessWatchdog {
  const events = options.events ?? process;
  const stderr = options.stderr ?? process.stderr;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const restorer = createTerminalRestorer(options.stdout);
  let handled = false;
  let disposed = false;

  const handleFatal = (kind: string, error: unknown) => {
    if (handled) return;
    handled = true;
    try {
      options.getInstance()?.unmount();
    } catch {
      // Emergency restoration must still run when framework teardown fails.
    }
    try {
      restorer.restore();
    } catch {
      // stderr + exit remain more important than a failed best-effort write.
    }
    stderr.write(`\n[push silvery watchdog] ${kind}: ${errorDetail(error)}\n`);
    exit(1);
  };

  const onUncaughtException = (error: unknown) => handleFatal('uncaughtException', error);
  const onUnhandledRejection = (reason: unknown) => handleFatal('unhandledRejection', reason);
  events.on('uncaughtException', onUncaughtException);
  events.on('unhandledRejection', onUnhandledRejection);

  return {
    restorer,
    handleFatal,
    dispose() {
      if (disposed) return;
      disposed = true;
      events.off('uncaughtException', onUncaughtException);
      events.off('unhandledRejection', onUnhandledRejection);
    },
  };
}

interface RecoverableBoundaryProps {
  children?: ReactNode;
  resetKey?: string | number;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface RecoverableBoundaryState {
  error: Error | null;
}

export class RecoverableBoundary extends Component<
  RecoverableBoundaryProps,
  RecoverableBoundaryState
> {
  state: RecoverableBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RecoverableBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
  }

  componentDidUpdate(previous: RecoverableBoundaryProps) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red" bold>
            ! This screen failed to render
          </Text>
          <Text color="$fg-muted">{this.state.error.message}</Text>
          <Text color="$fg-muted">
            Push is still running. Retry this screen or continue from another client.
          </Text>
        </Box>
      );
    }
    return this.props.children;
  }
}

export interface PushShellProps {
  children?: ReactNode;
  resetKey?: string | number;
  onRecoverableError?: (error: Error, info: ErrorInfo) => void;
  onRootError?: (error: Error) => void;
}

export function PushShell({ children, resetKey, onRecoverableError, onRootError }: PushShellProps) {
  return (
    <SilveryErrorBoundary onError={onRootError}>
      <RecoverableBoundary resetKey={resetKey} onError={onRecoverableError}>
        {children}
      </RecoverableBoundary>
    </SilveryErrorBoundary>
  );
}

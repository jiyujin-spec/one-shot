import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// ─── Build 26: Global console.error log accumulator ───────────────────────────
// Intercept console.error BEFORE React mounts so we can capture any
// initialization errors that happen synchronously at module-evaluation time.
// Logs are stored here and rendered in the ErrorBoundary fallback UI.

const _capturedLogs: string[] = [];
const _origConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  _origConsoleError(...args);
  try {
    const line = args
      .map((a) =>
        a instanceof Error
          ? `${a.message}\n${a.stack ?? ''}`
          : typeof a === 'object'
          ? JSON.stringify(a)
          : String(a)
      )
      .join(' ');
    _capturedLogs.push(`[${new Date().toISOString()}] ${line}`);
    // Keep at most 60 entries to avoid unlimited growth
    if (_capturedLogs.length > 60) _capturedLogs.shift();
  } catch {
    // ignore stringify errors
  }
};

// ─── Global Error Boundary ────────────────────────────────────────────────────
// React のレンダリングフェーズで発生した未処理の例外を補足し、
// ネイティブ側の SIGABRT（ExceptionsManagerQueue クラッシュ）を防ぐ。
// Build 26: エラー詳細（message + stack + console.error ログ）を常時表示。
//           __DEV__ ガードを外して本番ビルドでも診断情報を読めるようにする。

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
  errorStack: string;
  logs: string[];
}

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '', errorStack: '', logs: [] };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? '') : '';
    // Snapshot accumulated console.error logs at the moment of crash
    const logs = [..._capturedLogs];
    return { hasError: true, errorMessage: msg, errorStack: stack, logs };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error('[AppErrorBoundary] Caught render error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      const { errorMessage, errorStack, logs } = this.state;
      return (
        <View style={styles.errorContainer}>
          <Text style={styles.errorTitle}>予期せぬエラーが発生しました</Text>
          <Text style={styles.errorTitleEn}>An unexpected error occurred</Text>
          <Text style={styles.errorHint}>
            アプリを再起動してください。{'\n'}Please restart the app.
          </Text>

          {/* ── Debug section (Build 26) ─────────────────────────── */}
          <ScrollView style={styles.debugScroll} contentContainerStyle={styles.debugContent}>
            <Text style={styles.debugHeader}>── Error Message ──</Text>
            <Text style={styles.debugText} selectable>{errorMessage || '(empty)'}</Text>

            {!!errorStack && (
              <>
                <Text style={styles.debugHeader}>── Stack Trace ──</Text>
                <Text style={styles.debugText} selectable>{errorStack}</Text>
              </>
            )}

            {logs.length > 0 && (
              <>
                <Text style={styles.debugHeader}>── console.error logs ({logs.length}) ──</Text>
                {logs.map((line, i) => (
                  <Text key={i} style={styles.debugText} selectable>{line}</Text>
                ))}
              </>
            )}
          </ScrollView>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  errorContainer: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    padding: 24,
    paddingTop: 60,
  },
  errorTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8,
  },
  errorTitleEn: {
    color: '#888',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 16,
  },
  errorHint: {
    color: '#666',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
  },
  // ── Debug UI ────────────────────────────────────────────────
  debugScroll: {
    flex: 1,
    width: '100%',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    backgroundColor: '#0d0d0d',
  },
  debugContent: {
    padding: 12,
    paddingBottom: 40,
  },
  debugHeader: {
    color: '#ff6b6b',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 12,
    marginBottom: 4,
  },
  debugText: {
    color: '#e0e0e0',
    fontSize: 10,
    lineHeight: 15,
    fontVariant: ['tabular-nums'],
  },
});

// ─── Root Layout ──────────────────────────────────────────────────────────────

export default function RootLayout() {
  return (
    <AppErrorBoundary>
      <SafeAreaProvider>
        <StatusBar style="light" backgroundColor="#000" translucent />
        <Stack screenOptions={{ headerShown: false }} />
      </SafeAreaProvider>
    </AppErrorBoundary>
  );
}

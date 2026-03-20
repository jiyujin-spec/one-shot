import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// ─── Global Error Boundary ────────────────────────────────────────────────────
// React のレンダリングフェーズで発生した未処理の例外を補足し、
// ネイティブ側の SIGABRT（ExceptionsManagerQueue クラッシュ）を防ぐ。
// ErrorBoundary はクラスコンポーネントでのみ実装できる（React の制約）。

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const msg = error instanceof Error ? error.message : String(error);
    return { hasError: true, errorMessage: msg };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    // 本番でも原因追跡できるようにコンソールへ出力する
    console.error('[AppErrorBoundary] Caught render error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.errorContainer}>
          <Text style={styles.errorTitle}>予期せぬエラーが発生しました</Text>
          <Text style={styles.errorTitleEn}>An unexpected error occurred</Text>
          <Text style={styles.errorHint}>
            アプリを再起動してください。{'\n'}Please restart the app.
          </Text>
          {__DEV__ && (
            <Text style={styles.errorDetail}>{this.state.errorMessage}</Text>
          )}
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
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
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
    marginBottom: 24,
  },
  errorHint: {
    color: '#666',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
  },
  errorDetail: {
    marginTop: 24,
    color: '#8B0000',
    fontSize: 11,
    textAlign: 'center',
    fontFamily: 'monospace',
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

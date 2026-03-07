/**
 * One Shot – app/index.tsx
 * Expo Router main screen (export default function Page)
 * React Native port of the web PWA
 */

import React, { useState, useEffect, useRef, useCallback, type RefObject } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  ScrollView,
  StyleSheet,
  Alert,
  Modal,
  Switch,
  Dimensions,
  ActivityIndicator,
  Image,
  Linking,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { Feather, Ionicons } from '@expo/vector-icons';
import { Video, ResizeMode } from 'expo-av';
import { LinearGradient } from 'expo-linear-gradient';
import MaskedView from '@react-native-masked-view/masked-view';
import { differenceInCalendarDays, subHours, getDay, format } from 'date-fns';
import Purchases, {
  PurchasesOfferings,
  PurchasesPackage,
  CustomerInfo,
} from 'react-native-purchases';
import { captureRef } from 'react-native-view-shot';
import * as Notifications from 'expo-notifications';
import * as StoreReview from 'expo-store-review';
import { processVideo } from '../modules/video-overlay';

// ─── Constants ───────────────────────────────────────────────────────────────

const RC_API_KEY = 'appl_hxzNKcnblLemtdWosMHSIFpQWYR';
const HOUR_BOUNDARY = 3; // Day resets at 3 AM
const STORAGE_KEY = 'oneshot_state_v2';
const LANG_KEY = 'oneshot_lang';

// ─── Types ────────────────────────────────────────────────────────────────────

type Screen = 'onboarding' | 'paywall' | 'home' | 'camera' | 'history' | 'settings' | 'guide';
type Lang = 'ja' | 'en';

interface AppState {
  goal: string;
  streak: number;
  lastRecordDate: string;
  freePassCount: number;
  paidPassCount: number;
  onboarded: boolean;
  guideShown: boolean;
  lastPassGrant: string;
  notifyTime: string;
  subscribed: boolean;
  showRecordingCountdown: boolean;
  rcUserID: string;
  reviewRequested: boolean;
  userId: string;          // "OS-YYYY-NNN" generated once
  challengeDays?: number;  // total days for challenge (undefined = no challenge)
}

interface RecordEntry {
  date: string;
  day: number;
  ts: number;
  uri?: string;
  isPass?: boolean;
}

// ─── Translations ─────────────────────────────────────────────────────────────

const TRANSLATIONS: Record<Lang, Record<string, string>> = {
  ja: {
    meta_description: '1日1本。習慣を動画で記録するアプリ。',
    onboarding_subtitle: '5秒で記録する、ストイックな習慣',
    onboarding_label: '目標を入力',
    onboarding_placeholder: '例: 筋トレ毎日',
    streak_label: 'Day Streak',
    today_label: '今日',
    pass_remain_label: 'パス残',
    mode_video: '動画',
    mode_photo: '写真',
    retry_btn: '撮り直し',
    save_btn: '保存',
    share_btn: 'SNSにシェア',
    close_btn: '閉じる',
    settings_title: 'SETTINGS',
    settings_guide: 'アプリの使い方',
    settings_goal_label: '目標',
    settings_notify_label: 'リマインド通知',
    settings_notify_hint: '毎日この時刻に通知します',
    settings_save_btn: '保存',
    settings_reset_btn: 'すべてのデータをリセット',
    settings_language_label: '言語 / Language',
    paywall_sub: 'メンバーシップ',
    paywall_price_sub: '/ 年（税込）・自動更新',
    paywall_feature1: '動画・写真の毎日撮影（無制限）',
    paywall_feature2: 'ストリーク管理・継続記録',
    paywall_feature3: 'Instagram / TikTok への SNS シェア',
    paywall_feature4: '毎週1枚の無料パス自動付与',
    paywall_feature5: '撮影履歴・カレンダー表示',
    paywall_subscribe_btn: '年額プランで始める',
    paywall_pass_note: 'お休みパスは ¥100/枚 で別途購入できます',
    paywall_restore_btn: '購入を復元する',
    paywall_terms: '利用規約',
    paywall_privacy: 'プライバシーポリシー',
    nav_today: 'TODAY',
    nav_history: 'HISTORY',
    guide_sub: '使い方ガイド',
    guide_card1_title: '習慣化の仕組み',
    guide_card1_body: '1日1回、継続したい習慣の動画を撮り、SNSにシェアしましょう。フォロワーが見ていることで、サボれない環境を作ります。',
    guide_card2_title: '撮影の流れ',
    guide_step1: 'カメラボタンを押す',
    guide_step2: '3・2・1 カウントダウン',
    guide_step3: '自動で3秒録画・停止',
    guide_step4: '保存 → シェア',
    guide_card3_title: 'Instagram で継続を確実に',
    guide_card3_body: '動画はInstagramストーリーにアップし、「ハイライト」に保存しましょう。',
    guide_tip1: 'フォロワーが見ている＝サボれない',
    guide_tip2: 'ハイライトに記録が積み上がる',
    guide_tip3: '継続を可視化して自信につなげる',
    guide_card4_title: 'パス（お休み）機能',
    guide_card4_body: '週に1回、お休みできる「パス」が付与されます。どうしても継続できない時に使いましょう。ストリークがそのまま維持されます。',
    guide_card5_title: 'パスの購入',
    guide_card5_body: 'パスは1枚¥100で追加購入できます。有効期限なし、何枚でもストックできます。',
    guide_start_btn: 'はじめる',
    pass_purchase_btn: 'パスを購入（¥100）',
    use_pass_btn_prefix: 'パスを使う（残り ',
    use_pass_btn_suffix: '枚）',
    toast_save_error: '保存エラー',
    toast_db_error: 'ストレージエラー',
    toast_free_pass_granted: '今週の無料パスが付与されました',
    toast_pass_used_auto: 'パスを使用してストリークを維持しました',
    toast_settings_saved: '設定を保存しました',
    toast_camera_error: 'カメラエラー: ',
    toast_retry: '撮り直します',
    toast_no_data: 'データなし',
    toast_save_complete: 'DAY {day} 保存完了！',
    toast_share_done: 'シェアしました！',
    toast_share_fail: 'シェア失敗: ',
    toast_share_unsupported: 'シェア非対応',
    toast_download_done: '動画を端末に保存しました',
    toast_already_recorded: '今日はすでに記録済みです',
    toast_no_pass: 'パスがありません',
    toast_pass_used: 'パスを使用しました。お疲れ様！',
    toast_paid_pass_added: '有料パス +1 追加されました（ストック中）',
    confirm_purchase_pass: 'パスを1回分購入しますか？（¥100）',
    confirm_subscribe: '月額¥300のメンバーシップを開始しますか？',
    confirm_restore: '購入を復元しますか？',
    confirm_use_pass: '本日はパス（お休み）を使用しますか？\nストリークがそのまま維持されます。',
    confirm_reset: 'すべてのデータを削除しますか？',
    no_history: 'まだ記録がありません',
    recorded_today: 'RECORDED TODAY',
    share_hashtag: '#oneshot #習慣化',
    cam_permission_title: 'カメラへのアクセスを許可してください',
    cam_permission_body: 'One Shot はカメラとマイクを使用して動画を記録します。設定からアクセスを許可してください。',
    cam_permission_btn: 'カメラ設定を開く',
    cam_permission_back: '戻る',
    settings_countdown_label: '録画中カウントダウン',
    settings_countdown_hint: '録画中に残り時間を表示',
    settings_restore_btn: '購入の復元',
    settings_contact_btn: 'お問い合わせ',
    confirm_use_pass_ok: 'はい',
    cancel: 'キャンセル',
    processing: '処理中...',
    restoring: '復元中...',
    subscribe_success: 'メンバーシップが有効になりました',
    restore_success: '購入内容を復元しました',
    restore_none: '復元できる購入履歴が見つかりませんでした',
    purchase_failed: '購入に失敗しました',
    restore_failed: '復元に失敗しました',
    pass_not_found: 'パス商品が見つかりません',
    product_not_found: '商品情報の取得に失敗しました',
    history_delete: '削除',
    history_resave: '再保存',
    confirm_delete_record: 'この記録を削除しますか？\n削除後は今日の撮影が再度できるようになります。',
    toast_deleted: '記録を削除しました',
    toast_resave_done: 'カメラロールに再保存しました',
    toast_processing_video: '5秒動画を生成中...',
    toast_processing_error: '動画処理エラー（元の動画を使用）',
  },
  en: {
    meta_description: 'One video a day. Build the habit. Leave the record.',
    onboarding_subtitle: 'One video. Every day. No excuses.',
    onboarding_label: 'Name your habit',
    onboarding_placeholder: 'e.g. MORNING RUN',
    streak_label: 'DAY STREAK',
    today_label: 'TODAY',
    pass_remain_label: 'PASSES',
    mode_video: 'VIDEO',
    mode_photo: 'PHOTO',
    retry_btn: 'RETAKE',
    save_btn: 'SAVE',
    share_btn: 'SHARE',
    close_btn: 'CLOSE',
    settings_title: 'SETTINGS',
    settings_guide: 'How to use',
    settings_goal_label: 'Habit',
    settings_notify_label: 'Daily Reminder',
    settings_notify_hint: "You'll be notified at this time every day",
    settings_save_btn: 'SAVE',
    settings_reset_btn: 'Reset All Data',
    settings_language_label: '言語 / Language',
    paywall_sub: 'ANNUAL MEMBERSHIP',
    paywall_price_sub: '/ year · billed annually · cancel anytime',
    paywall_feature1: 'Unlimited daily video & photo recording',
    paywall_feature2: 'Streak tracking & accountability log',
    paywall_feature3: 'Direct share to Instagram / TikTok',
    paywall_feature4: 'Weekly free rest pass — auto-granted',
    paywall_feature5: 'Full history with calendar view',
    paywall_subscribe_btn: 'Get Access',
    paywall_pass_note: 'Rest passes available separately at ¥100/pass',
    paywall_restore_btn: 'Restore Purchases',
    paywall_terms: 'Terms of Service',
    paywall_privacy: 'Privacy Policy',
    nav_today: 'TODAY',
    nav_history: 'HISTORY',
    guide_sub: 'How It Works',
    guide_card1_title: 'The system',
    guide_card1_body: 'Record one short video of your habit every day. Share it. The accountability of an audience makes quitting harder than continuing.',
    guide_card2_title: 'Recording flow',
    guide_step1: 'Tap the camera',
    guide_step2: '3 · 2 · 1 countdown',
    guide_step3: 'Auto-records 3 sec, stops',
    guide_step4: 'Save → Share',
    guide_card3_title: 'Lock it in with Instagram',
    guide_card3_body: 'Post to Instagram Stories. Save to a Highlight. Your streak becomes a permanent archive.',
    guide_tip1: 'Public commitment = no exit ramp',
    guide_tip2: 'Your highlight reel is your proof of work',
    guide_tip3: 'Visible data builds unshakeable confidence',
    guide_card4_title: 'Rest pass',
    guide_card4_body: "One free pass per week. Use it when life intervenes. Your streak stays intact — one pass, one miss.",
    guide_card5_title: 'Extra passes',
    guide_card5_body: 'Additional passes at ¥100 each. No expiry. Stock them before you need them.',
    guide_start_btn: 'START',
    pass_purchase_btn: 'BUY A PASS (¥100)',
    use_pass_btn_prefix: 'USE PASS  (',
    use_pass_btn_suffix: ' left)',
    toast_save_error: 'Save error',
    toast_db_error: 'Storage error',
    toast_free_pass_granted: 'Weekly free pass granted',
    toast_pass_used_auto: 'Pass used — streak maintained',
    toast_settings_saved: 'Saved',
    toast_camera_error: 'Camera error: ',
    toast_retry: 'Retaking...',
    toast_no_data: 'No data',
    toast_save_complete: 'DAY {day} — LOGGED',
    toast_share_done: 'Shared',
    toast_share_fail: 'Share failed: ',
    toast_share_unsupported: 'Sharing not supported',
    toast_download_done: 'Saved to camera roll',
    toast_already_recorded: 'Already logged today',
    toast_no_pass: 'No passes remaining',
    toast_pass_used: 'Pass used. Stay on track.',
    toast_paid_pass_added: 'Pass +1 stocked',
    confirm_purchase_pass: 'Purchase 1 rest pass? (¥100)',
    confirm_subscribe: 'Start your annual membership?',
    confirm_restore: 'Restore purchases?',
    confirm_use_pass: 'Use a rest pass for today?\nYour streak will be maintained.',
    confirm_reset: 'Delete all data?',
    no_history: 'No records yet',
    recorded_today: 'LOGGED TODAY',
    share_hashtag: '#oneshot #habitbuilding',
    cam_permission_title: 'Camera Access Required',
    cam_permission_body: 'ONE SHOT needs camera and microphone access to record. Please enable in Settings.',
    cam_permission_btn: 'Open Settings',
    cam_permission_back: 'Go Back',
    settings_countdown_label: 'Recording Countdown',
    settings_countdown_hint: 'Display timer during recording',
    settings_restore_btn: 'Restore Purchases',
    settings_contact_btn: 'Contact',
    confirm_use_pass_ok: 'Confirm',
    cancel: 'Cancel',
    processing: 'Processing...',
    restoring: 'Restoring...',
    subscribe_success: 'Access granted',
    restore_success: 'Purchases restored',
    restore_none: 'No restorable purchases found',
    purchase_failed: 'Purchase failed',
    restore_failed: 'Restore failed',
    pass_not_found: 'Pass product not found',
    product_not_found: 'Product info unavailable',
    history_delete: 'Delete',
    history_resave: 'Re-save',
    confirm_delete_record: "Delete this record?\nYou'll be able to log again today.",
    toast_deleted: 'Record deleted',
    toast_resave_done: 'Re-saved to camera roll',
    toast_processing_video: 'Rendering overlay...',
    toast_processing_error: 'Overlay error (using original)',
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return n < 10 ? '0' + n : '' + n;
}

// AM3:00 を日付境界として「アプリ上の今日」の日付文字列を返す
function getAppDate(d?: Date): string {
  return format(subHours(d ?? new Date(), HOUR_BOUNDARY), 'yyyy-MM-dd');
}

// 週の曜日（0=日, 1=月 … 6=土）を AM3:00 基準で返す
function getAppDayOfWeek(d?: Date): number {
  return getDay(subHours(d ?? new Date(), HOUR_BOUNDARY));
}

// date-fns でカレンダー日数差を計算（切り捨て誤差なし）
function daysBetween(a: string, b: string): number {
  return differenceInCalendarDays(new Date(b), new Date(a));
}

const defaultState: AppState = {
  goal: '',
  streak: 0,
  lastRecordDate: '',
  freePassCount: 0,
  paidPassCount: 0,
  onboarded: false,
  guideShown: false,
  lastPassGrant: '',
  notifyTime: '21:00',
  subscribed: false,
  showRecordingCountdown: true,
  rcUserID: '',
  reviewRequested: false,
  userId: '',
  challengeDays: undefined,
};

// ─── Notifications ────────────────────────────────────────────────────────────

Notifications.setNotificationHandler({
  handleNotification: async (): Promise<Notifications.NotificationBehavior> => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function scheduleDailyNotification(timeStr: string, title: string, body: string) {
  await Notifications.cancelAllScheduledNotificationsAsync();
  const parts = timeStr.split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1] ?? '0', 10);
  if (isNaN(h) || isNaN(m)) return;
  await Notifications.scheduleNotificationAsync({
    content: { title, body, sound: true },
    trigger: {
      hour: h,
      minute: m,
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
    },
  });
}

// ─── StableCameraView ─────────────────────────────────────────────────────────
// CameraView を React.memo でラップし、親の state 変化による再レンダリングを防ぐ
// countdown/isRecording が変わっても CameraView 自体は再マウントされない → フリッカー解消

const StableCameraView = React.memo(({ cameraRef, facing, mode }: {
  cameraRef: RefObject<CameraView>;
  facing: CameraType;
  mode: 'video' | 'picture';
}) => (
  <CameraView
    ref={cameraRef}
    style={styles.camera}
    facing={facing}
    mode={mode}
  />
));

// ─── Toast Component ──────────────────────────────────────────────────────────

interface ToastProps {
  message: string;
  isError?: boolean;
}

const Toast: React.FC<ToastProps> = ({ message, isError }) => {
  if (!message) return null;
  return (
    <View style={[styles.toast, isError && styles.toastError]}>
      <Text style={styles.toastText}>{message}</Text>
    </View>
  );
};

// ─── Main Page Component ──────────────────────────────────────────────────────

export default function Page() {
  const [appState, setAppState] = useState<AppState>(defaultState);
  const [lang, setLang] = useState<Lang>('en');
  const [screen, setScreen] = useState<Screen>('onboarding');
  const [toastMsg, setToastMsg] = useState('');
  const [toastError, setToastError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [guideVisible, setGuideVisible] = useState(false);

  // Camera state
  const [camPermission, requestCamPermission] = useCameraPermissions();
  const [mediaPermission, requestMediaPermission] = MediaLibrary.usePermissions();
  const [facing, setFacing] = useState<CameraType>('front');
  const [camMode, setCamMode] = useState<'video' | 'photo'>('video');
  const [isRecording, setIsRecording] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);       // 撮影前 3-2-1
  const [recordingCountdown, setRecordingCountdown] = useState<number | null>(null); // 録画中残り秒数
  const [capturedUri, setCapturedUri] = useState<string | null>(null);
  const [capturedType, setCapturedType] = useState<'photo' | 'video'>('video');
  const [capturedTime, setCapturedTime] = useState<Date | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingCountdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [isProcessingVideo, setIsProcessingVideo] = useState(false);
  // null! = non-null assertion: RefObject<CameraView> として扱い TS の型エラーを解消
  const cameraRef = useRef<CameraView>(null!);
  const previewVideoRef = useRef<Video>(null);
  const previewCardRef = useRef<any>(null);     // react-native-view-shot 用

  // History state
  const [records, setRecords] = useState<RecordEntry[]>([]);
  const [calYear, setCalYear] = useState(new Date().getFullYear());
  const [calMonth, setCalMonth] = useState(new Date().getMonth());
  const [selectedRecord, setSelectedRecord] = useState<RecordEntry | null>(null);

  // RevenueCat state
  const [rcOfferings, setRcOfferings] = useState<PurchasesOfferings | null>(null);

  // Review trigger
  const [reviewReady, setReviewReady] = useState(false);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Translation helper ──────────────────────────────────────────────────────

  const t = useCallback((key: string, vars?: Record<string, string | number>): string => {
    let str = TRANSLATIONS[lang][key] ?? TRANSLATIONS['en'][key] ?? key;
    if (vars) {
      Object.entries(vars).forEach(([k, v]) => {
        str = str.replace(`{${k}}`, String(v));
      });
    }
    return str;
  }, [lang]);

  // ── Toast ───────────────────────────────────────────────────────────────────

  const showToast = useCallback((msg: string, isError = false) => {
    setToastMsg(msg);
    setToastError(isError);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), 3000);
  }, []);

  // ── State persistence ───────────────────────────────────────────────────────

  const saveAppState = useCallback(async (newState: AppState) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(newState));
    } catch {
      // silent
    }
  }, []);

  const updateState = useCallback((updates: Partial<AppState>) => {
    setAppState(prev => {
      const next = { ...prev, ...updates };
      saveAppState(next);
      return next;
    });
  }, [saveAppState]);

  // ── Date helpers ────────────────────────────────────────────────────────────

  const totalPassCount = useCallback((s?: AppState): number => {
    const st = s || appState;
    return st.freePassCount + st.paidPassCount;
  }, [appState]);

  const consumePass = useCallback((s: AppState): AppState => {
    if (s.freePassCount > 0) return { ...s, freePassCount: s.freePassCount - 1 };
    if (s.paidPassCount > 0) return { ...s, paidPassCount: s.paidPassCount - 1 };
    return s;
  }, []);

  const checkPassGrant = useCallback((s: AppState): AppState => {
    const today = getAppDate();
    const dow = getAppDayOfWeek();
    if (dow === 1 && s.lastPassGrant !== today) {
      return { ...s, freePassCount: 1, lastPassGrant: today };
    }
    return s;
  }, []);

  // 当日限定モデル: 前日までに記録もパスもなければ容赦なくリセット
  const updateStreak = useCallback((s: AppState): AppState => {
    if (!s.lastRecordDate) return s;
    const diff = daysBetween(s.lastRecordDate, getAppDate());
    if (diff >= 2) return { ...s, streak: 0 }; // 昨日以前から未記録 → 即リセット
    return s; // diff=0(今日済) or diff=1(昨日済・今日まだ) はそのまま
  }, []);

  // ── RevenueCat helpers ──────────────────────────────────────────────────────

  const findRCPackage = useCallback((type: 'pass' | 'subscription'): PurchasesPackage | null => {
    if (!rcOfferings?.current) return null;
    const pkgs = rcOfferings.current.availablePackages;
    if (type === 'subscription') {
      // 1st: 年額プランの製品ID で完全一致
      return pkgs.find(p => p.product.identifier === 'com.jin.oneshot.annual.premium')
        // 2nd: RevenueCat 標準の $rc_annual パッケージ
        ?? rcOfferings.current.annual
        ?? pkgs.find(p => p.identifier === '$rc_annual' || p.identifier.toLowerCase().includes('annual'))
        // 3rd: 旧月額プランへのフォールバック
        ?? pkgs.find(p => p.product.identifier === 'com.jin.oneshot.premium')
        ?? rcOfferings.current.monthly
        ?? pkgs.find(p => p.identifier === '$rc_monthly' || p.identifier.toLowerCase().includes('month'))
        ?? pkgs[0]
        ?? null;
    }
    if (type === 'pass') {
      // 1st: Product ID で完全一致
      return pkgs.find(p => p.product.identifier === 'com.jin.oneshot.1pass')
        // 2nd: Package ID フォールバック
        ?? pkgs.find(p => p.identifier === 'pass')
        ?? pkgs.find(p => p.identifier.toLowerCase().includes('pass'))
        ?? null;
    }
    return null;
  }, [rcOfferings]);

  const syncRCEntitlements = useCallback(async (): Promise<boolean> => {
    try {
      const info: CustomerInfo = await Purchases.getCustomerInfo();
      // Entitlement ID 'premium' で判定
      return !!info.entitlements.active['premium'];
    } catch {
      return false;
    }
  }, []);

  // ── Purchase flows ──────────────────────────────────────────────────────────

  const purchasePass = useCallback(async () => {
    const pkg = findRCPackage('pass');
    if (!pkg) {
      showToast(t('pass_not_found'), true);
      return;
    }
    showToast(t('processing'));
    try {
      await Purchases.purchasePackage(pkg);
      setAppState(prev => {
        const next = { ...prev, paidPassCount: prev.paidPassCount + 1 };
        saveAppState(next);
        return next;
      });
      showToast(t('toast_paid_pass_added'));
    } catch (e: any) {
      if (!e.userCancelled) {
        showToast(t('purchase_failed'), true);
      }
    }
  }, [findRCPackage, showToast, t, saveAppState]);

  const subscribePremium = useCallback(async () => {
    const pkg = findRCPackage('subscription');
    if (!pkg) {
      showToast(t('product_not_found'), true);
      return;
    }
    showToast(t('processing'));
    try {
      const { customerInfo } = await Purchases.purchasePackage(pkg);
      const active = !!customerInfo.entitlements.active['premium'];
      if (active) {
        updateState({ subscribed: true });
        showToast(t('subscribe_success'));
        setScreen('home');
        setAppState(prev => {
          if (!prev.guideShown) {
            setTimeout(() => setGuideVisible(true), 400);
          }
          return prev;
        });
      }
    } catch (e: any) {
      if (!e.userCancelled) {
        showToast(t('purchase_failed'), true);
      }
    }
  }, [findRCPackage, showToast, t, updateState]);

  const restorePurchase = useCallback(async () => {
    showToast(t('restoring'));
    try {
      const info = await Purchases.restorePurchases();
      const active = !!info.entitlements.active['premium'];
      if (active) {
        updateState({ subscribed: true });
        showToast(t('restore_success'));
        setScreen('home');
      } else {
        showToast(t('restore_none'), true);
      }
    } catch {
      showToast(t('restore_failed'), true);
    }
  }, [showToast, t, updateState]);

  // ── Use pass ────────────────────────────────────────────────────────────────

  const usePassToday = useCallback(() => {
    const today = getAppDate();
    if (appState.lastRecordDate === today) {
      showToast(t('toast_already_recorded'));
      return;
    }
    if (totalPassCount() === 0) {
      purchasePass();
      return;
    }
    Alert.alert('', t('confirm_use_pass'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('confirm_use_pass_ok'),
        onPress: () => {
          setAppState(prev => {
            const diff = prev.lastRecordDate ? daysBetween(prev.lastRecordDate, today) : 999;
            const newStreak = diff <= 1 ? prev.streak + 1 : 1;
            const passEntry: RecordEntry = { date: today, day: newStreak, ts: Date.now(), isPass: true };
            setRecords(r => [passEntry, ...r.filter(x => x.date !== today)]);
            const consumed = consumePass({ ...prev, streak: newStreak, lastRecordDate: today });
            saveAppState(consumed);
            return consumed;
          });
          showToast(t('toast_pass_used'));
        },
      },
    ]);
  }, [appState, totalPassCount, purchasePass, consumePass, saveAppState, showToast, t]);

  // ── Record today ────────────────────────────────────────────────────────────

  const recordToday = useCallback((uri: string) => {
    setAppState(prev => {
      const today = getAppDate();
      if (prev.lastRecordDate === today) return prev;
      const diff = prev.lastRecordDate ? daysBetween(prev.lastRecordDate, today) : 999;
      const newStreak = diff <= 1 ? prev.streak + 1 : 1;
      const newEntry: RecordEntry = { date: today, day: newStreak, ts: Date.now(), uri };
      setRecords(r => [newEntry, ...r]);
      // Trigger store review when streak first reaches 5
      const shouldReview = newStreak === 5 && !prev.reviewRequested;
      if (shouldReview) setReviewReady(true);
      const next = { ...prev, streak: newStreak, lastRecordDate: today,
        reviewRequested: shouldReview ? true : prev.reviewRequested };
      saveAppState(next);
      showToast(t('toast_save_complete', { day: newStreak }));
      return next;
    });
  }, [saveAppState, showToast, t]);

  // ── Store review trigger ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!reviewReady) return;
    setReviewReady(false);
    (async () => {
      try {
        if (await StoreReview.isAvailableAsync()) {
          await StoreReview.requestReview();
        }
      } catch {}
    })();
  }, [reviewReady]);

  // ── Init ────────────────────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      try {
        // Load lang
        const savedLang = await AsyncStorage.getItem(LANG_KEY);
        if (savedLang === 'en' || savedLang === 'ja') setLang(savedLang);

        // Load state
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        let loaded: AppState = { ...defaultState };
        if (raw) {
          const parsed = JSON.parse(raw);
          loaded = { ...defaultState, ...parsed };
        }

        // Ensure rcUserID
        if (!loaded.rcUserID) {
          loaded.rcUserID = 'user_' + Math.random().toString(36).substr(2, 12) + '_' + Date.now();
        }

        // Ensure userId (stable "OS-YYYY-NNN" identifier for overlay)
        if (!loaded.userId) {
          const year = new Date().getFullYear();
          const num = Math.floor(Math.random() * 999) + 1;
          loaded.userId = `OS-${year}-${String(num).padStart(3, '0')}`;
        }

        // Load records
        const recRaw = await AsyncStorage.getItem('oneshot_records_v2');
        if (recRaw) setRecords(JSON.parse(recRaw));

        setAppState(loaded);
        await saveAppState(loaded);

        // Init RevenueCat
        try {
          Purchases.configure({ apiKey: RC_API_KEY, appUserID: loaded.rcUserID });
          const offerings = await Purchases.getOfferings();
          setRcOfferings(offerings);
          const active = await syncRCEntitlements();
          if (active !== loaded.subscribed) {
            const next = { ...loaded, subscribed: active };
            setAppState(next);
            await saveAppState(next);
            loaded = next;
          }
        } catch (e) {
          console.warn('[RC] init error:', e);
        }

        // Init notifications
        try {
          const { status } = await Notifications.requestPermissionsAsync();
          if (status === 'granted') {
            const notifyLang = savedLang ?? 'ja';
            const notifyTitle = notifyLang === 'ja' ? '今日の記録をしましょう！' : "Time to record today's habit!";
            const notifyBody = notifyLang === 'ja'
              ? `目標: ${loaded.goal || 'One Shot'}`
              : `Goal: ${loaded.goal || 'One Shot'}`;
            await scheduleDailyNotification(loaded.notifyTime, notifyTitle, notifyBody);
          }
        } catch (e) {
          console.warn('[Notify] init error:', e);
        }

        // Navigate
        if (!loaded.onboarded) {
          setScreen('onboarding');
        } else if (!loaded.subscribed) {
          setScreen('paywall');
        } else {
          setScreen('home');
          if (!loaded.guideShown) setGuideVisible(true);
        }
      } finally {
        setIsLoading(false);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Save records ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isLoading) {
      AsyncStorage.setItem('oneshot_records_v2', JSON.stringify(records)).catch(() => {});
    }
  }, [records, isLoading]);

  // ── Refresh home (streak/pass) ──────────────────────────────────────────────

  useEffect(() => {
    if (screen === 'home') {
      setAppState(prev => {
        const afterStreak = updateStreak(prev);        // diff>=2 → streak=0
        const afterPass = checkPassGrant(afterStreak); // 月曜フリーパス付与
        if (afterPass !== prev) saveAppState(afterPass);
        return afterPass;
      });
    }
  }, [screen]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Camera recording ────────────────────────────────────────────────────────

  const clearCamTimers = useCallback(() => {
    if (recordingTimerRef.current) { clearTimeout(recordingTimerRef.current); recordingTimerRef.current = null; }
    if (recordingCountdownRef.current) { clearInterval(recordingCountdownRef.current); recordingCountdownRef.current = null; }
  }, []);

  const startRecording = useCallback(async () => {
    if (isRecording || countdown !== null) return;

    // 権限確認
    if (!camPermission?.granted) {
      const result = await requestCamPermission();
      if (!result.granted) return;
    }
    if (!cameraRef.current) return;

    // ── 事前カウントダウン（トグル ON 時のみ）──
    // CameraScreen() を直接呼び出し（<CameraScreen />ではない）ので
    // CameraView は同一位置に留まり、state 変化で再マウントされない → フリッカーなし
    if (appState.showRecordingCountdown) {
      for (let i = 3; i >= 1; i--) {
        setCountdown(i);
        await new Promise<void>(r => setTimeout(r, 1000));
      }
      setCountdown(null);
    }

    // ── ハードウェア準備待機（iOS実機: 200ms でカメラが確実に安定）──
    await new Promise<void>(r => setTimeout(r, 200));
    if (!cameraRef.current) return; // 待機中に unmount された場合のガード

    // ── 写真モード ──
    if (camMode === 'photo') {
      try {
        const photo = await cameraRef.current.takePictureAsync({
          quality: 0.92,
          skipProcessing: false,
        });
        if (photo?.uri) {
          setCapturedUri(photo.uri);
          setCapturedType('photo');
          setCapturedTime(new Date());
        }
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        console.error('[photo] takePictureAsync error:', msg);
        showToast(t('toast_camera_error') + msg, true);
      }
      return;
    }

    // ── 動画モード（3秒録画 → FFmpegで5秒に延長）──
    setIsRecording(true);
    const RECORD_SECS = 3;

    // 録画中カウントダウン
    setRecordingCountdown(RECORD_SECS);
    let remaining = RECORD_SECS;
    recordingCountdownRef.current = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        setRecordingCountdown(null);
        if (recordingCountdownRef.current) {
          clearInterval(recordingCountdownRef.current);
          recordingCountdownRef.current = null;
        }
      } else {
        setRecordingCountdown(remaining);
      }
    }, 1000);

    let rawUri: string | null = null;
    try {
      // recordAsync 呼び出し前にさらに 50ms の余裕を確保
      await new Promise<void>(r => setTimeout(r, 50));
      const recordPromise = cameraRef.current.recordAsync({ maxDuration: RECORD_SECS + 0.5 });

      // 安全マージン +400ms で確実に停止
      recordingTimerRef.current = setTimeout(() => {
        try { cameraRef.current?.stopRecording(); } catch { /* ignore */ }
      }, RECORD_SECS * 1000 + 400);

      const result = await recordPromise;
      clearCamTimers();
      setRecordingCountdown(null);
      rawUri = result?.uri ?? null;
    } catch (e: any) {
      clearCamTimers();
      const msg = String(e?.message ?? e);
      console.error('[video] recordAsync error:', msg);
      if (!msg.includes('cancel') && !msg.includes('stopped') && !msg.includes('abort') && !msg.includes('RecordingExceptionError')) {
        showToast(t('toast_camera_error') + msg, true);
      }
    } finally {
      setIsRecording(false);
      setCountdown(null);
      setRecordingCountdown(null);
    }

    if (!rawUri) return;

    // Show raw video in preview immediately, then replace with overlay-burned version
    const captureTime = new Date();
    setCapturedTime(captureTime);
    setCapturedType('video');
    setCapturedUri(rawUri);
    setIsProcessingVideo(true);
    try {
      const processed = await processVideo({
        inputPath: rawUri,
        userId: appState.userId || 'OS-2026-001',
        habitName: (appState.goal || 'HABIT').toUpperCase(),
        currentDay: appState.streak + 1,
        totalDays: appState.challengeDays,
      });
      setCapturedUri(processed);
    } catch (vErr) {
      console.warn('[processVideo] fallback to raw video:', vErr);
      // capturedUri already set to rawUri, just proceed without overlay
    } finally {
      setIsProcessingVideo(false);
    }
  }, [camPermission, requestCamPermission, isRecording, countdown, camMode,
      appState.showRecordingCountdown, appState.userId, appState.goal,
      appState.streak, appState.challengeDays, clearCamTimers, showToast, t]);

  const retake = useCallback(() => {
    clearCamTimers();
    setCapturedUri(null);
    setCapturedType('video');
    setCapturedTime(null);
    setIsPreviewPlaying(false);
  }, [clearCamTimers]);

  const saveCapture = useCallback(async () => {
    if (!capturedUri) return;
    try {
      if (!mediaPermission?.granted) await requestMediaPermission();

      let uriToSave = capturedUri;

      // 動画の場合: オーバーレイは撮影直後にSwift側で焼き込み済み → そのまま保存
      // (capturedUri は processVideo() 済みのファイルを指している)

      // 写真の場合: react-native-view-shot でフィルター込みの見た目通りに保存
      if (capturedType === 'photo' && previewCardRef.current) {
        try {
          uriToSave = await captureRef(previewCardRef.current, {
            format: 'jpg',
            quality: 0.95,
            result: 'tmpfile',
          });
          console.log('[view-shot] captured with filter:', uriToSave);
        } catch (vsErr) {
          console.warn('[view-shot] fallback to raw photo:', vsErr);
          uriToSave = capturedUri;
        }
      }

      await MediaLibrary.saveToLibraryAsync(uriToSave);
      recordToday(capturedUri); // 元のURIを記録に残す
      setCapturedUri(null);
      setCapturedTime(null);
      setScreen('home');
    } catch (e) {
      console.error('[saveCapture] error:', e);
      showToast(t('toast_save_error'), true);
    }
  }, [capturedUri, capturedType, mediaPermission, requestMediaPermission, recordToday, showToast, t]);

  // ── 履歴レコード削除（当日分はストリーク・lastRecordDateもリセット）──
  const deleteRecord = useCallback((record: RecordEntry) => {
    Alert.alert('', t('confirm_delete_record'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('history_delete'),
        style: 'destructive',
        onPress: () => {
          const today = getAppDate();
          const isToday = record.date === today;

          setRecords(prev => {
            const next = prev.filter(r => r.date !== record.date);
            AsyncStorage.setItem('oneshot_records_v2', JSON.stringify(next)).catch(() => {});
            return next;
          });

          // 今日の記録を削除 → 今日もう一度撮影できるようにリセット
          if (isToday) {
            setAppState(prev => {
              const prevStreak = Math.max(0, prev.streak - 1);
              const next = { ...prev, streak: prevStreak, lastRecordDate: '' };
              saveAppState(next);
              return next;
            });
          }

          setSelectedRecord(null);
          showToast(t('toast_deleted'));
        },
      },
    ]);
  }, [t, saveAppState, showToast]);

  // ── 履歴レコード再保存（カメラロールへ）──
  const resaveRecord = useCallback(async (record: RecordEntry) => {
    if (!record.uri) { showToast(t('toast_no_data'), true); return; }
    try {
      if (!mediaPermission?.granted) await requestMediaPermission();
      await MediaLibrary.saveToLibraryAsync(record.uri);
      showToast(t('toast_resave_done'));
    } catch (e) {
      console.error('[resaveRecord] error:', e);
      showToast(t('toast_save_error'), true);
    }
  }, [mediaPermission, requestMediaPermission, showToast, t]);

  // ── 履歴レコードSNSシェア ──
  const shareRecord = useCallback(async (record: RecordEntry) => {
    if (!record.uri) { showToast(t('toast_no_data'), true); return; }
    try {
      const isPhoto = /\.(jpg|jpeg|png)$/i.test(record.uri);
      await Sharing.shareAsync(record.uri, {
        mimeType: isPhoto ? 'image/jpeg' : 'video/mp4',
        UTI: isPhoto ? 'public.image' : 'public.movie',
        dialogTitle: 'Share to Instagram Stories',
      });
      showToast(t('toast_share_done'));
    } catch (e: any) {
      if (!e?.message?.includes('cancel')) showToast(t('toast_share_fail') + String(e), true);
    }
  }, [showToast, t]);

  // Instagram Stories への直接シェア（インストール済みの場合）
  // フォールバック: システムシェアシートで選択可能
  const shareToInstagram = useCallback(async () => {
    if (!capturedUri) return;
    try {
      // Instagram がインストール済みか確認
      const igScheme = 'instagram://';
      const igInstalled = await Linking.canOpenURL(igScheme).catch(() => false);
      if (igInstalled) {
        // システムシェアシートを Instagram 向けに開く
        await Sharing.shareAsync(capturedUri, {
          UTI: capturedType === 'photo' ? 'public.image' : 'public.movie',
          mimeType: capturedType === 'photo' ? 'image/jpeg' : 'video/mp4',
          dialogTitle: 'Share to Instagram Stories',
        });
      } else {
        const canShare = await Sharing.isAvailableAsync();
        if (!canShare) { showToast(t('toast_share_unsupported')); return; }
        await Sharing.shareAsync(capturedUri);
      }
      showToast(t('toast_share_done'));
    } catch (e: any) {
      if (!e?.message?.includes('cancel')) {
        showToast(t('toast_share_fail') + String(e), true);
      }
    }
  }, [capturedUri, capturedType, showToast, t]);

  // ── Language switch ─────────────────────────────────────────────────────────

  const switchLang = useCallback((l: Lang) => {
    setLang(l);
    AsyncStorage.setItem(LANG_KEY, l).catch(() => {});
  }, []);

  // ── Reset all ───────────────────────────────────────────────────────────────

  const resetAll = useCallback(() => {
    Alert.alert('', t('confirm_reset'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: 'OK',
        style: 'destructive',
        onPress: async () => {
          await AsyncStorage.multiRemove([STORAGE_KEY, LANG_KEY, 'oneshot_records_v2']);
          setAppState(defaultState);
          setRecords([]);
          setScreen('onboarding');
        },
      },
    ]);
  }, [t]);

  // ─── Screens ─────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <SafeAreaView style={styles.loadingContainer} edges={['top', 'bottom']}>
        <ActivityIndicator size="large" color="#8B0000" />
      </SafeAreaView>
    );
  }

  const today = getAppDate();
  const recordedToday = appState.lastRecordDate === today;

  // ─── Onboarding Screen ───────────────────────────────────────────────────────

  const OnboardingScreen = () => {
    const [goal, setGoal] = useState('');
    return (
      <View style={styles.screenCenter}>
        <Text style={styles.appTitle}>ONE SHOT</Text>
        <Text style={styles.subtitle}>{t('onboarding_subtitle')}</Text>
        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>{t('onboarding_label')}</Text>
          <TextInput
            style={styles.textInput}
            placeholder={t('onboarding_placeholder')}
            placeholderTextColor="#555"
            value={goal}
            onChangeText={setGoal}
            maxLength={40}
            returnKeyType="done"
          />
        </View>
        <TouchableOpacity
          style={[styles.btnPrimary, !goal.trim() && styles.btnDisabled]}
          disabled={!goal.trim()}
          onPress={() => {
            const next = { ...appState, goal: goal.trim(), onboarded: true };
            setAppState(next);
            saveAppState(next);
            if (!next.subscribed) setScreen('paywall');
            else { setScreen('home'); if (!next.guideShown) setGuideVisible(true); }
          }}
        >
          <Text style={styles.btnPrimaryText}>START</Text>
        </TouchableOpacity>
        <View style={styles.langRow}>
          <TouchableOpacity onPress={() => switchLang('ja')}>
            <Text style={[styles.langBtn, lang === 'ja' && styles.langBtnActive]}>日本語</Text>
          </TouchableOpacity>
          <Text style={styles.langSep}>|</Text>
          <TouchableOpacity onPress={() => switchLang('en')}>
            <Text style={[styles.langBtn, lang === 'en' && styles.langBtnActive]}>English</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ─── Paywall Screen ──────────────────────────────────────────────────────────

  const PaywallScreen = () => {
    const annualPkg  = findRCPackage('subscription');
    const priceStr   = annualPkg?.product.priceString ?? null;
    // ボタンラベル: Store から価格を取得できた場合は動的表示
    const btnLabel   = priceStr
      ? (lang === 'ja' ? `${priceStr} / 年で始める` : `GET ACCESS  —  ${priceStr} / YR`)
      : t('paywall_subscribe_btn');

    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.paywallContent}>
        <Text style={styles.appTitle}>ONE SHOT</Text>

        {/* ── Early Supporter バッジ ── */}
        <View style={styles.paywallBadge}>
          <Text style={styles.paywallBadgeText}>
            {lang === 'ja' ? '早期サポーター特典' : 'EARLY SUPPORTER PRICING'}
          </Text>
        </View>

        <Text style={styles.paywallSub}>{t('paywall_sub')}</Text>

        {/* ── 価格ブロック（Store取得価格を大きく表示）── */}
        <View style={styles.paywallPriceBlock}>
          <Text style={styles.paywallPrice}>{priceStr ?? '—'}</Text>
          <Text style={styles.paywallPriceSub}>{t('paywall_price_sub')}</Text>
        </View>

        {/* ── 機能リスト ── */}
        {[1, 2, 3, 4, 5].map(i => (
          <View key={i} style={styles.featureRow}>
            <Feather name="check-circle" size={16} color="#8B0000" />
            <Text style={styles.featureText}>{t(`paywall_feature${i}`)}</Text>
          </View>
        ))}

        {/* ── CTA ── */}
        <TouchableOpacity style={styles.btnPrimary} onPress={subscribePremium}>
          <Text style={styles.btnPrimaryText}>{btnLabel}</Text>
        </TouchableOpacity>

        <Text style={styles.paywallPassNote}>{t('paywall_pass_note')}</Text>

        <TouchableOpacity onPress={restorePurchase}>
          <Text style={styles.linkText}>{t('paywall_restore_btn')}</Text>
        </TouchableOpacity>
        <View style={styles.paywallLinks}>
          <Text style={styles.linkSmall}>{t('paywall_terms')}</Text>
          <Text style={styles.linkSmall}>  ·  </Text>
          <Text style={styles.linkSmall}>{t('paywall_privacy')}</Text>
        </View>
      </ScrollView>
    );
  };

  // ─── Home Screen ─────────────────────────────────────────────────────────────

  const HomeScreen = () => (
    <View style={styles.homeScreen}>

      {/* ── Header: ONE SHOT + settings gear ── */}
      <View style={styles.homeHeader}>
        <Text style={styles.homeLogo}>ONE SHOT</Text>
        <TouchableOpacity style={styles.settingsIconBtn} onPress={() => setScreen('settings')}>
          <Feather name="settings" size={22} color="#888" />
        </TouchableOpacity>
      </View>

      {/* ── 上部スペーサー（ロゴとストリークの間隔を広げる） ── */}
      <View style={{ flex: 1 }} />

      {/* ── ストリーク数字（Web版と同じ縦グラデーション: 白→グレー） ── */}
      <View style={styles.streakSection}>
        {/* MaskedView: テキスト形状をマスクとして LinearGradient を型抜き */}
        <MaskedView maskElement={<Text style={styles.streakNum}>{appState.streak}</Text>}>
          <LinearGradient
            colors={['#ffffff', '#ffffff', '#555555']}
            locations={[0, 0.3, 1.0]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
          >
            {/* opacity:0 でグラデーションのサイズをテキストに合わせる */}
            <Text style={[styles.streakNum, { opacity: 0 }]}>{appState.streak}</Text>
          </LinearGradient>
        </MaskedView>
        <Text style={styles.streakLabel}>{t('streak_label')}</Text>
      </View>

      {/* ── ゴールカード + 2ステータスピル ── */}
      <View style={styles.goalCard}>
        <Text style={styles.goalTitle}>
          <Text style={styles.goalHash}># </Text>
          {appState.goal || '—'}
        </Text>
        <View style={styles.statusRow}>
          <View style={styles.statusPill}>
            <Text style={[styles.statusVal, recordedToday ? styles.statusValDone : styles.statusValPending]}>
              {recordedToday ? '✓' : '−'}
            </Text>
            <Text style={styles.statusLabel}>{t('today_label')}</Text>
          </View>
          <View style={styles.statusPill}>
            <Text style={styles.statusVal}>{totalPassCount()}</Text>
            <Text style={styles.statusLabel}>{t('pass_remain_label')}</Text>
          </View>
        </View>
      </View>

      {/* ── カメラボタン（写真カメラアイコン・赤グロー） ── */}
      <TouchableOpacity
        style={[styles.recBtn, recordedToday && styles.recBtnDone]}
        onPress={() => {
          if (recordedToday) {
            Alert.alert('', t('alert_already_recorded') ?? 'Already recorded today.');
            return;
          }
          setScreen('camera');
        }}
      >
        <Ionicons name="camera-outline" size={32} color={recordedToday ? '#555' : '#fff'} />
      </TouchableOpacity>

      {/* ── 記録済みラベル（緑） ── */}
      {recordedToday && (
        <Text style={styles.recDoneLabel}>✓ {t('recorded_today')}</Text>
      )}

      {/* ── パスを使うボタン（赤アウトライン） ── */}
      <TouchableOpacity style={styles.passBtn} onPress={usePassToday}>
        <Ionicons name="ticket-outline" size={14} color="#8B0000" />
        <Text style={styles.passBtnText}>
          {t('use_pass_btn_prefix')}{totalPassCount()}{t('use_pass_btn_suffix')}
        </Text>
      </TouchableOpacity>

      {/* ── パス購入ボタン（パスが0枚の時のみ表示） ── */}
      {totalPassCount() === 0 && (
        <TouchableOpacity style={styles.passBuyBtn} onPress={purchasePass}>
          <Ionicons name="card-outline" size={14} color="#8B0000" />
          <Text style={styles.passBuyBtnText}>{t('pass_purchase_btn')}</Text>
        </TouchableOpacity>
      )}

      {/* ── 下部スペーサー（コンテンツを中央よりやや上に押し上げる） ── */}
      <View style={{ flex: 1.4 }} />

    </View>
  );

  // ─── Camera Screen ────────────────────────────────────────────────────────────

  const CameraScreen = () => {
    // ── 権限なし ──
    if (!camPermission) return <ActivityIndicator color="#fff" style={styles.screenCenter} />;
    if (!camPermission.granted) {
      return (
        <View style={styles.screenCenter}>
          <Feather name="camera-off" size={44} color="#555" style={{ marginBottom: 24 }} />
          <Text style={styles.permTitle}>{t('cam_permission_title')}</Text>
          <Text style={styles.permBody}>{t('cam_permission_body')}</Text>
          <TouchableOpacity style={styles.btnPrimary} onPress={requestCamPermission}>
            <Text style={styles.btnPrimaryText}>{t('cam_permission_btn')}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setScreen('home')}>
            <Text style={styles.linkText}>{t('cam_permission_back')}</Text>
          </TouchableOpacity>
        </View>
      );
    }

    // ── プレビュー画面（動画・写真共通 — image_4 デザイン）──
    if (capturedUri) {
      const dayNum = appState.streak + 1;
      const ts = capturedTime ?? new Date();
      const dateStr = format(ts, 'yyyy.MM.dd');
      const timeStr = format(ts, 'HH:mm');
      const isPhoto = capturedType === 'photo';

      return (
        <View style={styles.previewScreen}>

          {/* ── メディアカード（角ブラケット付き）── */}
          <View ref={previewCardRef} style={styles.previewCard}>
            {isPhoto ? (
              <Image source={{ uri: capturedUri }} style={styles.previewMedia} resizeMode="cover" />
            ) : (
              <>
                <Video
                  ref={previewVideoRef}
                  source={{ uri: capturedUri }}
                  style={styles.previewMedia}
                  resizeMode={ResizeMode.COVER}
                  isLooping
                  shouldPlay={isPreviewPlaying}
                  isMuted={false}
                  positionMillis={0}
                />
                {/* 長押し再生エリア */}
                <Pressable
                  style={[StyleSheet.absoluteFill, { bottom: 0 }]}
                  onLongPress={() => setIsPreviewPlaying(true)}
                  onPressOut={async () => {
                    setIsPreviewPlaying(false);
                    await previewVideoRef.current?.setPositionAsync(0);
                  }}
                  delayLongPress={150}
                />
                {/* 長押しヒント */}
                {!isPreviewPlaying && (
                  <View style={styles.previewHint}>
                    <Feather name="play" size={14} color="rgba(255,255,255,0.8)" />
                    <Text style={styles.previewHintText}>
                      {lang === 'en' ? 'Hold to play' : '長押しで再生'}
                    </Text>
                  </View>
                )}
              </>
            )}

            {/* 角ブラケット装飾（viewfinder 風）*/}
            <View style={[styles.bracket, styles.bracketTL]} />
            <View style={[styles.bracket, styles.bracketTR]} />
            <View style={[styles.bracket, styles.bracketBL]} />
            <View style={[styles.bracket, styles.bracketBR]} />

            {/* 写真のみ JS 側オーバーレイを表示（動画はSwift焼き込み済み）*/}
            {isPhoto && (
              <>
                {/* 左上: DAY X + 日時 */}
                <View style={styles.previewTopLeft}>
                  <Text style={styles.previewDayNum}>DAY {dayNum}</Text>
                  <Text style={styles.previewDateTime}>{dateStr}{'  '}{timeStr}</Text>
                </View>

                {/* 中央下部: #ゴール名 */}
                <View style={styles.previewGoalOverlay}>
                  <Text style={styles.previewGoalText}>#{appState.goal}</Text>
                </View>
              </>
            )}

            {/* 動画処理中インジケーター */}
            {!isPhoto && isProcessingVideo && (
              <View style={styles.ffmpegOverlay}>
                <ActivityIndicator size="large" color="#C8C8C8" />
                <Text style={styles.ffmpegText}>Processing...</Text>
              </View>
            )}
          </View>

          {/* ── アクションボタン行（削除 | 保存 | 共有）── */}
          <View style={styles.previewActions}>
            <TouchableOpacity style={styles.previewBtnDelete} onPress={retake}>
              <Feather name="trash-2" size={18} color="#fff" />
              <Text style={styles.previewBtnLabel}>{t('retry_btn')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.previewBtnSave, isProcessingVideo && { opacity: 0.4 }]}
              onPress={saveCapture}
              disabled={isProcessingVideo}
            >
              <Feather name="download" size={18} color="#fff" />
              <Text style={styles.previewBtnLabel}>{t('save_btn')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.previewBtnShare} onPress={shareToInstagram}>
              <Feather name="share" size={18} color="#fff" />
              <Text style={styles.previewBtnLabel}>{t('share_btn')}</Text>
            </TouchableOpacity>
          </View>

        </View>
      );
    }

    // ── メインカメラビュー（image_3 デザイン）──
    return (
      <View style={styles.cameraContainer}>

        {/* StableCameraView: React.memo でラップ → フリッカーなし */}
        <StableCameraView
          cameraRef={cameraRef}
          facing={facing}
          mode={camMode === 'video' ? 'video' : 'picture'}
        />

        {/* 事前カウントダウン: 大きな白い数字（image_3 通り）*/}
        {countdown !== null && (
          <View style={styles.countdownOverlay}>
            <Text style={styles.countdownText}>{countdown}</Text>
          </View>
        )}

        {/* 録画中カウントダウン: 画面上部中央、大きめ白文字 */}
        {isRecording && recordingCountdown !== null && (
          <View style={styles.recCountdownOverlay}>
            <Text style={styles.recCountdownNum}>{recordingCountdown}</Text>
          </View>
        )}

        {/* REC ドット（録画中）*/}
        {isRecording && (
          <View style={styles.recIndicator}>
            <View style={styles.recDot} />
            <Text style={styles.recText}>REC</Text>
          </View>
        )}

        {/* トップバー: 左=×（閉じる）、右=フリップ */}
        <View style={styles.camTopBar}>
          <TouchableOpacity style={styles.camTopBtn} onPress={() => setScreen('home')}>
            <Feather name="x" size={22} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.camTopBtn}
            onPress={() => setFacing(f => f === 'front' ? 'back' : 'front')}
          >
            <Feather name="refresh-cw" size={20} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* ボトムエリア: モードタブ + シャッター行 */}
        <View style={styles.camBottomArea}>

          {/* モードタブ（image_3 通りのピルデザイン）*/}
          <View style={styles.camModeRow}>
            {(['video', 'photo'] as const).map(m => (
              <TouchableOpacity
                key={m}
                onPress={() => !isRecording && setCamMode(m)}
                style={[styles.camModeTab, camMode === m && styles.camModeTabActive]}
              >
                <Text style={[styles.camModeBtn, camMode === m && styles.camModeBtnActive]}>
                  {t(m === 'video' ? 'mode_video' : 'mode_photo')}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* シャッター行: タイマーアイコン（左）| シャッター（中央）| スペーサー（右）*/}
          <View style={styles.camControls}>
            {/* 左: タイマートグル（ON=赤、OFF=グレー）*/}
            <TouchableOpacity
              style={[styles.camTimerBtn, appState.showRecordingCountdown && styles.camTimerBtnOn]}
              onPress={() => updateState({ showRecordingCountdown: !appState.showRecordingCountdown })}
            >
              <Feather name="clock" size={20} color={appState.showRecordingCountdown ? '#fff' : 'rgba(255,255,255,0.35)'} />
            </TouchableOpacity>

            {/* 中央: シャッターボタン（赤い内側）*/}
            <TouchableOpacity
              style={styles.shutterBtn}
              onPress={startRecording}
              disabled={isRecording || countdown !== null}
              activeOpacity={0.8}
            >
              <View style={[styles.shutterInner, isRecording && styles.shutterInnerRec]} />
            </TouchableOpacity>

            {/* 右: スペーサー（対称性のため）*/}
            <View style={styles.camTimerBtn} />
          </View>

        </View>
      </View>
    );
  };

  // ─── History Screen ───────────────────────────────────────────────────────────

  const HistoryScreen = () => {
    const firstDay = new Date(calYear, calMonth, 1).getDay();
    const lastDate = new Date(calYear, calMonth + 1, 0).getDate();
    const recordMap = new Map(records.map(r => [r.date, r]));
    const todayStr = getAppDate();
    const dayLabels = lang === 'en'
      ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      : ['日', '月', '火', '水', '木', '金', '土'];

    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.historyContent} contentInsetAdjustmentBehavior="automatic">
        <View style={styles.calHeader}>
          <TouchableOpacity onPress={() => {
            if (calMonth === 0) { setCalMonth(11); setCalYear(y => y - 1); }
            else setCalMonth(m => m - 1);
          }}>
            <Feather name="chevron-left" size={22} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.calMonthLabel}>{calYear}.{pad2(calMonth + 1)}</Text>
          <TouchableOpacity onPress={() => {
            if (calMonth === 11) { setCalMonth(0); setCalYear(y => y + 1); }
            else setCalMonth(m => m + 1);
          }}>
            <Feather name="chevron-right" size={22} color="#fff" />
          </TouchableOpacity>
        </View>
        <View style={styles.calGrid}>
          {dayLabels.map(l => (
            <View key={l} style={styles.calCell}>
              <Text style={styles.calDayLabel}>{l}</Text>
            </View>
          ))}
          {Array.from({ length: firstDay }).map((_, i) => (
            <View key={`empty-${i}`} style={styles.calCell} />
          ))}
          {Array.from({ length: lastDate }, (_, i) => i + 1).map(day => {
            const ds = `${calYear}-${pad2(calMonth + 1)}-${pad2(day)}`;
            const rec = recordMap.get(ds);
            const recorded = !!rec;
            const isPass = rec?.isPass === true;
            const isToday = ds === todayStr;
            const cell = (
              <>
                <Text style={[styles.calDayNum, recorded && styles.calDayNumRecorded]}>
                  {day}
                </Text>
                {recorded && !isPass && <Text style={styles.calCheck}>✓</Text>}
                {isPass && <Text style={styles.calPassMark}>○</Text>}
              </>
            );
            return recorded ? (
              <TouchableOpacity
                key={ds}
                style={[styles.calCell, styles.calDayCell,
                  isPass ? styles.calDayCellPass : styles.calDayCellRecorded,
                  isToday && styles.calDayCellToday]}
                onPress={() => setSelectedRecord(rec)}
                activeOpacity={0.7}
              >
                {cell}
              </TouchableOpacity>
            ) : (
              <View
                key={ds}
                style={[styles.calCell, styles.calDayCell, isToday && styles.calDayCellToday]}
              >
                {cell}
              </View>
            );
          })}
        </View>
        {records.length === 0 && (
          <Text style={styles.noHistoryText}>{t('no_history')}</Text>
        )}

        {/* Fullscreen record modal */}
        <Modal
          visible={!!selectedRecord}
          animationType="fade"
          transparent={false}
          onRequestClose={() => setSelectedRecord(null)}
        >
          <View style={styles.recordModalBg}>
            {/* 閉じるボタン */}
            <TouchableOpacity style={styles.recordModalClose} onPress={() => setSelectedRecord(null)}>
              <Feather name="x" size={26} color="#fff" />
            </TouchableOpacity>

            {selectedRecord && (
              <>
                {/* メディア表示 */}
                {selectedRecord.uri ? (
                  /\.(jpg|jpeg|png)$/i.test(selectedRecord.uri) ? (
                    <Image source={{ uri: selectedRecord.uri }} style={styles.recordModalMedia} resizeMode="contain" />
                  ) : (
                    <Video
                      source={{ uri: selectedRecord.uri }}
                      style={styles.recordModalMedia}
                      resizeMode={ResizeMode.CONTAIN}
                      shouldPlay
                      isLooping
                      useNativeControls={false}
                    />
                  )
                ) : (
                  <View style={styles.recordModalNoMedia}>
                    <Feather name="film" size={48} color="#444" />
                    <Text style={styles.recordModalNoMediaText}>{t('no_history')}</Text>
                  </View>
                )}

                {/* フィルターオーバーレイ（撮影プレビューと同じ見た目）*/}
                {!selectedRecord.isPass && selectedRecord.uri && (
                  <View style={styles.recordModalFilterOverlay} pointerEvents="none">
                    {/* 左上: DAY X + 日付 */}
                    <View style={styles.recordModalFilterTop}>
                      <Text style={styles.recordModalFilterDay}>DAY {selectedRecord.day}</Text>
                      <Text style={styles.recordModalFilterDate}>{selectedRecord.date}</Text>
                    </View>
                    {/* 中央下部: #ゴール名 */}
                    <View style={styles.recordModalFilterBottom}>
                      <Text style={styles.recordModalFilterGoal}>#{appState.goal}</Text>
                    </View>
                  </View>
                )}

                {/* DAY + 日付オーバーレイ（アクションボタン上のラベル）*/}
                <View style={styles.recordModalInfo}>
                  <Text style={styles.recordModalDay}>DAY {selectedRecord.day}</Text>
                  <Text style={styles.recordModalDate}>{selectedRecord.date}</Text>
                </View>

                {/* ── アクションボタン（削除 | 再保存 | シェア）── */}
                <View style={styles.recordModalActions}>
                  <TouchableOpacity
                    style={styles.recordModalBtnDelete}
                    onPress={() => deleteRecord(selectedRecord)}
                  >
                    <Feather name="trash-2" size={16} color="#fff" />
                    <Text style={styles.recordModalBtnText}>{t('history_delete')}</Text>
                  </TouchableOpacity>

                  {selectedRecord.uri ? (
                    <>
                      <TouchableOpacity
                        style={styles.recordModalBtnSave}
                        onPress={() => resaveRecord(selectedRecord)}
                      >
                        <Feather name="download" size={16} color="#fff" />
                        <Text style={styles.recordModalBtnText}>{t('history_resave')}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.recordModalBtnShare}
                        onPress={() => shareRecord(selectedRecord)}
                      >
                        <Feather name="share" size={16} color="#fff" />
                        <Text style={styles.recordModalBtnText}>{t('share_btn')}</Text>
                      </TouchableOpacity>
                    </>
                  ) : null}
                </View>
              </>
            )}
          </View>
        </Modal>
      </ScrollView>
    );
  };

  // ─── Settings Screen ──────────────────────────────────────────────────────────

  const SettingsScreen = () => {
    const [goalEdit, setGoalEdit] = useState(appState.goal);
    const [notifyEdit, setNotifyEdit] = useState(appState.notifyTime);
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.settingsContent}>
        <Text style={styles.settingsTitle}>{t('settings_title')}</Text>

        <View style={styles.settingGroup}>
          <Text style={styles.settingLabel}>{t('settings_goal_label')}</Text>
          <TextInput
            style={styles.textInput}
            value={goalEdit}
            onChangeText={setGoalEdit}
            maxLength={40}
          />
        </View>

        {!appState.subscribed && (() => {
          const _pkg   = findRCPackage('subscription');
          const _price = _pkg?.product.priceString ?? null;
          const _btn   = _price
            ? (lang === 'ja' ? `${_price} / 年で始める` : `GET ACCESS  —  ${_price} / YR`)
            : t('paywall_subscribe_btn');
          return (
            <View style={[styles.settingGroup, styles.premiumCard]}>
              <Text style={styles.paywallBadgeText}>
                {lang === 'ja' ? '早期サポーター特典' : 'EARLY SUPPORTER PRICING'}
              </Text>
              <Text style={[styles.settingLabel, { marginTop: 8 }]}>{t('paywall_sub')}</Text>
              <Text style={styles.settingHint}>{_price ? `${_price}  ${t('paywall_price_sub')}` : t('paywall_price_sub')}</Text>
              <TouchableOpacity style={styles.btnPrimary} onPress={subscribePremium}>
                <Text style={styles.btnPrimaryText}>{_btn}</Text>
              </TouchableOpacity>
            </View>
          );
        })()}

        <View style={styles.settingGroup}>
          <Text style={styles.settingLabel}>{t('settings_countdown_label')}</Text>
          <Text style={styles.settingHint}>{t('settings_countdown_hint')}</Text>
          <Switch
            value={appState.showRecordingCountdown}
            onValueChange={v => updateState({ showRecordingCountdown: v })}
            thumbColor="#fff"
            trackColor={{ false: '#333', true: '#8B0000' }}
          />
        </View>

        <View style={styles.settingGroup}>
          <Text style={styles.settingLabel}>{t('settings_notify_label')}</Text>
          <Text style={styles.settingHint}>{t('settings_notify_hint')}</Text>
          <TextInput
            style={styles.textInput}
            value={notifyEdit}
            onChangeText={setNotifyEdit}
            placeholder="HH:MM"
            placeholderTextColor="rgba(255,255,255,0.3)"
            keyboardType="numbers-and-punctuation"
            maxLength={5}
          />
        </View>

        <View style={styles.settingGroup}>
          <Text style={styles.settingLabel}>{t('settings_language_label')}</Text>
          <View style={styles.langRow}>
            <TouchableOpacity onPress={() => switchLang('ja')}>
              <Text style={[styles.langBtn, lang === 'ja' && styles.langBtnActive]}>日本語</Text>
            </TouchableOpacity>
            <Text style={styles.langSep}>|</Text>
            <TouchableOpacity onPress={() => switchLang('en')}>
              <Text style={[styles.langBtn, lang === 'en' && styles.langBtnActive]}>English</Text>
            </TouchableOpacity>
          </View>
        </View>

        <TouchableOpacity
          style={styles.btnPrimary}
          onPress={async () => {
            const updates: Partial<AppState> = { goal: goalEdit.trim() };
            const timeValid = /^\d{1,2}:\d{2}$/.test(notifyEdit.trim());
            if (timeValid) {
              updates.notifyTime = notifyEdit.trim();
              try {
                const { status } = await Notifications.getPermissionsAsync();
                if (status === 'granted') {
                  const title = lang === 'ja' ? '今日の記録をしましょう！' : "Time to record today's habit!";
                  const body = lang === 'ja'
                    ? `目標: ${goalEdit.trim() || 'One Shot'}`
                    : `Goal: ${goalEdit.trim() || 'One Shot'}`;
                  await scheduleDailyNotification(notifyEdit.trim(), title, body);
                }
              } catch {}
            }
            updateState(updates);
            showToast(t('toast_settings_saved'));
            setScreen('home');
          }}
        >
          <Text style={styles.btnPrimaryText}>{t('settings_save_btn')}</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.btnOutline} onPress={restorePurchase}>
          <Text style={styles.btnOutlineText}>{t('settings_restore_btn')}</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.btnOutline} onPress={() => setGuideVisible(true)}>
          <Text style={styles.btnOutlineText}>{t('settings_guide')}</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.btnDanger} onPress={resetAll}>
          <Text style={styles.btnDangerText}>{t('settings_reset_btn')}</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  };

  // ─── Guide Modal ──────────────────────────────────────────────────────────────

  const GuideModal = () => (
    <Modal visible={guideVisible} animationType="slide" transparent>
      <View style={styles.modalOverlay}>
        <ScrollView style={styles.guideSheet} contentContainerStyle={styles.guideContent}>
          <Text style={styles.guideTitle}>ONE SHOT</Text>
          <Text style={styles.guideSub}>{t('guide_sub')}</Text>

          {[
            { title: t('guide_card1_title'), body: t('guide_card1_body') },
            { title: t('guide_card3_title'), body: t('guide_card3_body') },
            { title: t('guide_card4_title'), body: t('guide_card4_body') },
            { title: t('guide_card5_title'), body: t('guide_card5_body') },
          ].map((card, i) => (
            <View key={i} style={styles.guideCard}>
              <Text style={styles.guideCardTitle}>{card.title}</Text>
              <Text style={styles.guideCardBody}>{card.body}</Text>
            </View>
          ))}

          <View style={styles.guideCard}>
            <Text style={styles.guideCardTitle}>{t('guide_card2_title')}</Text>
            {[1, 2, 3, 4].map(i => (
              <Text key={i} style={styles.guideStep}>{i}. {t(`guide_step${i}`)}</Text>
            ))}
          </View>

          <TouchableOpacity
            style={[styles.btnPrimary, { marginTop: 8 }]}
            onPress={() => {
              setGuideVisible(false);
              if (!appState.guideShown) updateState({ guideShown: true });
            }}
          >
            <Text style={styles.btnPrimaryText}>{t('guide_start_btn')}</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    </Modal>
  );

  // ─── Bottom Nav ───────────────────────────────────────────────────────────────

  const hideNav = screen === 'onboarding' || screen === 'camera' || screen === 'paywall';

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>

      {screen === 'onboarding' && <OnboardingScreen />}
      {screen === 'paywall' && <PaywallScreen />}
      {screen === 'home' && <HomeScreen />}
      {/* CameraScreen() を関数として直接呼び出す（<CameraScreen />ではない）
           → React が JSX ツリーの同じ位置に View/StableCameraView を見つけ続ける
           → countdown state が変わっても CameraView を再マウントしない → フリッカー根絶 */}
      {screen === 'camera' && CameraScreen()}
      {screen === 'history' && <HistoryScreen />}
      {screen === 'settings' && <SettingsScreen />}

      {!hideNav && (
        <View style={styles.bottomNav}>
          <TouchableOpacity
            style={[styles.navItem, screen === 'home' && styles.navItemActive]}
            onPress={() => setScreen('home')}
          >
            <Feather name="home" size={20} color={screen === 'home' ? '#fff' : '#555'} />
            <Text style={[styles.navLabel, screen === 'home' && styles.navLabelActive]}>
              {t('nav_today')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.navItem, screen === 'history' && styles.navItemActive]}
            onPress={() => setScreen('history')}
          >
            <Feather name="calendar" size={20} color={screen === 'history' ? '#fff' : '#555'} />
            <Text style={[styles.navLabel, screen === 'history' && styles.navLabelActive]}>
              {t('nav_history')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.navItem, screen === 'settings' && styles.navItemActive]}
            onPress={() => setScreen('settings')}
          >
            <Feather name="settings" size={20} color={screen === 'settings' ? '#fff' : '#555'} />
            <Text style={[styles.navLabel, screen === 'settings' && styles.navLabelActive]}>
              {t('settings_title')}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      <GuideModal />
      {toastMsg ? <Toast message={toastMsg} isError={toastError} /> : null}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const { width } = Dimensions.get('window');
const CELL_SIZE = Math.floor((width - 32) / 7);

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  screen: {
    flex: 1,
    backgroundColor: '#000',
  },
  screenCenter: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },

  // ── Typography ──
  appTitle: {
    fontSize: 28,
    fontWeight: '900',
    color: '#fff',
    letterSpacing: 6,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#888',
    textAlign: 'center',
    marginBottom: 40,
    letterSpacing: 0.5,
  },

  // ── Inputs ──
  inputGroup: {
    width: '100%',
    marginBottom: 24,
  },
  inputLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#888',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  textInput: {
    backgroundColor: '#111',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#222',
  },

  // ── Buttons ──
  btnPrimary: {
    backgroundColor: '#8B0000',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 24,
    alignItems: 'center',
    marginBottom: 12,
    width: '100%',
  },
  btnPrimaryText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15,
    letterSpacing: 1,
  },
  btnDisabled: {
    opacity: 0.4,
  },
  btnOutline: {
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
    alignItems: 'center',
    marginBottom: 12,
    width: '100%',
  },
  btnOutlineText: {
    color: '#aaa',
    fontWeight: '600',
    fontSize: 14,
  },
  btnDanger: {
    borderWidth: 1,
    borderColor: '#500',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
    alignItems: 'center',
    marginBottom: 12,
    width: '100%',
  },
  btnDangerText: {
    color: '#8B0000',
    fontWeight: '600',
    fontSize: 14,
  },
  linkText: {
    color: '#888',
    fontSize: 13,
    textDecorationLine: 'underline',
    marginBottom: 12,
  },

  // ── Lang row ──
  langRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  langBtn: {
    color: '#555',
    fontSize: 13,
    paddingHorizontal: 8,
  },
  langBtnActive: {
    color: '#fff',
    fontWeight: '700',
  },
  langSep: {
    color: '#333',
  },

  // ── Paywall ──
  paywallContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 24,
    paddingVertical: 40,
    alignItems: 'center',
  },
  paywallBadge: {
    backgroundColor: '#1a0000',
    borderWidth: 1,
    borderColor: '#8B0000',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginBottom: 16,
  },
  paywallBadgeText: {
    color: '#CC3333',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  paywallSub: {
    fontSize: 13,
    fontWeight: '700',
    color: '#888',
    marginBottom: 12,
    letterSpacing: 3,
    textTransform: 'uppercase',
  },
  paywallPriceBlock: {
    alignItems: 'center',
    marginBottom: 24,
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    backgroundColor: '#0d0d0d',
    borderWidth: 1,
    borderColor: '#1a1a1a',
    alignSelf: 'stretch',
  },
  paywallPrice: {
    fontSize: 36,
    fontWeight: '900',
    color: '#fff',
    letterSpacing: -1,
    marginBottom: 4,
  },
  paywallPriceSub: {
    fontSize: 12,
    color: '#555',
    letterSpacing: 0.5,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    alignSelf: 'stretch',
  },
  featureText: {
    color: '#ccc',
    fontSize: 14,
    marginLeft: 10,
    flex: 1,
  },
  paywallPassNote: {
    fontSize: 12,
    color: '#555',
    textAlign: 'center',
    marginBottom: 16,
  },
  paywallLinks: {
    flexDirection: 'row',
    marginTop: 8,
  },
  linkSmall: {
    color: '#444',
    fontSize: 11,
  },

  // ── Home ──
  homeScreen: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 4,
  },
  homeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
  },
  homeLogo: {
    fontSize: 22,
    fontWeight: '900',
    color: '#fff',
    letterSpacing: -1,
  },
  settingsIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  streakSection: {
    alignItems: 'center',
    paddingBottom: 8,
  },
  streakNum: {
    fontSize: 120,         // 1.5倍（80→120）
    fontWeight: '900',
    color: '#fff',
    letterSpacing: -6,
    lineHeight: 120,
    includeFontPadding: false,
  } as any,
  streakLabel: {
    fontSize: 12,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 4,
    marginTop: 4,
  },
  goalCard: {
    backgroundColor: '#111',
    borderRadius: 16,
    padding: 16,
    marginBottom: 10,
  },
  goalTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#fff',
  },
  goalHash: {
    color: '#8B0000',
  },
  statusRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
  },
  statusPill: {
    flex: 1,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: '#1a1a1a',
    alignItems: 'center',
  },
  statusVal: {
    fontSize: 18,
    fontWeight: '900',
    color: '#fff',
    marginBottom: 2,
  },
  statusValDone: {
    color: '#00FF88',
  },
  statusValPending: {
    color: '#8B0000',
  },
  statusLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#888',
  },
  recBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#8B0000',
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'center',
    marginVertical: 14,
    shadowColor: '#8B0000',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.65,
    shadowRadius: 18,
    elevation: 8,
  },
  recBtnDone: {
    backgroundColor: '#1a1a1a',
    shadowOpacity: 0,
  },
  recDoneLabel: {
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 6,
    fontSize: 11,
    fontWeight: '700',
    color: '#00FF88',
    textTransform: 'uppercase',
    letterSpacing: 2,
  },
  passBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    marginBottom: 8,
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#8B0000',
    backgroundColor: 'transparent',
  },
  passBtnText: {
    color: '#8B0000',
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  passBuyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#8B0000',
    backgroundColor: '#111',
  },
  passBuyBtnText: {
    color: '#8B0000',
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },

  // ── Camera (main view) ──
  cameraContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  camera: {
    flex: 1,
  },

  // 事前カウントダウン: 画面中央、大きな白い数字（背景なし）
  countdownOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
    pointerEvents: 'none',
  } as any,
  countdownText: {
    fontSize: 160,
    fontWeight: '900',
    color: '#fff',
    letterSpacing: -4,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 12,
  },

  // 録画中カウントダウン: 上部中央、大きめ白文字
  recCountdownOverlay: {
    position: 'absolute',
    top: 100,
    left: 0,
    right: 0,
    alignItems: 'center',
    pointerEvents: 'none',
  } as any,
  recCountdownNum: {
    fontSize: 72,
    fontWeight: '900',
    color: '#fff',
    letterSpacing: -2,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
  },

  // REC ドット + テキスト
  recIndicator: {
    position: 'absolute',
    top: 20,
    left: 68,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  recDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#f00',
  },
  recText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },

  // トップバー（左=×、右=フリップ）
  camTopBar: {
    position: 'absolute',
    top: 16,
    left: 16,
    right: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  camTopBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ボトムエリア
  camBottomArea: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: 36,
    paddingTop: 8,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },

  // モードタブ: ピルデザイン（image_3 通り）
  camModeRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: 20,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignSelf: 'center',
    borderRadius: 20,
    padding: 3,
  },
  camModeTab: {
    paddingHorizontal: 22,
    paddingVertical: 7,
    borderRadius: 17,
  },
  camModeTabActive: {
    backgroundColor: '#fff',
  },
  camModeBtn: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  camModeBtnActive: {
    color: '#000',
  },

  // シャッター行（タイマー左 | シャッター中央 | スペーサー右）
  camControls: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingHorizontal: 36,
  },

  // タイマーアイコンボタン（左下）— ON=赤、OFF=半透明白
  camTimerBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  // ON時: 鮮やかな赤色（一目でわかる状態表示）
  camTimerBtnOn: {
    backgroundColor: '#CC0000',
    borderColor: '#FF3333',
    shadowColor: '#CC0000',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.7,
    shadowRadius: 8,
    elevation: 4,
  },

  // シャッターボタン: 白枠 + 赤い内側（image_3）
  shutterBtn: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 3,
    borderColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  shutterInner: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: '#CC0000',
  },
  // 録画中: 赤い角丸四角形
  shutterInnerRec: {
    width: 26,
    height: 26,
    borderRadius: 6,
    backgroundColor: '#CC0000',
  },

  // ── Preview Screen (image_4 デザイン) ──
  previewScreen: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  previewCard: {
    width: '100%',
    flex: 1,
    maxHeight: '78%',
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#111',
    marginBottom: 16,
    position: 'relative',
  },
  previewMedia: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: '100%',
  } as any,

  // 角ブラケット（viewfinder 風コーナー装飾）
  bracket: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderColor: '#fff',
  },
  bracketTL: {
    top: 12,
    left: 12,
    borderTopWidth: 2,
    borderLeftWidth: 2,
    borderTopLeftRadius: 3,
  },
  bracketTR: {
    top: 12,
    right: 12,
    borderTopWidth: 2,
    borderRightWidth: 2,
    borderTopRightRadius: 3,
  },
  bracketBL: {
    bottom: 12,
    left: 12,
    borderBottomWidth: 2,
    borderLeftWidth: 2,
    borderBottomLeftRadius: 3,
  },
  bracketBR: {
    bottom: 12,
    right: 12,
    borderBottomWidth: 2,
    borderRightWidth: 2,
    borderBottomRightRadius: 3,
  },

  // 左上: DAY X + 日時（Web版と同等の極太・大きさ）
  previewTopLeft: {
    position: 'absolute',
    top: 20,
    left: 20,
  },
  previewDayNum: {
    fontSize: 52,           // Web版と同等の大きさ
    fontWeight: '900',
    color: '#fff',
    letterSpacing: 1,
    lineHeight: 56,
    textShadowColor: 'rgba(0,0,0,0.75)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 12,
  },
  previewDateTime: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.6)',
    fontWeight: '600',
    letterSpacing: 1.5,
    marginTop: 2,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },

  // 中央下部: #ゴール（Web版準拠の透過度 + テキストシャドウ）
  previewGoalOverlay: {
    position: 'absolute',
    bottom: 32,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  previewGoalText: {
    fontSize: 20,
    fontWeight: '800',
    color: 'rgba(255,255,255,0.85)',  // Web版と完全一致
    letterSpacing: 1.5,
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 10,
  },

  // 長押しヒント（動画のみ）
  previewHint: {
    position: 'absolute',
    bottom: 72,
    left: 0,
    right: 0,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  previewHintText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    fontWeight: '600',
  },

  // アクションボタン行（削除 | 保存 | 共有）
  previewActions: {
    flexDirection: 'row',
    width: '100%',
    gap: 10,
  },
  previewBtnDelete: {
    flex: 1,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  previewBtnSave: {
    flex: 1,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: '#1a1a1a',
  },
  previewBtnShare: {
    flex: 1,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: '#8B0000',
  },
  previewBtnLabel: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },

  // ── History ──
  historyContent: {
    flexGrow: 1,
    padding: 16,
    paddingTop: 40,
    justifyContent: 'center',
  },
  calHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
    paddingHorizontal: 8,
  },
  calMonthLabel: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: 2,
  },
  calGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  calCell: {
    width: CELL_SIZE,
    height: CELL_SIZE,
    justifyContent: 'center',
    alignItems: 'center',
  },
  calDayLabel: {
    fontSize: 11,
    color: '#555',
    fontWeight: '700',
  },
  calDayCell: {
    borderRadius: 6,
    position: 'relative',
  },
  calDayCellRecorded: {
    backgroundColor: 'rgba(139,0,0,0.2)',
  },
  calDayCellPass: {
    backgroundColor: 'rgba(100,80,0,0.25)',
  },
  calDayCellToday: {
    borderWidth: 1,
    borderColor: '#8B0000',
  },
  calDayNum: {
    fontSize: 13,
    color: '#777',
    fontWeight: '600',
  },
  calDayNumRecorded: {
    color: '#fff',
  },
  calCheck: {
    position: 'absolute',
    top: 2,
    right: 3,
    fontSize: 9,
    color: '#CC0000',
    fontWeight: '900',
  },
  calPassMark: {
    position: 'absolute',
    top: 2,
    right: 3,
    fontSize: 9,
    color: '#CC9900',
    fontWeight: '900',
  },
  noHistoryText: {
    color: '#555',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 40,
  },
  recordModalBg: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  recordModalClose: {
    position: 'absolute',
    top: 56,
    right: 20,
    zIndex: 10,
    padding: 8,
  },
  recordModalMedia: {
    width: '100%',
    height: '100%',
    position: 'absolute',
  },
  recordModalNoMedia: {
    alignItems: 'center',
    gap: 16,
  },
  recordModalNoMediaText: {
    color: '#555',
    fontSize: 14,
  },
  // フィルターオーバーレイ（撮影プレビューと同じ DAY/ゴール表示）
  recordModalFilterOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 5,
  },
  recordModalFilterTop: {
    position: 'absolute',
    top: 60,
    left: 20,
  },
  recordModalFilterDay: {
    fontSize: 48,
    fontWeight: '900',
    color: '#fff',
    letterSpacing: 1,
    lineHeight: 52,
    textShadowColor: 'rgba(0,0,0,0.75)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 12,
  },
  recordModalFilterDate: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.6)',
    fontWeight: '600',
    letterSpacing: 1.5,
    marginTop: 2,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  recordModalFilterBottom: {
    position: 'absolute',
    bottom: 140,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  recordModalFilterGoal: {
    fontSize: 18,
    fontWeight: '800',
    color: 'rgba(255,255,255,0.85)',
    letterSpacing: 1.5,
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 10,
  },
  recordModalInfo: {
    position: 'absolute',
    bottom: 120,    // アクションボタン行（約100px）の上に配置
    left: 20,
    alignItems: 'flex-start',
    gap: 2,
  },
  recordModalDate: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
    letterSpacing: 1,
  },
  recordModalDay: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 2,
  },

  // 履歴モーダル: アクションボタン行
  recordModalActions: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    padding: 20,
    gap: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  recordModalBtnDelete: {
    flex: 1,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  recordModalBtnSave: {
    flex: 1,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#1a1a1a',
  },
  recordModalBtnShare: {
    flex: 1,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#8B0000',
  },
  recordModalBtnText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },

  // FFmpeg処理中オーバーレイ
  ffmpegOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
    gap: 16,
  },
  ffmpegText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.5,
  },

  // ── Settings ──
  settingsContent: {
    padding: 20,
    paddingTop: 16,
  },
  settingsTitle: {
    fontSize: 16,
    fontWeight: '900',
    color: '#fff',
    letterSpacing: 4,
    marginBottom: 24,
  },
  settingGroup: {
    backgroundColor: '#111',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  premiumCard: {
    borderWidth: 1.5,
    borderColor: '#8B0000',
  },
  settingLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#888',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  settingHint: {
    fontSize: 12,
    color: '#555',
    marginBottom: 12,
  },

  // ── Guide Modal ──
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'flex-end',
  },
  guideSheet: {
    backgroundColor: '#0a0a0a',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '85%',
  },
  guideContent: {
    padding: 24,
  },
  guideTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#fff',
    letterSpacing: 6,
    textAlign: 'center',
    marginBottom: 4,
  },
  guideSub: {
    fontSize: 13,
    color: '#888',
    textAlign: 'center',
    marginBottom: 24,
  },
  guideCard: {
    backgroundColor: '#111',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  guideCardTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 8,
  },
  guideCardBody: {
    fontSize: 13,
    color: '#aaa',
    lineHeight: 20,
  },
  guideStep: {
    fontSize: 13,
    color: '#aaa',
    paddingVertical: 4,
    lineHeight: 20,
  },

  // ── Bottom Nav ──
  bottomNav: {
    flexDirection: 'row',
    backgroundColor: '#000',
    borderTopWidth: 1,
    borderTopColor: '#1a1a1a',
    paddingBottom: 4,
  },
  navItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    gap: 4,
  },
  navItemActive: {
    // highlight via label/icon color
  },
  navLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: '#555',
    letterSpacing: 1.5,
  },
  navLabelActive: {
    color: '#fff',
  },

  // ── Permission ──
  permTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center',
    marginBottom: 12,
  },
  permBody: {
    fontSize: 14,
    color: '#888',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 22,
  },

  // ── Toast ──
  toast: {
    position: 'absolute',
    bottom: 100,
    left: 24,
    right: 24,
    backgroundColor: '#1a1a1a',
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
  },
  toastError: {
    backgroundColor: '#3a0000',
  },
  toastText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
});

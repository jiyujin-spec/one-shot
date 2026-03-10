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
  userId: string;              // "OS-YYYY-NNN" generated once
  challengeDays?: number;      // total days for challenge (undefined = no challenge)
  phase: number;               // Current phase (1 = default)
  milestone10Shown: boolean;   // Whether 10-day milestone popup was shown
  phaseChangeFree: boolean;    // Whether next goal save skips the 10-day warning
  phasePromotedAt: number;     // Streak value at last phase promotion (0 = never)
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
    paywall_iap_note: '年額: $24.99/年  ·  月額: $4.99/月\nApple IDに課金されます。サブスクリプションは購入後、現在の期間終了前に解約しない限り自動更新されます。',
    paywall_pass_note: 'お休みパスは $0.99/枚 で別途購入できます',
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
    guide_card5_body: 'パスは1枚$0.99で追加購入できます。有効期限なし、何枚でもストックできます。',
    guide_start_btn: 'はじめる',
    pass_purchase_btn: 'パスを購入（$0.99）',
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
    confirm_purchase_pass: 'パスを1回分購入しますか？（$0.99）',
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
    confirm_change_goal_streak: '継続が10日を超えています。目標を変更すると、これまでの記録がリセットされDAY 0からの再スタートとなります。本当によろしいですか？',
    confirm_change_goal_cancel: '変更しない',
    confirm_change_goal_reset: 'リセットして変更する',
    milestone_10_title: 'おめでとう！',
    milestone_10_body: '10日間継続しました！\nこれ以降、目標を変更すると記録がリセットされます。',
    phase_next_btn: 'Next Phaseに進む',
    phase_promoted_toast: 'Phase {n} に昇格！目標を自由に変更できます。',
    phase_label: 'Phase {n}',
    guide_rule_10day_title: '目標の固定ルール',
    guide_rule_10day_body: '10日を過ぎると、その目標を変えることはできなくなります（変更にはリセットが必要になります）。',
    ok: 'OK',
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
    paywall_iap_note: 'Annual: $24.99/yr  ·  Monthly: $4.99/mo\nCharged to your Apple ID. Subscription auto-renews unless cancelled before the end of the current period.',
    paywall_pass_note: 'Rest passes available separately at $0.99/pass',
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
    guide_card5_body: 'Additional passes at $0.99 each. No expiry. Stock them before you need them.',
    guide_start_btn: 'START',
    pass_purchase_btn: 'BUY A PASS ($0.99)',
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
    confirm_purchase_pass: 'Purchase 1 rest pass? ($0.99)',
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
    confirm_change_goal_streak: 'Your streak is over 10 days. Changing your goal will reset your progress to DAY 0. Are you sure you want to proceed?',
    confirm_change_goal_cancel: 'Cancel',
    confirm_change_goal_reset: 'Reset and Change',
    milestone_10_title: 'Congratulations!',
    milestone_10_body: 'You\'ve made it to 10 days!\nFrom now on, changing your goal will reset your progress record.',
    phase_next_btn: 'Proceed to Next Phase',
    phase_promoted_toast: 'Promoted to Phase {n}! You can now change your goal freely.',
    phase_label: 'Phase {n}',
    guide_rule_10day_title: 'Goal Lock Rule',
    guide_rule_10day_body: 'After 10 days, you cannot change your goal without resetting your progress.',
    ok: 'OK',
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
  phase: 1,
  milestone10Shown: false,
  phaseChangeFree: false,
  phasePromotedAt: 0,
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
  // Use optional chaining to guard against runtime undefined on some Expo versions
  const dailyType = Notifications.SchedulableTriggerInputTypes?.DAILY ?? 'daily';
  await Notifications.scheduleNotificationAsync({
    content: { title, body, sound: true },
    trigger: {
      hour: h,
      minute: m,
      type: dailyType as any,
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
  const [milestone10Visible, setMilestone10Visible] = useState(false);
  const [legalVisible, setLegalVisible] = useState(false);
  const [legalType, setLegalType] = useState<'terms' | 'privacy'>('terms');

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
  const recordingTimerRef = useRef<any>(null);
  const recordingCountdownRef = useRef<any>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [isProcessingVideo, setIsProcessingVideo] = useState(false);
  const [isProcessingPhoto, setIsProcessingPhoto] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [photoProcessorData, setPhotoProcessorData] = useState<{
    uri: string;
    habitName: string;
    currentDay: number;
    captureTime: Date;
  } | null>(null);
  // null! = non-null assertion: RefObject<CameraView> として扱い TS の型エラーを解消
  const cameraRef = useRef<CameraView>(null!);
  const previewVideoRef = useRef<Video>(null);
  const previewCardRef = useRef<any>(null);
  const photoProcessorRef = useRef<any>(null);  // off-screen photo processor

  // History state
  const [records, setRecords] = useState<RecordEntry[]>([]);
  const [calYear, setCalYear] = useState(new Date().getFullYear());
  const [calMonth, setCalMonth] = useState(new Date().getMonth());
  const [selectedRecord, setSelectedRecord] = useState<RecordEntry | null>(null);

  // RevenueCat state
  const [rcOfferings, setRcOfferings] = useState<PurchasesOfferings | null>(null);

  // Review trigger
  const [reviewReady, setReviewReady] = useState(false);

  const toastTimer = useRef<any>(null);

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

  const openLegal = useCallback((type: 'terms' | 'privacy') => {
    setLegalType(type);
    setLegalVisible(true);
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

  const findRCPackage = useCallback((type: 'pass' | 'annual' | 'monthly'): PurchasesPackage | null => {
    if (!rcOfferings?.current) return null;
    const pkgs = rcOfferings.current.availablePackages;
    if (type === 'annual') {
      return pkgs.find(p => p.product.identifier === 'com.jin.oneshot.annual.premium')
        ?? rcOfferings.current.annual
        ?? pkgs.find(p => p.identifier === '$rc_annual' || p.identifier.toLowerCase().includes('annual'))
        ?? null;
    }
    if (type === 'monthly') {
      return pkgs.find(p => p.product.identifier === 'com.jin.oneshot.premium')
        ?? rcOfferings.current.monthly
        ?? pkgs.find(p => p.identifier === '$rc_monthly' || p.identifier.toLowerCase().includes('month'))
        ?? null;
    }
    if (type === 'pass') {
      return pkgs.find(p => p.product.identifier === 'com.jin.oneshot.1pass')
        ?? pkgs.find(p => p.identifier === 'pass')
        ?? pkgs.find(p => p.identifier.toLowerCase().includes('pass'))
        ?? null;
    }
    return null;
  }, [rcOfferings]);

  const syncRCEntitlements = useCallback(async (): Promise<boolean> => {
    try {
      const info: CustomerInfo = await Purchases.getCustomerInfo();
      // Entitlement ID 'premium' で判定（月額・年額どちらも対応）
      return !!info.entitlements.active['premium']
        || Object.keys(info.entitlements.active).length > 0
        || info.activeSubscriptions.includes('com.jin.oneshot.annual.premium')
        || info.activeSubscriptions.includes('com.jin.oneshot.premium');
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

  const subscribePremium = useCallback(async (pkg: PurchasesPackage) => {
    showToast(t('processing'));
    try {
      const { customerInfo } = await Purchases.purchasePackage(pkg);
      // Check entitlement OR active subscription product IDs directly
      // (annual: com.jin.oneshot.annual.premium / monthly: com.jin.oneshot.premium)
      const active = !!customerInfo.entitlements.active['premium']
        || Object.keys(customerInfo.entitlements.active).length > 0
        || customerInfo.activeSubscriptions.includes('com.jin.oneshot.annual.premium')
        || customerInfo.activeSubscriptions.includes('com.jin.oneshot.premium');
      if (active) {
        updateState({ subscribed: true });
        showToast(t('subscribe_success'));
        // Small delay to let React flush the state update before navigating
        await new Promise(r => setTimeout(r, 350));
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
  }, [showToast, t, updateState]);

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
      // Trigger 10-day milestone popup (once only)
      if (newStreak === 10 && !prev.milestone10Shown) {
        setTimeout(() => setMilestone10Visible(true), 800);
      }
      const next = {
        ...prev,
        streak: newStreak,
        lastRecordDate: today,
        reviewRequested: shouldReview ? true : prev.reviewRequested,
        milestone10Shown: newStreak >= 10 ? true : prev.milestone10Shown,
      };
      saveAppState(next);
      showToast(t('toast_save_complete', { day: newStreak }));
      return next;
    });
  }, [saveAppState, showToast, t]);

  // ── Off-screen photo processor: view-shot after image loads ─────────────────

  const processPhotoFromRef = useCallback(async (rawUri: string) => {
    await new Promise<void>(r => setTimeout(r, 80)); // allow Image to paint
    try {
      const processed = await captureRef(photoProcessorRef, {
        format: 'jpg',
        quality: 0.95,
        result: 'tmpfile',
      });
      setCapturedUri(processed);
    } catch (e) {
      console.warn('[photo processor] fallback to raw:', e);
      setCapturedUri(rawUri);
    } finally {
      setCapturedType('photo');
      setPhotoProcessorData(null);
      setIsProcessingPhoto(false);
    }
  }, []);

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
          const captureTime = new Date();
          setCapturedTime(captureTime);
          setIsProcessingPhoto(true);
          // Queue for off-screen filter baking
          setPhotoProcessorData({
            uri: photo.uri,
            habitName: (appState.goal || 'HABIT').toUpperCase(),
            currentDay: appState.streak + 1,
            captureTime,
          });
        }
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        console.error('[photo] takePictureAsync error:', msg);
        showToast(t('toast_camera_error') + msg, true);
      }
      return;
    }

    // ── 動画モード（5秒録画 → ネイティブでオーバーレイ焼き込み）──
    setIsRecording(true);
    const RECORD_SECS = 5;

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
      // recordAsync 呼び出し前にさらに 300ms の余裕を確保（冒頭暗転対策）
      await new Promise<void>(r => setTimeout(r, 300));
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

    // Stay on camera screen during processing; only navigate to preview when ready
    const captureTime = new Date();
    setCapturedTime(captureTime);
    setCapturedType('video');
    setIsProcessingVideo(true);
    try {
      const currentPhase = appState.phase ?? 1;
      const nextDay = appState.streak + 1;
      const processed = await processVideo({
        inputPath: rawUri,
        habitName: (appState.goal || 'HABIT').toUpperCase(),
        currentDay: nextDay,
        captureTime: format(captureTime, "yyyy.MM/dd HH:mm"),
        dayLabel: currentPhase > 1 ? `P${currentPhase} DAY${nextDay}` : undefined,
      });
      setCapturedUri(processed);  // transition to preview with processed video
    } catch (vErr) {
      console.warn('[processVideo] fallback to raw video:', vErr);
      setCapturedUri(rawUri);     // fallback: show raw video on error
    } finally {
      setIsProcessingVideo(false);
    }
  }, [camPermission, requestCamPermission, isRecording, countdown, camMode,
      appState.showRecordingCountdown, appState.goal,
      appState.streak, clearCamTimers, showToast, t]);

  const retake = useCallback(() => {
    clearCamTimers();
    setCapturedUri(null);
    setCapturedType('video');
    setCapturedTime(null);
    setIsPreviewPlaying(false);
    setVideoReady(false);
    setPhotoProcessorData(null);
    setIsProcessingPhoto(false);
  }, [clearCamTimers]);

  const saveCapture = useCallback(async () => {
    if (!capturedUri) return;
    try {
      if (!mediaPermission?.granted) await requestMediaPermission();
      // capturedUri is always a fully baked (filter + square crop) file for both photo and video
      await MediaLibrary.saveToLibraryAsync(capturedUri);
      recordToday(capturedUri);
      setCapturedUri(null);
      setCapturedTime(null);
      setScreen('home');
    } catch (e) {
      console.error('[saveCapture] error:', e);
      showToast(t('toast_save_error'), true);
    }
  }, [capturedUri, mediaPermission, requestMediaPermission, recordToday, showToast, t]);

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
    const annualPkg   = findRCPackage('annual');
    const monthlyPkg  = findRCPackage('monthly');
    const annualPrice = annualPkg?.product.priceString ?? null;
    const monthlyPrice = monthlyPkg?.product.priceString ?? null;

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

        {/* ── 機能リスト ── */}
        {[1, 2, 3, 4, 5].map(i => (
          <View key={i} style={styles.featureRow}>
            <Feather name="check-circle" size={16} color="#8B0000" />
            <Text style={styles.featureText}>{t(`paywall_feature${i}`)}</Text>
          </View>
        ))}

        {/* ── 年額プランカード（メイン） ── */}
        <TouchableOpacity
          style={styles.planCardActive}
          onPress={() => annualPkg && subscribePremium(annualPkg)}
          disabled={!annualPkg}
        >
          <View style={styles.planCardBadgeRow}>
            <View style={styles.paywallBadge}>
              <Text style={styles.paywallBadgeText}>
                {lang === 'ja' ? 'おすすめ' : 'BEST VALUE'}
              </Text>
            </View>
          </View>
          <Text style={styles.planCardPrice}>{annualPrice ?? '—'}</Text>
          <Text style={styles.planCardPeriod}>
            {lang === 'ja' ? '/ 年（1日あたり約8円）' : '/ YEAR  ·  BILLED ANNUALLY'}
          </Text>
          <Text style={styles.planCardCta}>
            {lang === 'ja' ? 'このプランで始める →' : 'GET ACCESS  →'}
          </Text>
        </TouchableOpacity>

        {/* ── 月額プランカード（サブ） ── */}
        {monthlyPkg && (
          <TouchableOpacity
            style={styles.planCardSecondary}
            onPress={() => subscribePremium(monthlyPkg)}
          >
            <Text style={styles.planCardSecondaryPrice}>{monthlyPrice ?? '—'}</Text>
            <Text style={styles.planCardSecondaryPeriod}>
              {lang === 'ja' ? '/ 月' : '/ MONTH  ·  BILLED MONTHLY'}
            </Text>
          </TouchableOpacity>
        )}

        <Text style={styles.subscriptionNote}>{t('paywall_iap_note')}</Text>

        <Text style={styles.paywallPassNote}>{t('paywall_pass_note')}</Text>

        <TouchableOpacity onPress={restorePurchase}>
          <Text style={styles.linkText}>{t('paywall_restore_btn')}</Text>
        </TouchableOpacity>
        <View style={styles.paywallLinks}>
          <TouchableOpacity onPress={() => openLegal('terms')}>
            <Text style={[styles.linkSmall, styles.linkSmallTappable]}>{t('paywall_terms')}</Text>
          </TouchableOpacity>
          <Text style={styles.linkSmall}>  ·  </Text>
          <TouchableOpacity onPress={() => openLegal('privacy')}>
            <Text style={[styles.linkSmall, styles.linkSmallTappable]}>{t('paywall_privacy')}</Text>
          </TouchableOpacity>
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
        {/* Phase ラベル（Phase 2 以上の場合のみ表示）*/}
        {(appState.phase ?? 1) > 1 && (
          <Text style={styles.phaseLabel}>
            {t('phase_label', { n: appState.phase ?? 1 })}
          </Text>
        )}
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
        <Text style={styles.streakLabel}>
          {(appState.phase ?? 1) > 1
            ? `${t('phase_label', { n: appState.phase ?? 1 })} ${t('streak_label')}`
            : t('streak_label')}
        </Text>
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

    // ── プレビュー画面（動画・写真共通）──
    if (capturedUri) {
      const isPhoto = capturedType === 'photo';

      return (
        <View style={styles.previewScreen}>

          {/* ── メディアカード（角ブラケット付き）── */}
          <View ref={previewCardRef} style={styles.previewCard}>
            {isPhoto ? (
              <Image source={{ uri: capturedUri }} style={styles.previewMedia} resizeMode="contain" />
            ) : (
              <>
                <Video
                  ref={previewVideoRef}
                  source={{ uri: capturedUri }}
                  style={styles.previewMedia}
                  resizeMode={ResizeMode.CONTAIN}
                  isLooping
                  shouldPlay={isPreviewPlaying}
                  isMuted={false}
                  positionMillis={0}
                  onReadyForDisplay={() => setVideoReady(true)}
                />
                {/* Video loading overlay — shown until first frame is ready */}
                {!videoReady && (
                  <View style={styles.videoLoadingOverlay}>
                    <ActivityIndicator size="large" color="#C8C8C8" />
                  </View>
                )}
                {/* 長押し再生エリア */}
                {videoReady && (
                  <Pressable
                    style={[StyleSheet.absoluteFill, { bottom: 0 }]}
                    onLongPress={() => setIsPreviewPlaying(true)}
                    onPressOut={async () => {
                      setIsPreviewPlaying(false);
                      await previewVideoRef.current?.setPositionAsync(0);
                    }}
                    delayLongPress={150}
                  />
                )}
                {/* 長押しヒント */}
                {videoReady && !isPreviewPlaying && (
                  <View style={styles.previewHint}>
                    <Feather name="play" size={14} color="rgba(255,255,255,0.8)" />
                    <Text style={styles.previewHintText}>
                      {lang === 'en' ? 'Hold to play' : '長押しで再生'}
                    </Text>
                  </View>
                )}
              </>
            )}

              {/* フィルターとコーナーブラケットはファイルに焼き込み済み（写真・動画ともに）*/}

          </View>

          {/* ── アクションボタン行（削除 | 保存 | 共有）── */}
          <View style={styles.previewActions}>
            <TouchableOpacity style={styles.previewBtnDelete} onPress={retake}>
              <Feather name="trash-2" size={18} color="#fff" />
              <Text style={styles.previewBtnLabel}>{t('retry_btn')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.previewBtnSave}
              onPress={saveCapture}
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

        {/* 処理中オーバーレイ（録画後またはフィルター焼き込み中に表示）*/}
        {(isProcessingVideo || isProcessingPhoto) && (
          <View style={styles.cameraProcessingOverlay}>
            <ActivityIndicator size="large" color="#C8C8C8" />
            <Text style={styles.cameraProcessingText}>
              {lang === 'en' ? 'PROCESSING...' : '処理中...'}
            </Text>
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

            {/* 右: 透明スペーサー（シャッター中央揃えのため・白い丸は削除済み）*/}
            <View style={{ width: 48 }} />
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

                {/* フィルターはファイルに焼き込み済みのため追加オーバーレイ不要 */}

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

    const handleSave = async () => {
      const newGoal = goalEdit.trim();
      const goalChanged = newGoal !== appState.goal;

      const finalizeAndSave = async (extraUpdates: Partial<AppState> = {}) => {
        const updates: Partial<AppState> = {
          goal: newGoal,
          phaseChangeFree: false,
          ...extraUpdates,
        };
        const timeValid = /^\d{1,2}:\d{2}$/.test(notifyEdit.trim());
        if (timeValid) {
          updates.notifyTime = notifyEdit.trim();
          try {
            const { status } = await Notifications.getPermissionsAsync();
            if (status === 'granted') {
              const title = lang === 'ja' ? '今日の記録をしましょう！' : "Time to record today's habit!";
              const body = lang === 'ja'
                ? `目標: ${newGoal || 'One Shot'}`
                : `Goal: ${newGoal || 'One Shot'}`;
              await scheduleDailyNotification(notifyEdit.trim(), title, body);
            }
          } catch {}
        }
        updateState(updates);
        showToast(t('toast_settings_saved'));
        setScreen('home');
      };

      // 10-day rule: warn when changing goal with streak > 10, unless phase change is free
      if (goalChanged && appState.streak > 10 && !appState.phaseChangeFree) {
        Alert.alert('', t('confirm_change_goal_streak'), [
          { text: t('confirm_change_goal_cancel'), style: 'cancel' },
          {
            text: t('confirm_change_goal_reset'),
            style: 'destructive',
            onPress: async () => {
              setRecords([]);
              await finalizeAndSave({ streak: 0, lastRecordDate: '', milestone10Shown: false });
            },
          },
        ]);
        return;
      }

      await finalizeAndSave();
    };

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
          {appState.streak > 10 && !appState.phaseChangeFree && (
            <Text style={styles.settingHint}>
              {lang === 'ja'
                ? '⚠ 10日超: 目標変更にはリセットが必要です'
                : '⚠ 10+ days: changing goal requires reset'}
            </Text>
          )}
        </View>

        {!appState.subscribed && (() => {
          const _pkg   = findRCPackage('annual');
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
              <TouchableOpacity style={styles.btnPrimary} onPress={() => _pkg && subscribePremium(_pkg)}>
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

        <TouchableOpacity style={styles.btnPrimary} onPress={handleSave}>
          <Text style={styles.btnPrimaryText}>{t('settings_save_btn')}</Text>
        </TouchableOpacity>

        {/* Phase 昇格ボタン: streak > 100 かつ前回昇格から 100 日以上経過した時のみ表示 */}
        {appState.streak > (appState.phasePromotedAt ?? 0) + 100 && (
          <TouchableOpacity
            style={[styles.btnPrimary, { backgroundColor: '#4a0080' }]}
            onPress={() => {
              const newPhase = (appState.phase ?? 1) + 1;
              updateState({
                phase: newPhase,
                phaseChangeFree: true,
                phasePromotedAt: appState.streak,
              });
              showToast(t('phase_promoted_toast', { n: newPhase }));
            }}
          >
            <Text style={styles.btnPrimaryText}>{t('phase_next_btn')}</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={styles.btnOutline} onPress={restorePurchase}>
          <Text style={styles.btnOutlineText}>{t('settings_restore_btn')}</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.btnOutline} onPress={() => setGuideVisible(true)}>
          <Text style={styles.btnOutlineText}>{t('settings_guide')}</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.btnDanger} onPress={resetAll}>
          <Text style={styles.btnDangerText}>{t('settings_reset_btn')}</Text>
        </TouchableOpacity>

        {/* ── 利用規約 / プライバシーポリシー ── */}
        <View style={styles.settingsLegalRow}>
          <TouchableOpacity onPress={() => openLegal('terms')}>
            <Text style={styles.settingsLegalLink}>{t('paywall_terms')}</Text>
          </TouchableOpacity>
          <Text style={styles.settingsLegalSep}> · </Text>
          <TouchableOpacity onPress={() => openLegal('privacy')}>
            <Text style={styles.settingsLegalLink}>{t('paywall_privacy')}</Text>
          </TouchableOpacity>
        </View>
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
            { title: t('guide_rule_10day_title'), body: t('guide_rule_10day_body') },
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

  // ─── Milestone 10 Modal ───────────────────────────────────────────────────────

  const Milestone10Modal = () => (
    <Modal visible={milestone10Visible} animationType="fade" transparent>
      <View style={styles.modalOverlay}>
        <View style={styles.milestone10Card}>
          <Text style={styles.milestone10Title}>{t('milestone_10_title')}</Text>
          <Text style={styles.milestone10Body}>{t('milestone_10_body')}</Text>
          <TouchableOpacity
            style={[styles.btnPrimary, { marginBottom: 0 }]}
            onPress={() => setMilestone10Visible(false)}
          >
            <Text style={styles.btnPrimaryText}>{t('ok')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );

  // ─── Legal Modal ──────────────────────────────────────────────────────────────

  const LegalModal = () => {
    const isTerms = legalType === 'terms';
    const title = isTerms ? t('paywall_terms') : t('paywall_privacy');

    const jaTerms =
`【利用規約】最終更新: 2024年

本規約は One Shot（以下「本アプリ」）のご利用条件を定めます。

■ サブスクリプション
・年額・月額プランは自動更新されます。
・更新停止は期間終了の24時間前までに行ってください。
・購入確認後の払い戻しはできません。
・料金はApple IDに請求されます。

■ お休みパス
お休みパス（$0.99/枚）は消耗品です。使用後の返金はできません。

■ 禁止事項
・本アプリを違法な目的に使用すること。
・他者への迷惑行為・不正アクセス。
・アプリのリバースエンジニアリング。

■ 免責事項
ストリークデータの保全は保証しません。端末障害等によるデータ損失について責任を負いません。

■ 規約の変更
本規約は予告なく変更される場合があります。継続利用をもって同意とみなします。

■ 準拠法
本規約は日本法に準拠します。

■ お問い合わせ
アプリ内の「お問い合わせ」からご連絡ください。`;

    const enTerms =
`TERMS OF SERVICE — Last updated: 2024

These terms govern your use of One Shot (the "App").

SUBSCRIPTIONS
· Annual and monthly plans auto-renew.
· Cancel at least 24 hours before the renewal date to avoid charges.
· No refunds after purchase confirmation.
· Billed to your Apple ID.

REST PASSES
Rest passes ($0.99 each) are consumable and non-refundable after use.

PROHIBITED USES
· Using the App for illegal purposes.
· Harassing other users or unauthorized access.
· Reverse engineering the App.

DISCLAIMER
We do not guarantee preservation of streak data. We are not liable for data loss due to device failure or other technical issues.

CHANGES TO TERMS
We may update these terms without prior notice. Continued use constitutes acceptance.

GOVERNING LAW
These terms are governed by applicable law.

CONTACT
Use the in-app contact feature to reach us.`;

    const jaPrivacy =
`【プライバシーポリシー】最終更新: 2024年

■ 収集する情報
・目標テキスト（端末内にのみ保存）
・撮影した動画・写真（端末内にのみ保存）
・ストリーク・利用統計（端末内にのみ保存）
・RevenueCat経由の購入情報

■ 収集しない情報
氏名・住所・位置情報・連絡先などの個人情報は収集しません。

■ データの保存
コンテンツデータはすべてお使いの端末内にのみ保存されます。クラウドへのアップロードは行いません。

■ 第三者サービス
・RevenueCat: 購入管理（revenuecat.com/privacy）
・Apple App Store: アプリ配信

■ データの削除
設定画面の「すべてのデータをリセット」からいつでも削除できます。

■ ポリシーの変更
本ポリシーは予告なく変更される場合があります。

■ お問い合わせ
アプリ内の「お問い合わせ」からご連絡ください。`;

    const enPrivacy =
`PRIVACY POLICY — Last updated: 2024

INFORMATION WE COLLECT
· Your habit goal text (stored locally only)
· Recorded videos and photos (on-device only)
· Streak and usage statistics (local)
· Purchase information via RevenueCat

INFORMATION WE DO NOT COLLECT
We do not collect personal identifiers such as your name, address, location, or contact information.

DATA STORAGE
All content data is stored exclusively on your device. We do not upload content to the cloud.

THIRD-PARTY SERVICES
· RevenueCat: Purchase management (revenuecat.com/privacy)
· Apple App Store: App distribution

DATA DELETION
You can delete all data at any time via Settings → Reset All Data.

CHANGES
This policy may be updated without prior notice.

CONTACT
Use the in-app contact feature to reach us.`;

    const content = lang === 'ja'
      ? (isTerms ? jaTerms : jaPrivacy)
      : (isTerms ? enTerms : enPrivacy);

    return (
      <Modal visible={legalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.legalSheet}>
            <View style={styles.legalHeader}>
              <Text style={styles.legalTitle}>{title}</Text>
              <TouchableOpacity
                onPress={() => setLegalVisible(false)}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              >
                <Feather name="x" size={22} color="#888" />
              </TouchableOpacity>
            </View>
            <ScrollView
              style={styles.legalScroll}
              contentContainerStyle={styles.legalScrollContent}
            >
              <Text style={styles.legalBody}>{content}</Text>
            </ScrollView>
          </View>
        </View>
      </Modal>
    );
  };

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
      <Milestone10Modal />
      <LegalModal />
      {toastMsg ? <Toast message={toastMsg} isError={toastError} /> : null}

      {/* ── Off-screen photo filter processor ──────────────────────────────── */}
      {/* Renders the raw photo + all overlays off-screen; view-shot captures it
          to produce a fully baked processedUri before showing preview.          */}
      {photoProcessorData && (() => {
        const { uri, habitName, currentDay, captureTime } = photoProcessorData;
        const sq = Dimensions.get('window').width;
        const pad = sq * 0.045;
        const textSize = sq * 0.038;
        const armLen = sq * 0.07;
        const bracketW = Math.max(sq * 0.003, 1.5);
        const dotSize = textSize * 0.95;
        const dotX = pad + armLen * 0.25;
        const dotY = pad + armLen * 0.25;
        const textTop = dotY + dotSize / 2 - textSize / 2;
        const neShotX = dotX + dotSize + textSize * 0.22;
        const lineGap = textSize * 1.35;
        const tsStr = format(captureTime, "yyyy.MM/dd HH:mm");
        const habitStr = `HABIT:${habitName}`;
        const currentPhaseForPhoto = appState.phase ?? 1;
        const dayStr = currentPhaseForPhoto > 1 ? `P${currentPhaseForPhoto} DAY${currentDay}` : `DAY${currentDay}`;

        const textShadow = {
          textShadowColor: 'rgba(0,0,0,0.6)' as any,
          textShadowOffset: { width: 1, height: 1 },
          textShadowRadius: 3,
        };
        const baseText = {
          color: '#fff' as const,
          fontWeight: '700' as const,
          fontSize: textSize,
          position: 'absolute' as const,
          ...textShadow,
        };

        return (
          <View
            ref={photoProcessorRef}
            style={{
              position: 'absolute',
              left: -(sq * 3),
              top: 0,
              width: sq,
              height: sq,
              overflow: 'hidden',
              backgroundColor: '#000',
            }}
          >
            {/* Raw photo cropped to square */}
            <Image
              source={{ uri }}
              style={{ width: sq, height: sq }}
              resizeMode="cover"
              onLoadEnd={() => processPhotoFromRef(uri)}
            />
            {/* Dark / cold tone overlay */}
            <View style={{
              position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
              backgroundColor: 'rgba(0,10,31,0.38)',
            }} />
            {/* TL corner bracket ┌ */}
            <View style={{
              position: 'absolute', top: pad, left: pad,
              width: armLen, height: armLen,
              borderTopWidth: bracketW, borderLeftWidth: bracketW,
              borderColor: '#fff',
            }} />
            {/* Red dot ● */}
            <View style={{
              position: 'absolute',
              top: dotY, left: dotX,
              width: dotSize, height: dotSize,
              borderRadius: dotSize / 2,
              backgroundColor: '#FF0D0D',
            }} />
            {/* "ne shot" */}
            <Text style={{ ...baseText, top: textTop, left: neShotX }}>ne shot</Text>
            {/* DAYn (right side, same row) */}
            <Text style={{ ...baseText, top: textTop, right: pad }}>{dayStr}</Text>
            {/* Timestamp line */}
            <Text style={{ ...baseText, bottom: pad + lineGap, left: pad }}>{tsStr}</Text>
            {/* HABIT line */}
            <Text style={{ ...baseText, bottom: pad, left: pad }}>{habitStr}</Text>
            {/* BR corner bracket ┘ */}
            <View style={{
              position: 'absolute', bottom: pad, right: pad,
              width: armLen, height: armLen,
              borderBottomWidth: bracketW, borderRightWidth: bracketW,
              borderColor: '#fff',
            }} />
          </View>
        );
      })()}

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
  // ── Plan cards ──
  planCardActive: {
    alignSelf: 'stretch',
    borderWidth: 1.5,
    borderColor: '#8B0000',
    borderRadius: 12,
    backgroundColor: '#0d0000',
    padding: 20,
    marginBottom: 12,
    marginTop: 20,
  },
  planCardBadgeRow: {
    flexDirection: 'row',
    marginBottom: 10,
  },
  planCardPrice: {
    fontSize: 34,
    fontWeight: '900',
    color: '#fff',
    letterSpacing: -1,
    marginBottom: 4,
  },
  planCardPeriod: {
    fontSize: 11,
    color: '#888',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 14,
  },
  planCardCta: {
    fontSize: 13,
    fontWeight: '800',
    color: '#CC3333',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  planCardSecondary: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 12,
    backgroundColor: '#0d0d0d',
    paddingVertical: 14,
    paddingHorizontal: 20,
    marginBottom: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  planCardSecondaryPrice: {
    fontSize: 20,
    fontWeight: '700',
    color: '#aaa',
    letterSpacing: -0.5,
  },
  planCardSecondaryPeriod: {
    fontSize: 11,
    color: '#555',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
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
  linkSmallTappable: {
    color: '#666',
    textDecorationLine: 'underline',
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
  phaseLabel: {
    fontSize: 11,
    color: '#9966cc',
    fontWeight: '700',
    letterSpacing: 3,
    textTransform: 'uppercase',
    marginBottom: 2,
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

  // 動画読み込み中オーバーレイ（onReadyForDisplay が来るまで黒画面をスピナーで覆う）
  videoLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 5,
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

  // ── Camera processing overlay (shown while Swift processes after recording) ──
  cameraProcessingOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
    zIndex: 20,
  },
  cameraProcessingText: {
    color: '#C8C8C8',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 3,
  },

  // ── Industrial Data 4-corner overlay (photo preview, matching Swift output) ──
  idTopLeft: {
    position: 'absolute',
    top: '12%',
    left: '5%',
    fontFamily: 'Menlo',
    fontSize: 12,
    color: '#C8C8C8',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 4,
  },
  idTopRight: {
    position: 'absolute',
    top: '12%',
    right: '5%',
    fontFamily: 'Menlo',
    fontSize: 12,
    color: '#C8C8C8',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 4,
  },
  idBottomLeft: {
    position: 'absolute',
    bottom: '25%',
    left: '5%',
    fontFamily: 'Menlo',
    fontSize: 12,
    color: '#C8C8C8',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 4,
  },
  idBottomRight: {
    position: 'absolute',
    bottom: '25%',
    right: '5%',
    fontFamily: 'Menlo',
    fontSize: 12,
    color: '#C8C8C8',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 4,
  },

  // ── Subscription IAP note (Apple Review compliance) ──
  subscriptionNote: {
    fontSize: 10,
    color: '#444',
    textAlign: 'center',
    lineHeight: 15,
    marginBottom: 12,
    paddingHorizontal: 8,
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
  milestone10Card: {
    backgroundColor: '#0d0d0d',
    borderWidth: 1,
    borderColor: '#8B0000',
    borderRadius: 20,
    margin: 24,
    padding: 28,
    alignItems: 'center',
  },
  milestone10Title: {
    fontSize: 24,
    fontWeight: '900',
    color: '#fff',
    letterSpacing: 2,
    marginBottom: 16,
    textAlign: 'center',
  },
  milestone10Body: {
    fontSize: 15,
    color: '#ccc',
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: 24,
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

  // ── Legal Modal ──
  legalSheet: {
    backgroundColor: '#0a0a0a',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '85%',
    minHeight: '60%',
  },
  legalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  legalTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: 1,
  },
  legalScroll: {
    flex: 1,
  },
  legalScrollContent: {
    padding: 20,
    paddingBottom: 40,
  },
  legalBody: {
    fontSize: 13,
    color: '#aaa',
    lineHeight: 22,
  },
  settingsLegalRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 20,
  },
  settingsLegalLink: {
    color: '#444',
    fontSize: 12,
    textDecorationLine: 'underline',
  },
  settingsLegalSep: {
    color: '#333',
    fontSize: 12,
    paddingHorizontal: 6,
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

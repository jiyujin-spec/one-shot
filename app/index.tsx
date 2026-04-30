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
  Animated,
  Easing,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ICloudKV } from 'icloud-kv-store';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { Feather, Ionicons } from '@expo/vector-icons';
import Svg, { Polyline, Line, Circle, Text as SvgText } from 'react-native-svg';
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
import * as FileSystem from 'expo-file-system';
import * as Notifications from 'expo-notifications';
import * as StoreReview from 'expo-store-review';
import * as Font from 'expo-font';
import * as Haptics from 'expo-haptics';
// Build 27: expo-web-browser (v55) は expo 51 のネイティブ層に存在しないため
// Linking.openURL に置き換えて ExpoWebBrowser ネイティブモジュール依存を排除する。
// expo-web-browser import removed
// Build 22: video-overlay は起動時にロードしない（iOS 18 クラッシュ対策）
// 実際の呼び出し直前に require() で遅延ロードする。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let processVideo: ((opts: any) => Promise<string>) | null = null;

// ─── Constants ───────────────────────────────────────────────────────────────

const RC_API_KEY = 'appl_hxzNKcnblLemtdWosMHSIFpQWYR';
const HOUR_BOUNDARY = 3; // Day resets at 3 AM
const MAX_SLOTS = 5; // 1日あたり最大撮影枚数

// ── Build 7: スキーマバージョン管理 ─────────────────────────────────────────
// schema_version = 7 を起点に、ストレージフォーマットを永続的に管理する。
// 将来のフォーマット変更は SCHEMA_VERSION を上げてマイグレーション関数を追加する。
const SCHEMA_VERSION = 7;

// v7+ ストレージキー（v2 → v3 キー変更で旧データを明示的に分離）
const STORAGE_KEY   = 'oneshot_state_v3';
const RECORDS_KEY   = 'oneshot_records_v3';
const LANG_KEY      = 'oneshot_lang';

// v2 レガシーキー（マイグレーション時のみ参照）
const LEGACY_STORAGE_KEY  = 'oneshot_state_v2';
const LEGACY_RECORDS_KEY  = 'oneshot_records_v2';

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
  colorFilterEnabled: boolean;
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
  uri?: string;    // legacy: single URI (kept for backward compat)
  uris?: string[]; // multi-slot: up to MAX_SLOTS URIs
  isPass?: boolean;
}

// ── Build 7: URI 永続化ヘルパー ───────────────────────────────────────────────
//
// 【設計思想】
//   iOS のアプリコンテナ UUID はアプリの更新では変わらないが、
//   完全な再インストール時に変化する。
//   documentDirectory 内のファイルを絶対 URI で保存すると、
//   万が一 UUID が変わった際にパスが無効になりデータが消える。
//
//   Build 7 以降はすべての documentDirectory ファイルを「相対パス」で保存し、
//   読み出し時に実行時の documentDirectory を先頭に付与して絶対 URI を復元する。
//   Photos ライブラリ URI（ph:// / file://...Media/...）は
//   アプリコンテナ外に存在するため変換不要 → そのまま保存・返却する。
//
//   これにより Build 7 以降は「データが消えない」を構造レベルで保証する。

/**
 * documentDirectory 配下のファイルを相対パスに変換して返す。
 * Photos ライブラリ URI など documentDirectory 外のパスはそのまま返す。
 *
 * 例: "file:///...UUID.../Documents/oneshot_abc.mp4" → "oneshot_abc.mp4"
 *      "file:///var/mobile/Media/DCIM/IMG_001.MP4"   → そのまま（変換なし）
 */
function toRelativeUri(uri: string): string {
  const docDir = FileSystem.documentDirectory ?? '';
  if (docDir && uri.startsWith(docDir)) {
    return uri.slice(docDir.length); // e.g. "oneshot_processed_abc.mp4"
  }
  return uri; // Photos library URI / 外部 URI はそのまま
}

/**
 * 相対パスを実行時の documentDirectory を使って絶対 URI に復元する。
 * すでに絶対 URI（file://, ph://, https://）の場合はそのまま返す。
 *
 * 例: "oneshot_abc.mp4"     → "file:///...UUID.../Documents/oneshot_abc.mp4"
 *      "file://...absolute" → そのまま（変換なし）
 */
function toAbsoluteUri(uri: string): string {
  if (!uri) return uri;
  if (uri.startsWith('file://') || uri.startsWith('ph://') || uri.startsWith('http')) {
    return uri; // すでに絶対 URI
  }
  return (FileSystem.documentDirectory ?? '') + uri;
}


// RecordEntry から URI 配列を取得するヘルパー（後方互換 + Build 7 絶対URI復元）
function getRecordUris(rec: RecordEntry): string[] {
  const raw: string[] = (() => {
    if (rec.uris && rec.uris.length > 0) return rec.uris;
    if (rec.uri) return [rec.uri];
    return [];
  })();
  // Build 7: 相対パスで保存されたエントリを実行時に絶対 URI へ復元
  return raw.map(toAbsoluteUri);
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
    paywall_feature5: 'ストリーク記録・カレンダー表示',
    paywall_subscribe_btn: '年額プランで始める',
    paywall_iap_note: 'App Storeに表示される現在の価格が適用されます。Apple IDに課金されます。サブスクリプションは購入後、現在の期間終了前に解約しない限り自動更新されます。サブスクリプションの管理・自動更新のオフは、購入後にApple IDのアカウント設定から行えます。',
    paywall_pass_note: 'お休みパスはApp Storeに表示される現在の価格で別途購入できます',
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
    guide_card4_body: 'パスは毎週月曜日に1回分付与されます。\nどうしても継続できない時に使いましょう。\nストリークがそのまま維持されます。\n\n使わなかったパスは翌週以降も残ります。',
    guide_card5_title: 'パスの追加購入',
    guide_card5_body: 'パスはApp Storeに表示される現在の価格で追加購入できます。\n有効期限なし、何枚でもストックできます。',
    guide_start_btn: 'はじめる',
    pass_purchase_btn: 'パスを購入',
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
    confirm_purchase_pass: 'パスを1回分購入しますか？（App Storeに表示される現在の価格）',
    confirm_subscribe: 'メンバーシップを開始しますか？',
    confirm_restore: '購入を復元しますか？',
    confirm_use_pass: '本日はパス（お休み）を使用しますか？\nストリークがそのまま維持されます。',
    confirm_reset: 'すべてのデータを削除しますか？',
    no_history: 'まだ記録がありません',
    recorded_today: 'RECORDED TODAY',
    share_hashtag: '#oneshot #習慣化',
    cam_permission_title: 'カメラへのアクセスが必要です',
    cam_permission_body: 'One Shot はカメラとマイクを使用して動画を記録します。次の画面でアクセスを許可してください。',
    cam_permission_btn: 'カメラへのアクセスを許可する',
    cam_permission_denied_body: 'カメラへのアクセスが拒否されています。設定アプリからカメラとマイクへのアクセスを許可してください。',
    cam_permission_settings_btn: '設定を開く',
    cam_permission_back: '戻る',
    settings_countdown_label: '録画中カウントダウン',
    settings_countdown_hint: '録画中に残り時間を表示',
    settings_color_filter_label: 'Color Filter',
    settings_color_filter_hint: '色調補正（暗めのグレーディング）',
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
    video_today_only: '動画は当日のみ保存されます\nInstagram等にシェアして記録を残しましょう',
    onboarding_rule: '明日になれば消える。でも、投稿した記録は残る。',
    preview_expiry_hint: 'この動画は明日消えます — 今すぐシェアして記録を残そう',
    guide_card_storage_title: '動画の保存ルール',
    guide_card_storage_body: '動画はアプリ内に当日のみ保存されます。翌日のアプリ起動時に自動削除されます。\n\n記録を残したいときは、当日中にInstagramやTikTokにシェアしてください。\nシェアした投稿が、あなたの継続の証になります。',
    guide_free_trial_title: '無料体験について',
    guide_free_trial_body: 'One Shotは新規登録の方に7日間の無料体験をご提供します。\n\n無料体験の確認後すぐにサブスクリプションが開始されますが、7日間の体験期間中は一切課金されません。\n\n体験終了後は選択したプランで自動的に更新されます。\n・月額プラン: ¥500 / 月\n・年額プラン: ¥5,000 / 年\n\n課金を避けるには、体験終了の24時間前までに解約してください。\n\n解約方法:\niPhoneの設定 → Apple ID → サブスクリプション',
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
    paywall_feature5: 'Streak calendar & daily check-in log',
    paywall_subscribe_btn: 'Get Access',
    paywall_iap_note: 'Current price shown in the App Store applies. Charged to your Apple ID. Subscription auto-renews unless cancelled before the end of the current period. You can manage your subscription and turn off auto-renewal in your Apple ID Account Settings after purchase.',
    paywall_pass_note: 'Rest passes available separately at the current price shown in the App Store',
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
    guide_card4_body: 'One pass is granted every Monday.\nUse it when life intervenes.\nYour streak stays intact — one pass, one miss.\n\nUnused passes carry over to the following week.',
    guide_card5_title: 'Extra passes',
    guide_card5_body: 'Additional passes available at the current price shown in the App Store.\nNo expiry. Stock them before you need them.',
    guide_start_btn: 'START',
    pass_purchase_btn: 'BUY A PASS',
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
    confirm_purchase_pass: 'Purchase 1 rest pass? (Current price shown in the App Store)',
    confirm_subscribe: 'Start your annual membership?',
    confirm_restore: 'Restore purchases?',
    confirm_use_pass: 'Use a rest pass for today?\nYour streak will be maintained.',
    confirm_reset: 'Delete all data?',
    no_history: 'No records yet',
    recorded_today: 'LOGGED TODAY',
    share_hashtag: '#oneshot #habitbuilding',
    cam_permission_title: 'Camera Access Required',
    cam_permission_body: 'ONE SHOT needs camera and microphone access to record. Tap the button below to allow access.',
    cam_permission_btn: 'Allow Camera Access',
    cam_permission_denied_body: 'Camera access has been denied. Please go to Settings to allow camera and microphone access.',
    cam_permission_settings_btn: 'Open Settings',
    cam_permission_back: 'Go Back',
    settings_countdown_label: 'Recording Countdown',
    settings_countdown_hint: 'Display timer during recording',
    settings_color_filter_label: 'Color Filter',
    settings_color_filter_hint: 'Dark cold-tone color grading',
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
    video_today_only: "Videos are kept for today only\nShare before midnight to preserve them",
    onboarding_rule: 'Gone by midnight. Unless you post it.',
    preview_expiry_hint: 'This video disappears tomorrow — share now to keep it',
    guide_card_storage_title: 'Video storage',
    guide_card_storage_body: 'Videos are stored in the app for today only and automatically deleted on your next launch.\n\nTo preserve your record, share to Instagram or TikTok before the day ends.\nYour post is your proof of work.',
    guide_free_trial_title: 'Free Trial',
    guide_free_trial_body: 'One Shot offers a 7-day free trial for new subscribers.\n\nYour subscription begins immediately after confirming your free trial. You will NOT be charged during the 7-day trial period.\n\nAfter the trial ends, your subscription automatically renews at the selected price:\n・Monthly: ¥500 / month\n・Annual: ¥5,000 / year\n\nTo avoid being charged, cancel at least 24 hours before the trial ends.\n\nCancel anytime via:\niPhone Settings → Apple ID → Subscriptions',
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

// ─── Pure streak calculator ───────────────────────────────────────────────────
// records 配列のみを唯一の正解源として streak を算出する純粋関数。
// appState.streak への依存を一切排除することで、削除/再撮影ループで値が壊れるのを
// 構造的に防ぐ。
//
// ロジック:
//   1. records の全日付（パス含む）を重複排除・降順ソート
//   2. 最新日付が today から 2日以上前なら streak = 0（継続途切れ）
//   3. 最新日付から遡って連続する日付を数える → それが streak
//
// これにより「撮影→削除→再撮影」を何度繰り返しても、
// records に前日までのエントリが存在する限り streak は正しく復元される。
function calculateStreak(records: RecordEntry[], today: string): number {
  // 未来日を除外した一意の日付を降順で取得
  const uniqueDates = [...new Set(records.map(r => r.date))]
    .filter(d => d <= today)
    .sort()
    .reverse();

  if (uniqueDates.length === 0) return 0;

  // 最新記録が 2日以上前 → 継続途切れ
  if (daysBetween(uniqueDates[0], today) >= 2) return 0;

  // 連続日数をカウント（1日ずつ遡る）
  let streak = 1;
  for (let i = 1; i < uniqueDates.length; i++) {
    if (daysBetween(uniqueDates[i], uniqueDates[i - 1]) === 1) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// records 配列から最新の記録日付を返す（streak と同じ基準: 未来日除外）
function getLastRecordDate(records: RecordEntry[], today: string): string {
  const dates = [...new Set(records.map(r => r.date))]
    .filter(d => d <= today)
    .sort()
    .reverse();
  return dates[0] ?? '';
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
  colorFilterEnabled: true,
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

const NOTIFY_MESSAGES: Record<Lang, { title: string; body: (goal: string) => string }[]> = {
  ja: [
    { title: '記録待機中',                       body: (g) => `「${g || 'ONE SHOT'}」— 今日のログが未完了です。` },
    { title: 'ONE SHOT LOG',                    body: (g) => `「${g || 'ONE SHOT'}」— 1分でも良いので、始めましょう。` },
    { title: 'ストリーク継続中',                  body: (g) => `「${g || 'ONE SHOT'}」— ストリーク有効期限まで残りわずか。` },
  ],
  en: [
    { title: 'LOG PENDING',           body: (g) => `"${g || 'ONE SHOT'}" — Today's entry is waiting.` },
    { title: 'ONE SHOT LOG',          body: (g) => `"${g || 'ONE SHOT'}" — One minute is enough. Begin.` },
    { title: 'STREAK ACTIVE',         body: (g) => `"${g || 'ONE SHOT'}" — Record window closing soon.` },
  ],
};

function pickNotifyMessage(lang: Lang, goal: string): { title: string; body: string } {
  const messages = NOTIFY_MESSAGES[lang];
  const idx = new Date().getDay() % messages.length; // deterministic rotation by day-of-week
  const m = messages[idx];
  return { title: m.title, body: m.body(goal) };
}

// NOTE: setNotificationHandler is called inside a useEffect in the Page
// component to avoid top-level evaluation errors crashing the app before
// React can mount the ErrorBoundary.

async function scheduleDailyNotification(timeStr: string, title: string, body: string, hasRecordedToday = false) {
  await Notifications.cancelAllScheduledNotificationsAsync();
  if (hasRecordedToday) return;
  const parts = timeStr.split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1] ?? '0', 10);
  if (isNaN(h) || isNaN(m)) return;
  await Notifications.scheduleNotificationAsync({
    content: { title, body, sound: true },
    trigger: {
      hour: h,
      minute: m,
      repeats: true,
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
  const [recSecs, setRecSecs] = useState<5 | 10>(5);
  const recSecsRef = useRef<5 | 10>(5);
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
  // 日付セルタップで開くデイリー詳細シート用
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  // デイリー詳細シートから再生する動画スロットのインデックス
  const [selectedSlotIdx, setSelectedSlotIdx] = useState<number | null>(null);
  // 再生モーダルでの画像読み込みエラー追跡（旧 tmpfile URI が失効した場合のフォールバック用）
  const [playingUriError, setPlayingUriError] = useState(false);

  // RevenueCat state
  const [rcOfferings, setRcOfferings] = useState<PurchasesOfferings | null>(null);

  // Review trigger
  const [reviewReady, setReviewReady] = useState(false);

  const toastTimer = useRef<any>(null);

  // ── Graph animation state (History screen) ──────────────────────────────────
  // graphAnimRef: Animated.Value 0→1 (linear, quad-in easing applied in listener)
  // graphAnimStep: 現在アニメーション中の描画済み日数 (0 = 未描画, streak = 完了)
  // graphShowFuture: true になった瞬間に将来予測破線を表示
  const graphAnimRef = useRef(new Animated.Value(0));
  const [graphAnimStep, setGraphAnimStep] = useState(0);
  const [graphShowFuture, setGraphShowFuture] = useState(false);

  // ── Font loading ────────────────────────────────────────────────────────────

  useEffect(() => {
    Font.loadAsync({
      'BebasNeue-Regular': require('../assets/fonts/BebasNeue-Regular.ttf'),
      'SpaceMono-Regular': require('../assets/fonts/SpaceMono-Regular.ttf'),
      'SpaceMono-Bold':    require('../assets/fonts/SpaceMono-Bold.ttf'),
    }).catch(() => { /* font load failure is non-fatal */ });
  }, []);

  // ── Notification handler (inside useEffect to avoid top-level crash) ─────────

  useEffect(() => {
    try {
      Notifications.setNotificationHandler({
        handleNotification: async (): Promise<Notifications.NotificationBehavior> => ({
          shouldShowAlert: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        }),
      });
    } catch {}
  }, []);

  // ── History graph animation ─────────────────────────────────────────────────
  // HISTORY 画面に遷移するたびに成長曲線アニメーションを再生する。
  // ・赤い点が DAY 1 → 現在地へ Quad In 加速しながら移動
  // ・白い実線が赤い点に追従してリアルタイムに伸びる
  // ・現在地到達と同時に白い破線（将来予測）をパッと表示
  // ・移動中は Light ハプティクスを等間隔で発火（トトトトトッ）
  // ・到達時は Heavy ハプティクスを1回発火（ドン！）
  useEffect(() => {
    if (screen !== 'history' || appState.streak === 0) return;

    const streak = appState.streak;

    // リセット
    graphAnimRef.current.stopAnimation();
    graphAnimRef.current.setValue(0);
    setGraphAnimStep(0);
    setGraphShowFuture(false);

    // ハプティクス発火間隔: streak が大きいほど粗くなるが最大 15 発
    const hapticInterval = Math.max(1, Math.ceil(streak / 15));
    // 重複発火防止用（クロージャ内の可変カウンタ）
    let lastFiredStep = -1;
    let lastSetStep = -1;

    const listenerId = graphAnimRef.current.addListener(({ value }) => {
      // Quad In: value は 0→1 (linear) → step は加速感あり
      const step = Math.min(Math.round(value * streak), streak);
      // 同じ step での再描画をスキップ（パフォーマンス最適化）
      if (step === lastSetStep) return;
      lastSetStep = step;
      setGraphAnimStep(step);

      // 移動中ハプティクス（等間隔 Light）
      if (step > 0 && step < streak) {
        const hapticBucket = Math.floor(step / hapticInterval);
        const lastBucket   = Math.floor(lastFiredStep / hapticInterval);
        if (hapticBucket > lastBucket) {
          lastFiredStep = step;
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        }
      }
    });

    Animated.timing(graphAnimRef.current, {
      toValue: 1,
      duration: 1350,
      easing: Easing.in(Easing.quad),  // 最初ゆっくり → 後半爆速
      useNativeDriver: false,
    }).start(({ finished }) => {
      graphAnimRef.current.removeListener(listenerId);
      if (finished) {
        setGraphAnimStep(streak);
        setGraphShowFuture(true);
        // 到達ハプティクス（Heavy: ドン！）
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
      }
    });

    return () => {
      graphAnimRef.current.removeListener(listenerId);
      graphAnimRef.current.stopAnimation();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, appState.streak]);

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
      // Build 7: schema_version を付与して v3 キーに保存
      const json = JSON.stringify({ schema_version: SCHEMA_VERSION, ...newState });
      await AsyncStorage.setItem(STORAGE_KEY, json);
      ICloudKV.setItem(STORAGE_KEY, json);
      ICloudKV.synchronize();
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

  // records 配列から streak を再計算して appState を更新する（唯一の正解源を強制適用）
  // 旧実装は lastRecordDate との diff だけで判定していたが、
  // calculateStreak は records 全体を走査するため不整合が発生しない。
  const updateStreak = useCallback((s: AppState, currentRecords: RecordEntry[]): AppState => {
    const today = getAppDate();
    const computedStreak = calculateStreak(currentRecords, today);
    const computedLastDate = getLastRecordDate(currentRecords, today);
    if (s.streak === computedStreak && s.lastRecordDate === computedLastDate) return s;
    return { ...s, streak: computedStreak, lastRecordDate: computedLastDate };
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
          // records を唯一の正解源として streak を計算（appState.streak に依存しない）
          const recordsWithToday = [...records.filter(r => r.date !== today),
            { date: today, ts: Date.now(), day: 0 } as RecordEntry];
          const newStreak = calculateStreak(recordsWithToday, today);
          const passEntry: RecordEntry = { date: today, day: newStreak, ts: Date.now(), isPass: true };
          setRecords(r => [passEntry, ...r.filter(x => x.date !== today)]);
          setAppState(prev => {
            const consumed = consumePass({ ...prev, streak: newStreak, lastRecordDate: today });
            saveAppState(consumed);
            return consumed;
          });
          showToast(t('toast_pass_used'));
        },
      },
    ]);
  }, [appState, records, totalPassCount, purchasePass, consumePass, saveAppState, showToast, t]);

  // ── Record today ────────────────────────────────────────────────────────────
  // ・1日1本目：ストリーク更新 + レコード作成 + 通知キャンセル
  // ・2本目以降（最大MAX_SLOTS）：既存エントリの uris に追記のみ（ストリーク変更なし）

  const recordToday = useCallback((uri: string) => {
    const today = getAppDate();

    // ── 既に今日記録済みかチェック（最新の records を直接参照） ──
    // useCallback の deps に records を含めることで最新値を保持
    const todayRec = records.find(r => r.date === today && !r.isPass);

    // Build 7: ストレージ用 URI は raw（相対パスのまま）を使う。
    // getRecordUris は表示・シェア用の絶対 URI を返すため、
    // ストレージへの書き込みには使用しない。
    const todayStorageUris: string[] = todayRec?.uris ?? (todayRec?.uri ? [todayRec.uri] : []);

    if (todayStorageUris.length >= MAX_SLOTS) {
      // 5本上限に達している場合は何もしない
      showToast(lang === 'ja' ? '今日の記録は最大5件です' : 'Max 5 recordings per day', true);
      return;
    }

    if (todayRec) {
      // ── 2本目以降：既存エントリに URI を追加（ストリーク変更なし）──
      // Build 7: uri は toRelativeUri 済みの相対パスで渡ってくる
      const updatedUris = [...todayStorageUris, uri];
      setRecords(prev =>
        prev.map(r =>
          r.date === today && !r.isPass
            ? { ...r, uris: updatedUris, uri: updatedUris[0] }
            : r
        )
      );
      showToast(t('toast_save_complete', { day: appState.streak }));
      return;
    }

    // ── 1本目：ストリーク計算・更新 ──
    // records 配列を唯一の正解源として calculateStreak で算出する。
    // appState.streak / lastRecordDate には依存しないため、
    // 削除後に appState が不整合な状態でも正しい値が得られる。
    const recordsWithToday = [...records.filter(r => r.date !== today),
      { date: today, ts: Date.now(), day: 0 } as RecordEntry];
    const newStreak = calculateStreak(recordsWithToday, today);

    const newEntry: RecordEntry = { date: today, day: newStreak, ts: Date.now(), uris: [uri], uri };
    setRecords(prev => [newEntry, ...prev.filter(r => r.date !== today)]);

    // Trigger store review when streak first reaches 5
    const shouldReview = newStreak === 5 && !appState.reviewRequested;
    if (shouldReview) setReviewReady(true);
    // Trigger 10-day milestone popup (once only)
    if (newStreak === 10 && !appState.milestone10Shown) {
      setTimeout(() => setMilestone10Visible(true), 800);
    }
    // 30-day celebration push notification
    if (newStreak === 30) {
      Notifications.scheduleNotificationAsync({
        content: {
          title: lang === 'ja' ? '🎉 30日連続達成！' : '🎉 30-Day Streak!',
          body: lang === 'ja'
            ? `「${appState.goal || 'One Shot'}」30日間、記録は嘘をつきません。本物の習慣が始まりました。`
            : `"${appState.goal || 'One Shot'}" — 30 days. The record never lies. This is real.`,
          sound: true,
        },
        trigger: null, // fire immediately
      }).catch(() => {});
    }

    const next: AppState = {
      ...appState,
      streak: newStreak,
      lastRecordDate: today,
      reviewRequested: shouldReview ? true : appState.reviewRequested,
      milestone10Shown: newStreak >= 10 ? true : appState.milestone10Shown,
    };
    setAppState(next);
    saveAppState(next);
    showToast(t('toast_save_complete', { day: newStreak }));

    // ── 通知キャンセル: 1本目を記録したら当日の未発火通知を無効化 ──
    // 次回アプリ起動時（Init effect）で再スケジュールされる
    Notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
  }, [appState, records, lang, saveAppState, showToast, t]);

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
  // Build 10: 各初期化ステップを個別の try...catch で保護。
  // どのステップが失敗しても setIsLoading(false) が必ず実行され、
  // ホーム画面（またはオンボーディング）が表示される。

  useEffect(() => {
    (async () => {
      // ステップ間で共有する変数をここで宣言する。
      // 各ステップが失敗しても後続ステップがデフォルト値で動作できるようにする。
      let loaded: AppState = { ...defaultState };
      let loadedRecords: RecordEntry[] = [];
      let savedLang: string | null = null;
      let initToday = '';

      try {
        // ── ステップ 0: 現在日付の取得 ──────────────────────────────────────
        // getAppDate() が失敗した場合は ISO 日付文字列でフォールバック
        try {
          initToday = getAppDate();
        } catch (e) {
          console.error('[Init] getAppDate() failed, using ISO fallback:', e);
          initToday = new Date().toISOString().slice(0, 10);
        }

        // ── ステップ 1: 言語設定のロード ────────────────────────────────────
        try {
          const rawLang = await AsyncStorage.getItem(LANG_KEY);
          if (rawLang === 'en' || rawLang === 'ja') {
            savedLang = rawLang;
            setLang(rawLang);
          } else {
            // ローカルになければ iCloud から復元
            const iCloudLang = ICloudKV.getItem(LANG_KEY);
            if (iCloudLang === 'en' || iCloudLang === 'ja') {
              savedLang = iCloudLang;
              setLang(iCloudLang as Lang);
            }
          }
        } catch (e) {
          console.error('[Init] Failed to load language setting:', e);
          // savedLang は null のまま → 通知などは 'ja' フォールバックを使用
        }

        // ── ステップ 2: AppState のロード（v3 → v2 フォールバック）───────────
        // v3 キーが存在しない場合は v2 レガシーキーから移行する。
        // AppState 自体にファイル URI は含まれないため、構造コピーのみで完了する。
        try {
          const rawV3 = await AsyncStorage.getItem(STORAGE_KEY);
          if (rawV3) {
            // v3 データが存在 → schema_version フィールドを除いて AppState にマージ
            const { schema_version: _sv, ...parsed } = JSON.parse(rawV3);
            loaded = { ...defaultState, ...parsed };
          } else {
            // v3 なし → v2 レガシーから移行
            const rawV2 = await AsyncStorage.getItem(LEGACY_STORAGE_KEY);
            if (rawV2) {
              const parsed = JSON.parse(rawV2);
              loaded = { ...defaultState, ...parsed };
              console.log('[Build7] State migrated from v2 to v3');
            } else {
              // ローカルデータなし → iCloud から復元（機種変更対応）
              const iCloudRaw = ICloudKV.getItem(STORAGE_KEY);
              if (iCloudRaw) {
                const { schema_version: _sv, ...parsed } = JSON.parse(iCloudRaw);
                loaded = { ...defaultState, ...parsed };
                console.log('[iCloud] AppState restored from iCloud KV Store');
              }
            }
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
        } catch (e) {
          console.error('[Init] Failed to load AppState, using default state:', e);
          loaded = { ...defaultState };
          loaded.rcUserID = 'user_' + Math.random().toString(36).substr(2, 12) + '_' + Date.now();
          const year = new Date().getFullYear();
          const num = Math.floor(Math.random() * 999) + 1;
          loaded.userId = `OS-${year}-${String(num).padStart(3, '0')}`;
        }

        // ── ステップ 3: Records のロード（v3 → v2 フォールバック + URI 移行）──
        //
        // 【マイグレーション戦略】
        //   v2: [ RecordEntry, ... ]         （生配列、絶対 URI 混在）
        //   v3: { schema_version: 7, records: RecordEntry[] }
        //              （ラップ形式、documentDirectory URI は相対パス）
        //
        //   v2 → v3 移行時に各 URI に toRelativeUri を適用する。
        //   ・現行 documentDirectory 内のファイル → 相対パスに変換（永続化）
        //   ・Photos ライブラリ URI              → そのまま（変換不要）
        //   ・旧 UUID の壊れた絶対パス           → 変換は不完全だが
        //     エントリ（日付・ストリーク情報）は必ず保持する
        try {
          const recRawV3 = await AsyncStorage.getItem(RECORDS_KEY);
          if (recRawV3) {
            // v3 形式から直接ロード
            const stored = JSON.parse(recRawV3) as { schema_version: number; records: RecordEntry[] };
            loadedRecords = Array.isArray(stored.records) ? stored.records : [];
          } else {
            // v3 なし → v2 レガシーから移行
            const recRawV2 = await AsyncStorage.getItem(LEGACY_RECORDS_KEY);
            if (recRawV2) {
              const legacyParsed: RecordEntry[] = JSON.parse(recRawV2);
              console.log(`[Build7] Records migrating ${legacyParsed.length} entries from v2 to v3`);

              // Step 1: uri → uris 統一（v1→v2 の残留対応）
              const step1 = legacyParsed.map(r => {
                if (r.uri && (!r.uris || r.uris.length === 0)) {
                  return { ...r, uris: [r.uri] };
                }
                return r;
              });

              // Step 2: 絶対 URI を相対パスに変換（Build 7 の核心）
              loadedRecords = step1.map(r => {
                if (!r.uris || r.uris.length === 0) return r;
                const relUris = r.uris.map(toRelativeUri);
                return { ...r, uris: relUris, uri: relUris[0] };
              });

              // v3 形式で永続化
              const migratedJson = JSON.stringify({ schema_version: SCHEMA_VERSION, records: loadedRecords });
              AsyncStorage.setItem(RECORDS_KEY, migratedJson).catch(() => {});
              ICloudKV.setItem(RECORDS_KEY, migratedJson);
              ICloudKV.synchronize();
              console.log('[Build7] Records migration to v3 complete');
            } else {
              // ローカルデータなし → iCloud から復元（機種変更対応）
              const iCloudRaw = ICloudKV.getItem(RECORDS_KEY);
              if (iCloudRaw) {
                const stored = JSON.parse(iCloudRaw) as { schema_version: number; records: RecordEntry[] };
                loadedRecords = Array.isArray(stored.records) ? stored.records : [];
                console.log('[iCloud] Records restored from iCloud KV Store');
              }
            }
            // recRawV2 もなければ iCloud もなければ loadedRecords は [] のまま（新規インストール）
          }
        } catch (e) {
          console.error('[Init] Failed to load records, using empty array:', e);
          loadedRecords = []; // データ消失を防ぐため空配列で継続
        }

        // records ステートを確定（空配列でも正常）
        setRecords(loadedRecords);

        // ── ステップ 5: streak 再計算と AppState の確定・永続化 ─────────────
        // 保存された appState.streak は過去の不整合で壊れている可能性があるため、
        // 起動のたびに records から正しい値を導出して上書きする。
        try {
          loaded.streak = calculateStreak(loadedRecords, initToday);
          loaded.lastRecordDate = getLastRecordDate(loadedRecords, initToday);
          setAppState(loaded);
          await saveAppState(loaded);
        } catch (e) {
          console.error('[Init] Failed to calculate streak or persist AppState:', e);
          // streak 計算失敗時でも loaded の現在値で setAppState する
          setAppState(loaded);
        }

        // ── ステップ 6: RevenueCat の初期化 ─────────────────────────────────
        try {
          Purchases.configure({ apiKey: RC_API_KEY, appUserID: loaded.rcUserID });
          const offerings = await Purchases.getOfferings();
          // ── [DEBUG] RC offerings の生データを確認 ──────────────────────────
          console.log('[RC Debug] getOfferings() raw result:', JSON.stringify({
            currentOfferingId: offerings.current?.identifier,
            packages: offerings.current?.availablePackages.map(p => ({
              rcIdentifier: p.identifier,
              productId:    p.product.identifier,
              price:        p.product.price,
              priceString:  p.product.priceString,
              currency:     p.product.currencyCode,
              title:        p.product.title,
            })) ?? [],
          }, null, 2));
          // ──────────────────────────────────────────────────────────────────
          setRcOfferings(offerings);
          const active = await syncRCEntitlements();
          if (active !== loaded.subscribed) {
            const next = { ...loaded, subscribed: active };
            setAppState(next);
            await saveAppState(next);
            loaded = next;
          }
        } catch (e) {
          console.error('[RC] init error:', e);
          // RC 失敗 → subscribed は false のまま → paywall を表示（安全側）
        }

        // ── ステップ 7: 通知権限の取得とスケジューリング ─────────────────────
        try {
          const { status } = await Notifications.requestPermissionsAsync();
          if (status === 'granted') {
            const notifyLang = (savedLang ?? 'ja') as Lang;
            const { title: notifyTitle, body: notifyBody } = pickNotifyMessage(notifyLang, loaded.goal);
            const alreadyRecordedToday = loadedRecords.some(r => r.date === initToday && !r.isPass);
            await scheduleDailyNotification(loaded.notifyTime, notifyTitle, notifyBody, alreadyRecordedToday);
          }
        } catch (e) {
          console.error('[Notify] init error:', e);
          // 通知の失敗はアプリ起動を妨げない
        }

        // ── ステップ 8: 画面遷移 ─────────────────────────────────────────────
        try {
          if (!loaded.onboarded) {
            setScreen('onboarding');
          } else if (!loaded.subscribed) {
            setScreen('paywall');
          } else {
            setScreen('home');
            if (!loaded.guideShown) setGuideVisible(true);
          }
        } catch (e) {
          console.error('[Init] Navigation failed, defaulting to onboarding:', e);
          setScreen('onboarding');
        }

      } catch (unexpectedErr) {
        // 上記の個別 try...catch を突き破った予期しないエラーの最終安全網
        console.error('[Init] Unexpected top-level error during initialization:', unexpectedErr);
        setScreen('onboarding');
      } finally {
        // Build 22: iOS 18 対策 — スプラッシュ画面を 1 秒維持し、
        // OS 側のネイティブ初期化（AVFoundation・StoreKit 等）が完了するまで待つ。
        await new Promise<void>(r => setTimeout(r, 1000));
        // どのステップが失敗しても必ず isLoading を解除してホーム/オンボーディングを表示
        setIsLoading(false);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Save records (Build 7: v3 形式で永続化) ─────────────────────────────────
  // { schema_version: 7, records: [...] } 形式で RECORDS_KEY に保存する。
  // 個々のエントリの uris は toRelativeUri 適用済みの相対パスが入っている。

  useEffect(() => {
    if (!isLoading) {
      const json = JSON.stringify({ schema_version: SCHEMA_VERSION, records });
      AsyncStorage.setItem(RECORDS_KEY, json).catch(() => {});
      ICloudKV.setItem(RECORDS_KEY, json);
      ICloudKV.synchronize();
    }
  }, [records, isLoading]);

  // ── Refresh RC offerings when paywall is shown ─────────────────────────────
  // RevenueCat SDK は内部的に offerings をキャッシュするため、
  // App Store Connect で価格を更新した直後はキャッシュが古い値を返すことがある。
  // Paywall 表示のたびに再取得することで常に最新価格を反映させる。
  useEffect(() => {
    if (screen === 'paywall') {
      Purchases.getOfferings()
        .then(fresh => {
          console.log('[RC Debug] Paywall refresh - annual priceString:',
            fresh.current?.availablePackages
              .find(p => p.product.identifier === 'com.jin.oneshot.annual.premium')
              ?.product.priceString ?? 'NOT FOUND');
          console.log('[RC Debug] Paywall refresh - monthly priceString:',
            fresh.current?.availablePackages
              .find(p => p.product.identifier === 'com.jin.oneshot.premium')
              ?.product.priceString ?? 'NOT FOUND');
          setRcOfferings(fresh);
        })
        .catch(e => console.warn('[RC Debug] Paywall offerings refresh error:', e));
    }
  }, [screen]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── selectedRecord / selectedSlotIdx が変わったら画像エラー状態をリセット ──
  // 旧データの tmpfile URI が失効して onError が発火した後、別のスロットを開く際に
  // エラー状態が残らないよう、選択変更のたびにリセットする。
  useEffect(() => {
    setPlayingUriError(false);
  }, [selectedRecord, selectedSlotIdx]);

  // ── Refresh home (streak/pass) ──────────────────────────────────────────────
  // ホーム画面表示のたびに records から streak を再計算し、appState と同期させる。
  // これにより、バックグラウンド復帰時や日付またぎでも正しい値が表示される。

  useEffect(() => {
    if (screen === 'home') {
      setAppState(prev => {
        const afterStreak = updateStreak(prev, records);  // records → streak 再計算
        const afterPass = checkPassGrant(afterStreak);    // 月曜フリーパス付与
        if (afterPass !== prev) saveAppState(afterPass);
        return afterPass;
      });
    }
  }, [screen]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Guideline 5.1.1(iv): カメラ画面に遷移したとき、権限が未決定なら即座に標準ダイアログを表示 ──
  // Apple は「カスタム UI を挟まず、最初は必ず OS 標準ダイアログを出すこと」を要求している。
  // canAskAgain が true（初回 or undetermined）のとき自動リクエストすることで
  // カスタム UI が表示される前にシステムダイアログが起動する。
  useEffect(() => {
    if (screen === 'camera' && camPermission && !camPermission.granted && camPermission.canAskAgain !== false) {
      requestCamPermission();
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

    // ── フィルター用 currentDay を計算（ホーム画面ストリークと同ロジック）──
    // 同日2本目以降は todayRec.day を流用しカウントアップを防ぐ。
    // 1本目は records から calculateStreak で正しい値を導出する。
    const filterToday = getAppDate();
    const filterTodayRec = records.find(r => r.date === filterToday && !r.isPass);
    const filterCurrentDay = filterTodayRec
      ? filterTodayRec.day  // 2本目以降: 1本目と同じ day 番号を再利用
      : (() => {             // 1本目: 今日分を仮追加してストリークを計算
          const withToday = [
            ...records.filter(r => r.date !== filterToday),
            { date: filterToday, ts: Date.now(), day: 0 } as RecordEntry,
          ];
          return calculateStreak(withToday, filterToday);
        })();

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
            currentDay: filterCurrentDay,
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

    // ── 動画モード（recSecs 秒録画 → ネイティブでオーバーレイ焼き込み）──
    setIsRecording(true);
    const RECORD_SECS = recSecsRef.current; // always reflects latest toggle value

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
      // Build 22: 起動時ではなく処理直前に遅延ロード（iOS 18 ネイティブ初期化衝突対策）
      if (!processVideo) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        processVideo = (require('../modules/video-overlay') as { processVideo: (opts: any) => Promise<string> }).processVideo;
      }
      // filterCurrentDay は上で計算済み（同日2本目以降はカウントアップしない）
      const processed = await processVideo({
        inputPath: rawUri,
        habitName: (appState.goal || 'HABIT').toUpperCase(),
        currentDay: filterCurrentDay,
        captureTimestamp: captureTime.getTime(),
        colorFilterEnabled: appState.colorFilterEnabled,
      });
      setCapturedUri(processed);  // transition to preview with processed video
    } catch (vErr) {
      console.warn('[processVideo] fallback to raw video:', vErr);
      setCapturedUri(rawUri);     // fallback: show raw video on error
    } finally {
      setIsProcessingVideo(false);
    }
  }, [camPermission, requestCamPermission, isRecording, countdown, camMode,
      appState.showRecordingCountdown, appState.goal, appState.phase,
      records, clearCamTimers, showToast, t]);

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

      // ── 永続 URI の取得 ──────────────────────────────────────────────────────
      // 【修正理由】旧実装は saveToLibraryAsync(capturedUri) の後に capturedUri（tmpfile）
      // をそのままレコードへ保存していた。写真の capturedUri は captureRef が生成する
      // NSTemporaryDirectory 内の一時ファイルであり、iOS がアプリ非アクティブ時・
      // ストレージ圧迫時に積極的に削除する。その結果、翌日以降に履歴を開くと
      // <Image> が真っ黒になり、シェア/保存操作でエラーが発生していた。
      //
      // 動画の tmpfile は揮発性で消えるため、写真と同様に Photos ライブラリから永続 URI を取得する。
      //
      // 【修正】createAssetAsync でカメラロールへ保存し、getAssetInfoAsync で
      // Photos ライブラリ内の永続的な localUri（file:// パス）を取得してレコードへ
      // 保存する。localUri はユーザーが写真を削除しない限り消えない。
      const asset = await MediaLibrary.createAssetAsync(capturedUri);
      const assetInfo = await MediaLibrary.getAssetInfoAsync(asset);

      // ── Build 29: 永続 URI の決定と相対パス変換 ──────────────────────────────
      // 動画の場合: Photos ライブラリの localUri（/var/mobile/Media/...）は
      // expo-av の AVPlayer から直接アクセスできず黒画面になるため、
      // documentDirectory へコピーして相対パスを保存する。
      // これにより expo-av が常にファイルを読み込める状態を保証する。
      //
      // 写真の場合: Photos ライブラリの localUri を従来通り使用（Image コンポーネントは
      // Photos ライブラリのパスを問題なく読み込める）。
      let rawPersistentUri: string;
      if (capturedType === 'video') {
        // Build 29: ビデオは documentDirectory にコピーして保存
        const destFilename = 'oneshot_v_' + Date.now() + '.mp4';
        const destUri = (FileSystem.documentDirectory ?? '') + destFilename;
        await FileSystem.copyAsync({ from: capturedUri, to: destUri });
        rawPersistentUri = destUri;
      } else {
        // 写真: Photos ライブラリの安定 file:// パスを使用（Build 9 従来ロジック）
        rawPersistentUri = assetInfo.localUri || capturedUri;
      }
      const persistentUri = toRelativeUri(rawPersistentUri);

      recordToday(persistentUri);
      Notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
      setCapturedUri(null);
      setCapturedTime(null);
      setScreen('home');
    } catch (e) {
      console.error('[saveCapture] error:', e);
      showToast(t('toast_save_error'), true);
    }
  }, [capturedUri, capturedType, mediaPermission, requestMediaPermission, recordToday, showToast, t]);

  // ── 履歴レコード削除 ────────────────────────────────────────────────────────
  // ・当日分のみ削除可（過去のデータはガードで保護）
  // ・slotIdx を指定すると、その動画スロットのみ削除（残スロットがある場合はエントリ保持）
  // ・最後の1本を削除した場合は、直前の記録日時・ストリーク値に確実に復元する
  const deleteRecord = useCallback((record: RecordEntry, slotIdx?: number) => {
    const today = getAppDate();
    // ── ガード: 当日以外の削除は完全に無効 ──
    if (record.date !== today) return;

    Alert.alert('', t('confirm_delete_record'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('history_delete'),
        style: 'destructive',
        onPress: () => {
          const existingUris = getRecordUris(record);

          if (slotIdx !== undefined && existingUris.length > 1) {
            // ── 特定スロットのみ削除（残スロットあり → エントリ保持）──
            // Build 7: getRecordUris は絶対URIを返すので、保存前に相対化する
            const newUris = existingUris.filter((_, i) => i !== slotIdx).map(toRelativeUri);
            setRecords(prev => {
              const next = prev.map(r =>
                r.date === today && !r.isPass
                  ? { ...r, uris: newUris, uri: newUris[0] }
                  : r
              );
              AsyncStorage.setItem(
                RECORDS_KEY,
                JSON.stringify({ schema_version: SCHEMA_VERSION, records: next })
              ).catch(() => {});
              return next;
            });
          } else {
            // ── エントリ全削除 → calculateStreak で streak を動的に再計算 ──
            // latestBefore.day（保存済みの古い値）には依存しない。
            // records 配列が唯一の正解源なので、削除後の配列から計算すれば
            // 「撮影→削除→再撮影」を何度繰り返しても正しい値が必ず得られる。
            const recordsAfterDelete = records.filter(r => r.date !== record.date);
            setRecords(recordsAfterDelete);
            AsyncStorage.setItem(
              RECORDS_KEY,
              JSON.stringify({ schema_version: SCHEMA_VERSION, records: recordsAfterDelete })
            ).catch(() => {});

            const todayForCalc = getAppDate();
            const restoredStreak = calculateStreak(recordsAfterDelete, todayForCalc);
            const restoredDate = getLastRecordDate(recordsAfterDelete, todayForCalc);

            setAppState(prev => {
              const next = { ...prev, streak: restoredStreak, lastRecordDate: restoredDate };
              saveAppState(next);
              return next;
            });
          }

          setSelectedRecord(null);
          setSelectedDate(null);
          showToast(t('toast_deleted'));
        },
      },
    ]);
  }, [records, t, saveAppState, showToast]);

  // ── 履歴レコード再保存（カメラロールへ）──
  const resaveRecord = useCallback(async (uri: string) => {
    if (!uri) { showToast(t('toast_no_data'), true); return; }
    try {
      if (!mediaPermission?.granted) await requestMediaPermission();
      await MediaLibrary.saveToLibraryAsync(uri);
      showToast(t('toast_resave_done'));
    } catch (e) {
      console.error('[resaveRecord] error:', e);
      showToast(t('toast_save_error'), true);
    }
  }, [mediaPermission, requestMediaPermission, showToast, t]);

  // ── 履歴レコードSNSシェア ──
  const shareRecord = useCallback(async (uri: string) => {
    if (!uri) { showToast(t('toast_no_data'), true); return; }
    try {
      // heic/heif も画像として扱う（getAssetInfoAsync 経由の localUri は .HEIC になることがある）
      const isPhoto = /\.(jpg|jpeg|png|heic|heif)$/i.test(uri);
      await Sharing.shareAsync(uri, {
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
    ICloudKV.setItem(LANG_KEY, l);
    ICloudKV.synchronize();
  }, []);

  // ── Reset all ───────────────────────────────────────────────────────────────

  const resetAll = useCallback(() => {
    Alert.alert('', t('confirm_reset'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: 'OK',
        style: 'destructive',
        onPress: async () => {
          // Build 7: v2 レガシーキーも含めてすべてクリア
          await AsyncStorage.multiRemove([
            STORAGE_KEY, RECORDS_KEY, LANG_KEY,
            LEGACY_STORAGE_KEY, LEGACY_RECORDS_KEY,
          ]);
          ICloudKV.removeItem(STORAGE_KEY);
          ICloudKV.removeItem(RECORDS_KEY);
          ICloudKV.removeItem(LANG_KEY);
          ICloudKV.synchronize();
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

  // レンダリングフェーズでの例外を防ぐため try-catch でガードする
  let today = '';
  try { today = getAppDate(); } catch { today = new Date().toISOString().slice(0, 10); }
  const safeRecords = Array.isArray(records) ? records : [];
  const recordedToday = appState.lastRecordDate === today; // 今日1本以上記録済み
  // 今日のスロット数（0〜MAX_SLOTS）
  const todayRecord = safeRecords.find(r => r.date === today && !r.isPass);
  const todaySlotCount = todayRecord ? getRecordUris(todayRecord).length : 0;
  const recordingFull = recordedToday && todaySlotCount >= MAX_SLOTS; // 5本上限に達している

  // ─── Onboarding Screen ───────────────────────────────────────────────────────

  const OnboardingScreen = () => {
    const [goal, setGoal] = useState('');
    return (
      <View style={styles.screenCenter}>
        <Text style={styles.appTitle}>ONE SHOT</Text>
        <Text style={styles.subtitle}>{t('onboarding_subtitle')}</Text>
        <Text style={styles.onboardingRule}>{t('onboarding_rule')}</Text>
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
    const annualFallback  = lang === 'ja' ? '¥5,000' : '$39.99';
    const annualPrice = annualPkg?.product.priceString ?? annualFallback;
    const monthlyPrice = monthlyPkg?.product.priceString ?? null;

    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.paywallContent}>
        <Text style={styles.appTitle}>ONE SHOT</Text>

        {/* ── 7日間無料トライアルバッジ ── */}
        <Text style={styles.trialBadgeText}>
          {lang === 'ja' ? '🎁 7日間 無料体験' : '🎁 7-Day Free Trial'}
        </Text>

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
          <Text style={styles.planCardSubtext}>
            {lang === 'ja' ? '最初の7日間は無料' : 'First 7 days free'}
          </Text>
          <Text style={styles.planCardPeriod}>
            {lang === 'ja' ? '/ 年（1日あたり約8円）' : '/ YEAR  ·  BILLED ANNUALLY'}
          </Text>
          <Text style={styles.planCardCta}>
            {lang === 'ja' ? '無料で始める →' : 'Start Free Trial →'}
          </Text>
        </TouchableOpacity>

        {/* ── 月額プランカード（サブ） ── */}
        {monthlyPkg && (
          <TouchableOpacity
            style={styles.planCardSecondary}
            onPress={() => subscribePremium(monthlyPkg)}
          >
            <Text style={styles.planCardSecondaryPrice}>{monthlyPrice ?? '—'}</Text>
            <Text style={styles.planCardSubtext}>
              {lang === 'ja' ? '最初の7日間は無料' : 'First 7 days free'}
            </Text>
            <Text style={styles.planCardSecondaryPeriod}>
              {lang === 'ja' ? '/ 月' : '/ MONTH  ·  BILLED MONTHLY'}
            </Text>
          </TouchableOpacity>
        )}

        {/* ── サブスクリプション開示（Apple 3.1.2(c) 必須） ── */}
        <Text style={styles.subscriptionInfoDetail}>
          {lang === 'ja'
            ? `年額 ${annualPrice ?? '—'}（自動更新）${monthlyPkg ? `　月額 ${monthlyPrice ?? '—'}（自動更新）` : ''}　Apple IDで課金・管理`
            : `Annual ${annualPrice ?? '—'} · auto-renews${monthlyPkg ? `   Monthly ${monthlyPrice ?? '—'} · auto-renews` : ''}   Managed via Apple ID`}
        </Text>

        {/* ── 無料トライアル注意書き ── */}
        <Text style={styles.trialNote}>
          {lang === 'ja'
            ? '7日間の無料体験終了後、自動的に課金が開始されます。\n無料期間終了の24時間前までにキャンセルしない限り、\nサブスクリプションは自動更新されます。\n解約はiPhone設定 → Apple ID → サブスクリプションから\nいつでも可能です。'
            : 'After the 7-day free trial, you will be charged\n¥500/month or ¥5,000/year automatically.\nCancel anytime in Settings before the trial ends\nto avoid being charged.\nNo refunds for partial subscription periods.'}
        </Text>

        {/* ── 利用規約・プライバシー（購入ボタン直下・Apple 3.1.2(c) 必須） ── */}
        <View style={styles.paywallLinks}>
          <TouchableOpacity onPress={() => Linking.openURL('https://ivory-green-d0a.notion.site/One-shot-Term-of-Service-3285c8dc66068011bacad02879f4ddc2?pvs=73')}>
            <Text style={[styles.linkSmall, styles.linkSmallTappable]}>{t('paywall_terms')}</Text>
          </TouchableOpacity>
          <Text style={styles.linkSmall}>  ·  </Text>
          <TouchableOpacity onPress={() => Linking.openURL('https://ivory-green-d0a.notion.site/One-shot-Privacy-policy-3285c8dc660680d7ac1fe514d6690703')}>
            <Text style={[styles.linkSmall, styles.linkSmallTappable]}>{t('paywall_privacy')}</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.subscriptionNote}>{t('paywall_iap_note')}</Text>

        <Text style={styles.paywallPassNote}>{t('paywall_pass_note')}</Text>

        <TouchableOpacity onPress={restorePurchase}>
          <Text style={styles.linkText}>{t('paywall_restore_btn')}</Text>
        </TouchableOpacity>
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
        <MaskedView maskElement={<Text style={styles.streakNum}>{appState.streak ?? 0}</Text>}>
          <LinearGradient
            colors={['#ffffff', '#ffffff', '#555555']}
            locations={[0, 0.3, 1.0]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
          >
            {/* opacity:0 でグラデーションのサイズをテキストに合わせる */}
            <Text style={[styles.streakNum, { opacity: 0 }]}>{appState.streak ?? 0}</Text>
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
              {recordedToday ? (todaySlotCount > 1 ? `${todaySlotCount}` : '✓') : '−'}
            </Text>
            <Text style={styles.statusLabel}>{t('today_label')}</Text>
          </View>
          <View style={styles.statusPill}>
            <Text style={styles.statusVal}>{totalPassCount()}</Text>
            <Text style={styles.statusLabel}>{t('pass_remain_label')}</Text>
          </View>
        </View>
      </View>

      {/* ── カメラボタン（ガラスプラットフォーム上に浮かぶ赤い丸） ── */}
      <View style={styles.recBtnWrapper}>
        <TouchableOpacity
          style={[styles.recBtn, recordingFull && styles.recBtnDone]}
          onPress={() => {
            if (recordingFull) {
              Alert.alert('', t('alert_already_recorded') ?? 'Already recorded today.');
              return;
            }
            setScreen('camera');
          }}
        >
          <Ionicons name="camera-outline" size={32} color={recordingFull ? '#555' : '#fff'} />
        </TouchableOpacity>
      </View>

      {/* ── 記録済みラベル（今日の記録件数を表示） ── */}
      {recordedToday && (
        <Text style={styles.recDoneLabel}>
          ✓ {t('recorded_today')}{todaySlotCount > 1 ? `  ${todaySlotCount}/${MAX_SLOTS}` : ''}
        </Text>
      )}

      {/* ── パスを使うボタン（ガラスパネル） ── */}
      <TouchableOpacity style={styles.passBtn} onPress={usePassToday}>
        <Ionicons name="ticket-outline" size={14} color="#fff" />
        <Text style={styles.passBtnText}>
          {t('use_pass_btn_prefix')}{totalPassCount()}{t('use_pass_btn_suffix')}
        </Text>
      </TouchableOpacity>

      {/* ── パス購入ボタン（パスが0枚の時のみ表示） ── */}
      {totalPassCount() === 0 && (
        <TouchableOpacity style={styles.passBuyBtn} onPress={purchasePass}>
          <Ionicons name="card-outline" size={14} color="#fff" />
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
      // Guideline 5.1.1(iv): canAskAgain=true のとき（初回/undetermined）は
      // useEffect が自動で requestCamPermission() を呼ぶためここではローディングのみ表示。
      // OS 標準ダイアログが必ず先に出るようにし、カスタム UI は一切表示しない。
      if (camPermission.canAskAgain !== false) {
        return <ActivityIndicator color="#fff" style={styles.screenCenter} />;
      }
      // canAskAgain=false（ユーザーが明示的に拒否済み）の場合のみ設定誘導を表示
      return (
        <View style={styles.screenCenter}>
          <Feather name="camera-off" size={44} color="#555" style={{ marginBottom: 24 }} />
          <Text style={styles.permTitle}>{t('cam_permission_title')}</Text>
          <Text style={styles.permBody}>{t('cam_permission_denied_body')}</Text>
          <TouchableOpacity
            style={styles.btnPrimary}
            onPress={() => Linking.openSettings()}
          >
            <Text style={styles.btnPrimaryText}>{t('cam_permission_settings_btn')}</Text>
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

          {/* ── 当日のみ保存ヒント ── */}
          <Text style={styles.previewExpiryHint}>{t('preview_expiry_hint')}</Text>

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
          <TouchableOpacity style={styles.camTopBtnFlat} onPress={() => setScreen('home')}>
            <Ionicons name="close" size={28} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.camTopBtnFlat}
            onPress={() => setFacing(f => f === 'front' ? 'back' : 'front')}
          >
            <Ionicons name="camera-reverse-outline" size={26} color="#fff" />
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
              <Ionicons name="timer-outline" size={22} color={appState.showRecordingCountdown ? '#fff' : 'rgba(255,255,255,0.35)'} />
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

            {/* 右: 録画秒数トグル（3s → 5s → 7s → 3s）*/}
            <TouchableOpacity
              style={styles.camTimerBtn}
              onPress={() => {
                const next: 5 | 10 = recSecs === 5 ? 10 : 5;
                recSecsRef.current = next;
                setRecSecs(next);
              }}
              disabled={isRecording}
            >
              <Text style={[styles.camDurLabel, isRecording && { opacity: 0.25 }]}>
                {recSecs}s
              </Text>
            </TouchableOpacity>
          </View>

        </View>
      </View>
    );
  };

  // ─── History Screen ───────────────────────────────────────────────────────────

  const HistoryScreen = () => {
    const firstDay = new Date(calYear, calMonth, 1).getDay();
    const lastDate = new Date(calYear, calMonth + 1, 0).getDate();
    const recordMap = new Map((Array.isArray(records) ? records : []).map(r => [r.date, r]));
    let todayStr = '';
    try { todayStr = getAppDate(); } catch { todayStr = new Date().toISOString().slice(0, 10); }
    const dayLabels = lang === 'en'
      ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      : ['日', '月', '火', '水', '木', '金', '土'];

    // デイリー詳細シートで表示するレコード
    const selectedDateRecord = selectedDate ? recordMap.get(selectedDate) : null;
    const selectedDateUris = selectedDateRecord ? getRecordUris(selectedDateRecord) : [];

    // 再生モーダルで表示する URI（スロット指定）
    const playingUri = selectedRecord && selectedSlotIdx !== null
      ? getRecordUris(selectedRecord)[selectedSlotIdx] ?? null
      : selectedRecord ? getRecordUris(selectedRecord)[0] ?? null : null;

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
            // 今日以外はタップ不可・グレーアウト（クラッシュ回避 + One Shot コンセプト）
            const isTappable = isToday && recorded && !isPass;
            // 複数スロットの場合は件数バッジを表示
            const slotCount = rec && !isPass ? getRecordUris(rec).length : 0;
            const cell = (
              <>
                <Text style={[styles.calDayNum, recorded && styles.calDayNumRecorded]}>
                  {day}
                </Text>
                {recorded && !isPass && (
                  <Svg width={42} height={42} style={styles.calCheck} viewBox="0 0 42 42">
                    <Polyline
                      points="8,21 17,30 34,12"
                      stroke="#FF3333"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      fill="none"
                    />
                  </Svg>
                )}
                {isPass && <Text style={styles.calPassMark}>○</Text>}
                {slotCount > 1 && (
                  <Text style={styles.calSlotBadge}>{slotCount}</Text>
                )}
              </>
            );
            const cellStyle = [
              styles.calCell, styles.calDayCell,
              recorded && (isPass ? styles.calDayCellPass : styles.calDayCellRecorded),
              isToday && styles.calDayCellToday,
              // 今日以外は少し薄くする（視認性確保）
              !isToday && { opacity: 0.78 },
            ];
            return isTappable ? (
              <TouchableOpacity
                key={ds}
                style={cellStyle}
                onPress={() => setSelectedDate(ds)}
                activeOpacity={0.7}
              >
                {cell}
              </TouchableOpacity>
            ) : (
              <View
                key={ds}
                style={cellStyle}
              >
                {cell}
              </View>
            );
          })}
        </View>

        {/* ── Growth Index Chart ── */}
        {appState.streak > 0 && (() => {
          const streak   = appState.streak;
          const chartW   = Dimensions.get('window').width - 32;
          const chartH   = 200;
          const gcVals   = Array.from({ length: streak }, (_, i) => 3 * Math.pow(1.01, i + 1));
          const curVal   = gcVals[gcVals.length - 1];

          // xMax: ~1x future buffer so future section equals past section
          const xMax = Math.max(streak * 2, 10);

          // Y-axis: scale to predicted value at xMax so current position stays near center
          const gcMinV  = 3.0;
          const gcMaxV  = Math.ceil(3 * Math.pow(1.01, xMax) / 0.5) * 0.5;
          const gcRange = Math.max(gcMaxV - gcMinV, 0.1);

          // Margins: extra left for Y-axis labels
          const mL = 40, mB = 22, mR = 12, mT = 10;
          const plotW = chartW - mL - mR;
          const plotH = chartH - mT - mB;

          const xToSvg = (day: number) => mL + (day / xMax) * plotW;
          const yToSvg = (v: number)   => mT + plotH - ((v - gcMinV) / gcRange) * plotH;

          // 全 streak 日分の座標（アニメーションのスライスに使う）
          const pts = gcVals.map((v, i) => ({ x: xToSvg(i + 1), y: yToSvg(v) }));

          // アニメーション進行に応じて描画する点数を絞り込む
          // graphAnimStep = 0 → 未描画, graphAnimStep = streak → 完了
          const clampedStep = Math.min(Math.max(graphAnimStep, 0), streak);
          const animPts    = pts.slice(0, clampedStep);
          const animLastPt = animPts.length > 0 ? animPts[animPts.length - 1] : null;

          // Dashed line: future prediction (current → xMax), sampled for perf
          const futureStep = Math.max(1, Math.floor((xMax - streak) / 80));
          const futurePts: {x: number; y: number}[] = [];
          for (let day = streak; day <= xMax; day += futureStep) {
            futurePts.push({ x: xToSvg(day), y: yToSvg(3 * Math.pow(1.01, day)) });
          }
          if (futurePts.length === 0 || futurePts[futurePts.length - 1].x < xToSvg(xMax) - 0.5) {
            futurePts.push({ x: xToSvg(xMax), y: yToSvg(3 * Math.pow(1.01, xMax)) });
          }

          // Y-axis labels (0.5-step increments)
          const yLabels: number[] = [];
          for (let yv = gcMinV; yv <= gcMaxV + 0.001; yv += 0.5) {
            yLabels.push(parseFloat(yv.toFixed(1)));
          }

          // X-axis labels: DAY 1, every 10 days (past only), current day (red)
          const xLabelDays: number[] = [1];
          for (let d = 10; d < streak; d += 10) {
            xLabelDays.push(d);
          }
          if (!xLabelDays.includes(streak)) xLabelDays.push(streak);

          return (
            <View style={{ paddingHorizontal: 16, marginTop: 24, marginBottom: 16 }}>
              <Text style={{ fontFamily: 'BebasNeue-Regular', color: '#555', fontSize: 11, letterSpacing: 2, marginBottom: 4 }}>
                GROWTH INDEX
              </Text>
              <Text style={{ fontFamily: 'BebasNeue-Regular', color: '#FF3333', fontSize: 40, lineHeight: 44, marginBottom: 10 }}>
                {curVal.toFixed(2)}
              </Text>
              <Svg width={chartW} height={chartH}>
                {/* Y-axis guide lines (dotted) and labels */}
                {yLabels.map(yv => {
                  const ly = yToSvg(yv);
                  return (
                    <React.Fragment key={`yg-${yv}`}>
                      <Line
                        x1={mL} y1={ly} x2={mL + plotW} y2={ly}
                        stroke="rgba(255,255,255,0.1)"
                        strokeWidth={0.5}
                        strokeDasharray="3,4"
                      />
                      <SvgText
                        x={mL - 4} y={ly + 3}
                        fontSize={7} fill="rgba(255,255,255,0.45)"
                        fontFamily="Courier" textAnchor="end"
                      >{yv.toFixed(1)}</SvgText>
                    </React.Fragment>
                  );
                })}
                {/* Y axis */}
                <Line x1={mL} y1={mT} x2={mL} y2={mT + plotH}
                  stroke="rgba(255,255,255,0.35)" strokeWidth={0.8} />
                {/* X axis */}
                <Line x1={mL} y1={mT + plotH} x2={mL + plotW} y2={mT + plotH}
                  stroke="rgba(255,255,255,0.35)" strokeWidth={0.8} />
                {/* X-axis labels */}
                {xLabelDays.map(d => {
                  const lx = xToSvg(d);
                  const isCurrentDay = d === streak;
                  return (
                    <React.Fragment key={`xl-${d}`}>
                      <Line x1={lx} y1={mT + plotH} x2={lx} y2={mT + plotH + 3}
                        stroke="rgba(255,255,255,0.4)" strokeWidth={0.5} />
                      <SvgText
                        x={lx} y={mT + plotH + 11}
                        fontSize={7}
                        fill={isCurrentDay ? 'rgba(255,51,51,0.8)' : 'rgba(255,255,255,0.4)'}
                        fontFamily="Courier" textAnchor="middle"
                      >{`DAY ${d}`}</SvgText>
                    </React.Fragment>
                  );
                })}
                {/* 白い実線: DAY 1 → アニメーション現在地（リアルタイムに伸びる） */}
                {animPts.length > 1 && (
                  <Polyline
                    points={animPts.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')}
                    fill="none"
                    stroke="rgba(255,255,255,0.9)"
                    strokeWidth={1.8}
                  />
                )}
                {/* 白い破線（将来予測）: 現在地到達の瞬間にパッと表示 */}
                {graphShowFuture && futurePts.length > 1 && (
                  <Polyline
                    points={futurePts.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')}
                    fill="none"
                    stroke="rgba(255,255,255,0.9)"
                    strokeWidth={1.8}
                    strokeDasharray="6,5"
                  />
                )}
                {/* 赤い点: アニメーション中は現在の描画先端を追う */}
                {animLastPt && (
                  <Circle cx={animLastPt.x} cy={animLastPt.y} r={4} fill="#FF3333" />
                )}
              </Svg>
            </View>
          );
        })()}

        {/* ── デイリー詳細シート（今日のみ表示・過去日は開かないガード）── */}
        <Modal
          visible={!!selectedDate && selectedDate === todayStr}
          animationType="slide"
          transparent={true}
          onRequestClose={() => setSelectedDate(null)}
        >
          <Pressable
            style={styles.dayDetailBackdrop}
            onPress={() => setSelectedDate(null)}
          >
            <View style={styles.dayDetailSheet} onStartShouldSetResponder={() => true}>
              {/* シートヘッダー */}
              <View style={styles.dayDetailHeader}>
                <Text style={styles.dayDetailTitle}>
                  {selectedDate ?? ''}
                </Text>
                {selectedDateRecord && !selectedDateRecord.isPass && (
                  <Text style={styles.dayDetailDayBadge}>
                    DAY {selectedDateRecord.day}
                  </Text>
                )}
                <TouchableOpacity onPress={() => setSelectedDate(null)} style={styles.dayDetailCloseBtn}>
                  <Feather name="x" size={20} color="#888" />
                </TouchableOpacity>
              </View>

              {/* 動画リスト */}
              {selectedDateRecord?.isPass ? (
                <View style={styles.dayDetailPassRow}>
                  <Text style={styles.dayDetailPassText}>
                    {lang === 'ja' ? 'パス使用日' : 'Rest pass used'}
                  </Text>
                </View>
              ) : selectedDateRecord && !selectedDateRecord.isPass && selectedDate !== todayStr ? (
                // 過去の記録 → ファイルパスへのアクセスを一切行わず、ロックを表示
                <View style={styles.dayDetailPassRow}>
                  <Feather name="lock" size={20} color="#555" style={{ marginBottom: 6 }} />
                  <Text style={styles.dayDetailPassText}>
                    {lang === 'ja' ? '過去の記録は閲覧できません' : 'Past records cannot be viewed'}
                  </Text>
                </View>
              ) : selectedDateRecord && !selectedDateRecord.isPass && selectedDate === todayStr && selectedDateUris.length > 0 ? (
                selectedDateUris.map((uri, idx) => (
                  <TouchableOpacity
                    key={idx}
                    style={styles.dayDetailItem}
                    onPress={() => {
                      setSelectedRecord(selectedDateRecord);
                      setSelectedSlotIdx(idx);
                      setSelectedDate(null);
                    }}
                    activeOpacity={0.7}
                  >
                    <View style={styles.dayDetailItemIcon}>
                      <Feather
                        name={/\.(jpg|jpeg|png)$/i.test(uri) ? 'image' : 'video'}
                        size={20}
                        color="#CC0000"
                      />
                    </View>
                    <Text style={styles.dayDetailItemLabel}>
                      {lang === 'ja' ? `動画 ${idx + 1}` : `Video ${idx + 1}`}
                    </Text>
                    <View style={styles.dayDetailItemActions}>
                      <TouchableOpacity
                        style={styles.dayDetailDeleteBtn}
                        onPress={() => {
                          if (selectedDateRecord) deleteRecord(selectedDateRecord, idx);
                        }}
                      >
                        <Feather name="trash-2" size={14} color="#CC0000" />
                        <Text style={styles.dayDetailDeleteText}>{t('history_delete')}</Text>
                      </TouchableOpacity>
                      <Feather name="chevron-right" size={16} color="#555" />
                    </View>
                  </TouchableOpacity>
                ))
              ) : (
                <View style={styles.dayDetailPassRow}>
                  <Text style={styles.dayDetailPassText}>{t('no_history')}</Text>
                </View>
              )}
            </View>
          </Pressable>
        </Modal>

        {/* ── フルスクリーン再生モーダル ── */}
        <Modal
          visible={!!selectedRecord}
          animationType="fade"
          transparent={false}
          onRequestClose={() => { setSelectedRecord(null); setSelectedSlotIdx(null); }}
        >
          <View style={styles.recordModalBg}>
            {/* 閉じるボタン */}
            <TouchableOpacity
              style={styles.recordModalClose}
              onPress={() => { setSelectedRecord(null); setSelectedSlotIdx(null); }}
            >
              <Feather name="x" size={26} color="#fff" />
            </TouchableOpacity>

            {/* 過去の記録 → ファイルパスへのアクセスを一切行わず、ロックを表示 */}
            {selectedRecord && selectedRecord.date !== todayStr && (
              <View style={styles.recordModalNoMedia}>
                <Feather name="lock" size={48} color="#444" />
                <Text style={styles.recordModalNoMediaText}>
                  {lang === 'ja' ? '過去の記録は閲覧できません' : 'Past records cannot be viewed'}
                </Text>
              </View>
            )}

            {selectedRecord && selectedRecord.date === todayStr && playingUri != null && (
              <>
                {/* メディア表示 */}
                {/* ── 画像/動画の判定: 拡張子で判断（heic/heif も対応）─── */}
                {/\.(jpg|jpeg|png|heic|heif)$/i.test(playingUri) ? (
                  // ── 旧 tmpfile URI が失効した場合の onError フォールバック ──
                  playingUriError ? (
                    <View style={styles.recordModalNoMedia}>
                      <Feather name="image" size={48} color="#444" />
                      <Text style={styles.recordModalNoMediaText}>
                        {lang === 'ja' ? '画像データが見つかりません\n（カメラロールをご確認ください）' : 'Image unavailable\n(check your camera roll)'}
                      </Text>
                    </View>
                  ) : (
                    <Image
                      source={{ uri: playingUri }}
                      style={styles.recordModalMedia}
                      resizeMode="contain"
                      onError={() => setPlayingUriError(true)}
                    />
                  )
                ) : (
                  <Video
                    source={{ uri: playingUri }}
                    style={styles.recordModalMedia}
                    resizeMode={ResizeMode.CONTAIN}
                    shouldPlay
                    isLooping
                    useNativeControls={false}
                  />
                )}

                {/* ── アクションボタン（削除 | 再保存 | シェア）── */}
                <View style={styles.recordModalActions}>
                  <TouchableOpacity
                    style={styles.recordModalBtnDelete}
                    onPress={() => {
                      const slotIdx = selectedSlotIdx ?? 0;
                      setSelectedRecord(null);
                      setSelectedSlotIdx(null);
                      deleteRecord(selectedRecord, slotIdx);
                    }}
                  >
                    <Feather name="trash-2" size={16} color="#fff" />
                    <Text style={styles.recordModalBtnText}>{t('history_delete')}</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.recordModalBtnSave}
                    onPress={() => resaveRecord(playingUri)}
                  >
                    <Feather name="download" size={16} color="#fff" />
                    <Text style={styles.recordModalBtnText}>{t('history_resave')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.recordModalBtnShare}
                    onPress={() => shareRecord(playingUri)}
                  >
                    <Feather name="share" size={16} color="#fff" />
                    <Text style={styles.recordModalBtnText}>{t('share_btn')}</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}

            {/* 当日だが URI がない場合（パス使用日）*/}
            {selectedRecord && selectedRecord.date === todayStr && playingUri == null && (
              <View style={styles.recordModalNoMedia}>
                <Feather name="film" size={48} color="#444" />
                <Text style={styles.recordModalNoMediaText}>
                  {selectedRecord.isPass
                    ? (lang === 'ja' ? 'パス使用日' : 'Rest pass used')
                    : t('video_today_only')}
                </Text>
              </View>
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
              const { title, body } = pickNotifyMessage(lang, newGoal);
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
            trackColor={{ false: '#333', true: '#666' }}
          />
        </View>

        <View style={styles.settingGroup}>
          <Text style={styles.settingLabel}>{t('settings_color_filter_label')}</Text>
          <Text style={styles.settingHint}>{t('settings_color_filter_hint')}</Text>
          <Switch
            value={appState.colorFilterEnabled}
            onValueChange={v => updateState({ colorFilterEnabled: v })}
            thumbColor="#fff"
            trackColor={{ false: '#333', true: '#666' }}
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

        {/* ── 3ボタン横並び（保存 / 購入の復元 / アプリの使い方） ── */}
        <View style={styles.btnRowThree}>
          <TouchableOpacity style={styles.btnGhost} onPress={handleSave}>
            <Text style={styles.btnGhostText}>{t('settings_save_btn')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.btnGhost} onPress={restorePurchase}>
            <Text style={styles.btnGhostText}>{t('settings_restore_btn')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.btnGhost} onPress={() => setGuideVisible(true)}>
            <Text style={styles.btnGhostText}>{t('settings_guide')}</Text>
          </TouchableOpacity>
        </View>

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

        {/* ── リセットボタン（白枠線、薄い赤テキスト） ── */}
        <TouchableOpacity style={styles.btnDangerGhost} onPress={resetAll}>
          <Text style={styles.btnDangerGhostText}>{t('settings_reset_btn')}</Text>
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
            { title: t('guide_card_storage_title'), body: t('guide_card_storage_body'), highlight: true },
            { title: t('guide_card3_title'), body: t('guide_card3_body') },
            { title: t('guide_card4_title'), body: t('guide_card4_body') },
            { title: t('guide_card5_title'), body: t('guide_card5_body') },
            { title: t('guide_rule_10day_title'), body: t('guide_rule_10day_body') },
            { title: t('guide_free_trial_title'), body: t('guide_free_trial_body') },
          ].map((card, i) => (
            <View key={i} style={[styles.guideCard, card.highlight && styles.guideCardHighlight]}>
              <Text style={[styles.guideCardTitle, card.highlight && styles.guideCardTitleHighlight]}>{card.title}</Text>
              <Text style={styles.guideCardBody}>{card.body}</Text>
            </View>
          ))}

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
`【日本語】利用規約（Terms of Use）
最終更新日：2026年3月9日

1. はじめに・同意
本利用規約（以下「本規約」）は、「One Shot」（以下「本アプリ」）を提供する開発者（以下「当社」）と、本アプリを利用する方（以下「ユーザー」）との間の条件を定めるものです。

本アプリをダウンロード・インストール・使用することにより、ユーザーは本規約に同意したものとみなされます。同意いただけない場合は、本アプリを直ちにアンインストールしてください。

2. サービスの内容
本アプリは以下の機能を提供します。

* 1日1本の動画撮影・保存・SNSシェア機能
* 連続記録日数（ストリーク）の管理
* パス機能（無料パス・有料パスによるストリーク維持）
* アプリ内課金による有料パスの購入

3. 利用資格
本アプリは13歳以上の方を対象としています。アプリ内課金を利用するには、Apple App Store のアカウントおよび購入に必要な支払い方法が必要です。

未成年者が本アプリを利用する場合は、保護者の同意を得てください。

4. サブスクリプションプラン
本アプリのすべての機能はサブスクリプションプランでご利用いただけます。課金は Apple ID アカウントを通じて処理されます。

* 年額プラン： App Storeに表示される現在の価格（年払い）
* 月額プラン： App Storeに表示される現在の価格（月払い）
* 更新周期： 各契約期間終了時に自動更新されます。
* 課金タイミング： 購入確認後、Apple ID アカウントに課金されます。以降、各更新期間の開始24時間以内に自動的に課金されます。
* 無料トライアル（提供する場合）： 無料トライアル期間終了の24時間前までに解約しない場合、有料サブスクリプションに移行します。
* 解約方法： App Store の「設定」→「サブスクリプション」からいつでも解約できます。解約は次回更新日の24時間前までに行ってください。解約後も、現在の契約期間が終了するまでサービスをご利用いただけます。
* 価格の変更： 価格が変更される場合は、事前にアプリ内または登録済みメールアドレスへ通知します。

Apple サブスクリプションの管理・解約は以下から行えます：

* iOS： 設定アプリ → Apple ID → サブスクリプション
* Mac： App Store → アカウント → サブスクリプション

5. アプリ内課金（パスの購入）
本アプリのアプリ内課金はすべて Apple App Store を通じて処理されます。購入・払い戻し・キャンセルは Apple の規約に従います。

* 有料パス（App Storeに表示される現在の価格）： ストリークを維持するための消費アイテムです。消費後の返金はいたしかねます。有効期限なしで何枚でもストックできます。
* 無料パス： 毎週月曜日 AM3:00 に1枚付与されます。繰り越し不可です。
* 消費順序： 有料パスが先に消費され、次に無料パスが消費されます。

払い戻しを希望する場合は、Apple の払い戻し申請ページ（https://reportaproblem.apple.com/）をご利用ください。

6. ユーザーの義務と禁止事項
ユーザーは以下の行為を行ってはなりません。

* 本アプリを違法な目的に使用すること
* 他者を誹謗中傷・ハラスメントする内容の動画を撮影・共有すること
* 本アプリのリバースエンジニアリング・改変・複製
* 本アプリのシステムへの不正アクセス・負荷攻撃
* 第三者の著作権・肖像権・プライバシーを侵害するコンテンツの作成・共有
* わいせつ・暴力的・差別的なコンテンツの撮影・共有

6-1. サービス仕様：目標（habit）の変更ルール（10日ルール）
本アプリでは、習慣継続の意図的な設計として「10日ルール」を採用しています。ユーザーは本ルールの内容を十分に理解した上で本アプリを利用するものとします。

* 10日未満の継続： 目標（habit）はいつでも自由に変更できます。変更後も記録はリセットされません。
* 10日を超えた継続後の目標変更： ストリーク（連続記録日数）が10日を超えた後に目標を変更した場合、これまでのすべての記録がリセットされ、DAY 0（ゼロ）からの再スタートとなります。この仕様はサービスの重要な設計要素であり、ユーザーの同意のもとで適用されます。
* 確認ダイアログ： 目標変更の実行前に、本ルールに関する確認画面が表示されます。ユーザーが明示的に同意した場合にのみ変更・リセットが実行されます。

当社は本ルールの適用によって生じたデータのリセットについて、責任を負いません。

7. コンテンツの権利
ユーザーが本アプリを通じて撮影した動画の著作権はユーザーに帰属します。

ユーザーが SNS シェア機能を通じて動画を外部プラットフォームに共有した場合、各プラットフォームの利用規約が適用されます。当社はシェア先でのコンテンツの取り扱いについて責任を負いません。

8. 知的財産権
本アプリのデザイン・ロゴ・ソフトウェアコード・テキストなど、本アプリを構成するすべての要素の知的財産権は当社に帰属します。ユーザーに対して明示的に許可されていない権利の行使を禁じます。

9. 免責事項
本アプリは「現状のまま」提供されます。当社は以下について保証しません。

* 本アプリが常に利用可能であること、または中断・エラーがないこと
* 本アプリの利用によって得られる特定の結果（習慣形成など）
* ユーザーのデバイスとの完全な互換性

本アプリの利用に起因するいかなる損害についても、法令上の責任を負う場合を除き、当社は責任を負いません。

10. サービスの変更・終了
当社は事前通知なく、本アプリの機能の追加・変更・削除、またはサービス全体の提供停止を行う場合があります。サービス終了に伴う損害について当社は責任を負いません。

11. 規約の変更
当社は本規約を随時変更することがあります。変更後に本アプリを継続してご利用いただいた場合、変更後の規約に同意いただいたものとみなします。

重要な変更については、アプリ内通知またはアプリのアップデートノートにてお知らせします。

12. 準拠法・裁判管轄
本規約は日本法に準拠します。本規約に関する紛争については、東京地方裁判所を第一審の専属的合意管轄裁判所とします。

13. お問い合わせ
One Shot 開発チーム
メール：ristu.japan@gmail.com`;

    const enTerms =
`【English】Terms of Service
Last updated: March 9, 2026

1. Introduction & Agreement
These Terms of Service ("Terms") govern the relationship between the developer ("we," "us," or "our") of "One Shot" ("the App") and users ("you") who use the App.

By downloading, installing, or using the App, you agree to be bound by these Terms. If you do not agree, please uninstall the App immediately.

2. Service Description
The App provides the following features:

* Daily video recording, saving, and social media sharing
* Streak (consecutive recording days) tracking
* Pass feature (free and paid passes to maintain streaks)
* In-app purchase of paid passes

3. Eligibility
The App is intended for users aged 13 and older. To use in-app purchases, you must have an Apple App Store account and a valid payment method.

Minors must obtain parental or guardian consent before using this App.

4. Subscription Plans
All features of the App are available through a subscription plan. Payments are processed through your Apple ID account.

* Annual Plan: Current price shown in the App Store (billed annually)
* Monthly Plan: Current price shown in the App Store (billed monthly)
* Renewal: Automatically renews at the end of each billing period.
* Billing: Charged to your Apple ID account upon purchase confirmation. Subsequent charges occur within 24 hours before the start of each renewal period.
* Free Trial (if offered): If you do not cancel at least 24 hours before the end of the free trial period, you will be charged for a paid subscription.
* Cancellation: You can cancel anytime via the App Store under Settings → Subscriptions. Cancel at least 24 hours before the next renewal date. You may continue to use the service until the end of the current billing period after cancellation.
* Price changes: If prices change, we will notify you in-app or via your registered email address in advance.

To manage or cancel your Apple subscription:

* iOS: Settings app → Apple ID → Subscriptions
* Mac: App Store → Account → Subscriptions

5. In-App Purchases (Passes)
All in-app purchases are processed through the Apple App Store. Purchases, refunds, and cancellations are subject to Apple's policies.

* Paid Pass (current price shown in the App Store): A consumable item used to maintain your streak. No refunds after use. No expiry — stock as many as you like.
* Free Pass: One pass is automatically granted every Monday at 3:00 AM. Cannot be carried over to the next week.
* Consumption order: Paid passes are consumed first, then free passes.

To request a refund, please use Apple's refund request page: https://reportaproblem.apple.com/

6. User Obligations & Prohibited Activities
You must not:

* Use the App for any illegal purpose
* Record or share content that defames, harasses, or harms others
* Reverse engineer, modify, or copy the App
* Attempt unauthorized access or load attacks on the App's systems
* Create or share content that infringes third-party copyrights, portrait rights, or privacy
* Record or share obscene, violent, or discriminatory content

6-1. Service Specification: Habit Goal Change Rule (10-Day Rule)
The App enforces a "10-Day Rule" as a deliberate design element to reinforce habit commitment. Users are expected to understand and accept this rule before using the App.

* Within the first 10 days: You may change your habit goal at any time without affecting your recorded history.
* After 10 consecutive days: If you change your habit goal once your streak exceeds 10 days, all existing records will be permanently reset and your streak will restart from DAY 0. This behavior is a core feature of the service and applies upon your explicit consent.
* Confirmation dialog: Before any reset is executed, a confirmation screen will be displayed explaining the consequences. The reset only proceeds if you explicitly agree.

We are not liable for any data loss resulting from a goal change that triggers a reset under this rule.

7. Content Rights
You retain copyright over videos you record using the App.

If you share a video to an external platform via the social sharing feature, the terms of service of that platform apply. We are not responsible for how content is handled on third-party platforms.

8. Intellectual Property
All intellectual property rights in the App — including its design, logo, software code, and text — belong to us. You may not exercise any rights not expressly granted to you.

9. Disclaimer of Warranties
The App is provided "as is." We make no warranties regarding:

* Continuous availability of the App, or that it will be free from interruptions or errors
* Specific results from using the App (such as habit formation)
* Full compatibility with your device

To the extent permitted by law, we are not liable for any damages arising from your use of the App.

10. Service Changes & Termination
We may add, modify, or remove features, or discontinue the App entirely, without prior notice. We are not liable for any losses resulting from service termination.

11. Changes to These Terms
We may update these Terms at any time. Continued use of the App after changes constitutes your acceptance of the updated Terms.

Material changes will be communicated via in-app notifications or App update release notes.

12. Governing Law & Jurisdiction
These Terms are governed by the laws of Japan. Any disputes arising from these Terms shall be subject to the exclusive jurisdiction of the Tokyo District Court as the court of first instance.

13. Contact Us
One Shot Development Team
Email: ristu.japan@gmail.com`;

    const jaPrivacy =
`【日本語】プライバシーポリシー（Privacy Policy）
最終更新日：2026年3月9日

1. はじめに
「One Shot」（以下「本アプリ」）を提供する開発者（以下「当社」）は、利用者のプライバシーを最大限に尊重します。本ポリシーは、本アプリが収集する情報・利用目的・管理方法について説明します。

本アプリをご利用いただくことで、本ポリシーに同意いただいたものとみなします。同意いただけない場合は、本アプリのご利用をお控えください。

2. 収集する情報
本アプリが収集・処理する情報は以下のとおりです。

* カメラ映像・音声： 動画撮影機能のために、デバイスのカメラおよびマイクへのアクセスを使用します。録画データはデバイス内のみで処理され、外部サーバーへは送信されません。
* ローカルストレージデータ： 連続記録日数（ストリーク）・パス残数・購入状態・アプリ設定などをデバイス内の localStorage に保存します。これらはサーバーへ送信されません。
* 購入情報： アプリ内課金（パスの購入）は Apple の App Store を通じて処理されます。当社はクレジットカード番号等の決済情報を収集・保存しません。Apple のプライバシーポリシーが適用されます。
* クラッシュレポート（任意）： 将来的にクラッシュ情報を収集する場合は、事前に本ポリシーを更新の上、利用者に通知します。

3. 情報の利用目的
収集した情報は、以下の目的にのみ使用します。

* 本アプリの機能提供（動画撮影・保存・SNSシェア）
* ストリーク・パス管理などユーザー体験の維持
* アプリの改善・不具合修正

当社は収集した情報を第三者に販売・貸与しません。

4. カメラ・マイクへのアクセス
本アプリは動画撮影のためにカメラおよびマイクへのアクセスを必要とします。アクセス許可はいつでも iOS の「設定」→「プライバシーとセキュリティ」から変更できます。

撮影した映像は端末内にのみ保存されます。SNSシェア機能を使用した場合、動画ファイルをユーザー自身の操作によって外部アプリ（Instagram・TikTok等）に共有します。その際の取り扱いは各プラットフォームのプライバシーポリシーに従います。

5. データの保存と削除
本アプリのデータはすべてお使いのデバイスに保存されます。アプリを削除することで、ローカルに保存されたすべてのデータが削除されます。

撮影した動画は端末の写真ライブラリまたはアプリ内ストレージに保存されます。削除はお使いのデバイスの写真アプリ等から行ってください。

6. サードパーティサービス
本アプリは以下のサードパーティサービスを利用します。

* Apple App Store / In-App Purchase： アプリ内課金の決済処理。（Apple プライバシーポリシー：https://www.apple.com/legal/privacy/jp/）
* Google Fonts（Inter）： フォントの配信のみに使用。（Google プライバシーポリシー：https://policies.google.com/privacy）

当社はこれらサードパーティの情報取り扱いについて責任を負いません。

7. お子様のプライバシー
本アプリは13歳未満のお子様を対象としていません。13歳未満のお子様の情報を故意に収集することはありません。万が一当該情報を収集していることが判明した場合は、速やかに削除します。

8. 本ポリシーの変更
当社は本ポリシーを随時更新することがあります。変更がある場合は本ページに最新版を掲載し、重大な変更の場合はアプリ内通知等で告知します。

9. お問い合わせ
One Shot 開発チーム
メール：ristu.japan@gmail.com`;

    const enPrivacy =
`【English】Privacy Policy
Last updated: March 9, 2026

1. Introduction
The developer ("we," "us," or "our") of "One Shot" ("the App") is committed to protecting your privacy. This policy explains what information the App collects, how it is used, and how it is managed.

By using the App, you agree to this policy. If you do not agree, please discontinue use of the App.

2. Information We Collect
The App collects and processes the following information:

* Camera & Microphone: The App accesses your device's camera and microphone for video recording. Recorded data is processed entirely on your device and is never transmitted to external servers.
* Local Storage Data: Streak count, remaining passes, purchase status, and app settings are stored in your device's localStorage. This data is never sent to a server.
* Purchase Information: In-app purchases (pass purchases) are processed through Apple's App Store. We do not collect or store credit card numbers or other payment details. Apple's Privacy Policy applies to payment data.
* Crash Reports (future): If we ever collect crash information in the future, we will update this policy and notify users in advance.

3. How We Use Your Information
Collected information is used solely for the following purposes:

* Providing App features (video recording, saving, and social sharing)
* Maintaining user experience such as streak and pass management
* Improving the App and fixing bugs

We do not sell or rent your information to third parties.

4. Camera & Microphone Access
The App requires access to your camera and microphone for video recording. You can change this permission at any time via iOS Settings → Privacy & Security.

Recorded footage is saved only on your device. If you use the social sharing feature, video files are shared to external apps (such as Instagram or TikTok) through your own action. The handling of such data is governed by the respective platform's privacy policy.

5. Data Storage & Deletion
All App data is stored locally on your device. Deleting the App will remove all locally stored data.

Recorded videos are saved in the App's internal storage. To delete them, use the App's settings or your device's file manager.

6. Third-Party Services
The App uses the following third-party services:

* Apple App Store / In-App Purchase: Payment processing for in-app purchases. (Apple Privacy Policy: https://www.apple.com/legal/privacy/)
* Google Fonts (Inter): Used solely for font delivery. (Google Privacy Policy: https://policies.google.com/privacy)

We are not responsible for the data practices of these third-party services.

7. Children's Privacy
The App is not directed at children under the age of 13. We do not knowingly collect personal information from children under 13. If we discover that such information has been collected, we will promptly delete it.

8. Changes to This Policy
We may update this policy from time to time. The latest version will always be posted on this page. For material changes, we will notify users via in-app notifications or other means.

9. Contact Us
One Shot Development Team
Email: ristu.japan@gmail.com`;

    const content = lang === 'ja'
      ? (isTerms ? jaTerms : jaPrivacy)
      : (isTerms ? enTerms : enPrivacy);

    const renderLegalContent = (text: string) => {
      return text.split('\n').map((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('【') && trimmed.endsWith('】') ||
            (trimmed.startsWith('【') && trimmed.includes('】'))) {
          return <Text key={index} style={styles.legalSectionTitle}>{trimmed}</Text>;
        } else if (trimmed.startsWith('最終更新') || trimmed.startsWith('Last updated')) {
          return <Text key={index} style={styles.legalDateText}>{trimmed}</Text>;
        } else if (/^\d+[-\d]*\. /.test(trimmed)) {
          return <Text key={index} style={styles.legalHeading}>{trimmed}</Text>;
        } else if (trimmed.startsWith('* ')) {
          return <Text key={index} style={styles.legalBullet}>{'• ' + trimmed.slice(2)}</Text>;
        } else if (trimmed === '') {
          return <View key={index} style={{ height: 8 }} />;
        } else {
          return <Text key={index} style={styles.legalBody}>{trimmed}</Text>;
        }
      });
    };

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
              {renderLegalContent(content)}
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
      {/* HistoryScreen() を関数として直接呼び出す（<HistoryScreen /> ではない）
          → Page 再レンダリング時も同一位置の JSX ノードとして扱われる
          → selectedRecord 等の state 変更が即座にモーダル visible に反映され、
            タブ切り替えなしで画面が更新される「レンダリング詰まり」を解消 */}
      {screen === 'history' && HistoryScreen()}
      {screen === 'settings' && <SettingsScreen />}

      {!hideNav && (
        <View style={styles.bottomNav}>
          <TouchableOpacity
            style={[styles.navItem, screen === 'home' && styles.navItemActive]}
            onPress={() => setScreen('home')}
          >
            <Ionicons name="home-outline" size={20} color={screen === 'home' ? '#FFFFFF' : '#555555'} />
            <Text style={[styles.navLabel, screen === 'home' && styles.navLabelActive]}>
              {t('nav_today')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.navItem, screen === 'history' && styles.navItemActive]}
            onPress={() => setScreen('history')}
          >
            <Ionicons name="calendar-outline" size={20} color={screen === 'history' ? '#FFFFFF' : '#555555'} />
            <Text style={[styles.navLabel, screen === 'history' && styles.navLabelActive]}>
              {t('nav_history')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.navItem, screen === 'settings' && styles.navItemActive]}
            onPress={() => setScreen('settings')}
          >
            <Ionicons name="settings-outline" size={20} color={screen === 'settings' ? '#FFFFFF' : '#555555'} />
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
      {/* ── Off-screen photo filter processor (9:16 layout) ────────────────── */}
      {/* Renders the raw photo + overlays off-screen at 9:16 ratio;
          view-shot captures it to produce a fully baked processedUri.         */}
      {photoProcessorData && (() => {
        const { uri, habitName, currentDay, captureTime } = photoProcessorData;

        // Canvas: width = screen width, height = width × (16/9)
        const canvasW = Dimensions.get('window').width;
        const canvasH = Math.round(canvasW * (16 / 9));
        const barH    = Math.round((canvasH - canvasW) / 2);  // upper/lower bar height

        // Formatting timestamps
        let lowerTs = '';
        try {
          lowerTs = format(captureTime, "yyyy.MM.dd HH:mm");
        } catch { /* no-op */ }

        // "DAY 015" — zero-padded 3 digits
        const dayStr  = `DAY ${String(currentDay).padStart(3, '0')}`;
        const habitStr = habitName;

        // Font sizes (relative to canvas width, matching native pixel sizes ÷ 1080 × canvasW)
        const hPad     = canvasW * (44 / 1080);
        const logoFS   = canvasW * (72 / 1080);
        const dayFS    = barH * 0.55;
        const habitFS  = canvasW * (88 / 1080);
        const lowerTsFS = canvasW * (60 / 1080);

        // Logo Y: vertically centered in upper bar, same formula as DAY
        const logoTopY = (barH - logoFS) / 2;

        // Lower bar: two lines stacked on left, centered together vertically in bar
        const lowerBarTopY   = canvasH - barH;
        const lowerLineGap   = canvasW * (12 / 1080);
        const twoLineH       = lowerTsFS + lowerLineGap + habitFS;
        const lowerTsY       = lowerBarTopY + (barH - twoLineH) / 2;
        const habitY         = lowerTsY + lowerTsFS + lowerLineGap;

        // Bracket: 3× inset, 4× arm, 3× stroke — matches iOS native video side
        const bInset = canvasW * (24 / 1080);
        const bArm   = canvasW * (144 / 1080);
        const bStroke = canvasW * (9 / 1080);

        // Left text area width — prevents overflow into graph area
        const leftTextW = canvasW * 0.36 - hPad;

        const textShadow = {
          textShadowColor: 'rgba(0,0,0,0.65)' as const,
          textShadowOffset: { width: 1, height: 1 },
          textShadowRadius: 4,
        };

        return (
          <View
            ref={photoProcessorRef}
            style={{
              position: 'absolute',
              left: -(canvasW * 3),
              top: 0,
              width: canvasW,
              height: canvasH,
              backgroundColor: '#000',
              overflow: 'hidden',
            }}
          >
            {/* ── Center video band ── */}
            <Image
              source={{ uri }}
              style={{ position: 'absolute', top: barH, left: 0, width: canvasW, height: canvasW }}
              resizeMode="cover"
              onLoadEnd={() => processPhotoFromRef(uri)}
            />

            {/* Color overlay on video (exposure approx) */}
            {appState.colorFilterEnabled && (
              <View style={{
                position: 'absolute', top: barH, left: 0,
                width: canvasW, height: canvasW,
                backgroundColor: 'rgba(0,0,0,0.38)',
              }} />
            )}

            {/* TL corner bracket ┌ — 70% opacity, sharp corners, 3× stroke */}
            <View style={{
              position: 'absolute',
              top: barH + bInset, left: bInset,
              width: bArm, height: bArm,
              borderTopWidth: bStroke, borderLeftWidth: bStroke,
              borderColor: 'rgba(255,255,255,0.7)',
              borderRadius: 0,
            }} />
            {/* TR corner bracket ┐ — 70% opacity, sharp corners */}
            <View style={{
              position: 'absolute',
              top: barH + bInset, right: bInset,
              width: bArm, height: bArm,
              borderTopWidth: bStroke, borderRightWidth: bStroke,
              borderColor: 'rgba(255,255,255,0.7)',
              borderRadius: 0,
            }} />
            {/* BL corner bracket └ — 70% opacity, sharp corners */}
            <View style={{
              position: 'absolute',
              bottom: barH + bInset, left: bInset,
              width: bArm, height: bArm,
              borderBottomWidth: bStroke, borderLeftWidth: bStroke,
              borderColor: 'rgba(255,255,255,0.7)',
              borderRadius: 0,
            }} />
            {/* BR corner bracket ┘ — 70% opacity, sharp corners */}
            <View style={{
              position: 'absolute',
              bottom: barH + bInset, right: bInset,
              width: bArm, height: bArm,
              borderBottomWidth: bStroke, borderRightWidth: bStroke,
              borderColor: 'rgba(255,255,255,0.7)',
              borderRadius: 0,
            }} />

            {/* ── Upper bar ── */}
            {/* "ONE SHOT" logo — wide kerning 0.15em, Y-center aligned with DAY */}
            <Text style={{
              position: 'absolute', top: logoTopY, left: hPad,
              fontSize: logoFS, color: '#fff',
              fontFamily: 'BebasNeue-Regular',
              letterSpacing: logoFS * 0.15,
              ...textShadow,
            }}>ONE SHOT</Text>
            {/* "DAY 015" — right-aligned, vertically centred in upper bar */}
            <Text style={{
              position: 'absolute',
              top: (barH - dayFS) / 2,
              left: hPad, right: hPad,
              fontSize: dayFS, color: '#fff',
              fontFamily: 'BebasNeue-Regular',
              textAlign: 'right',
              ...textShadow,
            }}>{dayStr}</Text>

            {/* ── Lower bar ── */}
            {/* Timestamp — constrained to left text area */}
            <Text
              numberOfLines={1}
              style={{
                position: 'absolute', top: lowerTsY, left: hPad,
                width: leftTextW,
                fontSize: lowerTsFS, color: '#fff',
                fontFamily: 'BebasNeue-Regular',
                ...textShadow,
              }}>{lowerTs}</Text>
            {/* Habit name (no prefix) — constrained to left text area */}
            <Text
              numberOfLines={1}
              style={{
                position: 'absolute', top: habitY, left: hPad,
                width: leftTextW,
                fontSize: habitFS, color: '#fff',
                fontFamily: 'BebasNeue-Regular',
                ...textShadow,
              }}>{habitStr}</Text>

            {/* ── Growth curve full graph (right half: Y-axis pinned at screen center) ── */}
            {currentDay > 0 && (() => {
              // Y-axis pinned at canvasW/2: left half = text area, right half = graph area
              const gcML_fixed = canvasW * (50 / 1080);
              const gcLeft = canvasW / 2 - gcML_fixed;  // Y-axis at exactly canvasW/2
              const gcW    = canvasW - gcLeft - hPad * 0.5;
              const gcH    = barH * 0.80;
              const gcTop  = lowerBarTopY + (barH - gcH) / 2;

              const mL = gcML_fixed;  // fixed, not percentage — ensures Y-axis stays at center
              const mB = gcH * 0.17;
              const mR = gcW * 0.025;
              const mT = gcH * 0.06;
              const plotW = gcW - mL - mR;
              const plotH = gcH - mT - mB;

              const gcVals = Array.from({ length: currentDay }, (_, i) => 3 * Math.pow(1.01, i + 1));
              const curVal = gcVals[gcVals.length - 1] ?? 3.0;

              // xMax: ~1x future buffer so future section equals past section
              const xMax = Math.max(currentDay * 2, 10);

              // Y-axis: scale to predicted value at xMax so current position stays near center
              const gcMinV = 3.0;
              const gcMaxV = Math.ceil(3 * Math.pow(1.01, xMax) / 0.5) * 0.5;
              const gcRange = Math.max(gcMaxV - gcMinV, 0.1);

              const xToSvg = (day: number) => mL + (day / xMax) * plotW;
              const yToSvg = (v: number) => mT + plotH - ((v - gcMinV) / gcRange) * plotH;

              // Solid line: past data (DAY 1 → current)
              const pts = gcVals.map((v, i) => ({ x: xToSvg(i + 1), y: yToSvg(v) }));
              const lastPt = pts[pts.length - 1];

              // Dashed line: future prediction (current → xMax), sampled for perf
              const futureStep = Math.max(1, Math.floor((xMax - currentDay) / 80));
              const futurePts: {x: number; y: number}[] = [];
              for (let day = currentDay; day <= xMax; day += futureStep) {
                futurePts.push({ x: xToSvg(day), y: yToSvg(3 * Math.pow(1.01, day)) });
              }
              if (futurePts.length === 0 || futurePts[futurePts.length - 1].x < xToSvg(xMax) - 0.5) {
                futurePts.push({ x: xToSvg(xMax), y: yToSvg(3 * Math.pow(1.01, xMax)) });
              }

              // Y labels: 0.5-step increments
              const yLabels: number[] = [];
              for (let yv = gcMinV; yv <= gcMaxV + 0.001; yv += 0.5) {
                yLabels.push(parseFloat(yv.toFixed(1)));
              }

              // X labels: DAY 1, every 10 days (past only), current day (red)
              const xLabelDays: number[] = [1];
              for (let d = 10; d < currentDay; d += 10) {
                xLabelDays.push(d);
              }
              if (!xLabelDays.includes(currentDay)) xLabelDays.push(currentDay);

              const labelFS = Math.max(gcW * 0.028, 5.5);
              const dotR    = gcW * 0.014;

              return (
                <Svg
                  key="gc-full"
                  width={gcW}
                  height={gcH}
                  style={{ position: 'absolute', top: gcTop, left: gcLeft }}
                >
                  {/* Y-axis dotted guide lines + labels */}
                  {yLabels.map(yv => {
                    const ly = yToSvg(yv);
                    return (
                      <React.Fragment key={`yg-${yv}`}>
                        <Line
                          x1={mL} y1={ly} x2={mL + plotW} y2={ly}
                          stroke="rgba(255,255,255,0.1)"
                          strokeWidth={0.5}
                          strokeDasharray="3,4"
                        />
                        <SvgText
                          x={mL - 3} y={ly + labelFS * 0.38}
                          fontSize={labelFS}
                          fill="rgba(255,255,255,0.5)"
                          fontFamily="Courier"
                          textAnchor="end"
                        >{yv.toFixed(1)}</SvgText>
                      </React.Fragment>
                    );
                  })}
                  {/* Y axis */}
                  <Line x1={mL} y1={mT} x2={mL} y2={mT + plotH}
                    stroke="rgba(255,255,255,0.5)" strokeWidth={1.2} />
                  {/* X axis */}
                  <Line x1={mL} y1={mT + plotH} x2={mL + plotW} y2={mT + plotH}
                    stroke="rgba(255,255,255,0.5)" strokeWidth={1.2} />
                  {/* X-axis labels */}
                  {xLabelDays.map(d => {
                    const lx = xToSvg(d);
                    const isCurrentDay = d === currentDay;
                    return (
                      <React.Fragment key={`xl-${d}`}>
                        <Line x1={lx} y1={mT + plotH} x2={lx} y2={mT + plotH + 3}
                          stroke="rgba(255,255,255,0.4)" strokeWidth={0.5} />
                        <SvgText
                          x={lx} y={mT + plotH + labelFS + 2}
                          fontSize={labelFS}
                          fill={isCurrentDay ? 'rgba(255,51,51,0.9)' : 'rgba(255,255,255,0.45)'}
                          fontFamily="Courier"
                          textAnchor="middle"
                        >{`DAY ${d}`}</SvgText>
                      </React.Fragment>
                    );
                  })}
                  {/* Solid growth line: DAY 1 → current (white solid) */}
                  {pts.length > 1 && (
                    <Polyline
                      points={pts.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')}
                      fill="none"
                      stroke="rgba(255,255,255,0.9)"
                      strokeWidth={1.8}
                    />
                  )}
                  {/* Dashed future prediction: current → xMax (white dashed) */}
                  {futurePts.length > 1 && (
                    <Polyline
                      points={futurePts.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')}
                      fill="none"
                      stroke="rgba(255,255,255,0.9)"
                      strokeWidth={1.8}
                      strokeDasharray="6,5"
                    />
                  )}
                  {/* Current position — red dot */}
                  <Circle cx={lastPt.x} cy={lastPt.y} r={dotR} fill="#FF3333" />
                </Svg>
              );
            })()}
          </View>
        );
      })()}

    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const { width } = Dimensions.get('window');
const CELL_SIZE = Math.floor((width - 16) / 7);

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
    fontSize: 36,
    fontWeight: '900',
    color: '#fff',
    letterSpacing: 10,
    marginBottom: 8,
    fontFamily: 'BebasNeue-Regular',
  },
  subtitle: {
    fontSize: 14,
    color: '#888',
    textAlign: 'center',
    marginBottom: 12,
    letterSpacing: 0.5,
  },
  onboardingRule: {
    fontSize: 13,
    color: '#CC0000',
    textAlign: 'center',
    marginBottom: 32,
    letterSpacing: 0.3,
    fontStyle: 'italic',
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
  btnRowThree: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
    marginTop: 8,
  },
  btnGhost: {
    flex: 1,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnGhostText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 11,
    letterSpacing: 0.5,
  },
  btnDangerGhost: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
    alignItems: 'center',
    marginBottom: 12,
    width: '100%',
  },
  btnDangerGhostText: {
    color: 'rgba(220,80,80,0.85)',
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
    justifyContent: 'flex-start',
    padding: 24,
    paddingTop: 56,
    paddingBottom: 48,
    alignItems: 'center',
    backgroundColor: '#000',
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
    fontSize: 16,
    fontWeight: '700',
    color: '#888',
    marginBottom: 12,
    letterSpacing: 4,
    textTransform: 'uppercase',
    fontFamily: 'BebasNeue-Regular',
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
    fontSize: 52,
    fontWeight: '900',
    color: '#fff',
    letterSpacing: 0,
    marginBottom: 4,
    fontFamily: 'BebasNeue-Regular',
  },
  planCardPeriod: {
    fontSize: 11,
    color: '#888',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 14,
  },
  planCardCta: {
    fontSize: 15,
    fontWeight: '800',
    color: '#CC3333',
    letterSpacing: 2,
    textTransform: 'uppercase',
    fontFamily: 'BebasNeue-Regular',
  },
  trialBadgeText: {
    fontSize: 22,
    fontWeight: '800',
    color: '#CC0000',
    marginBottom: 16,
    textAlign: 'center',
    fontFamily: 'BebasNeue-Regular',
    letterSpacing: 2,
  },
  planCardSubtext: {
    fontSize: 12,
    color: '#CC0000',
    fontWeight: '600',
    marginBottom: 6,
  },
  trialNote: {
    fontSize: 12,
    color: '#888888',
    textAlign: 'center',
    lineHeight: 18,
    marginTop: 12,
    marginBottom: 8,
    paddingHorizontal: 8,
  },
  planCardSecondary: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 12,
    backgroundColor: '#0d0d0d',
    paddingVertical: 18,
    paddingHorizontal: 20,
    marginBottom: 20,
    flexDirection: 'column',
  },
  planCardSecondaryPrice: {
    fontSize: 36,
    fontWeight: '700',
    color: '#aaa',
    letterSpacing: 0,
    marginBottom: 4,
    fontFamily: 'BebasNeue-Regular',
  },
  planCardSecondaryPeriod: {
    fontSize: 11,
    color: '#555',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginTop: 2,
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
    marginTop: 12,
    marginBottom: 4,
  },
  linkSmall: {
    color: '#666',
    fontSize: 12,
  },
  linkSmallTappable: {
    color: '#999',
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
    paddingVertical: 20,
    paddingHorizontal: 32,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    marginHorizontal: 16,
    marginBottom: 10,
  },
  streakNum: {
    fontSize: 156,         // 1.3倍（120→156）
    fontWeight: '900',
    color: '#fff',
    letterSpacing: -6,
    lineHeight: 156,
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
    backgroundColor: 'transparent',
    borderRadius: 0,
    padding: 4,
    marginBottom: 10,
    borderTopWidth: 1,
    borderTopColor: '#222222',
    borderBottomWidth: 1,
    borderBottomColor: '#222222',
    paddingVertical: 12,
  },
  goalTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#fff',
  },
  goalHash: {
    color: '#fff',
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
    borderRadius: 0,
    backgroundColor: 'transparent',
    alignItems: 'center',
  },
  statusVal: {
    fontSize: 18,
    fontWeight: '900',
    color: '#fff',
    marginBottom: 2,
  },
  statusValDone: {
    color: '#fff',
  },
  statusValPending: {
    color: '#fff',
  },
  statusLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#888',
  },
  recBtnWrapper: {
    alignSelf: 'center',
    padding: 20,
    borderRadius: 28,
    backgroundColor: 'rgba(15,15,15,0.65)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    marginVertical: 6,
  },
  recBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#8B0000',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
  },
  recBtnDone: {
    backgroundColor: '#1a1a1a',
  },
  recDoneLabel: {
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 6,
    fontSize: 11,
    fontWeight: '700',
    color: '#fff',
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
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  passBtnText: {
    color: '#fff',
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
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  passBuyBtnText: {
    color: '#fff',
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
  camTopBtnFlat: {
    width: 44,
    height: 44,
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
  // 録画秒数トグルのラベル
  camDurLabel: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.5,
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
    paddingBottom: 24,
  },
  previewCard: {
    width: '100%',
    aspectRatio: 9 / 16,
    overflow: 'hidden',
    backgroundColor: '#000000',
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
    width: 36,
    height: 36,
    borderColor: '#fff',
  },
  bracketTL: {
    top: 8,
    left: 8,
    borderTopWidth: 3,
    borderLeftWidth: 3,
    borderTopLeftRadius: 3,
  },
  bracketTR: {
    top: 8,
    right: 8,
    borderTopWidth: 3,
    borderRightWidth: 3,
    borderTopRightRadius: 3,
  },
  bracketBL: {
    bottom: 8,
    left: 8,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    borderBottomLeftRadius: 3,
  },
  bracketBR: {
    bottom: 8,
    right: 8,
    borderBottomWidth: 3,
    borderRightWidth: 3,
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
  previewExpiryHint: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.35)',
    textAlign: 'center',
    marginTop: 12,
    letterSpacing: 0.2,
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
    paddingHorizontal: 8,
    paddingTop: 16,
    paddingBottom: 32,
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
    color: '#888',
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
    borderColor: '#FF3333',
  },
  calDayNum: {
    fontSize: 17,
    color: '#aaa',
    fontWeight: '600',
  },
  calDayNumRecorded: {
    color: '#FFFFFF',
  },
  calCheck: {
    position: 'absolute',
    top: 0,
    right: 0,
  },
  calPassMark: {
    position: 'absolute',
    top: 2,
    right: 3,
    fontSize: 9,
    color: '#CC9900',
    fontWeight: '900',
  },
  // 複数スロット件数バッジ（カレンダーセル左下）
  calSlotBadge: {
    position: 'absolute',
    bottom: 2,
    left: 3,
    fontSize: 8,
    color: '#CC0000',
    fontWeight: '900',
  },

  // ── デイリー詳細シート ──
  dayDetailBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  dayDetailSheet: {
    backgroundColor: '#111',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 40,
    minHeight: 200,
  },
  dayDetailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1e1e1e',
  },
  dayDetailTitle: {
    flex: 1,
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 1,
  },
  dayDetailDayBadge: {
    color: '#8B0000',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    marginRight: 12,
  },
  dayDetailCloseBtn: {
    padding: 4,
  },
  dayDetailItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  dayDetailItemIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: 'rgba(139,0,0,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  dayDetailItemLabel: {
    flex: 1,
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  dayDetailItemActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  dayDetailDeleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(204,0,0,0.4)',
  },
  dayDetailDeleteText: {
    color: '#CC0000',
    fontSize: 12,
    fontWeight: '600',
  },
  dayDetailPassRow: {
    padding: 20,
    alignItems: 'center',
  },
  dayDetailPassText: {
    color: '#555',
    fontSize: 14,
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
  // Build 25: fontFamily: 'Menlo' を全削除。
  // Menlo は macOS 標準フォントだが iOS には搭載されていない。
  // StyleSheet.create() はモジュールパース時に同期実行されるため、
  // 未登録フォント名が UIFont.bestMatchingFontForCharacters: を呼び出し
  // iOS 18 のメインスレッド制約に抵触して SIGABRT を引き起こしていた。
  idTopLeft: {
    position: 'absolute',
    top: '12%',
    left: '5%',
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
    fontSize: 12,
    color: '#C8C8C8',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 4,
  },

  // ── Subscription info box (Apple Review 3.1.2(c) compliance) ──
  subscriptionInfoBox: {
    backgroundColor: '#111',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#333',
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 16,
    width: '100%',
  },
  subscriptionInfoTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 6,
    letterSpacing: 0.5,
  },
  subscriptionInfoDetail: {
    fontSize: 12,
    color: '#aaa',
    lineHeight: 18,
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
    backgroundColor: 'transparent',
    borderRadius: 0,
    padding: 4,
    paddingVertical: 14,
    marginBottom: 0,
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
  guideCardHighlight: {
    borderWidth: 1,
    borderColor: 'rgba(204,0,0,0.5)',
    backgroundColor: 'rgba(204,0,0,0.06)',
  },
  guideCardTitleHighlight: {
    color: '#CC0000',
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
  legalSectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
    marginTop: 4,
    marginBottom: 4,
  },
  legalDateText: {
    fontSize: 12,
    color: '#666',
    marginBottom: 12,
  },
  legalHeading: {
    fontSize: 14,
    fontWeight: '700',
    color: '#e0e0e0',
    marginTop: 16,
    marginBottom: 4,
  },
  legalBullet: {
    fontSize: 13,
    color: '#aaa',
    lineHeight: 22,
    paddingLeft: 12,
    marginBottom: 2,
  },
  legalBody: {
    fontSize: 13,
    color: '#aaa',
    lineHeight: 22,
    marginBottom: 2,
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

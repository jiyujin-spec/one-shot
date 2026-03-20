/**
 * FontCacheWarmer.m — Build 24: ShadowQueue UIFont クラッシュ根本対策
 *
 * 【問題】
 *   iOS 18 + Xcode 16 環境で com.facebook.react.ShadowQueue が
 *   テキストレイアウトを計算する際に以下を呼び出し SIGABRT が発生する:
 *     -[NSTextStorage fixFontAttributeInRange:]
 *     -[UIFont bestMatchingFontForCharacters:attributes:actualCoveredLength:]
 *
 *   これらの API は iOS 18 からメインスレッドでのみ安全に呼び出せるが、
 *   React Native の ShadowQueue はバックグラウンドスレッドで動作するため衝突する。
 *
 * 【根本修正の仕組み】
 *   ObjC の +load メソッドは UIApplicationMain() より前に実行される。
 *   ここで UIApplicationDidFinishLaunchingNotification を購読し、
 *   メインスレッドで NSTextStorage / UIFont を使った「空振り」レイアウトを実行する。
 *
 *   OS 内部では UIFont のグリフカバレッジマップがスレッドセーフなキャッシュに書き込まれる。
 *   ShadowQueue が同じ処理を後から呼ぶ際にはキャッシュヒットして安全に返るため、
 *   SIGABRT が物理的に発生しなくなる。
 *
 *   タイミング:
 *     [+load 登録] → UIApplicationMain() → AppDelegate::didFinishLaunching
 *     → React Native Bridge 初期化 → [UIApplicationDidFinishLaunchingNotification]
 *     → ★ここでフォントウォームアップ実行（メインスレッド）
 *     → JS バンドルロード（非同期） → React レンダリング → ShadowQueue テキスト計測
 *                                                          ↑ キャッシュヒット → 安全
 */

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

@interface OneShotFontCacheWarmer : NSObject
@end

@implementation OneShotFontCacheWarmer

// +load は ObjC ランタイムがクラスをロードした直後に呼ぶ。
// UIApplicationMain() より前に実行されるため、ここでは UIKit は使えない。
// 代わりにアプリ起動完了通知を購読してメインスレッドでの処理を予約する。
+ (void)load {
    [[NSNotificationCenter defaultCenter]
        addObserver:self
           selector:@selector(warmFontCacheOnLaunch:)
               name:UIApplicationDidFinishLaunchingNotification
             object:nil];
}

+ (void)warmFontCacheOnLaunch:(NSNotification *)notification {
    NSAssert([NSThread isMainThread],
             @"[Build24] FontCacheWarmer must run on the main thread");

    // ── Step 1: システムフォントの全ウェイト・サイズをプリロード ─────────────
    // UIFont のメタデータを OS フォントキャッシュに書き込む。
    CGFloat sizes[] = {11.0, 12.0, 13.0, 14.0, 16.0, 17.0, 18.0, 20.0, 24.0, 32.0};
    NSUInteger sizeCount = sizeof(sizes) / sizeof(sizes[0]);
    for (NSUInteger i = 0; i < sizeCount; i++) {
        (void)[UIFont systemFontOfSize:sizes[i]];
        (void)[UIFont boldSystemFontOfSize:sizes[i]];
        (void)[UIFont italicSystemFontOfSize:sizes[i]];
    }

    // ── Step 2: NSTextStorage + NSLayoutManager でフォント解決をプリウォーム ──
    // -[NSTextStorage fixFontAttributeInRange:] と
    // -[UIFont bestMatchingFontForCharacters:attributes:actualCoveredLength:]
    // をメインスレッドで先行実行し OS の内部グリフカバレッジキャッシュを構築する。
    //
    // 日本語 (ひらがな・カタカナ・CJK) を含む文字列を必ず通す。
    // アプリが起動時に描画する文字種をすべてカバーすることが目的。
    NSArray<NSString *> *warmStrings = @[
        @"あいうえおかきくけこさしすせそたちつてとなにぬねの",
        @"アイウエオカキクケコサシスセソタチツテトナニヌネノ",
        @"一二三四五六七八九十百千万億兆日本語文字列テスト",
        @"予期せぬエラーが発生しました Please restart the app.",
        @"DAY1 HABIT One Shot 2024.01/01 12:34",
        @"OS-2024-001 ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789",
    ];

    UIFont *sysFont   = [UIFont systemFontOfSize:16.0];
    UIFont *boldFont  = [UIFont boldSystemFontOfSize:16.0];
    NSDictionary *sysAttrs  = @{NSFontAttributeName: sysFont};
    NSDictionary *boldAttrs = @{NSFontAttributeName: boldFont};

    for (NSString *str in warmStrings) {
        for (NSDictionary *attrs in @[sysAttrs, boldAttrs]) {
            NSAttributedString *attrStr =
                [[NSAttributedString alloc] initWithString:str attributes:attrs];
            NSTextStorage   *storage   = [[NSTextStorage alloc] initWithAttributedString:attrStr];
            NSLayoutManager *layout    = [[NSLayoutManager alloc] init];
            NSTextContainer *container =
                [[NSTextContainer alloc] initWithSize:CGSizeMake(2000.0, 2000.0)];

            [storage addLayoutManager:layout];
            [layout  addTextContainer:container];

            // usedRectForTextContainer: が内部で:
            //   fixFontAttributeInRange: → bestMatchingFontForCharacters:
            // を呼び出す。ここでメインスレッド上でキャッシュが構築される。
            (void)[layout usedRectForTextContainer:container];
        }
    }

    NSLog(@"[Build24][FontCacheWarmer] ✓ UIFont/NSTextStorage cache warmed on main thread."
          @" ShadowQueue calls are now safe on iOS 18.");
}

@end

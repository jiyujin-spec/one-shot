/**
 * RCTFatalInterceptor.m — Build 25: ExceptionsManagerQueue SIGABRT 完全防止
 *
 * 【問題】
 *   iOS 18 + Xcode 16 環境で、JS 例外が ExceptionsManager に報告される際、
 *   RCTFatal() がデフォルトで abort() を呼び出し SIGABRT が発生する。
 *   クラッシュログ上は ShadowQueue の fontAttribute 解決中に見えるが、
 *   これは abort() シグナルが届いた瞬間に ShadowQueue がそこにいただけ（赤いニシン）。
 *
 * 【仕組み】
 *   アプリ起動後 5 秒間の「起動ウィンドウ」内に限り、RCTSetFatalHandler で
 *   カスタムハンドラを設定して abort() を抑制する。
 *   このウィンドウ内に発生した JS Fatal はログ出力のみ行い、
 *   AppErrorBoundary が React レンダーエラーを表示する猶予を与える。
 *
 *   5 秒後はデフォルト動作を復元するため、通常の起動後 JS Fatal は
 *   引き続きクラッシュとして記録される（診断可能）。
 *
 * 【タイミング】
 *   [+load 登録]
 *     → UIApplicationDidFinishLaunchingNotification
 *     → ★ RCTSetFatalHandler 登録（起動ウィンドウ開始）
 *     → JS バンドルロード → React レンダリング（← この間に発生した Fatal を捕捉）
 *     → 5秒後: デフォルト復元（起動ウィンドウ終了）
 *
 * 【注意】
 *   このファイルは modules/video-overlay/ios/ に置くことで
 *   VideoOverlay.podspec の "ios/ ** / *.{h,m,mm,...}" グロブにより
 *   自動的にビルドターゲットへ取り込まれる。明示的な呼び出しは不要。
 */

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

// RCTAssert.h から型定義のみ流用（ヘッダ全体のインポートを避ける）
typedef void (^RCTFatalHandler)(NSError *error);
extern void RCTSetFatalHandler(RCTFatalHandler fatalHandler);

static const NSTimeInterval kStartupWindowSeconds = 5.0;

@interface OneShotFatalInterceptor : NSObject
@end

@implementation OneShotFatalInterceptor

// +load は ObjC ランタイムがクラスをロードした直後に呼ばれる。
// UIApplicationMain() より前なので UIKit は未初期化。
// ここでは通知のみ登録し、実際のインストールを didFinishLaunching 後に行う。
+ (void)load {
    [[NSNotificationCenter defaultCenter]
        addObserver:self
           selector:@selector(onAppDidFinishLaunching:)
               name:UIApplicationDidFinishLaunchingNotification
             object:nil];
}

+ (void)onAppDidFinishLaunching:(NSNotification *)notification {
    NSAssert([NSThread isMainThread],
             @"[Build25] FatalInterceptor must install handler on the main thread");

    __block BOOL startupWindowOpen = YES;

    // 5 秒後に起動ウィンドウを閉じ、デフォルト動作を復元する
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kStartupWindowSeconds * NSEC_PER_SEC)),
        dispatch_get_main_queue(),
        ^{
            startupWindowOpen = NO;
            RCTSetFatalHandler(nil); // nil = React Native デフォルト動作に戻す
            NSLog(@"[Build25][FatalInterceptor] Startup window closed. "
                  @"Default fatal handler restored.");
        }
    );

    RCTSetFatalHandler(^(NSError *error) {
        if (startupWindowOpen) {
            // 起動ウィンドウ内: abort() を呼ばず、エラー内容をログに残す。
            // JS Fatal が何者かを次ビルドで特定するための情報源となる。
            NSLog(@"[Build25][FatalInterceptor] *** JS Fatal intercepted during startup "
                  @"(SIGABRT suppressed) ***\n"
                  @"  Description : %@\n"
                  @"  Domain      : %@\n"
                  @"  Code        : %ld\n"
                  @"  UserInfo    : %@",
                  error.localizedDescription,
                  error.domain,
                  (long)error.code,
                  error.userInfo);
            // abort() を呼ばない → SIGABRT は発生しない
            // AppErrorBoundary がフォールバック UI を表示する
        } else {
            // 起動ウィンドウ外: 通常の Fatal はクラッシュさせて診断を容易にする
            NSLog(@"[Build25][FatalInterceptor] JS Fatal outside startup window — aborting.");
            abort();
        }
    });

    NSLog(@"[Build25][FatalInterceptor] Startup fatal handler installed "
          @"(%.0f-second window). SIGABRT guard active.",
          kStartupWindowSeconds);
}

@end

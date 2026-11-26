//! 隐私相关的原生桥。
//!
//! macOS 系统锁屏不会必然触发 WebView 的 `blur`/`visibilitychange`，因此额外
//! 监听系统分布式通知 `com.apple.screenIsLocked` / `com.apple.screenIsUnlocked`，
//! 通过 Tauri 事件通知前端立即覆盖窗口。前端只消费“已锁定”事件；解锁事件
//! 不用于自动揭开遮挡，恢复仍需用户显式点击。
//!
//! 这里只注册系统通知，不读取屏幕内容、不申请额外 TCC 权限，也不写日志内容。
//!
//! 上游参考：
//! - Apple `NSDistributedNotificationCenter`
//!   https://developer.apple.com/documentation/foundation/nsdistributednotificationcenter
//! - 锁屏/解锁通知名采用 macOS 长期使用的
//!   `com.apple.screenIsLocked` / `com.apple.screenIsUnlocked`；
//! - 窗口聚焦事件参考 Tauri Window `onFocusChanged`（使用方为前端 hook）。
//! - 不承诺防截屏：Apple 已把 `NSWindow.SharingType.none` 标为 legacy，
//!   Tauri `setContentProtected` 在 macOS 也不能作为可靠承诺。

#[cfg(target_os = "macos")]
pub fn install_screen_lock_watcher(app: &tauri::AppHandle) {
    use block2::RcBlock;
    use core::ptr::NonNull;
    use objc2_foundation::{
        NSDistributedNotificationCenter, NSNotification, NSOperationQueue, NSString,
    };
    use tauri::Emitter;

    let center = NSDistributedNotificationCenter::defaultCenter();
    let queue = NSOperationQueue::mainQueue();
    let notifications = [
        ("com.apple.screenIsLocked", "privacy://screen-locked"),
        ("com.apple.screenIsUnlocked", "privacy://screen-unlocked"),
    ];

    for (name, event_name) in notifications {
        let handle = app.clone();
        let block = RcBlock::new(move |_notification: NonNull<NSNotification>| {
            // 事件本身不携带任务/笔记内容；前端据此只切换遮挡状态。
            let _ = handle.emit(event_name, ());
        });
        let notification_name = NSString::from_str(name);
        let observer = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(&notification_name),
                None,
                Some(&queue),
                &block,
            )
        };
        // block-based observer 由通知中心强引用；token 需活到进程结束。
        // 这里显式保留，避免应用运行期间被释放后失去锁屏通知。
        std::mem::forget(observer);
    }

    log::info!("privacy screen lock watcher installed");
}

#[cfg(not(target_os = "macos"))]
pub fn install_screen_lock_watcher(_app: &tauri::AppHandle) {
    // 其他平台由窗口失焦 / Page Visibility 覆盖；不伪造系统锁屏事件。
}

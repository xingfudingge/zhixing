// ZX-UX-01 真实鼠标拖拽辅助：用 CoreGraphics 向 Tauri 窗口发送系统级鼠标事件。
// 坐标由 Node 侧根据探针返回的 viewport rect + CGWindow 边界换算成屏幕点。
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>

static NSString *arg(NSString *name) {
    NSArray<NSString *> *args = NSProcessInfo.processInfo.arguments;
    NSUInteger index = [args indexOfObject:name];
    if (index == NSNotFound || index + 1 >= args.count) {
        return nil;
    }
    return args[index + 1];
}

static double num(NSString *name) {
    NSString *raw = arg(name);
    return raw == nil ? NAN : raw.doubleValue;
}

static void emit(NSDictionary *payload) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

static CGPoint cursorLocation(void) {
    CGEventRef event = CGEventCreate(NULL);
    CGPoint point = CGEventGetLocation(event);
    CFRelease(event);
    return point;
}

static pid_t gPid = 0;
static BOOL gTrusted = NO;

static void postMouse(CGEventType type, CGPoint point) {
    CGEventRef event = CGEventCreateMouseEvent(
        NULL, type, point, kCGMouseButtonLeft);
    CGEventSetIntegerValueField(event, kCGMouseEventClickState, 1);
    if (gTrusted) {
        CGEventPost(kCGHIDEventTap, event);
    } else {
        // 无辅助功能权限时全局 HID 注入会被系统丢弃；
        // 直接投递到目标进程，事件仍进入该窗口的事件队列。
        CGEventPostToPid(gPid, event);
    }
    CFRelease(event);
}

static double distance(CGPoint a, CGPoint b) {
    return hypot(a.x - b.x, a.y - b.y);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        BOOL trusted = AXIsProcessTrusted();
        NSString *pidRaw = arg(@"--pid");
        if (pidRaw == nil) {
            emit(@{@"ok": @NO, @"error": @"missing --pid", @"trusted": @(trusted)});
            return 2;
        }
        pid_t pid = (pid_t)pidRaw.intValue;
        gPid = pid;
        gTrusted = trusted;

        CFArrayRef windows = CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID);
        CGRect best = CGRectNull;
        for (NSDictionary *window in (__bridge NSArray *)windows) {
            NSNumber *owner = window[(id)kCGWindowOwnerPID];
            if (owner.intValue != pid) {
                continue;
            }
            NSNumber *layer = window[(id)kCGWindowLayer];
            if (layer.intValue != 0) {
                continue;
            }
            NSDictionary *bounds = window[(id)kCGWindowBounds];
            CGRect rect;
            if (CGRectMakeWithDictionaryRepresentation(
                    (__bridge CFDictionaryRef)bounds, &rect)) {
                if (CGRectIsNull(best) ||
                    rect.size.width * rect.size.height >
                        best.size.width * best.size.height) {
                    best = rect;
                }
            }
        }
        CFRelease(windows);

        if (CGRectIsNull(best)) {
            emit(@{
                @"ok": @NO,
                @"error": @"window-not-found",
                @"trusted": @(trusted),
                @"pid": @(pid),
            });
            return 3;
        }

        NSRunningApplication *app =
            [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
        [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
        usleep(500000);

        NSString *mode = arg(@"--mode") ?: @"bounds";
        if ([mode isEqualToString:@"bounds"]) {
            CGPoint cursor = cursorLocation();
            emit(@{
                @"ok": @YES,
                @"trusted": @(trusted),
                @"bounds": @{
                    @"x": @(best.origin.x),
                    @"y": @(best.origin.y),
                    @"width": @(best.size.width),
                    @"height": @(best.size.height),
                },
                @"cursor": @{@"x": @(cursor.x), @"y": @(cursor.y)},
            });
            return 0;
        }

        double viewportX = num(@"--x");
        double viewportY = num(@"--y");
        double targetX = num(@"--tx");
        double targetY = num(@"--ty");
        double innerWidth = num(@"--inner-width");
        double innerHeight = num(@"--inner-height");
        if ([mode isEqualToString:@"drag"] &&
            !(isnan(viewportX) || isnan(viewportY) || isnan(targetX) ||
              isnan(targetY) || isnan(innerWidth) || isnan(innerHeight))) {
            // DOM client 坐标是视口左上角；CGWindow 边界含标题栏。
            double contentX = best.origin.x + (best.size.width - innerWidth) / 2.0;
            double contentY = best.origin.y + (best.size.height - innerHeight);
            CGPoint start = CGPointMake(contentX + viewportX, contentY + viewportY);
            CGPoint end = CGPointMake(contentX + targetX, contentY + targetY);

            postMouse(kCGEventMouseMoved, start);
            usleep(180000);
            CGPoint cursorAtStart = cursorLocation();

            postMouse(kCGEventLeftMouseDown, start);
            usleep(180000);
            const int steps = 18;
            for (int index = 1; index <= steps; index++) {
                double t = (double)index / (double)steps;
                CGPoint point = CGPointMake(
                    start.x + (end.x - start.x) * t,
                    start.y + (end.y - start.y) * t);
                postMouse(kCGEventLeftMouseDragged, point);
                usleep(28000);
            }
            usleep(120000);
            postMouse(kCGEventLeftMouseUp, end);
            usleep(220000);
            CGPoint cursorAtEnd = cursorLocation();

            BOOL moved = distance(cursorAtStart, start) < 2.0 &&
                         distance(cursorAtEnd, end) < 2.0;
            emit(@{
                @"ok": @YES,
                @"trusted": @(trusted),
                @"dispatch": trusted ? @"cghid" : @"pid",
                @"bounds": @{
                    @"x": @(best.origin.x),
                    @"y": @(best.origin.y),
                    @"width": @(best.size.width),
                    @"height": @(best.size.height),
                },
                @"contentOrigin": @{@"x": @(contentX), @"y": @(contentY)},
                @"start": @{@"x": @(start.x), @"y": @(start.y)},
                @"end": @{@"x": @(end.x), @"y": @(end.y)},
                @"cursorAtStart": @{@"x": @(cursorAtStart.x), @"y": @(cursorAtStart.y)},
                @"cursorAtEnd": @{@"x": @(cursorAtEnd.x), @"y": @(cursorAtEnd.y)},
                @"moved": @(moved),
            });
            return 0;
        }

        emit(@{@"ok": @NO, @"error": @"missing drag args", @"trusted": @(trusted)});
        return 2;
    }
}

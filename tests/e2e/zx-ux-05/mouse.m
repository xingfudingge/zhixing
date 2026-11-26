// ZX-UX-05 真实鼠标/窗口辅助：
// * bounds：返回 Tauri 窗口的屏幕边界、Window ID 与 viewport 尺寸；
// * move：把系统鼠标移动到视口坐标，用于触发真实 :hover。
// 无辅助功能权限时退化为 CGEventPostToPid（仍投递给目标窗口）。
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

static pid_t gPid = 0;
static BOOL gTrusted = NO;

static void postMouse(CGEventType type, CGPoint point) {
    CGEventRef event = CGEventCreateMouseEvent(
        NULL, type, point, kCGMouseButtonLeft);
    CGEventSetIntegerValueField(event, kCGMouseEventClickState, 1);
    if (gTrusted) {
        CGEventPost(kCGHIDEventTap, event);
    } else {
        CGEventPostToPid(gPid, event);
    }
    CFRelease(event);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        BOOL trusted = AXIsProcessTrusted();
        NSString *pidRaw = arg(@"--pid");
        if (pidRaw == nil) {
            emit(@{@"ok": @NO, @"error": @"missing --pid", @"trusted": @(trusted)});
            return 2;
        }
        gPid = (pid_t)pidRaw.intValue;
        gTrusted = trusted;

        CFArrayRef windows = CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID);
        CGRect best = CGRectNull;
        CGWindowID bestNumber = 0;
        for (NSDictionary *window in (__bridge NSArray *)windows) {
            NSNumber *owner = window[(id)kCGWindowOwnerPID];
            if (owner.intValue != gPid) {
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
                    bestNumber = [window[(id)kCGWindowNumber] unsignedIntValue];
                }
            }
        }
        CFRelease(windows);

        if (CGRectIsNull(best)) {
            emit(@{
                @"ok": @NO,
                @"error": @"window-not-found",
                @"trusted": @(trusted),
                @"pid": @(gPid),
            });
            return 3;
        }

        NSRunningApplication *app =
            [NSRunningApplication runningApplicationWithProcessIdentifier:gPid];
        [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
        usleep(400000);

        NSString *mode = arg(@"--mode") ?: @"bounds";
        double innerWidth = num(@"--inner-width");
        double innerHeight = num(@"--inner-height");
        if (isnan(innerWidth)) innerWidth = best.size.width;
        if (isnan(innerHeight)) innerHeight = best.size.height;
        double contentX = best.origin.x + (best.size.width - innerWidth) / 2.0;
        double contentY = best.origin.y + (best.size.height - innerHeight);

        if ([mode isEqualToString:@"bounds"]) {
            emit(@{
                @"ok": @YES,
                @"trusted": @(trusted),
                @"windowId": @(bestNumber),
                @"bounds": @{
                    @"x": @(best.origin.x),
                    @"y": @(best.origin.y),
                    @"width": @(best.size.width),
                    @"height": @(best.size.height),
                    @"contentX": @(contentX),
                    @"contentY": @(contentY),
                },
            });
            return 0;
        }

        if ([mode isEqualToString:@"key"]) {
            CGKeyCode keyCode = (CGKeyCode)num(@"--keycode");
            BOOL shift = num(@"--shift") == 1;
            CGEventRef down = CGEventCreateKeyboardEvent(NULL, keyCode, true);
            CGEventRef up = CGEventCreateKeyboardEvent(NULL, keyCode, false);
            if (shift) {
                CGEventSetFlags(down, kCGEventFlagMaskShift);
                CGEventSetFlags(up, kCGEventFlagMaskShift);
            }
            if (gTrusted) {
                CGEventPost(kCGHIDEventTap, down);
                CGEventPost(kCGHIDEventTap, up);
            } else {
                CGEventPostToPid(gPid, down);
                CGEventPostToPid(gPid, up);
            }
            CFRelease(down);
            CFRelease(up);
            usleep(220000);
            emit(@{
                @"ok": @YES,
                @"trusted": @(trusted),
                @"mode": @"key",
                @"keycode": @(keyCode),
                @"shift": @(shift),
            });
            return 0;
        }

        double x = num(@"--x");
        double y = num(@"--y");
        if (isnan(x) || isnan(y)) {
            emit(@{@"ok": @NO, @"error": @"missing --x/--y", @"trusted": @(trusted)});
            return 4;
        }
        CGPoint point = CGPointMake(contentX + x, contentY + y);
        if ([mode isEqualToString:@"move"]) {
            // CGWarp 负责把系统光标真正放到目标点，让 WebKit 依据全局
            // 光标位置更新 :hover；事件再投递给目标进程作补充。
            CGWarpMouseCursorPosition(point);
            usleep(120000);
            postMouse(kCGEventMouseMoved, point);
            // 再投递一次全局 HID 事件，让 WKWebView 重新做命中测试并更新
            // :hover；无辅助功能权限时系统会丢弃，不影响后续回退。
            CGEventRef global = CGEventCreateMouseEvent(
                NULL, kCGEventMouseMoved, point, kCGMouseButtonLeft);
            CGEventPost(kCGHIDEventTap, global);
            CFRelease(global);
            usleep(350000);
            CGEventRef event = CGEventCreate(NULL);
            CGPoint cursor = CGEventGetLocation(event);
            CFRelease(event);
            emit(@{
                @"ok": @YES,
                @"trusted": @(trusted),
                @"mode": @"move",
                @"target": @{@"x": @(point.x), @"y": @(point.y)},
                @"cursor": @{@"x": @(cursor.x), @"y": @(cursor.y)},
            });
            return 0;
        }
        if ([mode isEqualToString:@"click"]) {
            postMouse(kCGEventMouseMoved, point);
            usleep(120000);
            postMouse(kCGEventLeftMouseDown, point);
            usleep(90000);
            postMouse(kCGEventLeftMouseUp, point);
            // 同时尝试全局 HID 点击：无辅助功能权限时会被系统丢弃，
            // 有权限时能让窗口真正成为 key window（:focus/:hover 生效）。
            CGEventRef globalDown = CGEventCreateMouseEvent(
                NULL, kCGEventLeftMouseDown, point, kCGMouseButtonLeft);
            CGEventRef globalUp = CGEventCreateMouseEvent(
                NULL, kCGEventLeftMouseUp, point, kCGMouseButtonLeft);
            CGEventPost(kCGHIDEventTap, globalDown);
            CGEventPost(kCGHIDEventTap, globalUp);
            CFRelease(globalDown);
            CFRelease(globalUp);
            usleep(250000);
            emit(@{
                @"ok": @YES,
                @"trusted": @(trusted),
                @"mode": @"click",
                @"target": @{@"x": @(point.x), @"y": @(point.y)},
            });
            return 0;
        }
        emit(@{@"ok": @NO, @"error": @"unknown --mode", @"trusted": @(trusted)});
        return 5;
    }
}

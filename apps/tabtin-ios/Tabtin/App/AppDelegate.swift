import UIKit
import UserNotifications

/// UIKit 生命周期挂点：注册原生 APNs token，并接收系统通知点击回调。
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        #if !targetEnvironment(simulator)
        Task { @MainActor in
            let settings = await center.notificationSettings()
            if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
                application.registerForRemoteNotifications()
            }
        }
        #endif
        return true
    }

    #if !targetEnvironment(simulator)
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in
            PushService.shared.handleAPNsDeviceToken(deviceToken)
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NSLog("[Push] APNs register failed: %@", error.localizedDescription)
    }
    #endif
}

extension AppDelegate: @preconcurrency UNUserNotificationCenterDelegate {
    /// App 在前台时由实时链路更新界面，不重复展示系统横幅。
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        []
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard let ext = APNsPushPayload.extensionJSON(
            from: response.notification.request.content.userInfo
        ) else { return }
        await MainActor.run {
            PushService.shared.handleNotificationExt(ext)
        }
    }
}

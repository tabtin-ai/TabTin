package com.tabtin.mobile.data.automation

import com.tabtin.mobile.data.automation.handlers.AutomationStatusHandler
import com.tabtin.mobile.data.automation.handlers.BatteryInfoHandler
import com.tabtin.mobile.data.automation.handlers.DeviceInfoHandler
import com.tabtin.mobile.data.automation.handlers.NetworkInfoHandler
import com.tabtin.mobile.data.automation.handlers.l1.AppListHandler
import com.tabtin.mobile.data.automation.handlers.l1.CalendarReadHandler
import com.tabtin.mobile.data.automation.handlers.l1.CallLogHandler
import com.tabtin.mobile.data.automation.handlers.l1.ContactsReadHandler
import com.tabtin.mobile.data.automation.handlers.l1.ContactsSearchHandler
import com.tabtin.mobile.data.automation.handlers.l1.LocationHandler
import com.tabtin.mobile.data.automation.handlers.l1.MediaReadHandler
import com.tabtin.mobile.data.automation.handlers.l1.NotificationReadHandler
import com.tabtin.mobile.data.automation.handlers.l1.MakeCallHandler
import com.tabtin.mobile.data.automation.handlers.l1.SmsSendHandler
import com.tabtin.mobile.data.automation.handlers.l1.SmsReadHandler
import com.tabtin.mobile.data.automation.handlers.l2.GetSystemSettingHandler
import com.tabtin.mobile.data.automation.handlers.l2.ScreenCaptureHandler
import com.tabtin.mobile.data.automation.handlers.l2.ScreenForceStopAppHandler
import com.tabtin.mobile.data.automation.handlers.l2.ScreenKeyEventHandler
import com.tabtin.mobile.data.automation.handlers.l2.ScreenLaunchAppHandler
import com.tabtin.mobile.data.automation.handlers.l2.ScreenLongPressHandler
import com.tabtin.mobile.data.automation.handlers.l2.ScreenOpenAppHandler
import com.tabtin.mobile.data.automation.handlers.l2.ScreenSnapshotHandler
import com.tabtin.mobile.data.automation.handlers.l2.ScreenSwipeHandler
import com.tabtin.mobile.data.automation.handlers.l2.ScreenFindElementHandler
import com.tabtin.mobile.data.automation.handlers.l2.ScreenGetContextHandler
import com.tabtin.mobile.data.automation.handlers.l2.ScreenLongPressElementHandler
import com.tabtin.mobile.data.automation.handlers.l2.ScreenTapElementHandler
import com.tabtin.mobile.data.automation.handlers.l2.ScreenTapAreaHandler
import com.tabtin.mobile.data.automation.handlers.l2.ScreenTapHandler
import com.tabtin.mobile.data.automation.handlers.l2.ScreenTypeInElementHandler
import com.tabtin.mobile.data.automation.handlers.l2.ScreenTypeTextHandler
import com.tabtin.mobile.data.automation.handlers.l2.ScreenUiTreeHandler
import com.tabtin.mobile.data.automation.handlers.l2.ScreenWaitForElementHandler
import com.tabtin.mobile.data.automation.handlers.l2.ScreenWaitForIdleHandler
import com.tabtin.mobile.data.automation.handlers.l2.LaunchWithIntentHandler
import com.tabtin.mobile.data.automation.handlers.l2.SaveToDeviceHandler
import com.tabtin.mobile.data.automation.handlers.l2.SetStealthModeHandler
import com.tabtin.mobile.data.automation.handlers.l2.SetSystemSettingHandler
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import dagger.multibindings.IntoSet

@Module
@InstallIn(SingletonComponent::class)
internal abstract class ActionHandlerModule {

    // L0: zero-permission handlers
    @Binds @IntoSet public abstract fun deviceInfo(h: DeviceInfoHandler): ActionHandler
    @Binds @IntoSet public abstract fun batteryInfo(h: BatteryInfoHandler): ActionHandler
    @Binds @IntoSet public abstract fun networkInfo(h: NetworkInfoHandler): ActionHandler
    @Binds @IntoSet public abstract fun automationStatus(h: AutomationStatusHandler): ActionHandler

    // L1: standard-permission handlers
    @Binds @IntoSet public abstract fun contactsRead(h: ContactsReadHandler): ActionHandler
    @Binds @IntoSet public abstract fun contactsSearch(h: ContactsSearchHandler): ActionHandler
    @Binds @IntoSet public abstract fun smsRead(h: SmsReadHandler): ActionHandler
    @Binds @IntoSet public abstract fun smsSend(h: SmsSendHandler): ActionHandler
    @Binds @IntoSet public abstract fun callLog(h: CallLogHandler): ActionHandler
    @Binds @IntoSet public abstract fun makeCall(h: MakeCallHandler): ActionHandler
    @Binds @IntoSet public abstract fun calendarRead(h: CalendarReadHandler): ActionHandler
    @Binds @IntoSet public abstract fun notificationRead(h: NotificationReadHandler): ActionHandler
    @Binds @IntoSet public abstract fun appList(h: AppListHandler): ActionHandler
    @Binds @IntoSet public abstract fun location(h: LocationHandler): ActionHandler
    @Binds @IntoSet public abstract fun mediaRead(h: MediaReadHandler): ActionHandler

    // L2: privileged-process handlers (screen automation)
    @Binds @IntoSet public abstract fun screenCapture(h: ScreenCaptureHandler): ActionHandler
    @Binds @IntoSet public abstract fun screenSnapshot(h: ScreenSnapshotHandler): ActionHandler
    @Binds @IntoSet public abstract fun screenUiTree(h: ScreenUiTreeHandler): ActionHandler
    @Binds @IntoSet public abstract fun screenTap(h: ScreenTapHandler): ActionHandler
    @Binds @IntoSet public abstract fun screenTapArea(h: ScreenTapAreaHandler): ActionHandler
    @Binds @IntoSet public abstract fun screenSwipe(h: ScreenSwipeHandler): ActionHandler
    @Binds @IntoSet public abstract fun screenLongPress(h: ScreenLongPressHandler): ActionHandler
    @Binds @IntoSet public abstract fun screenTypeText(h: ScreenTypeTextHandler): ActionHandler
    @Binds @IntoSet public abstract fun screenKeyEvent(h: ScreenKeyEventHandler): ActionHandler
    @Binds @IntoSet public abstract fun screenWaitForIdle(h: ScreenWaitForIdleHandler): ActionHandler
    @Binds @IntoSet public abstract fun screenTapElement(h: ScreenTapElementHandler): ActionHandler
    @Binds @IntoSet public abstract fun screenLongPressElement(h: ScreenLongPressElementHandler): ActionHandler
    @Binds @IntoSet public abstract fun screenTypeInElement(h: ScreenTypeInElementHandler): ActionHandler
    @Binds @IntoSet public abstract fun screenFindElement(h: ScreenFindElementHandler): ActionHandler
    @Binds @IntoSet public abstract fun screenGetContext(h: ScreenGetContextHandler): ActionHandler
    @Binds @IntoSet public abstract fun screenWaitForElement(h: ScreenWaitForElementHandler): ActionHandler
    @Binds @IntoSet public abstract fun screenLaunchApp(h: ScreenLaunchAppHandler): ActionHandler
    @Binds @IntoSet public abstract fun screenOpenApp(h: ScreenOpenAppHandler): ActionHandler
    @Binds @IntoSet public abstract fun screenForceStopApp(h: ScreenForceStopAppHandler): ActionHandler
    @Binds @IntoSet public abstract fun setSystemSetting(h: SetSystemSettingHandler): ActionHandler
    @Binds @IntoSet public abstract fun getSystemSetting(h: GetSystemSettingHandler): ActionHandler
    @Binds @IntoSet public abstract fun setStealthMode(h: SetStealthModeHandler): ActionHandler
    @Binds @IntoSet public abstract fun launchWithIntent(h: LaunchWithIntentHandler): ActionHandler
    @Binds @IntoSet public abstract fun saveToDevice(h: SaveToDeviceHandler): ActionHandler
}

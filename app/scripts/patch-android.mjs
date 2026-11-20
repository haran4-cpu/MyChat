// After `npx cap add android`: let mychat:// links open the app (the Google / OpenRouter sign-in returns through one).
import fs from "node:fs";
const f = "android/app/src/main/AndroidManifest.xml";
let x = fs.readFileSync(f, "utf8");
if (!x.includes('android:scheme="mychat"')) {
  const filter = `
            <intent-filter android:autoVerify="false">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="mychat" />
            </intent-filter>
        </activity>`;
  x = x.replace("</activity>", filter);
  fs.writeFileSync(f, x);
}
console.log("manifest:", x.includes('android:scheme="mychat"') ? "mychat:// links enabled" : "PATCH FAILED");
if (!x.includes('android:scheme="mychat"')) process.exit(1);

// ---------------------------------------------------------------- keep working when the screen is off or the app is in the background
// Android pauses a backgrounded app's WebView and may kill it. While a long task runs (deep read, agent), MyChat starts a
// small foreground service (a quiet "MyChat is working…" notification + wake lock) and keeps the WebView's timers running;
// when the task ends it posts "Answer ready" and stops. Plugin name: KeepAlive (start/stop/done).
const pkgDir = "android/app/src/main/java/il/mychat";
fs.mkdirSync(pkgDir, { recursive: true });
fs.writeFileSync(`${pkgDir}/MainActivity.java`, `package il.mychat;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(KeepAlivePlugin.class);
    super.onCreate(savedInstanceState);
  }

  @Override
  public void onPause() {
    super.onPause();
    // a task is running: keep JavaScript going instead of freezing it until the app comes back
    if (KeepAliveService.running && getBridge() != null && getBridge().getWebView() != null) {
      getBridge().getWebView().onResume();
      getBridge().getWebView().resumeTimers();
    }
  }
}
`);
fs.writeFileSync(`${pkgDir}/KeepAlivePlugin.java`, `package il.mychat;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Notification;
import android.content.Intent;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "KeepAlive")
public class KeepAlivePlugin extends Plugin {
  @PluginMethod
  public void start(PluginCall call) {
    Intent i = new Intent(getContext(), KeepAliveService.class);
    i.putExtra("text", call.getString("text", "MyChat is working…"));
    // Android 13+: ask once to show notifications (the task still runs if the answer is no; only the notice is hidden)
    if (Build.VERSION.SDK_INT >= 33 && getActivity() != null
        && getContext().checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED
        && !getContext().getSharedPreferences("mychat", 0).getBoolean("askedNotify", false)) {
      getContext().getSharedPreferences("mychat", 0).edit().putBoolean("askedNotify", true).apply();
      getActivity().requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 41);
    }
    try {
      if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(i); else getContext().startService(i);
      call.resolve();
    } catch (Exception e) { call.reject(e.getMessage()); }
  }

  @PluginMethod
  public void stop(PluginCall call) {
    getContext().stopService(new Intent(getContext(), KeepAliveService.class));
    call.resolve();
  }

  @PluginMethod
  public void done(PluginCall call) {
    getContext().stopService(new Intent(getContext(), KeepAliveService.class));
    if (call.getBoolean("notify", true)) {
      NotificationManager nm = (NotificationManager) getContext().getSystemService(android.content.Context.NOTIFICATION_SERVICE);
      if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(new NotificationChannel("mychat_done", "MyChat answers", NotificationManager.IMPORTANCE_DEFAULT));
      Intent open = new Intent(getContext(), MainActivity.class);
      open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
      PendingIntent pi = PendingIntent.getActivity(getContext(), 1, open, PendingIntent.FLAG_IMMUTABLE);
      Notification.Builder nb = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(getContext(), "mychat_done") : new Notification.Builder(getContext());
      nm.notify(8, nb.setContentTitle("MyChat").setContentText(call.getString("text", "Your answer is ready"))
        .setSmallIcon(android.R.drawable.stat_sys_download_done).setContentIntent(pi).setAutoCancel(true).build());
    }
    call.resolve();
  }
}
`);
fs.writeFileSync(`${pkgDir}/KeepAliveService.java`, `package il.mychat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

public class KeepAliveService extends Service {
  static volatile boolean running = false;
  private PowerManager.WakeLock lock;

  @Override
  public IBinder onBind(Intent intent) { return null; }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    String text = intent != null && intent.getStringExtra("text") != null ? intent.getStringExtra("text") : "MyChat is working…";
    NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
    if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(new NotificationChannel("mychat_work", "MyChat tasks", NotificationManager.IMPORTANCE_LOW));
    Intent open = new Intent(this, MainActivity.class);
    open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
    Notification.Builder nb = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, "mychat_work") : new Notification.Builder(this);
    Notification n = nb.setContentTitle("MyChat").setContentText(text).setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentIntent(pi).setOngoing(true).build();
    if (Build.VERSION.SDK_INT >= 29) startForeground(7, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC); else startForeground(7, n);
    if (lock == null) {
      lock = ((PowerManager) getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "mychat:work");
      lock.acquire(60 * 60 * 1000L);   // at most one hour per task
    }
    running = true;
    return START_NOT_STICKY;
  }

  @Override
  public void onDestroy() {
    running = false;
    if (lock != null && lock.isHeld()) lock.release();
    lock = null;
    super.onDestroy();
  }
}
`);
let m = fs.readFileSync(f, "utf8");
for (const perm of ["FOREGROUND_SERVICE", "FOREGROUND_SERVICE_DATA_SYNC", "WAKE_LOCK", "POST_NOTIFICATIONS"])
  if (!m.includes(`android.permission.${perm}"`)) m = m.replace("</manifest>", `    <uses-permission android:name="android.permission.${perm}" />\n</manifest>`);
// the phone link talks to your PC over plain http on the home network / Tailscale (token-protected)
if (!m.includes("usesCleartextTraffic")) m = m.replace("<application", '<application android:usesCleartextTraffic="true"');
if (!m.includes("KeepAliveService")) m = m.replace("</application>", `        <service android:name=".KeepAliveService" android:exported="false" android:foregroundServiceType="dataSync" />\n    </application>`);
fs.writeFileSync(f, m);
console.log("keep-alive:", m.includes("KeepAliveService") && m.includes("FOREGROUND_SERVICE_DATA_SYNC") ? "service + permissions added" : "PATCH FAILED");
if (!m.includes("KeepAliveService")) process.exit(1);

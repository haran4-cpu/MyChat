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

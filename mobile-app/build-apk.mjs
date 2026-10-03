// Build the Android APK (docs/OFFLINE-FIRST.md §29). Capacitor's Android project needs Java 21;
// when the default `java` is older, Android Studio's bundled runtime is used instead.
// Debug build by default; `node build-apk.mjs release` once a signing key is configured (§29, 7d).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const android = path.join(here, 'android');
const release = process.argv[2] === 'release';

/** The major version of a java binary (`java -version` prints to stderr). */
function javaMajor(javaBin) {
  const r = spawnSync(javaBin, ['-version'], { encoding: 'utf8' });
  return parseInt(/version "(\d+)/.exec(`${r.stderr ?? ''}${r.stdout ?? ''}`)?.[1] ?? '0', 10);
}

const env = { ...process.env };
const current = env.JAVA_HOME ? path.join(env.JAVA_HOME, 'bin', 'java') : 'java';
if (javaMajor(current) < 21) {
  const candidates = [
    'D:/Program Files/Android/Android Studio/jbr',
    'C:/Program Files/Android/Android Studio/jbr',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Android Studio', 'jbr'),
  ];
  const jbr = candidates.find((d) => fs.existsSync(path.join(d, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')));
  if (!jbr) throw new Error('Java 21 is needed (install Android Studio, or set JAVA_HOME to a JDK 21).');
  env.JAVA_HOME = jbr;
}

// Temp files on the project's drive, not the system one (a full C: stopped a build). Set
// GRADLE_USER_HOME yourself to move Gradle's download cache as well.
const tmp = path.join(android, 'build', 'tmp');
fs.mkdirSync(tmp, { recursive: true });
env.TEMP = env.TMP = env.TMPDIR = tmp;
env.GRADLE_OPTS = `${env.GRADLE_OPTS ?? ''} -Djava.io.tmpdir="${tmp}"`.trim();

// By full path: some Windows setups don't run commands from the current folder.
const gradlew = `"${path.join(android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')}"`;
const r = spawnSync(gradlew,[release ? 'assembleRelease' : 'assembleDebug'], { cwd: android, env, stdio: 'inherit', shell: true });
if (r.status !== 0) process.exit(r.status ?? 1);
const apk = path.join(android, 'app', 'build', 'outputs', 'apk', release ? 'release' : 'debug', release ? 'app-release.apk' : 'app-debug.apk');
console.log(fs.existsSync(apk) ? `APK: ${apk} (${(fs.statSync(apk).size / 1024 / 1024).toFixed(1)} MB)` : 'Build finished, but the APK was not found.');

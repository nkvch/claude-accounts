// Patch the app.asar of a Claude.app copy so Code sessions can run on another
// subscription (see hook.js). Usage: node patch.js "/path/to/Claude copy.app"
// Every edit must match exactly once; otherwise exit non-zero and touch nothing.
const asar = require("@electron/asar");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const app = process.argv[2];
const res = path.join(app, "Contents/Resources");
const archive = path.join(res, "app.asar");
const HOOK = path.join(__dirname, "hook.js");

function once(src, re, replace, what) {
  const hits = src.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
  if (!hits || hits.length !== 1) throw new Error(`${what}: expected 1 match, got ${hits ? hits.length : 0}`);
  return src.replace(re, replace);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "ccacct-"));
const dir = path.join(work, "app");
asar.extractAll(archive, dir);
const build = path.join(dir, ".vite/build");

// 1. Load the hook first thing in the main process.
const pre = path.join(build, "index.pre.js");
let s = fs.readFileSync(pre, "utf8");
s = once(s, /^"use strict";/, `"use strict";try{require(${JSON.stringify(HOOK)})}catch(e){console.error("cc-accounts hook",e)}`, "hook load");
fs.writeFileSync(pre, s);

// 2. Session spawn: pick the account, and keep the desktop's own token out.
const chunks = fs.readdirSync(build).filter((f) => f.endsWith(".js")).map((f) => path.join(build, f));
const spawnFile = chunks.find((f) => fs.readFileSync(f, "utf8").includes("this.deps.buildSessionEnv("));
if (!spawnFile) throw new Error("spawn chunk not found");
s = fs.readFileSync(spawnFile, "utf8");
const envM = s.match(/\{env:(\w+),secrets:\w+[^}]*\}[^;]*?=await Promise\.all\(\[this\.deps\.buildSessionEnv\((\w+),/);
if (!envM) throw new Error("env/session names not found");
const [, ENV, SID] = envM;
const cwdM = s.match(/\{cwd:(\w+),model:\w+\.model\|\|"default"/);
if (!cwdM) throw new Error("cwd name not found");
const CWD = cwdM[1];
s = once(s, /(?<![.\w])(\w+)=this\.deps\.cliOAuthTokenKeeper\(\)\.trackCliOAuthToken\(/,
  `$1=(globalThis.__ccAcct?.(${SID},${CWD},${ENV}),globalThis.__ccAcctOv?.(${SID}))?void 0:this.deps.cliOAuthTokenKeeper().trackCliOAuthToken(`, "token keeper");
s = once(s, new RegExp(`getHostAuthToken:([\\w$]+\\.[\\w$]+)\\(\\{spawnEnv:${ENV},`),
  `getHostAuthToken:globalThis.__ccAcctOv?.(${SID})?void 0:$1({spawnEnv:${ENV},`, "host auth");
// One Code session folder for every login, so switching account hides nothing.
s = once(s, /getStorageDir\(\)\{return!this\.currentAccountId\|\|!this\.currentOrgId\?null:\(0,(\w+)\.join\)\(this\.userDataPath,this\.baseDir,this\.currentAccountId,this\.currentOrgId\)\}/,
  "getStorageDir(){return!this.currentAccountId||!this.currentOrgId?null:(0,$1.join)(this.userDataPath,this.baseDir,...(globalThis.__ccStore?.()??[this.currentAccountId,this.currentOrgId]))}", "session store");
// The app's own quiet restart of a session's process (used to apply a new output style:
// waits until the session is idle, keeps typed input, no "interrupted" notice). Exposed so a
// switch of subscription restarts the session onto it (hook.js restartPending).
const mgrFile = chunks.find((f) => /refreshOutputStyles:\(\.\.\.(\w+)\)=>this\.refreshOutputStyles\(\.\.\.\1\)/.test(f === spawnFile ? s : fs.readFileSync(f, "utf8")));
if (!mgrFile) throw new Error("session manager chunk not found");
let m = mgrFile === spawnFile ? s : fs.readFileSync(mgrFile, "utf8");
m = once(m, /refreshOutputStyles:\(\.\.\.(\w+)\)=>this\.refreshOutputStyles\(\.\.\.\1\)/,
  "refreshOutputStyles:(globalThis.__ccRestart=(sid)=>this.refreshOutputStyles(sid),(...$1)=>this.refreshOutputStyles(...$1))", "quiet restart");
if (mgrFile === spawnFile) s = m; else fs.writeFileSync(mgrFile, m);
fs.writeFileSync(spawnFile, s);

// 3. This copy must never update itself (an update would drop the patch);
//    build.sh rebuilds it from the official /Applications/Claude.app instead.
const updFile = chunks.find((f) => /installed:\w+\(\),disabledByPolicy:/.test(fs.readFileSync(f, "utf8")));
if (!updFile) throw new Error("updater chunk not found");
s = fs.readFileSync(updFile, "utf8");
const INSTALLED = s.match(/installed:(\w+)\(\),disabledByPolicy:/)[1];
s = once(s, new RegExp(`function ${INSTALLED.replace("$", "\\$")}\\(\\)\\{`), `function ${INSTALLED}(){return!1;`, "updater off");
fs.writeFileSync(updFile, s);

// 4. Repack with the same files left outside the archive, and fix the integrity hash.
const unpackedBefore = listUnpacked(archive + ".unpacked");
const out = path.join(work, "app.asar");
const patterns = [...new Set(unpackedBefore.map((p) => "*" + (path.extname(p) || path.basename(p))))];
asar.createPackageWithOptions(dir, out, { unpack: `{${patterns.join(",")}}` }).then(() => {
  const unpackedAfter = listUnpacked(out + ".unpacked");
  if (unpackedAfter.join("\n") !== unpackedBefore.join("\n")) {
    throw new Error(`unpacked set differs:\nbefore ${unpackedBefore.join(" ")}\nafter ${unpackedAfter.join(" ")}`);
  }
  fs.rmSync(archive + ".unpacked", { recursive: true });
  fs.renameSync(out + ".unpacked", archive + ".unpacked");
  fs.copyFileSync(out, archive);
  const hash = crypto.createHash("sha256").update(asar.getRawHeader(archive).headerString).digest("hex");
  execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${hash}`, path.join(app, "Contents/Info.plist")]);
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`patched: ${path.basename(spawnFile)} (env=${ENV} sid=${SID} cwd=${CWD}), updater ${INSTALLED}()`);
}).catch((e) => { console.error(e.message); process.exit(1); });

function listUnpacked(root) {
  const outList = [];
  (function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      e.isDirectory() ? walk(p) : outList.push(path.relative(root, p));
    }
  })(root);
  return outList.sort();
}

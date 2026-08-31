#!/usr/bin/env node
/**
 * Patch main/index.js inside a WorkBuddy app.asar so it runs on Linux.
 *
 * Fixes applied:
 *   1. Prelude shim: hide ACC_PRODUCT_CONFIG_V3 / _V2 from libc's
 *      environ so Chromium's internal /proc/self/exe spawn for the
 *      network/GPU/utility services doesn't fail with E2BIG.
 *
 *   2. Attach the tray context menu via setContextMenu() on Linux so
 *      the libayatana-appindicator backend renders the right-click
 *      menu (the AppIndicator never emits the click/right-click events
 *      upstream relies on).
 *
 *   3. Construct the Linux Tray from an on-disk PNG path (the
 *      .workbuddy-linux/workbuddy.png file written by install.sh)
 *      instead of a resized in-memory NativeImage — AppIndicator on
 *      Mint/Cinnamon otherwise renders a missing-image placeholder.
 *
 *   4. Disable the "Check for Updates..." menu entry and stub out the
 *      update* RPC handlers. The upstream updater drives the macOS
 *      ShipIt / Windows Squirrel installers, neither of which applies
 *      on a Linux port.
 *
 *   5. (in the env shim) Monkey-patch child_process.spawn/spawnSync
 *      to spill oversized env entries (ACC_PRODUCT_CONFIG_V3 / _V2)
 *      to a private temp file and replace them with a *_FILE pointer.
 *      The sidecar-entry.js shim reads the file back and re-injects
 *      the value via the same Proxy so the sidecar still sees the
 *      full JSON. This eliminates the spawn E2BIG that previously
 *      broke sidecar startup and plugin marketplace updates.
 *
 * The script operates directly on an app.asar file. It extracts it to a
 * temp directory, edits main/index.js + main/sidecar-entry.js, and
 * repacks the asar while preserving the original unpacked=true set.
 *
 * Usage:
 *   node apply-linux-patches.js <path/to/app.asar> <marker>
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const asar = require('@electron/asar');

const [, , asarPath, marker] = process.argv;
if (!asarPath || !marker) {
    console.error('Usage: apply-linux-patches.js <app.asar> <marker>');
    process.exit(2);
}

function log(msg) { console.log('  [apply-linux-patches] ' + msg); }

// ---------------------------------------------------------------------------
// Patch bookkeeping.
//
// Historically every patch was guarded by a bare `if (idx >= 0)` with no
// else branch, so a drifted anchor silently disabled a patch with no output
// at all. Every patch now reports one of four states and the run ends with a
// summary. Set WB_PATCH_STRICT=1 to turn any hard failure into a non-zero
// exit (useful in CI or when validating a new upstream release).
// ---------------------------------------------------------------------------
const STRICT = process.env.WB_PATCH_STRICT === '1';
const results = [];

function record(name, status, detail) {
    results.push({ name, status, detail: detail || '' });
    const tag = { applied: '[OK]  ', skipped: '[SKIP]', na: '[N/A] ', failed: '[FAIL]' }[status] || '[??]  ';
    log(tag + ' ' + name + (detail ? ' — ' + detail : ''));
    if (status === 'failed' && STRICT) {
        console.error('[apply-linux-patches] STRICT: required patch failed: ' + name);
        process.exit(7);
    }
}

function summarize() {
    const by = (s) => results.filter((r) => r.status === s).length;
    log('---- patch summary ----');
    log('applied=' + by('applied') + ' skipped=' + by('skipped') +
        ' n/a=' + by('na') + ' failed=' + by('failed'));
    const failed = results.filter((r) => r.status === 'failed');
    if (failed.length) {
        console.error('[apply-linux-patches] ' + failed.length +
            ' patch(es) FAILED. Upstream code drifted — re-anchor against the new bundle.');
        for (const f of failed) console.error('  - ' + f.name + (f.detail ? ': ' + f.detail : ''));
    }
}

/** Replace only the first occurrence of `needle`. */
function replaceOnce(source, needle, replacement) {
    const i = source.indexOf(needle);
    if (i < 0) return null;
    return source.slice(0, i) + replacement + source.slice(i + needle.length);
}

// ---------------------------------------------------------------------------
// 1. Extract the asar into a temp dir. We pull file contents straight from
//    asar.extractFile() instead of relying on the CLI so that:
//      (a) we don't depend on the CLI sniffing the sibling .unpacked dir,
//      (b) we can reliably recover the exact bytes for every entry.
//    Unpacked entries are copied from the sibling <asar>.unpacked/ dir.
// ---------------------------------------------------------------------------
const { header } = asar.getRawHeader(asarPath);
const unpackedSiblingDir = asarPath + '.unpacked';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-asar-patch-'));
process.on('exit', () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

// ---------------------------------------------------------------------------
// Walk the header, collect every file's metadata, and write the bytes to
// the temp dir. Also accumulate the "unpacked" set for later.
// ---------------------------------------------------------------------------
const unpackedFiles = [];
function walk(node, prefix) {
    if (!node.files) return;
    for (const [name, entry] of Object.entries(node.files)) {
        const rel = prefix ? prefix + '/' + name : name;
        const abs = path.join(tmpDir, rel);
        if (entry.files) {
            fs.mkdirSync(abs, { recursive: true });
            walk(entry, rel);
        } else if (entry.link) {
            // Symlink entries — extractFile can't give us the target, so
            // we just recreate them directly.
            try {
                fs.mkdirSync(path.dirname(abs), { recursive: true });
                fs.symlinkSync(entry.link, abs);
            } catch (err) {
                console.warn('  [apply-linux-patches] skipped symlink ' + rel + ': ' + err.message);
            }
        } else {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            if (entry.unpacked) {
                unpackedFiles.push(rel);
                const src = path.join(unpackedSiblingDir, rel);
                if (fs.existsSync(src)) {
                    fs.copyFileSync(src, abs);
                    const stat = fs.statSync(src);
                    fs.chmodSync(abs, stat.mode & 0o777);
                } else {
                    // Unpacked file missing from sibling dir — write an empty
                    // placeholder so the header can still reference it. This
                    // path is only hit if someone has deleted files from
                    // app.asar.unpacked/ between build and patch.
                    fs.writeFileSync(abs, Buffer.alloc(0));
                    console.warn('  [apply-linux-patches] missing unpacked file: ' + rel);
                }
            } else {
                const buf = asar.extractFile(asarPath, rel);
                fs.writeFileSync(abs, buf);
                if (entry.executable) {
                    fs.chmodSync(abs, 0o755);
                }
            }
        }
    }
}
walk(header, '');
log('Extracted ' + unpackedFiles.length + ' unpacked + packed entries to temp dir');

// ---------------------------------------------------------------------------
// 2. Apply the two source patches to main/index.js.
// ---------------------------------------------------------------------------
const indexPath = path.join(tmpDir, 'main', 'index.js');
if (!fs.existsSync(indexPath)) {
    console.error('[apply-linux-patches] ERROR: main/index.js missing in asar');
    process.exit(3);
}

let source = fs.readFileSync(indexPath, 'utf8');

const SHIM_BODY = `// ${marker} — WorkBuddy Linux runtime patches (env + tray)
(function wbLinuxEnvShim() {
  if (process.platform !== "linux") return;
  try {
    // ---------------------------------------------------------------
    // Part A: keep the oversized product-config JSON out of libc
    // environ so Chromium's own execvp("/proc/self/exe") for network,
    // GPU and utility subprocesses doesn't fail with E2BIG.
    //
    // We replace process.env with a Proxy that stores the two hidden
    // keys in a private JS slot, hides them from every enumeration
    // path (has/ownKeys/getOwnPropertyDescriptor), and returns them
    // only via direct property access. Node's child_process spawn
    // enumerates process.env to build the child environment, so the
    // oversized string never lands in the child's argv block either.
    // ---------------------------------------------------------------
    var HIDDEN = new Set(["ACC_PRODUCT_CONFIG_V3", "ACC_PRODUCT_CONFIG_V2"]);
    var real = process.env;
    var store = Object.create(null);
    HIDDEN.forEach(function (key) {
      if (typeof real[key] === "string") {
        store[key] = real[key];
        try { delete real[key]; } catch (_) {}
      }
    });
    var proxy = new Proxy(real, {
      get: function (target, prop) {
        if (typeof prop === "string" && HIDDEN.has(prop)) return store[prop];
        return Reflect.get(target, prop);
      },
      set: function (target, prop, value) {
        if (typeof prop === "string" && HIDDEN.has(prop)) {
          store[prop] = value == null ? undefined : String(value);
          try { delete target[prop]; } catch (_) {}
          return true;
        }
        return Reflect.set(target, prop, value);
      },
      deleteProperty: function (target, prop) {
        if (typeof prop === "string" && HIDDEN.has(prop)) {
          delete store[prop];
          try { delete target[prop]; } catch (_) {}
          return true;
        }
        return Reflect.deleteProperty(target, prop);
      },
      has: function (target, prop) { return Reflect.has(target, prop); },
      ownKeys: function (target) { return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor: function (target, prop) {
        return Reflect.getOwnPropertyDescriptor(target, prop);
      }
    });
    Object.defineProperty(process, "env", {
      value: proxy,
      writable: true,
      configurable: true,
      enumerable: true
    });

    // ---------------------------------------------------------------
    // Part B: sidecar spawn E2BIG workaround.
    //
    // Upstream assigns the same ~260KB JSON into the env object it
    // passes to child_process.spawn (see SidecarManager.spawnSidecar
    // and related CLI helpers). Even though Part A keeps the value
    // off libc environ for the main process, spawn() still stuffs it
    // into the argv block of the new process, where MAX_ARG_STRLEN
    // rejects any single 128KB+ entry with E2BIG.
    //
    // We monkey-patch child_process.spawn / spawnSync so that any
    // env entry named ACC_PRODUCT_CONFIG_V3 / _V2 whose value is
    // larger than 100KB is spilled to a private temp file and
    // replaced in the child's env with ACC_PRODUCT_CONFIG_V3_FILE.
    // The sidecar-entry.js shim reads that file back and re-injects
    // the value via a matching Proxy so downstream code sees the
    // same process.env.ACC_PRODUCT_CONFIG_V3 string.
    // ---------------------------------------------------------------
    var cp = require("child_process");
    var fsMod = require("fs");
    var osMod = require("os");
    var pathMod = require("path");
    var cryptoMod = require("crypto");
    var SPILL_KEYS = ["ACC_PRODUCT_CONFIG_V3", "ACC_PRODUCT_CONFIG_V2"];
    var SPILL_THRESHOLD = 100 * 1024; // 100KB; MAX_ARG_STRLEN is 128KB

    function spillDir() {
      var dir = pathMod.join(osMod.tmpdir(), "workbuddy-linux-env-" + process.pid);
      try { fsMod.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (_) {}
      return dir;
    }

    function spillOversizedEnv(originalOpts) {
      if (!originalOpts || typeof originalOpts !== "object") return originalOpts;
      var env = originalOpts.env;
      if (!env || typeof env !== "object") return originalOpts;
      var spilled = null;
      for (var i = 0; i < SPILL_KEYS.length; i++) {
        var key = SPILL_KEYS[i];
        var value = env[key];
        if (typeof value === "string" && value.length >= SPILL_THRESHOLD) {
          try {
            var dir = spillDir();
            var filePath = pathMod.join(
              dir,
              key + "-" + cryptoMod.randomBytes(8).toString("hex") + ".json"
            );
            fsMod.writeFileSync(filePath, value, { mode: 0o600 });
            if (!spilled) spilled = Object.assign({}, env);
            delete spilled[key];
            spilled[key + "_FILE"] = filePath;
          } catch (err) {
            try {
              console.error("[wb-linux-shim] failed to spill " + key + ":", err);
            } catch (_) {}
          }
        }
      }
      if (!spilled) return originalOpts;
      return Object.assign({}, originalOpts, { env: spilled });
    }

    function wrapSpawnLike(name) {
      var orig = cp[name];
      if (typeof orig !== "function" || orig.__wbLinuxShimWrapped) return;
      function wrapped(command, args, options) {
        // Normalize arg shape: spawn(cmd[, args][, options])
        if (!Array.isArray(args) && typeof args === "object" && args !== null) {
          options = args;
          args = undefined;
        }
        var patched = spillOversizedEnv(options);
        if (args === undefined) return orig.call(cp, command, patched);
        return orig.call(cp, command, args, patched);
      }
      wrapped.__wbLinuxShimWrapped = true;
      try { cp[name] = wrapped; } catch (_) {}
    }
    wrapSpawnLike("spawn");
    wrapSpawnLike("spawnSync");
    wrapSpawnLike("execFile");
    wrapSpawnLike("execFileSync");

    // exec/execSync use shell and pass env via options too
    function wrapExecLike(name) {
      var orig = cp[name];
      if (typeof orig !== "function" || orig.__wbLinuxShimWrapped) return;
      function wrapped(command, options, callback) {
        if (typeof options === "function") {
          callback = options;
          options = undefined;
        }
        var patched = spillOversizedEnv(options);
        if (callback) return orig.call(cp, command, patched, callback);
        return orig.call(cp, command, patched);
      }
      wrapped.__wbLinuxShimWrapped = true;
      try { cp[name] = wrapped; } catch (_) {}
    }
    wrapExecLike("exec");
    wrapExecLike("execSync");

    // ---------------------------------------------------------------
    // Part C: receiver side.
    //
    // If our parent handed us a _FILE pointer (i.e. we are a child
    // process spawned after Part B kicked in), read the file back
    // and re-expose the original value on process.env through the
    // same Proxy. The file is deleted after a single read so we
    // don't leave the JSON lying around any longer than necessary.
    //
    // Additionally, we write a fresh _FILE pointer into the real env
    // so that any child processes we spawn (which inherit process.env
    // via the default behavior) can also pick up the value through
    // their own copy of this shim.
    // ---------------------------------------------------------------
    for (var j = 0; j < SPILL_KEYS.length; j++) {
      var rkey = SPILL_KEYS[j];
      var fkey = rkey + "_FILE";
      var fp = real[fkey];
      if (typeof fp === "string" && fp.length) {
        try {
          store[rkey] = fsMod.readFileSync(fp, "utf8");
          // Don't delete the file — child processes may also need it.
          // Instead, keep the _FILE pointer in the real env so children
          // that inherit process.env can read it too.
        } catch (err) {
          try {
            console.error("[wb-linux-shim] failed to read " + fkey + ":", err);
          } catch (_) {}
        }
      }
    }

    // If we have values in store (either from parent's _FILE or from
    // upstream code setting them via the Proxy), ensure a _FILE pointer
    // exists in the real env for child process inheritance.
    for (var k = 0; k < SPILL_KEYS.length; k++) {
      var skey = SPILL_KEYS[k];
      var sfkey = skey + "_FILE";
      if (store[skey] && typeof store[skey] === "string" && store[skey].length >= SPILL_THRESHOLD) {
        if (!real[sfkey]) {
          try {
            var sdir = pathMod.join(osMod.tmpdir(), "workbuddy-linux-env-" + process.pid);
            fsMod.mkdirSync(sdir, { recursive: true, mode: 0o700 });
            var sfp = pathMod.join(sdir, skey + ".json");
            fsMod.writeFileSync(sfp, store[skey], { mode: 0o600 });
            real[sfkey] = sfp;
          } catch (_) {}
        }
      }
    }

    // ---------------------------------------------------------------
    // Part D: ensure app.asar.unpacked/node_modules is on the
    // module resolution path. The asar-packed require() only sees
    // modules listed in the asar header. Platform-specific optional
    // packages like @lydell/node-pty-linux-x64 are installed into
    // app.asar.unpacked/ by the build script but never registered
    // in the asar header. Adding the unpacked node_modules to
    // Module.globalPaths lets require() find them.
    // ---------------------------------------------------------------
    try {
      var Module = require("module");
      var resourcesPath = typeof process.resourcesPath === "string"
        ? process.resourcesPath
        : pathMod.dirname(process.execPath);
      var unpackedNM = pathMod.join(resourcesPath, "app.asar.unpacked", "node_modules");
      if (fsMod.existsSync(unpackedNM)) {
        if (Module.globalPaths && !Module.globalPaths.includes(unpackedNM)) {
          Module.globalPaths.push(unpackedNM);
        }
      }
    } catch (_) {}

    // ---------------------------------------------------------------
    // Part E: wrap @lydell/node-pty spawn to spill oversized env.
    //
    // The sidecar uses node-pty (not child_process) to spawn the
    // host runtime CLI. node-pty calls forkpty+execve directly in
    // C++, bypassing our child_process monkey-patch. We intercept
    // the JS-level spawn() of the loaded node-pty module to strip
    // oversized env entries before they reach the native layer.
    // ---------------------------------------------------------------
    try {
      var origRequire = Module.prototype.require;
      var ptyPatched = false;
      Module.prototype.require = function wbRequireHook() {
        var result = origRequire.apply(this, arguments);
        var modName = arguments[0];
        if (!ptyPatched && typeof modName === "string" &&
            (modName === "@lydell/node-pty" || modName === "@lydell/node-pty-linux-x64" || modName === "node-pty") &&
            result && typeof result.spawn === "function" && !result.spawn.__wbPtyWrapped) {
          ptyPatched = true;
          var origSpawn = result.spawn;
          result.spawn = function wbPtySpawn(file, args, opts) {
            if (opts && opts.env && typeof opts.env === "object") {
              var patchedEnv = opts.env;
              var didPatch = false;
              for (var pi = 0; pi < SPILL_KEYS.length; pi++) {
                var pk = SPILL_KEYS[pi];
                var pv = patchedEnv[pk];
                if (typeof pv === "string" && pv.length >= SPILL_THRESHOLD) {
                  try {
                    var pdir = pathMod.join(osMod.tmpdir(), "workbuddy-linux-env-" + process.pid);
                    fsMod.mkdirSync(pdir, { recursive: true, mode: 0o700 });
                    var pfp = pathMod.join(pdir, pk + "-pty.json");
                    fsMod.writeFileSync(pfp, pv, { mode: 0o600 });
                    if (!didPatch) { patchedEnv = Object.assign({}, patchedEnv); didPatch = true; }
                    delete patchedEnv[pk];
                    patchedEnv[pk + "_FILE"] = pfp;
                  } catch (_) {}
                }
              }
              if (didPatch) opts = Object.assign({}, opts, { env: patchedEnv });
            }
            return origSpawn.call(this, file, args, opts);
          };
          result.spawn.__wbPtyWrapped = true;
        }
        return result;
      };
    } catch (_) {}
  } catch (err) {
    try { console.error("[wb-linux-shim] install failed:", err); } catch (_) {}
  }
})();
`;

// ---------------------------------------------------------------------------
// Patch the main-process bundle.
//
// Each patch below is independent and guarded by its own marker, so this
// script is idempotent: re-running it (or upgrading from an older shim
// generation) applies only what is still missing, instead of skipping the
// whole block merely because the env shim is already present.
// ---------------------------------------------------------------------------
const TRAY_MARKER = '__WB_TRAY_PATCH_V1__';
const WINCTRL_MARKER = '__WB_WINCTRL_PATCH_V1__';
const UPDATERPC_MARKER = '__WB_UPDATERPC_PATCH_V1__';
const AUTOUPDATE_MARKER = '__WB_AUTOUPDATE_PATCH_V1__';

if (source.includes(marker)) {
    record('env shim (main/index.js)', 'skipped', 'marker already present');
} else {
    source = SHIM_BODY + source;
    record('env shim (main/index.js)', 'applied', 'env Proxy + spawn env spill');
}

{
    // Fix 2 (Linux): attach the tray context menu. libayatana-appindicator
    // never emits the click/right-click events upstream relies on, so the
    // menu has to be attached explicitly with setContextMenu().
    if (source.includes(TRAY_MARKER)) {
        record('tray context menu + icon path (Fix 2/3)', 'skipped', 'already patched');
    } else {
    const trayMarker = 'this.tray = new electron.Tray(trayIcon);';
    const trayIdx = source.indexOf(trayMarker);
    const afterTray = trayIdx >= 0 ? source.slice(trayIdx) : '';
    const contextMenuDeclRe = /const contextMenu = electron\.Menu\.buildFromTemplate\(\[[\s\S]*?\]\);/;
    const m = afterTray ? afterTray.match(contextMenuDeclRe) : null;
    if (trayIdx < 0) {
        record('tray context menu + icon path (Fix 2/3)', 'failed',
            'tray construction line not found — re-anchor against upstream bundle');
    } else if (!m) {
        record('tray context menu + icon path (Fix 2/3)', 'failed',
            'contextMenu declaration not found after tray — re-anchor against upstream bundle');
    } else {
    const insertAt = trayIdx + m.index + m[0].length;
    const trayPatch =
        '\n\t\t\t// ' + TRAY_MARKER + '\n' +
        '\t\t\tif (process.platform === "linux") {\n' +
        '\t\t\t\ttry { this.tray.setContextMenu(contextMenu); } catch (_) {}\n' +
        '\t\t\t}';
    source = source.slice(0, insertAt) + trayPatch + source.slice(insertAt);

    // Fix 3 (Linux): the tray icon renders as a missing-image placeholder
    // (exclamation mark on Mint/Cinnamon) because upstream hands
    // libayatana-appindicator a resized in-memory NativeImage. The
    // AppIndicator backend wants an on-disk file path it can re-read
    // through GTK. On Linux we construct the Tray from the PNG written
    // by install.sh at <install-dir>/.workbuddy-linux/workbuddy.png
    // (shipped into /opt/<app>/.workbuddy-linux/ by the .deb/.rpm/.pacman
    // builders), falling back to the upstream NativeImage path if that
    // file is missing for any reason.
    const trayConstruct = 'this.tray = new electron.Tray(trayIcon);';
    const trayConstructReplacement =
        'if (process.platform === "linux") {\n' +
        '\t\t\t\ttry {\n' +
        '\t\t\t\t\tconst linuxTrayPath = path.join(path.dirname(process.resourcesPath), ".workbuddy-linux", "workbuddy.png");\n' +
        '\t\t\t\t\tif (fs.existsSync(linuxTrayPath)) {\n' +
        '\t\t\t\t\t\tthis.tray = new electron.Tray(linuxTrayPath);\n' +
        '\t\t\t\t\t}\n' +
        '\t\t\t\t} catch (_) {}\n' +
        '\t\t\t}\n' +
        '\t\t\tif (!this.tray) this.tray = new electron.Tray(trayIcon);';
    // There are two identical Tray constructions in the file in some
    // builds; replace only the first occurrence (the WindowManager one).
    const trayIdx2 = source.indexOf(trayConstruct);
    if (trayIdx2 >= 0) {
        source = source.slice(0, trayIdx2)
            + trayConstructReplacement
            + source.slice(trayIdx2 + trayConstruct.length);
        record('tray context menu + icon path (Fix 2/3)', 'applied',
            'setContextMenu() + on-disk PNG icon path');
    } else {
        record('tray context menu + icon path (Fix 2/3)', 'failed',
            'tray construction vanished after the menu patch');
    }
    } // end of the tray anchor else-branch
    } // end of the Fix 2/3 patch block

    // -----------------------------------------------------------------------
    // Fix 5 (Linux): add window control buttons (minimize/maximize/close).
    //
    // Upstream sets `frame: false` on Linux without providing a
    // titleBarOverlay (Windows gets one, macOS uses traffic lights), and
    // Electron's titleBarOverlay only works on Wayland, not X11. We draw
    // our own buttons in the renderer instead.
    //
    // Anchor note: WorkBuddy 5.3.x ships an esbuild bundle, so the logger
    // is namespaced (`require_logger.windowLog`) and the message is a
    // template literal carrying a timestamp suffix. Anchor on the stable
    // substring only, so a bundler rename cannot silently disable this.
    //
    // API note: the renderer exposes window control through
    // `workbuddyDesktop.window.getCurrentWindow()` (see preload/index.js),
    // NOT through `buddyAPI` — that object only carries telemetry and auth
    // helpers. We use the documented path and fall back to the generic
    // `invoke()` dispatcher behind DESKTOP_HOST_CHANNEL_MAP.
    // -----------------------------------------------------------------------
    if (source.includes(WINCTRL_MARKER)) {
        record('window control buttons (Fix 5)', 'skipped', 'already patched');
    } else {
        const readyMatch = source.match(/^[^\n]*Window ready to show[^\n]*/m);
        if (!readyMatch) {
            record('window control buttons (Fix 5)', 'failed',
                '"Window ready to show" line not found — re-anchor against upstream bundle');
        } else {
            const afterReady = readyMatch.index + readyMatch[0].length;
            const windowControlsInjection = `
                        // ${WINCTRL_MARKER} [wb-linux-patch] window control buttons
                        if (process.platform === "linux") {
                                const wbLinuxWindowControls = function() {
                                        if (document.getElementById('wb-linux-window-controls')) return;
                                        var css = document.createElement('style');
                                        css.textContent = [
                                                '#wb-linux-window-controls{position:fixed;top:0;right:0;z-index:99999;display:flex;height:36px;-webkit-app-region:no-drag;}',
                                                '#wb-linux-window-controls button{width:46px;height:36px;border:none;background:transparent;color:#cccccc;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;}',
                                                '#wb-linux-window-controls button:hover{background:rgba(255,255,255,0.1);}',
                                                '#wb-linux-window-controls button.wb-close:hover{background:#e81123;color:#ffffff;}',
                                                '#wb-linux-window-controls button svg{width:10px;height:10px;fill:currentColor;}'
                                        ].join('');
                                        document.head.appendChild(css);
                                        var box = document.createElement('div');
                                        box.id = 'wb-linux-window-controls';
                                        box.innerHTML = '<button class="wb-minimize" title="最小化"><svg viewBox="0 0 10 1"><rect width="10" height="1"/></svg></button>'
                                                + '<button class="wb-maximize" title="最大化"><svg viewBox="0 0 10 10"><path d="M0 0v10h10V0H0zm1 1h8v8H1V1z"/></svg></button>'
                                                + '<button class="wb-close" title="关闭"><svg viewBox="0 0 10 10"><path d="M1.41 0L5 3.59 8.59 0 10 1.41 6.41 5 10 8.59 8.59 10 5 6.41 1.41 10 0 8.59 3.59 5 0 1.41z"/></svg></button>';
                                        document.body.appendChild(box);
                                        var w = null;
                                        try {
                                                var d = window.workbuddyDesktop;
                                                if (d && d.window && typeof d.window.getCurrentWindow === 'function') w = d.window.getCurrentWindow();
                                        } catch (_) {}
                                        if (!w) {
                                                try {
                                                        var d2 = window.workbuddyDesktop;
                                                        if (d2 && typeof d2.invoke === 'function') w = {
                                                                minimize: function() { return d2.invoke('minimizeWindow'); },
                                                                maximize: function() { return d2.invoke('maximizeWindow'); },
                                                                close: function() { return d2.invoke('closeWindow'); }
                                                        };
                                                } catch (_) {}
                                        }
                                        var bind = function(sel, fn) {
                                                var el = box.querySelector(sel);
                                                if (el) el.addEventListener('click', fn);
                                        };
                                        bind('.wb-minimize', function() { if (w && w.minimize) w.minimize(); });
                                        bind('.wb-maximize', function() { if (w && w.maximize) w.maximize(); });
                                        bind('.wb-close', function() { if (w && w.close) w.close(); });
                                };
                                const wbLinuxInjectControls = () => {
                                        try {
                                                const wc = this.mainWindow ? this.mainWindow.webContents : null;
                                                if (!wc) return;
                                                wc.executeJavaScript('(' + wbLinuxWindowControls.toString() + ')()').catch(() => {});
                                        } catch (_) {}
                                };
                                this.mainWindow.webContents.once("did-finish-load", wbLinuxInjectControls);
                                setTimeout(wbLinuxInjectControls, 1500);
                                setTimeout(wbLinuxInjectControls, 5000);
                        }`;
            source = source.slice(0, afterReady) + windowControlsInjection + source.slice(afterReady);
            record('window control buttons (Fix 5)', 'applied',
                'injected at "Window ready to show" via workbuddyDesktop window API');
        }
    }

    // -----------------------------------------------------------------------
    // Fix 6a (Linux): grey out the "Check for Updates..." menu entry.
    //
    // Upstream 5.3.x removed `getUpdateMenuItem` altogether — the native
    // application menu no longer carries an update entry, so there is
    // nothing left to disable. We only patch when the function is present
    // (it existed in 4.22.x) and report n/a otherwise, so the summary
    // stays honest instead of silently doing nothing.
    // -----------------------------------------------------------------------
    const UPDATEMENU_MARKER = '__WB_UPDATEMENU_PATCH_V1__';
    const updateMenuM = source.match(/function getUpdateMenuItem\([^)]*\)\s*\{/);
    if (!updateMenuM) {
        record('update menu entry disabled (Fix 6a)', 'na',
            'upstream menu ships no update entry (getUpdateMenuItem absent)');
    } else if (source.includes(UPDATEMENU_MARKER)) {
        record('update menu entry disabled (Fix 6a)', 'skipped', 'already patched');
    } else {
        const linuxUpdateShim =
            updateMenuM[0] + '\n' +
            '\t// ' + UPDATEMENU_MARKER + '\n' +
            '\tif (process.platform === "linux") {\n' +
            '\t\treturn {\n' +
            '\t\t\tid: "checkForUpdates",\n' +
            '\t\t\tlabel: "Check for Updates... (Linux 不支持)",\n' +
            '\t\t\tdisabled: true,\n' +
            '\t\t\tcommandId: "menu.checkForUpdates.disabled"\n' +
            '\t\t};\n' +
            '\t}';
        source = replaceOnce(source, updateMenuM[0], linuxUpdateShim);
        record('update menu entry disabled (Fix 6a)', 'applied', 'menu entry greyed out on Linux');
    }

    // -----------------------------------------------------------------------
    // Fix 6b (Linux): stub the update RPCs.
    //
    // Two things drifted here. The registry parameter is now `registry`,
    // not `server`. Far more dangerous, the old injected body hardcoded
    // the minified identifier `handleRpc$1`, which no longer exists in the
    // 5.3.x bundle (it is `require_..._coordinator.handleRpc`); injecting
    // a stale identifier would throw ReferenceError in the main process at
    // startup. We now resolve the callee from the function body and refuse
    // to inject at all when it cannot be found.
    //
    // updateGetState is intentionally left functional (it is read-only) so
    // the renderer keeps receiving a well-formed payload.
    // -----------------------------------------------------------------------
    const updateRpcM = source.match(/function registerUpdateHandlers\(\s*([\w$]+)\s*,\s*([\w$]+)\s*\)\s*\{/);
    if (!updateRpcM) {
        record('update RPCs stubbed (Fix 6b)', 'failed',
            'registerUpdateHandlers signature not found — re-anchor against upstream bundle');
    } else if (source.includes(UPDATERPC_MARKER)) {
        record('update RPCs stubbed (Fix 6b)', 'skipped', 'already patched');
    } else {
        const registryVar = updateRpcM[1];
        const depsVar = updateRpcM[2];
        const bodyStart = updateRpcM.index + updateRpcM[0].length;
        const bodySlice = source.slice(bodyStart, bodyStart + 2000);
        const calleeRe = new RegExp('([\\w$]+(?:\\.[\\w$]+)*)\\.handleRpc\\(\\s*' + registryVar + '\\s*,');
        const calleeM = bodySlice.match(calleeRe);
        if (!calleeM) {
            record('update RPCs stubbed (Fix 6b)', 'failed',
                'could not resolve the handleRpc callee inside registerUpdateHandlers');
        } else {
            const rpc = calleeM[1];
            const call = (name, body) =>
                '\t\t' + rpc + '.handleRpc(' + registryVar + ', "' + name + '", ' + body + ');\n';
            const linuxRpcShim =
                updateRpcM[0] + '\n' +
                '\t// ' + UPDATERPC_MARKER + '\n' +
                '\tif (process.platform === "linux") {\n' +
                call('updateCheck', 'async () => {}') +
                call('updateDownload', 'async () => {}') +
                call('updateArchMismatchDownload', 'async () => {}') +
                call('updateArchMismatchInstall', 'async () => {}') +
                call('updateQuitAndInstall', 'async () => {}') +
                call('updateGetState',
                    'async () => toUiPayload(await (await Promise.resolve(' + depsVar + '.update)).getState())') +
                '\t\treturn;\n' +
                '\t}';
            source = replaceOnce(source, updateRpcM[0], linuxRpcShim);
            record('update RPCs stubbed (Fix 6b)', 'applied',
                'callee resolved as ' + rpc + '.handleRpc(' + registryVar + ', ...)');
        }
    }

    // -----------------------------------------------------------------------
    // Fix 6c (Linux): short-circuit UpdateServiceLinux.checkForUpdates.
    //
    // The upstream Linux service queries an update feed and drives the
    // macOS/Windows installers, neither of which applies here. The class
    // and method names survived the bundler, but we anchor with regexes so
    // a future rename becomes a reported failure instead of silence.
    // -----------------------------------------------------------------------
    if (source.includes(AUTOUPDATE_MARKER)) {
        record('auto-update short-circuit (Fix 6c)', 'skipped', 'already patched');
    } else {
        const classM = source.match(/UpdateServiceLinux\s*=\s*class[^{]*\{/);
        const methodRe = /async checkForUpdates\([^)]*\)\s*\{/;
        const afterClass = classM ? source.slice(classM.index + classM[0].length) : '';
        const methodM = afterClass ? afterClass.match(methodRe) : null;
        if (!classM || !methodM) {
            record('auto-update short-circuit (Fix 6c)', 'failed',
                'UpdateServiceLinux.checkForUpdates not found — re-anchor against upstream bundle');
        } else {
            const at = classM.index + classM[0].length + methodM.index + methodM[0].length;
            const earlyReturn =
                '\n\t\t\t\t\t// ' + AUTOUPDATE_MARKER + ' auto-update is unavailable on the Linux port\n' +
                '\t\t\t\t\treturn;\n';
            source = source.slice(0, at) + earlyReturn + source.slice(at);
            record('auto-update short-circuit (Fix 6c)', 'applied',
                'checkForUpdates returns early on Linux');
        }
    }

    fs.writeFileSync(indexPath, source);
}

// ---------------------------------------------------------------------------
// Also patch sidecar-entry.js so the sidecar process, spawned with
// ELECTRON_RUN_AS_NODE=1 and its own Node bootstrap, receives the same
// env Proxy / _FILE receiver installed in main/index.js. Without this
// the sidecar would boot without ACC_PRODUCT_CONFIG_V3 set (because
// the parent spilled it to a file) and every downstream call through
// getWorkbuddyBootstrapProductConfigurationEnv() would fall back to
// a stale bootstrap value.
// ---------------------------------------------------------------------------
const sidecarEntryPath = path.join(tmpDir, 'main', 'sidecar-entry.js');
if (!fs.existsSync(sidecarEntryPath)) {
    record('env shim (main/sidecar-entry.js)', 'failed',
        'sidecar-entry.js missing from the asar — sidecar will not see the product config');
} else {
    let sidecarSource = fs.readFileSync(sidecarEntryPath, 'utf8');
    if (sidecarSource.includes(marker)) {
        record('env shim (main/sidecar-entry.js)', 'skipped', 'marker already present');
    } else {
        sidecarSource = SHIM_BODY + sidecarSource;
        fs.writeFileSync(sidecarEntryPath, sidecarSource);
        record('env shim (main/sidecar-entry.js)', 'applied', 'env Proxy + _FILE receiver');
    }
}

// Everything that can be verified without repacking has now been checked.
summarize();

// ---------------------------------------------------------------------------
// Ensure @lydell/node-pty-linux-x64 is present in the asar's node_modules
// so that require("@lydell/node-pty-linux-x64") resolves from within the
// asar. The package lives on disk in app.asar.unpacked/node_modules/ but
// was never registered in the original macOS asar header. We copy it into
// the tmpDir so the repack step includes it as an unpacked entry.
// ---------------------------------------------------------------------------
const lydellLinuxSrc = path.join(unpackedSiblingDir, 'node_modules', '@lydell', 'node-pty-linux-x64');
const lydellLinuxDst = path.join(tmpDir, 'node_modules', '@lydell', 'node-pty-linux-x64');
if (fs.existsSync(lydellLinuxSrc) && !fs.existsSync(lydellLinuxDst)) {
    fs.cpSync(lydellLinuxSrc, lydellLinuxDst, { recursive: true });
    log('copied @lydell/node-pty-linux-x64 into asar source for repack');
}

// ---------------------------------------------------------------------------
// 3. Repack.
//
// @electron/asar's glob-based --unpack matcher has O(2^n) behaviour on a
// brace list the size of ours (~850 entries). Instead we build a Set of
// the original unpacked paths, use a catch-all minimatch pattern that
// accepts everything, and pass a `dot: true` pattern per directory. But
// the cleanest route with the public API is: pass a minimatch function
// that is fast. Turns out the simplest workable approach is to use the
// pattern scheme once per "class" of entry. On inspection, the original
// header's unpacked set is exactly:
//     cli/**   +   resources/**   +   a specific subset of node_modules/**
//
// For node_modules, the unpacked subset is always a whole package tree
// (better-sqlite3, @lydell/*, node-pty, nunjucks, @tencent/docs-engine).
//
// We compute that per-top-level-dir unpacked set dynamically from the
// original header and emit an asar `--unpack=…` pattern that names each
// top-level directory that must be fully unpacked. That's small enough
// for minimatch to handle in microseconds.
// ---------------------------------------------------------------------------
function collectFullyUnpackedDirs() {
    // Find every directory where 100% of its immediate children are unpacked
    // (recursively). Start from each top-level dir.
    const dirs = [];
    function visit(node, relPath) {
        if (!node.files) return { total: 0, unpacked: 0 };
        let total = 0, unpacked = 0;
        for (const [name, entry] of Object.entries(node.files)) {
            const child = relPath ? relPath + '/' + name : name;
            if (entry.files) {
                const sub = visit(entry, child);
                total += sub.total;
                unpacked += sub.unpacked;
            } else if (entry.link) {
                // links aren't packed or unpacked; ignore for the ratio
            } else {
                total++;
                if (entry.unpacked) unpacked++;
            }
        }
        if (total > 0 && total === unpacked && relPath) {
            dirs.push(relPath);
        }
        return { total, unpacked };
    }
    visit(header, '');
    // Only keep maximal directories (drop any dir whose parent is also in
    // the set), so the asar glob pattern stays minimal.
    const set = new Set(dirs);
    return dirs.filter(d => {
        const parts = d.split('/');
        for (let i = 1; i < parts.length; i++) {
            const parent = parts.slice(0, i).join('/');
            if (set.has(parent)) return false;
        }
        return true;
    });
}

const fullyUnpackedDirs = collectFullyUnpackedDirs();
// Also include any Linux platform packages we injected into the tmpDir
// that weren't in the original macOS header.
const extraUnpackDirs = ['node_modules/@lydell/node-pty-linux-x64'];
for (const d of extraUnpackDirs) {
    if (fs.existsSync(path.join(tmpDir, d)) && !fullyUnpackedDirs.includes(d)) {
        fullyUnpackedDirs.push(d);
    }
}
log('Fully-unpacked top directories: ' + fullyUnpackedDirs.length);

// Compose the asar `unpackDir` glob. It is matched against directory
// entries, so "cli" matches the cli/ tree recursively. Brace-list of
// ~10 paths is fast.
const unpackDirPattern = '{' + fullyUnpackedDirs.map(d =>
    d.replace(/[{}(),*?[\]!|+@\\]/g, ch => '\\' + ch)
).join(',') + '}';

// Also compute any individual unpacked files that live in partially-packed
// directories (e.g. a single file under node_modules/foo/ where only that
// one file is unpacked). Collect them and use an explicit --unpack glob.
const partialUnpackedFiles = [];
function findPartialFiles(node, relPath) {
    if (!node.files) return;
    if (fullyUnpackedDirs.includes(relPath)) return; // covered by unpackDir
    for (const [name, entry] of Object.entries(node.files)) {
        const child = relPath ? relPath + '/' + name : name;
        if (entry.files) {
            if (!fullyUnpackedDirs.includes(child)) {
                findPartialFiles(entry, child);
            }
        } else if (entry.unpacked && !entry.link) {
            // Is the child's directory already in the fully-unpacked set?
            const parent = child.split('/').slice(0, -1).join('/');
            if (!fullyUnpackedDirs.some(d => parent === d || parent.startsWith(d + '/'))) {
                partialUnpackedFiles.push(child);
            }
        }
    }
}
findPartialFiles(header, '');
log('Partially-unpacked individual files: ' + partialUnpackedFiles.length);

const unpackPattern = partialUnpackedFiles.length
    ? '{' + partialUnpackedFiles.map(p =>
        p.replace(/[{}(),*?[\]!|+@\\]/g, ch => '\\' + ch)
    ).join(',') + '}'
    : undefined;

// ---------------------------------------------------------------------------
// Pack.
//
// We only edit main/index.js, which lives inside the asar (packed). The
// sibling <asar>.unpacked/ sidecar directory therefore does not need to
// change — and we explicitly avoid touching it so that any files the
// install.sh step already placed there (e.g. rebuilt native modules,
// Linux ripgrep binary, the original resources/icon.png) stay as-is.
//
// The repack produces its own sidecar directory matching the header's
// unpack set. We throw that output away.
// ---------------------------------------------------------------------------
(async () => {
    const outPath = asarPath + '.new';
    const stagingSidecar = outPath + '.unpacked';
    try { fs.rmSync(outPath, { force: true }); } catch (_) {}
    try { fs.rmSync(stagingSidecar, { recursive: true, force: true }); } catch (_) {}

    await asar.createPackageWithOptions(tmpDir, outPath, {
        unpackDir: unpackDirPattern,
        unpack: unpackPattern,
    });
    log('wrote ' + path.basename(outPath) + ' (' + fs.statSync(outPath).size + ' bytes)');

    // Atomically replace app.asar only. Leave app.asar.unpacked alone.
    fs.renameSync(asarPath, asarPath + '.prepatch');
    try {
        fs.renameSync(outPath, asarPath);
    } catch (err) {
        // Roll back on failure.
        try { fs.renameSync(asarPath + '.prepatch', asarPath); } catch (_) {}
        throw err;
    }
    try { fs.rmSync(asarPath + '.prepatch'); } catch (_) {}

    // Discard the repack's sidecar directory; the on-disk one is already
    // correct and contains additional files (rebuilt native modules,
    // Linux binaries) that the staging dir does not have.
    try { fs.rmSync(stagingSidecar, { recursive: true, force: true }); } catch (_) {}

    log('replaced app.asar in place (app.asar.unpacked left untouched)');
})().catch(err => {
    console.error('[apply-linux-patches] pack failed:', err);
    process.exit(6);
});

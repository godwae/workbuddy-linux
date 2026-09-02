#!/usr/bin/env node
/**
 * Verify that the Linux runtime patches are actually present inside an
 * already-built app.asar.
 *
 * The patcher anchors on upstream source text, so a new upstream release
 * can silently disable a patch. This script reads the asar directly (no
 * @electron/asar dependency — the container format is a plain pickle
 * header followed by the concatenated file payloads) and reports which
 * patches are present, missing, or not applicable.
 *
 * Usage:
 *   node verify-patches.js [path/to/app.asar]
 *
 * Exit codes:
 *   0 = every required patch present
 *   1 = at least one required patch missing
 *   2 = the asar could not be read
 */
const fs = require('fs');
const path = require('path');

const asarPath = process.argv[2] ||
    path.join(__dirname, '..', '..', 'workbuddy-app', 'resources', 'app.asar');

const MARKERS = [
    { file: 'main/index.js', key: '__WB_LINUX_PATCHES_V5__', name: 'env shim (main)', required: true },
    { file: 'main/sidecar-entry.js', key: '__WB_LINUX_PATCHES_V5__', name: 'env shim (sidecar)', required: true },
    { file: 'main/index.js', key: '__WB_TRAY_PATCH_V1__', name: 'tray context menu (Fix 2)', required: true },
    { file: 'main/index.js', key: 'linuxTrayPath', name: 'tray on-disk icon (Fix 3)', required: true },
    { file: 'main/index.js', key: '__WB_WINCTRL_PATCH_V1__', name: 'window controls (Fix 5)', required: true },
    { file: 'main/index.js', key: '__WB_UPDATERPC_PATCH_V1__', name: 'update RPC stubs (Fix 6b)', required: true },
    { file: 'main/index.js', key: '__WB_AUTOUPDATE_PATCH_V1__', name: 'auto-update short-circuit (Fix 6c)', required: true },
    { file: 'main/index.js', key: '__WB_UPDATEMENU_PATCH_V1__', name: 'update menu greyed out (Fix 6a)', required: false },
    { file: 'main/index.js', key: '__WB_DESKTOPLAYOUT_PATCH_V1__', name: 'drag-region guard (Fix 8)', required: true },
];

function fail(msg) {
    console.error('[verify-patches] ' + msg);
    process.exit(2);
}

if (!fs.existsSync(asarPath)) fail('app.asar not found: ' + asarPath);

// ---------------------------------------------------------------------------
// Parse the asar container: [u32 4][u32 headerPickleLen][u32 strLen][JSON][data]
// ---------------------------------------------------------------------------
const fd = fs.openSync(asarPath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const strLen = head.readUInt32LE(12);
const header = JSON.parse(fs.readFileSync(asarPath).slice(16, 16 + strLen).toString('utf8'));
const dataBase = 16 + strLen;

function findEntry(node, prefix, target) {
    for (const [name, e] of Object.entries(node.files || {})) {
        const rel = prefix ? prefix + '/' + name : name;
        if (e.files) {
            const hit = findEntry(e, rel, target);
            if (hit) return hit;
        } else if (rel === target) {
            return e;
        }
    }
    return null;
}

const cache = new Map();
function readEntry(rel) {
    if (cache.has(rel)) return cache.get(rel);
    const e = findEntry(header, '', rel);
    if (!e) return null;
    if (e.unpacked) {
        const p = path.join(asarPath + '.unpacked', rel);
        const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
        cache.set(rel, text);
        return text;
    }
    const buf = Buffer.alloc(e.size);
    fs.readSync(fd, buf, 0, e.size, dataBase + Number(e.offset));
    const text = buf.toString('utf8');
    cache.set(rel, text);
    return text;
}

console.log('[verify-patches] ' + asarPath);
let missing = 0;
for (const m of MARKERS) {
    const text = readEntry(m.file);
    if (text === null) {
        console.log('  MISSING-FILE  ' + m.name + '  (' + m.file + ' not in asar)');
        if (m.required) missing++;
        continue;
    }
    const hit = text.includes(m.key);
    const tag = hit ? 'OK      ' : (m.required ? 'MISSING ' : 'N/A     ');
    console.log('  ' + tag + m.name + (hit ? '' : '  [' + m.key + ' in ' + m.file + ']'));
    if (!hit && m.required) missing++;
}

fs.closeSync(fd);

console.log('[verify-patches] ' + (missing === 0
    ? 'all required patches present'
    : missing + ' required patch(es) MISSING — re-run: make build-app'));
process.exit(missing === 0 ? 0 : 1);

"""Copy Code session records from other logins' folders into the shared one.

Run only while Claude is not running. Originals stay where they were (backup).
Records which session came from which account in state/merged.json, so the
sidebar can be grouped by account later. Safe to run again: copies only what
the shared folder does not have yet.
"""
import json
import os
import shutil
import sys

import config

ROOT = os.environ.get("CC_SESSIONS_ROOT") or os.path.expanduser("~/Library/Application Support/Claude/claude-code-sessions")

cfg = config.load()
if not cfg.get("sessionStore") or not cfg.get("mergeFrom"):
    sys.exit(0)  # nothing configured to merge
store = os.path.join(ROOT, cfg["sessionStore"])
merged_path = os.environ.get("CC_MERGED_JSON") or os.path.join(config.STATE, "merged.json")
os.makedirs(os.path.dirname(merged_path), exist_ok=True)
merged = json.load(open(merged_path)) if os.path.exists(merged_path) else {}

copied = 0
for src_rel, label in cfg.get("mergeFrom", {}).items():
    src = os.path.join(ROOT, src_rel)
    if not os.path.isdir(src):
        print(f"skip {label}: {src_rel} missing")
        continue
    for name in sorted(os.listdir(src)):
        if not (name.startswith("local_") and name.endswith(".json")):
            continue
        sid = name[:-5]
        merged.setdefault(label, [])
        if sid not in merged[label]:
            merged[label].append(sid)
        if os.path.exists(os.path.join(store, name)):
            continue
        shutil.copy2(os.path.join(src, name), os.path.join(store, name))
        copied += 1
    wi_src, wi_dst = os.path.join(src, "waiting-input"), os.path.join(store, "waiting-input")
    if os.path.isdir(wi_src):
        os.makedirs(wi_dst, exist_ok=True)
        for name in os.listdir(wi_src):
            if not os.path.exists(os.path.join(wi_dst, name)):
                shutil.copy2(os.path.join(wi_src, name), os.path.join(wi_dst, name))

json.dump(merged, open(merged_path, "w"), indent=1)
print(f"merged: copied {copied} session(s); " + ", ".join(f"{k}={len(v)}" for k, v in merged.items()))
sys.exit(0)

# claude-accounts

Run every Claude Code session in Claude Desktop on its own Claude subscription, in one window.

![Claude Desktop with the Subscriptions pane](docs/screenshot.png)

Claude Desktop gives every Code session the token of the account you are signed in to. If you
have several subscriptions (work, personal, a team seat, a friend's spare Ultra), you either sign
out and in all day or run two apps. claude-accounts runs a patched copy of Claude Desktop that,
per Code session, swaps in another subscription's long-lived token, and adds a **Subscriptions**
pane next to the chat:

- what is left of each subscription's 5-hour and weekly limit, each bar drawn to the plan's size,
  with a blue mark where an even spend would be now (green ahead of that pace, amber a little
  behind, red far behind);
- **Move chat here** — the chat restarts on that subscription as soon as it is idle (the app's
  own quiet restart, no "interrupted" notice);
- **Add subscription** — macOS dialogs, a sign-in page in the browser you pick, done. No terminal.

New chats pick a subscription by themselves: the one with the most weekly limit that would
otherwise go unused before its reset, weighted by plan size. Sub-sessions stay on their parent's.
Folder rules can pin a project to a subscription. Set `"autoPlace": false` (or run `acct auto off`)
to turn the automatic placement off: a new chat then stays on the desktop login until moved by hand,
and a subscription that fails its check falls back to the desktop login.

## Install

Needs macOS, Claude Desktop in `/Applications`, and Node.js (`brew install node`).

```bash
git clone https://github.com/nkvch/claude-accounts.git ~/claude-accounts
~/claude-accounts/install.sh
```

Then quit Claude and open **Claude Launcher** from `~/Applications` (put it in the Dock and use it
instead of Claude). The launcher rebuilds the patched copy (`~/Applications/Claude Accounts.app`)
whenever Claude updates; if a Claude update ever breaks the patch, it opens the official app and
tells you.

Set the plan of the account Claude Desktop is signed in to in `~/.claude-accounts/accounts.json`
(`plan`, and `proX` = times Pro usage per week: Pro 1, Max 5x 5, Ultra 10, Max 20x 20, Team Premium 6.25).

## Config: `~/.claude-accounts/`

| File | What |
| --- | --- |
| `accounts.json` | subscriptions (see `accounts.example.json`): `label`, `tokenKey`, `plan`, `proX`, optional `note`, `auto: false` to never pick it for new chats, `env`; top-level `autoPlace` (default `true`; `false` = no automatic placement of new chats, no fallback to another subscription), top-level `barScale` (`"adaptive"` default: each bar drawn to its plan size; `"independent"`: every bar full width, filled only relative to itself), `rules` pin folders to an account; optional `envFile` to keep tokens in another dotenv file |
| `tokens.env` | the long-lived tokens (`CC_TOKEN_<NAME>=…`, from `claude setup-token`), mode 600 |
| `state/` | `hook.log` (which session got which account), `launch.log`, `limits.json`, `overrides.json` |
| `inject.js` | optional: your own script run in every page of the app |
| `demo.json` | optional: made-up subscriptions for screenshots (copy `demo.example.json`); remove it to see your own |

`CLAUDE_ACCOUNTS_HOME` moves the folder.

## In a session

- `/acct` shows the chat's subscription; `/acct <name>` moves it (same as the pane's button).
- `acct scale` shows `adaptive`/`independent`; `acct scale adaptive|independent` sets `barScale` in `accounts.json` (also the "Bar width" button in the pane). `acct auto` shows whether new chats are placed automatically (`on`/`off`); `acct auto on|off` sets `autoPlace` in `accounts.json`, the next new chat follows it. `auto` is reserved for this: a subscription named `auto` cannot be moved to with `acct auto`.
- The Subscriptions pane has an Auto-place switch for the same flag.
- `/limits` reopens the pane.

## Chat banner

A chat can call you with a card in the top-right corner of the screen. It stays until you click
it, and the click opens the chat that raised it in Claude Accounts.app, so you land right where you
are needed. It needs [Hammerspoon](https://www.hammerspoon.org) (`brew install --cask hammerspoon`);
`install.sh` loads `nudge/claude_nudge.lua` into it and links the command to
`~/.claude-accounts/bin/claude-nudge` (`$CLAUDE_ACCOUNTS_HOME/bin/` if you moved the folder). It
also turns on Hammerspoon's `hs.ipc`, the port the command talks through: any program running as
you can then run Lua in Hammerspoon.

```bash
~/.claude-accounts/bin/claude-nudge "Deploy is stuck" "Need SSH access to the server"
```

`install.sh` also builds `~/.claude-accounts/bin/claude-share-state` from `nudge/share_state.swift`. It prints
`sharing` (exit 0) while any screen sharing or recording is running, `idle` (exit 1) otherwise, and
`unknown` (exit 2, reason on stderr) if it cannot tell; `--verbose` shows the signal. It reads
SkyLight's private `CGSIsScreenWatcherPresent`, which is true for `screencapture -v` on macOS 26.

The card knows its chat from `$CLAUDE_CODE_HOST_SESSION_ID`, which the desktop app sets in every
Code session, sub-sessions and scheduled tasks included. Run outside the app, the card still shows
and a click only dismisses it.

While your screen is shared or recorded (Meet, Zoom, Teams, QuickTime, Cmd+Shift+5, OBS, anything
that captures it; `~/.claude-accounts/bin/claude-share-state` reports it, polled every 3 s), no card
is drawn, and cards already on screen when it begins are taken down. Cards wait in a queue, and when the capture ends one summary card comes: "Пока ты шарил: N"
with a line per card, "title — first line of the body" (up to 6 lines, the rest as "… и ещё N").
A click on a line does what a click on that card would and removes the line; the ✕ drops the whole
summary. `claude-nudge --key K -- "$TITLE" "$BODY"` keeps a title or body that starts with
`--key` as text. A lone waiting card comes back as itself. A single failed detector run changes nothing;
after three polls in a row (9 s) the screen counts as not shared, cards show as usual, and a
"Не вижу, шаришь ли ты" alert and a console line say so once. `install.sh` builds the detector with
`swiftc`, only when the source is newer than the binary; if the build fails it prints swiftc's error
and "детектор шаринга выключен".

ctrl+alt+cmd+Q switches the same hold-back on by hand ("Тихо") and off ("Снова зову"), for when
nothing is being captured but you do not want to be interrupted.

`--key KEY` names a card: a card with the same key replaces the earlier one (also in the queue),
and a script can ask what became of it with
`hs -c 'return claudeNudgeState("KEY")'`: `open` (on screen), `queued` (held back), `gone`
(clicked or closed) or `unknown` (a key Hammerspoon has not seen since it was last reloaded, so the
card is lost, not answered).

The user-browser plugin (Claude Bridge) calls a notification hook when an agent in your browser
needs you. `install.sh` links `nudge/user-browser-notify` as `notify` in the plugin's data
directory (`$USER_BROWSER_DATA_DIR`, else `~/.local/share/user-browser/`, and any
`~/.claude/plugins/data/user-browser-*/user-browser/`), so those requests raise the same
card, held back while the screen is shared. A `notify` already there is left alone and `install.sh`
says so; point `USER_BROWSER_NOTIFY_HOOK` at the script instead. The hook passes the text to
Hammerspoon as files in a private temporary directory, never as code, and the click command it
carries is never logged. `nudge/test_user_browser_notify.sh` checks it with a fake `hs`.

To have every chat call you this way, add to `~/.claude/CLAUDE.md`:

```markdown
## Calling me
When you are blocked on me, finished a long task, or need my eyes, raise a banner
(it stays until I click it; the click opens this chat):
`~/.claude-accounts/bin/claude-nudge "Short title" "What exactly I need to do"`
One line each; the detail stays in the chat.
```

## How it works

`app/patch.js` edits a copy of Claude Desktop's `app.asar` in four places, each matched exactly
once or the build fails and touches nothing: it loads `app/hook.js` at startup, lets the hook
choose the token when a Code session's process is spawned (and keeps the desktop's own token out
of it), exposes the app's quiet session restart, and turns the copy's self-updater off. The copy is
re-signed ad hoc. `app/logic.js` holds the choosing logic and is reloaded on every call. Usage
numbers come from the rate-limit headers of a 1-token request per subscription, every 10 minutes.

Not covered: claude.ai chats, the app's own usage ring (it shows the desktop login), SSH and cloud
sessions.

## Uninstall

```bash
rm -rf ~/Applications/"Claude Accounts.app" ~/Applications/"Claude Launcher.app"
claude plugin uninstall subscriptions@claude-accounts
```

To drop the chat banner, remove the `-- Claude chat banner (claude-accounts)` comment and the
`claude_nudge.lua` line under it from `~/.hammerspoon/init.lua`
(and `require("hs.ipc")` if nothing else of yours uses it).

`~/.claude-accounts` holds your tokens: delete it too if you do not want to keep them.

-- Claude nudge banner: a persistent top-right card a chat raises to call you.
-- Loaded from ~/.hammerspoon/init.lua via dofile() (install.sh adds the line);
-- raised by nudge/claude-nudge. A click runs the card's
-- action (a shell command string, or an argv table run without a shell — the
-- user-browser notify hook passes one) or opens the chat that raised it, then
-- dismisses it. The ✕ only dismisses.
--
-- While the screen is shared or recorded (nudge/claude-share-state says so) or the
-- quiet mode is on (ctrl+alt+cmd+Q), no card is drawn: it waits in a queue and,
-- when that ends, comes as one summary card (or as itself when it is alone). Cards
-- already on screen when it begins are taken down and queued the same way.
-- The queue logic is in nudge_queue.lua, next to this file.

claudeNudges = claudeNudges or {}

local Q = dofile((debug.getinfo(1, "S").source:match("^@(.*)/[^/]*$") or ".") .. "/nudge_queue.lua")
claudeNudgeQueue = claudeNudgeQueue or Q.new()

-- The patched app (install.sh builds it); a bare `open` of a claude:// link would start the official one.
local CLAUDE_APP = os.getenv("HOME") .. "/Applications/Claude Accounts.app"

claudeNudgeTasks = claudeNudgeTasks or {}

local function openChat(session)
    local task
    task = hs.task.new("/usr/bin/open", function(code, _, stderr)
        claudeNudgeTasks[task] = nil
        if code ~= 0 then hs.alert.show("Не открылось: " .. (stderr or ""):sub(1, 160), 6) end
    end, { "-a", CLAUDE_APP, "claude://claude.ai/epitaxy/" .. session })
    claudeNudgeTasks[task] = true
    task:start()
end

-- Run a card's click command. Hammerspoon handled the click, so it may bring
-- Chrome forward even where macOS stops Chrome from activating itself; a failed
-- command says so instead of the card just vanishing.
-- key -> the app you were in when you clicked (and when); a later
-- claudeNudgeDismissKey(key, true) — the step is done and its window went back
-- to the Dock from under you — hands focus back to it.
claudeNudgeReturnTo = claudeNudgeReturnTo or {}
local RETURN_TTL_S = 15 * 60

local function runAction(action, key)
    if key then claudeNudgeReturnTo[key] = { app = hs.application.frontmostApplication(), at = os.time() } end
    -- A table is an argv list (program first) and runs without a shell; a string is a shell command.
    local program, args = "/bin/sh", { "-c", action }
    if type(action) == "table" then program, args = action[1], { table.unpack(action, 2) } end
    local task
    task = hs.task.new(program, function(code, _, stderr)
        claudeNudgeTasks[task] = nil
        if code == 0 then
            local chrome = hs.application.get("Google Chrome")
            if chrome then chrome:activate() end
        else
            hs.alert.show("Не открылось: " .. (stderr or ""):sub(1, 160), 6)
        end
    end, args)
    claudeNudgeTasks[task] = true
    task:start()
end

-- What a click on a card (or a summary row) does: the action, else the chat.
local function activate(action, session, key)
    if action then
        runAction(action, key)
    elseif session then
        openChat(session)
    end
end

local showItems, removeFromSummary  -- below: the summary card and what feeds it

local function relayout()
    local top = hs.screen.mainScreen():frame().y + 40
    for _, n in ipairs(claudeNudges) do
        local f = n.canvas:frame()
        n.canvas:frame({ x = f.x, y = top, w = f.w, h = f.h })
        top = top + f.h + 10
    end
end

function claudeNudgeDismiss(canvas)
    for i, n in ipairs(claudeNudges) do
        if n.canvas == canvas then
            table.remove(claudeNudges, i)
            break
        end
    end
    canvas:delete(0.15)
    relayout()
end

local function removeKeyed(key)
    for i = #claudeNudges, 1, -1 do
        if claudeNudges[i].key == key then claudeNudgeDismiss(claudeNudges[i].canvas) end
    end
end

-- The caller's step is done: dismiss its cards. With returnFocus, also go
-- back to the app the click came from — only while Chrome is still in front,
-- so if you have moved on yourself you are left alone.
function claudeNudgeDismissKey(key, returnFocus)
    removeKeyed(key)
    Q.remove(claudeNudgeQueue.queue, key)
    removeFromSummary(key)
    local back = claudeNudgeReturnTo[key]
    claudeNudgeReturnTo[key] = nil
    if not (returnFocus and back and os.time() - back.at < RETURN_TTL_S) then return true end
    local front = hs.application.frontmostApplication()
    if front and front:name() == "Google Chrome" and back.app:isRunning() and back.app:name() ~= "Google Chrome" then
        back.app:activate()
    end
    return true
end

local function drawCard(title, body, session, action, key)
    local screen = hs.screen.mainScreen():frame()
    local w = 380
    local pad = 16
    local titleH = 24
    local lines = 0  -- ~42 characters per line; count characters, not UTF-8 bytes
    for seg in (body .. "\n"):gmatch("([^\n]*)\n") do
        lines = lines + math.max(1, math.ceil((utf8.len(seg) or #seg) / 42))
    end
    local bodyH = math.max(20, lines * 19)
    local h = titleH + bodyH + pad * 2 + 14
    local x = screen.x + screen.w - w - 20
    local c = hs.canvas.new({ x = x, y = screen.y + 40, w = w, h = h })
    c:level(hs.canvas.windowLevels.overlay)
    c:behavior(hs.canvas.windowBehaviors.canJoinAllSpaces)

    c[1] = { type = "rectangle", action = "fill",
             fillColor = { red = 0.08, green = 0.09, blue = 0.12, alpha = 0.97 },
             roundedRectRadii = { xRadius = 12, yRadius = 12 } }
    c[2] = { type = "rectangle", action = "stroke", strokeWidth = 2,
             strokeColor = { red = 0.98, green = 0.62, blue = 0.20, alpha = 1.0 },
             roundedRectRadii = { xRadius = 12, yRadius = 12 } }
    c[3] = { type = "text", text = title,
             textColor = { red = 0.98, green = 0.72, blue = 0.30, alpha = 1 },
             textSize = 15, textFont = "Menlo-Bold",
             frame = { x = pad, y = pad - 4, w = w - pad * 2 - 24, h = titleH } }
    c[4] = { type = "text", text = body,
             textColor = { white = 0.92, alpha = 1 },
             textSize = 13, textFont = "Menlo",
             frame = { x = pad, y = pad + titleH - 6, w = w - pad * 2, h = bodyH + 8 } }
    c[5] = { type = "text",
             text = action and "нажми — откроется окно" or session and "нажми — откроется чат" or "нажми, чтобы закрыть",
             textColor = { white = 0.45, alpha = 1 },
             textSize = 10, textFont = "Menlo",
             frame = { x = pad, y = h - pad - 4, w = w - pad * 2, h = 14 } }

    c[6] = { type = "text", text = "✕", id = "close", trackMouseUp = true,
             textColor = { white = 0.6, alpha = 1 }, textSize = 15,
             frame = { x = w - 30, y = 8, w = 22, h = 22 } }

    c:clickActivating(false)
    c:mouseCallback(function(canvas, event, id)
        if event == "mouseUp" then
            if id ~= "close" then activate(action, session, key) end
            claudeNudgeDismiss(canvas)
        end
    end)
    c:canvasMouseEvents(true, true)
    c:show(0.2)

    table.insert(claudeNudges, { canvas = c, key = key,
        item = { title = title, body = body, session = session, action = action, key = key, at = os.time() } })
    relayout()
    return true
end

-- The summary card for cards held back during a share. A click on a row does what a
-- click on that card would, and the row goes; the ✕ drops the whole summary.
local SUMMARY_ROWS, ROW_H, ROW_CHARS = 6, 22, 40

local function summaryEntry()
    for _, n in ipairs(claudeNudges) do
        if n.summary then return n end
    end
end

local function drawSummary(items)
    local screen = hs.screen.mainScreen():frame()
    local w = 380
    local pad = 16
    local titleH = 24
    local rows, more = Q.rows(items, SUMMARY_ROWS, ROW_CHARS)
    local h = titleH + (#rows + (more > 0 and 1 or 0)) * ROW_H + pad * 2 + 14
    local x = screen.x + screen.w - w - 20
    local c = hs.canvas.new({ x = x, y = screen.y + 40, w = w, h = h })
    c:level(hs.canvas.windowLevels.overlay)
    c:behavior(hs.canvas.windowBehaviors.canJoinAllSpaces)

    c[1] = { type = "rectangle", action = "fill",
             fillColor = { red = 0.08, green = 0.09, blue = 0.12, alpha = 0.97 },
             roundedRectRadii = { xRadius = 12, yRadius = 12 } }
    c[2] = { type = "rectangle", action = "stroke", strokeWidth = 2,
             strokeColor = { red = 0.98, green = 0.62, blue = 0.20, alpha = 1.0 },
             roundedRectRadii = { xRadius = 12, yRadius = 12 } }
    c[3] = { type = "text", text = "Пока ты шарил: " .. #items,
             textColor = { red = 0.98, green = 0.72, blue = 0.30, alpha = 1 },
             textSize = 15, textFont = "Menlo-Bold",
             frame = { x = pad, y = pad - 4, w = w - pad * 2 - 24, h = titleH } }
    local top = pad + titleH - 6
    for i, row in ipairs(rows) do
        c[3 + i] = { type = "text", text = row.text, id = "row" .. i, trackMouseUp = true,
                 textColor = { white = 0.92, alpha = 1 },
                 textSize = 13, textFont = "Menlo",
                 frame = { x = pad, y = top, w = w - pad * 2, h = ROW_H } }
        top = top + ROW_H
    end
    if more > 0 then
        c[#rows + 4] = { type = "text", text = "… и ещё " .. more,
                 textColor = { white = 0.6, alpha = 1 },
                 textSize = 13, textFont = "Menlo",
                 frame = { x = pad, y = top, w = w - pad * 2, h = ROW_H } }
    end
    local n = #rows + (more > 0 and 4 or 3)
    c[n + 1] = { type = "text", text = "нажми на строку — откроется она",
             textColor = { white = 0.45, alpha = 1 },
             textSize = 10, textFont = "Menlo",
             frame = { x = pad, y = h - pad - 4, w = w - pad * 2, h = 14 } }
    c[n + 2] = { type = "text", text = "✕", id = "close", trackMouseUp = true,
             textColor = { white = 0.6, alpha = 1 }, textSize = 15,
             frame = { x = w - 30, y = 8, w = 22, h = 22 } }

    c:clickActivating(false)
    c:mouseCallback(function(canvas, event, id)
        if event ~= "mouseUp" then return end
        if id == "close" then
            claudeNudgeDismiss(canvas)
            return
        end
        local row = rows[tonumber((id or ""):match("^row(%d+)$"))]
        if not row then return end
        local entry = summaryEntry()
        for i, it in ipairs(entry.summary) do
            if it == row.item then
                table.remove(entry.summary, i)
                break
            end
        end
        claudeNudgeDismiss(canvas)
        activate(row.item.action, row.item.session, row.item.key)
        showItems(entry.summary)
    end)
    c:canvasMouseEvents(true, true)
    c:show(0.2)

    table.insert(claudeNudges, { canvas = c, summary = items })
    relayout()
    return true
end

-- One item is shown as its own card, several as the summary.
function showItems(items)
    if #items == 1 then
        local it = items[1]
        return drawCard(it.title, it.body, it.session, it.action, it.key)
    elseif #items > 1 then
        return drawSummary(items)
    end
end

-- A key was re-asked or its step is done: drop it from a summary on screen too.
function removeFromSummary(key)
    local entry = summaryEntry()
    if not entry or not Q.remove(entry.summary, key) then return end
    claudeNudgeDismiss(entry.canvas)
    showItems(entry.summary)
end

local function flush(items)
    local shown = summaryEntry()
    if shown then  -- an earlier summary nobody touched: fold it in
        local all = {}
        for _, it in ipairs(shown.summary) do Q.add(all, it) end
        for _, it in ipairs(items) do Q.add(all, it) end
        claudeNudgeDismiss(shown.canvas)
        items = all
    end
    showItems(items)
end

-- Screen capture state, from nudge/claude-share-state (see install.sh). A missing
-- or failing detector means `unknown`: cards show as before, with one console line.
local function shareStateBin()
    local home = os.getenv("CLAUDE_ACCOUNTS_HOME")
    if not home or home == "" then home = os.getenv("HOME") .. "/.claude-accounts" end
    return home .. "/bin/claude-share-state"
end

-- The capture or the quiet mode just began: nothing may stay on screen. Every card and
-- summary goes back to the queue with what it was raised with.
local function hideShown()
    local shown, items = {}, {}
    for _, n in ipairs(claudeNudges) do
        shown[#shown + 1] = n.canvas
        for _, it in ipairs(n.summary or { n.item }) do items[#items + 1] = it end
    end
    for _, canvas in ipairs(shown) do claudeNudgeDismiss(canvas) end
    Q.holdShown(claudeNudgeQueue, items)
end

local function applyCapture(state, why)
    if state == "unknown" and claudeNudgeQueue.capture ~= "unknown" then
        print("claude-nudge: screen-share state unknown, cards show as usual" .. (why and why ~= "" and (": " .. why) or ""))
    end
    local items, began = Q.update(claudeNudgeQueue, { capture = state })
    if began then hideShown() end
    if items then flush(items) end
end

-- Asked right before a card is drawn, so a share that began within the last poll
-- interval still holds the card back. The detector answers in well under 100 ms.
local function freshCheck()
    if claudeNudgeQueue.capture == "sharing" then return end  -- the poll ends it
    local bin = shareStateBin()
    if not hs.fs.attributes(bin) then return applyCapture("unknown", "no " .. bin) end
    local out = hs.execute("'" .. (bin:gsub("'", "'\\''")) .. "'")
    applyCapture(Q.parseState(out))
end

local pollTask, pollStarted
local function poll()
    if pollTask and pollTask:isRunning() then
        if os.time() - pollStarted > 10 then pollTask:terminate() end
        return
    end
    local bin = shareStateBin()
    if not hs.fs.attributes(bin) then return applyCapture("unknown", "no " .. bin) end
    pollStarted = os.time()
    pollTask = hs.task.new(bin, function(_, stdout, stderr)
        applyCapture(Q.parseState(stdout), (stderr or ""):sub(1, 160))
    end)
    pollTask:start()
end

if claudeNudgeTimer then claudeNudgeTimer:stop() end
claudeNudgeTimer = hs.timer.doEvery(3, poll)
poll()

-- The manual quiet mode behaves like a share until it is switched off.
function claudeNudgeSetQuiet(on)
    hs.alert.show(on and "Тихо" or "Снова зову")
    local items, began = Q.update(claudeNudgeQueue, { quiet = on })
    if began then hideShown() end
    if items then flush(items) end
end

if claudeNudgeHotkey then claudeNudgeHotkey:delete() end
claudeNudgeHotkey = hs.hotkey.bind({ "ctrl", "alt", "cmd" }, "q", function()
    claudeNudgeSetQuiet(not claudeNudgeQueue.quiet)
end)

-- open: the card (or a summary row) is on screen; queued: held back; gone: clicked,
-- closed, or never there.
function claudeNudgeState(key)
    local isOpen = false
    for _, n in ipairs(claudeNudges) do
        if n.key == key or (n.summary and Q.has(n.summary, key)) then isOpen = true end
    end
    return Q.stateOf(claudeNudgeQueue, key, isOpen)
end

function claudeNudge(title, body, session, action, key)
    if session == "" then session = nil end
    if action == "" or (type(action) == "table" and #action == 0) then action = nil end
    if key == "" then key = nil end
    if key then  -- a re-ask replaces the card; focus untouched, old return target dropped
        removeKeyed(key)
        claudeNudgeReturnTo[key] = nil
        removeFromSummary(key)
    end
    freshCheck()
    if Q.suppressed(claudeNudgeQueue) then
        Q.enqueue(claudeNudgeQueue, { title = title, body = body, session = session, action = action, key = key, at = os.time() })
        return true
    end
    return drawCard(title, body, session, action, key)
end

-- Entry points for a user-browser notify hook. The hook writes every value it
-- received (all untrusted) as raw bytes into files of a private temp dir and passes
-- only that dir's path, so no received text is ever part of Lua code.
local function readNudgeDir(dir)
    if type(dir) ~= "string" or not dir:match("^[%w/._-]+$") or not dir:find("/ub%-notify%.") then return nil end
    local files = {}
    for _, name in ipairs({ "key", "title", "body", "argv", "session", "return" }) do
        local f = io.open(dir .. "/" .. name, "rb")
        if f then
            files[name] = f:read("a")
            f:close()
            os.remove(dir .. "/" .. name)
        end
    end
    os.remove(dir)
    return files
end

function claudeNudgeFromDir(dir)
    local v = readNudgeDir(dir)
    if not v then return false end
    local argv = {}
    for part in (v.argv or ""):gmatch("([^\0]*)\0") do table.insert(argv, part) end
    if #argv == 0 then argv = nil end
    return claudeNudge(v.title or "", v.body or "", v.session or "", argv or "", v.key or "")
end

function claudeNudgeDismissFromDir(dir)
    local v = readNudgeDir(dir)
    if not v or not v.key or v.key == "" then return false end
    return claudeNudgeDismissKey(v.key, v["return"] == "true")
end

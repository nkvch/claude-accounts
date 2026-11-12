-- Behaviour of the chat banner while the screen is shared or the quiet mode is on.
-- Runs claude_nudge.lua against a fake Hammerspoon (hs.*): no screen, no timers.
--   lua nudge/test_nudge_queue.lua
local HERE = (arg[0]:match("^(.*)/[^/]*$") or ".")

local function loadQ() return dofile(HERE .. "/nudge_queue.lua") end

-- ---------------------------------------------------------------- fake hs
local H  -- per-test world

local function newWorld()
    local w = { canvases = {}, tasks = {}, alerts = {}, prints = {}, timers = {}, hotkeys = {},
                truth = "idle", binary = true, executed = 0, now = 100 }
    local Canvas = {}
    Canvas.__index = Canvas
    function Canvas:level() end
    function Canvas:behavior() end
    function Canvas:clickActivating() end
    function Canvas:canvasMouseEvents() end
    function Canvas:mouseCallback(fn) self.cb = fn end
    function Canvas:show() end
    function Canvas:delete() self.deleted = true end
    function Canvas:frame(f)
        if f then self.f = f end
        return self.f
    end
    function Canvas:elements()
        local list, i = {}, 1
        while rawget(self, i) do
            list[i] = rawget(self, i)
            i = i + 1
        end
        return list
    end
    function Canvas:click(id) self.cb(self, "mouseUp", id) end
    function Canvas:texts()
        local t = {}
        for _, e in ipairs(self:elements()) do
            if e.type == "text" then t[#t + 1] = e.text end
        end
        return t
    end

    local Task = {}
    Task.__index = Task
    function Task:start() self.running = true; return self end
    function Task:isRunning() return self.running end
    function Task:terminate() self.running = false end

    _G.hs = {
        canvas = {
            new = function(frame)
                local c = setmetatable({ f = frame }, Canvas)
                w.canvases[#w.canvases + 1] = c
                return c
            end,
            windowLevels = { overlay = 1 }, windowBehaviors = { canJoinAllSpaces = 1 },
        },
        screen = { mainScreen = function() return { frame = function() return { x = 0, y = 0, w = 1440, h = 900 } end } end },
        task = { new = function(path, cb, args)
            local t = setmetatable({ path = path, cb = cb, args = args }, Task)
            w.tasks[#w.tasks + 1] = t
            return t
        end },
        alert = { show = function(text) w.alerts[#w.alerts + 1] = text end },
        application = {
            frontmostApplication = function() return { name = function() return "Terminal" end } end,
            get = function() return nil end,
        },
        timer = { secondsSinceEpoch = function() return w.now end, doEvery = function(_, fn)
            local t = { fn = fn, stop = function() end }
            w.timers[#w.timers + 1] = t
            return t
        end },
        hotkey = { bind = function(mods, key, fn)
            local k = { mods = mods, key = key, fn = fn, delete = function() end }
            w.hotkeys[#w.hotkeys + 1] = k
            return k
        end },
        fs = { attributes = function() return w.binary and { mode = "file" } or nil end },
        execute = function()
            w.executed = w.executed + 1
            return w.truth == "missing-output" and "" or (w.truth .. "\n"), true, "exit", 0
        end,
    }
    _G.print = function(...) w.prints[#w.prints + 1] = table.concat({ ... }, " ") end
    return w
end

local realPrint = print
local function fresh()
    claudeNudges, claudeNudgeQueue, claudeNudgeTimer, claudeNudgeHotkey = nil, nil, nil, nil
    claudeNudgeTasks, claudeNudgeReturnTo = nil, nil
    H = newWorld()
    dofile(HERE .. "/claude_nudge.lua")
    local first = H.tasks[#H.tasks]  -- the poll made at load time
    first.running = false
    first.cb(0, "idle\n", "")
end

-- Finish the detector run the timer started, answering with the world's truth.
local function poll()
    H.timers[#H.timers].fn()
    local t = H.tasks[#H.tasks]
    assert(t and t.running and t.path:match("claude%-share%-state$"), "the timer must start the detector")
    t.running = false
    t.cb(0, H.truth == "missing-output" and "" or (H.truth .. "\n"), "")
end

local function live()
    local l = {}
    for _, c in ipairs(H.canvases) do
        if not c.deleted then l[#l + 1] = c end
    end
    return l
end

local function eq(got, want, msg)
    if got ~= want then error((msg or "mismatch") .. ": got " .. tostring(got) .. ", want " .. tostring(want), 2) end
end

local function titleOf(c) return c:texts()[1] end

local function opened()  -- tasks that opened a chat or ran a card's command (not the detector)
    local l = {}
    for _, t in ipairs(H.tasks) do
        if not t.path:match("claude%-share%-state$") then l[#l + 1] = t end
    end
    return l
end

-- ---------------------------------------------------------------- tests
local tests, order = {}, {}
local function test(name, fn) tests[name] = fn; order[#order + 1] = name end

test("idle: a card is drawn at once, state open", function()
    fresh()
    claudeNudge("Deploy", "stuck", "local_a", "", "k1")
    eq(#live(), 1)
    eq(titleOf(live()[1]), "Deploy")
    eq(claudeNudgeState("k1"), "open")
end)

test("sharing: no card, the card waits in the queue", function()
    fresh()
    H.truth = "sharing"; poll()
    claudeNudge("Deploy", "stuck", "local_a", "", "k1")
    eq(#live(), 0, "nothing on screen")
    eq(claudeNudgeState("k1"), "queued")
    eq(#claudeNudgeQueue.queue, 1)
    local it = claudeNudgeQueue.queue[1]
    eq(it.title, "Deploy"); eq(it.body, "stuck"); eq(it.session, "local_a"); eq(it.key, "k1")
    assert(it.at, "queued item carries its time")
end)

test("sharing that began after the last poll still holds the card back", function()
    fresh()
    H.truth = "idle"; poll()
    H.truth = "sharing"  -- no poll yet, and the last one is older than 3 s
    H.now = H.now + 3.5
    claudeNudge("T", "b", "", "", "k")
    eq(#live(), 0)
    eq(claudeNudgeState("k"), "queued")
end)

test("same key replaces the queued entry; no key keeps both", function()
    fresh()
    H.truth = "sharing"; poll()
    claudeNudge("A", "first", "", "", "k")
    claudeNudge("A", "second", "", "", "k")
    claudeNudge("B", "x", "", "", "")
    claudeNudge("B", "x", "", "", "")
    eq(#claudeNudgeQueue.queue, 3)
    eq(claudeNudgeQueue.queue[#claudeNudgeQueue.queue - 2].body, "second")
end)

test("a re-ask replaces a card that was already on screen", function()
    fresh()
    claudeNudge("A", "old", "", "", "k")
    H.truth = "sharing"; poll()
    claudeNudge("A", "new", "", "", "k")
    eq(#live(), 0, "the old card is gone")
    eq(claudeNudgeState("k"), "queued")
end)

test("sharing -> idle with two entries: one summary card", function()
    fresh()
    H.truth = "sharing"; poll()
    claudeNudge("Chat X", "need login", "local_x", "", "kx")
    claudeNudge("Chat Y", "check the map\nsecond line", "local_y", "", "ky")
    H.truth = "idle"; poll()
    eq(#live(), 1)
    local t = live()[1]:texts()
    eq(t[1], "Пока ты шарил: 2")
    eq(t[2], "Chat X — need login")
    eq(t[3], "Chat Y — check the map", "only the first line of the body")
    eq(#claudeNudgeQueue.queue, 0)
    eq(claudeNudgeState("kx"), "open")
end)

test("sharing -> idle with one entry: that card itself", function()
    fresh()
    H.truth = "sharing"; poll()
    claudeNudge("Solo", "just me", "local_s", "", "ks")
    H.truth = "idle"; poll()
    eq(#live(), 1)
    eq(titleOf(live()[1]), "Solo")
    eq(claudeNudgeState("ks"), "open")
end)

test("no entries: nothing appears when the share ends", function()
    fresh()
    H.truth = "sharing"; poll()
    H.truth = "idle"; poll()
    eq(#live(), 0)
end)

test("while still sharing the queue stays put", function()
    fresh()
    H.truth = "sharing"; poll()
    claudeNudge("A", "a", "", "", "ka"); claudeNudge("B", "b", "", "", "kb")
    poll(); poll()
    eq(#live(), 0)
    eq(#claudeNudgeQueue.queue, 2)
end)

test("a row click opens that chat, the row leaves, the rest stays", function()
    fresh()
    H.truth = "sharing"; poll()
    claudeNudge("A", "a", "local_aaa", "", "ka")
    claudeNudge("B", "b", "local_bbb", "", "kb")
    claudeNudge("C", "c", "local_ccc", "", "kc")
    H.truth = "idle"; poll()
    live()[1]:click("row2")
    local ran = opened()
    eq(#ran, 1)
    eq(ran[1].path, "/usr/bin/open")
    eq(ran[1].args[3], "claude://claude.ai/epitaxy/local_bbb")
    eq(claudeNudgeState("kb"), "gone")
    eq(claudeNudgeState("ka"), "open")
    eq(#live(), 1)
    eq(live()[1]:texts()[1], "Пока ты шарил: 2")
    eq(live()[1]:texts()[2], "A — a")
    eq(live()[1]:texts()[3], "C — c")
end)

test("a row click runs the card's own action (argv without a shell, or a shell string)", function()
    fresh()
    H.truth = "sharing"; poll()
    claudeNudge("A", "a", "", { "/usr/bin/say", "hi" }, "ka")
    claudeNudge("B", "b", "", "echo hello", "kb")
    H.truth = "idle"; poll()
    live()[1]:click("row1")
    local ran = opened()
    eq(ran[1].path, "/usr/bin/say"); eq(ran[1].args[1], "hi")
    -- one entry left: the summary turned into its card
    eq(titleOf(live()[1]), "B")
    live()[1]:click(nil)  -- a click on the card itself
    ran = opened()
    eq(ran[2].path, "/bin/sh"); eq(ran[2].args[2], "echo hello")
    eq(#live(), 0)
    eq(claudeNudgeState("kb"), "gone")
end)

test("the last row click leaves nothing on screen", function()
    fresh()
    H.truth = "sharing"; poll()
    claudeNudge("A", "a", "local_1", "", "ka"); claudeNudge("B", "b", "local_2", "", "kb")
    H.truth = "idle"; poll()
    live()[1]:click("row1")
    live()[1]:click(nil)
    eq(#live(), 0)
end)

test("the X on the summary drops all of it", function()
    fresh()
    H.truth = "sharing"; poll()
    claudeNudge("A", "a", "local_1", "", "ka"); claudeNudge("B", "b", "local_2", "", "kb")
    H.truth = "idle"; poll()
    live()[1]:click("close")
    eq(#live(), 0)
    eq(#opened(), 0, "closing opens nothing")
    eq(claudeNudgeState("ka"), "gone"); eq(claudeNudgeState("kb"), "gone")
end)

test("a click on the summary outside the rows and the X does nothing", function()
    fresh()
    H.truth = "sharing"; poll()
    claudeNudge("A", "a", "local_1", "", "ka"); claudeNudge("B", "b", "local_2", "", "kb")
    H.truth = "idle"; poll()
    live()[1]:click(nil)
    eq(#live(), 1)
    eq(claudeNudgeState("ka"), "open")
end)

test("state goes queued -> open -> gone for a plain card", function()
    fresh()
    eq(claudeNudgeState("k"), "unknown", "never seen")
    H.truth = "sharing"; poll()
    claudeNudge("A", "a", "local_1", "", "k")
    eq(claudeNudgeState("k"), "queued")
    H.truth = "idle"; poll()
    eq(claudeNudgeState("k"), "open")
    live()[1]:click(nil)
    eq(claudeNudgeState("k"), "gone")
end)

test("the X on a plain card makes it gone", function()
    fresh()
    claudeNudge("A", "a", "local_1", "", "k")
    live()[1]:click("close")
    eq(claudeNudgeState("k"), "gone")
    eq(#opened(), 0)
end)

test("claudeNudgeDismissKey clears a queued entry and one inside a summary", function()
    fresh()
    H.truth = "sharing"; poll()
    claudeNudge("A", "a", "", "", "ka"); claudeNudge("B", "b", "", "", "kb")
    claudeNudgeDismissKey("ka")
    eq(claudeNudgeState("ka"), "gone")
    eq(#claudeNudgeQueue.queue, 1)
    claudeNudge("C", "c", "", "", "kc")
    H.truth = "idle"; poll()
    eq(live()[1]:texts()[1], "Пока ты шарил: 2")
    claudeNudgeDismissKey("kb")
    eq(claudeNudgeState("kb"), "gone")
    eq(titleOf(live()[1]), "C", "one left: its card")
    eq(#live(), 1)
end)

test("quiet mode: hotkey toggles, cards wait, switching off shows the summary", function()
    fresh()
    local hk = H.hotkeys[#H.hotkeys]
    eq(hk.key, "q"); eq(table.concat(hk.mods, "+"), "ctrl+alt+cmd")
    hk.fn()
    eq(H.alerts[#H.alerts], "Тихо")
    claudeNudge("A", "a", "local_1", "", "ka"); claudeNudge("B", "b", "local_2", "", "kb")
    eq(#live(), 0)
    eq(claudeNudgeState("ka"), "queued")
    hk.fn()
    eq(H.alerts[#H.alerts], "Снова зову")
    eq(#live(), 1)
    eq(live()[1]:texts()[1], "Пока ты шарил: 2")
end)

test("quiet and sharing together: the queue is released only when both end", function()
    fresh()
    local hk = H.hotkeys[#H.hotkeys]
    hk.fn()
    H.truth = "sharing"; poll()
    claudeNudge("A", "a", "", "", "ka")
    H.truth = "idle"; poll()
    eq(#live(), 0, "still quiet")
    claudeNudge("B", "b", "", "", "kb")
    eq(#live(), 0)
    hk.fn()
    eq(#live(), 1)
    eq(live()[1]:texts()[1], "Пока ты шарил: 2")

    fresh()
    hk = H.hotkeys[#H.hotkeys]
    hk.fn()
    H.truth = "sharing"; poll()
    claudeNudge("A", "a", "", "", "ka")
    hk.fn()
    eq(#live(), 0, "still sharing")
    H.truth = "idle"; poll()
    eq(titleOf(live()[1]), "A")
end)

test("unknown for three polls in a row: cards show, one alert and one console line", function()
    fresh()
    H.truth = "banana"; poll(); poll()
    eq(#H.alerts, 0, "two failed polls are not enough")
    poll()
    eq(#H.alerts, 1)
    eq(H.alerts[1], "Не вижу, шаришь ли ты — карточки идут как обычно")
    eq(#H.prints, 1)
    assert(H.prints[1]:match("unknown"), H.prints[1])
    poll(); poll()
    eq(#H.alerts, 1, "the same spell warns once")
    claudeNudge("A", "a", "", "", "k")
    eq(#live(), 1)
    H.truth = "idle"; poll()
    H.truth = "banana"; poll(); poll(); poll()
    eq(#H.alerts, 2, "a new spell warns again")
end)

test("missing detector binary: cards show, a warning after three polls", function()
    fresh()
    H.binary = false
    for _ = 1, 3 do H.timers[#H.timers].fn() end
    eq(#H.alerts, 1)
    eq(#H.prints, 1)
    assert(H.prints[1]:match("claude%-share%-state"), H.prints[1])
    claudeNudge("A", "a", "", "", "k")
    eq(#live(), 1)
    eq(claudeNudgeState("k"), "open")
end)

test("a short detector failure does not end a share", function()
    fresh()
    H.truth = "sharing"; poll()
    claudeNudge("A", "a", "", "", "k")
    H.truth = "banana"; poll(); poll()
    eq(#live(), 0, "still held back")
    eq(claudeNudgeState("k"), "queued")
    H.truth = "sharing"; poll()
    H.truth = "banana"; poll(); poll()
    eq(#live(), 0, "the count started over")
    eq(#H.alerts, 0)
end)

test("a long detector failure counts as not sharing and releases the queue", function()
    fresh()
    H.truth = "sharing"; poll()
    claudeNudge("A", "a", "", "", "k")
    H.truth = "banana"; poll(); poll(); poll()
    eq(titleOf(live()[1]), "A")
    eq(#H.alerts, 1)
end)

test("a failed check before a card is not a poll: nothing changes, no alert", function()
    fresh()
    H.truth = "sharing"; poll()
    H.truth = "banana"
    for i = 1, 5 do
        H.now = H.now + 4
        claudeNudge("A" .. i, "a", "", "", "k" .. i)
    end
    eq(#live(), 0)
    eq(#H.alerts, 0)
    claudeNudge("B", "b", "", "", "kb")
end)

test("a poll's answer younger than 3 s is used without running the detector", function()
    fresh()
    H.truth = "idle"; poll()
    H.truth = "sharing"
    H.executed = 0
    H.now = H.now + 2.9
    claudeNudge("A", "a", "", "", "ka")
    eq(H.executed, 0, "the detector was not run")
    eq(#live(), 1, "the poll said idle")
    H.now = H.now + 0.2
    claudeNudge("B", "b", "", "", "kb")
    eq(H.executed, 1, "older than 3 s: asked again")
    eq(claudeNudgeState("kb"), "queued")
    eq(claudeNudgeState("ka"), "queued", "and the card on screen goes down")
end)

test("a key this session never saw is unknown, a lost one is gone; a reload of the code keeps that", function()
    fresh()
    eq(claudeNudgeState("nope"), "unknown")
    eq(claudeNudgeState(""), "unknown")
    claudeNudge("A", "a", "", "", "ka"); claudeNudge("B", "b", "", "", "kb"); claudeNudge("C", "c", "", "", "kc")
    live()[1]:click(nil)
    live()[1]:click("close")
    claudeNudgeDismissKey("kc")
    for _, k in ipairs({ "ka", "kb", "kc" }) do eq(claudeNudgeState(k), "gone", k) end
    H.truth = "sharing"; poll()
    claudeNudge("D", "d", "", "", "kd")
    dofile(HERE .. "/claude_nudge.lua")  -- Hammerspoon's init.lua runs it again
    for _, k in ipairs({ "ka", "kb", "kc" }) do eq(claudeNudgeState(k), "gone", k) end
    eq(claudeNudgeState("kd"), "queued")
    eq(claudeNudgeState("nope"), "unknown")
end)

test("a queued key replaced or dropped before it was shown is still gone, not unknown", function()
    fresh()
    H.truth = "sharing"; poll()
    claudeNudge("A", "a", "", "", "ka")
    claudeNudgeDismissKey("ka")
    eq(claudeNudgeState("ka"), "gone")
end)

test("a summary nobody touched is folded into the next one", function()
    fresh()
    H.truth = "sharing"; poll()
    claudeNudge("A", "a", "", "", "ka"); claudeNudge("B", "b", "", "", "kb")
    H.truth = "idle"; poll()
    H.truth = "sharing"; poll()
    claudeNudge("C", "c", "", "", "kc"); claudeNudge("D", "d", "", "", "kd")
    H.truth = "idle"; poll()
    eq(#live(), 1)
    local t = live()[1]:texts()
    eq(t[1], "Пока ты шарил: 4")
    eq(t[5], "D — d")
    eq(claudeNudgeState("kb"), "open")
end)

test("a re-ask while a summary is on screen takes its row out of it", function()
    fresh()
    H.truth = "sharing"; poll()
    claudeNudge("A", "a", "", "", "ka"); claudeNudge("B", "b", "", "", "kb")
    H.truth = "idle"; poll()
    claudeNudge("A", "again", "", "", "ka")
    eq(#live(), 2)
    eq(titleOf(live()[1]), "B", "summary shrank to the card of B")
    eq(live()[2]:texts()[2], "again")
end)

test("long lists: six rows, the rest counted; rows are cut to fit the card", function()
    fresh()
    H.truth = "sharing"; poll()
    for i = 1, 9 do claudeNudge("Chat " .. i, "x", "", "", "k" .. i) end
    claudeNudge("Chat 10", string.rep("я", 80), "", "", "k10")
    H.truth = "idle"; poll()
    local t = live()[1]:texts()
    eq(t[1], "Пока ты шарил: 10")
    eq(t[2], "Chat 1 — x"); eq(t[7], "Chat 6 — x")
    eq(t[8], "… и ещё 4")
    eq(live()[1]:frame().h, 24 + 7 * 22 + 32 + 14, "height: title + 6 rows + overflow row + padding")
    -- click rows away: the overflow rows move up
    live()[1]:click("row1")
    eq(live()[1]:texts()[7], "Chat 7 — x")
    eq(live()[1]:texts()[1], "Пока ты шарил: 9")
end)

test("a long body is cut with an ellipsis, wide enough for the card", function()
    fresh()
    H.truth = "sharing"; poll()
    claudeNudge("T", string.rep("я", 80), "", "", "a")
    claudeNudge("U", "b", "", "", "b")
    H.truth = "idle"; poll()
    local row = live()[1]:texts()[2]
    eq(utf8.len(row), 40)
    eq(row:sub(-3), "…")
end)

test("summary sits at the top right like a card", function()
    fresh()
    H.truth = "sharing"; poll()
    claudeNudge("T", "a", "", "", "a"); claudeNudge("U", "b", "", "", "b")
    H.truth = "idle"; poll()
    local f = live()[1]:frame()
    eq(f.w, 380); eq(f.x, 1440 - 380 - 20); eq(f.y, 40)
end)

test("the detector is looked for in CLAUDE_ACCOUNTS_HOME/bin, default ~/.claude-accounts/bin", function()
    fresh()
    local asked
    hs.fs.attributes = function(p) asked = p; return nil end
    H.timers[#H.timers].fn()
    eq(asked, os.getenv("HOME") .. "/.claude-accounts/bin/claude-share-state")
end)

test("a share that begins takes the cards on screen down and queues them in order", function()
    fresh()
    claudeNudge("A", "a", "local_a", "", "ka")
    claudeNudge("B", "b", "", { "/usr/bin/say", "b" }, "kb")
    eq(#live(), 2)
    H.truth = "sharing"; poll()
    eq(#live(), 0, "nothing stays visible")
    eq(claudeNudgeState("ka"), "queued"); eq(claudeNudgeState("kb"), "queued")
    local q = claudeNudgeQueue.queue
    eq(#q, 2)
    eq(q[1].title, "A"); eq(q[1].body, "a"); eq(q[1].session, "local_a"); eq(q[1].key, "ka")
    eq(q[2].title, "B"); eq(q[2].action[1], "/usr/bin/say")
    claudeNudge("C", "c", "", "", "kc")
    H.truth = "idle"; poll()
    eq(#live(), 1)
    local t = live()[1]:texts()
    eq(t[1], "Пока ты шарил: 3")
    eq(t[2], "A — a"); eq(t[3], "B — b"); eq(t[4], "C — c")
    live()[1]:click("row2")
    eq(opened()[1].path, "/usr/bin/say", "the hidden card kept its action")
end)

test("a lone card taken down by a share comes back as itself and still opens its chat", function()
    fresh()
    claudeNudge("Solo", "x", "local_s", "", "ks")
    H.truth = "sharing"; poll()
    eq(#live(), 0)
    H.truth = "idle"; poll()
    eq(#live(), 1); eq(titleOf(live()[1]), "Solo")
    live()[1]:click(nil)
    eq(opened()[1].args[3], "claude://claude.ai/epitaxy/local_s")
end)

test("a summary on screen goes back to the queue when a share begins", function()
    fresh()
    H.truth = "sharing"; poll()
    claudeNudge("A", "a", "", "", "ka"); claudeNudge("B", "b", "", "", "kb")
    H.truth = "idle"; poll()
    eq(live()[1]:texts()[1], "Пока ты шарил: 2")
    H.truth = "sharing"; poll()
    eq(#live(), 0)
    eq(claudeNudgeState("ka"), "queued"); eq(claudeNudgeState("kb"), "queued")
    H.truth = "idle"; poll()
    eq(live()[1]:texts()[1], "Пока ты шарил: 2")
end)

test("the quiet mode taking effect also takes the cards on screen down", function()
    fresh()
    local hk = H.hotkeys[#H.hotkeys]
    claudeNudge("A", "a", "", "", "ka"); claudeNudge("B", "b", "", "", "kb")
    hk.fn()
    eq(#live(), 0)
    eq(claudeNudgeState("ka"), "queued")
    hk.fn()
    eq(live()[1]:texts()[1], "Пока ты шарил: 2")
end)

test("a share found by the check before a new card takes the old cards down too", function()
    fresh()
    claudeNudge("A", "a", "", "", "ka")
    H.truth = "sharing"  -- no poll
    H.now = H.now + 3.5
    claudeNudge("B", "b", "", "", "kb")
    eq(#live(), 0)
    eq(claudeNudgeQueue.queue[1].key, "ka"); eq(claudeNudgeQueue.queue[2].key, "kb")
    eq(claudeNudgeState("ka"), "queued")
end)

test("unknown does not take cards down", function()
    fresh()
    claudeNudge("A", "a", "", "", "ka")
    H.truth = "banana"; poll()
    eq(#live(), 1)
    eq(claudeNudgeState("ka"), "open")
end)

test("a card clicked before the share is not brought back", function()
    fresh()
    claudeNudge("A", "a", "local_1", "", "ka"); claudeNudge("B", "b", "", "", "kb")
    live()[1]:click(nil)
    H.truth = "sharing"; poll()
    H.truth = "idle"; poll()
    eq(titleOf(live()[1]), "B")
    eq(claudeNudgeState("ka"), "gone")
end)

-- queue module on its own
test("queue: parseState", function()
    local Q = loadQ()
    eq(Q.parseState("sharing\n"), "sharing"); eq(Q.parseState("idle"), "idle")
    eq(Q.parseState("unknown\n"), "unknown"); eq(Q.parseState(""), "unknown")
    eq(Q.parseState(nil), "unknown"); eq(Q.parseState("sharing idle"), "unknown")
end)

test("queue: update returns the items only when suppression ends with a non-empty queue", function()
    local Q = loadQ()
    local s = Q.new()
    eq(Q.update(s, { capture = "sharing" }), nil)
    Q.enqueue(s, { title = "a", key = "k" })
    eq(Q.update(s, { quiet = true }), nil)
    eq(Q.update(s, { capture = "idle" }), nil, "quiet still on")
    local items = Q.update(s, { quiet = false })
    eq(#items, 1); eq(#s.queue, 0)
    eq(Q.update(s, { quiet = true }), nil)
    eq(Q.update(s, { quiet = false }), nil, "empty queue")
end)

test("queue: observe holds the state through short unknowns", function()
    local Q = loadQ()
    local s = Q.new()
    s.capture = "sharing"
    local st, warn = Q.observe(s, "unknown", true); eq(st, "sharing"); eq(warn, false)
    st, warn = Q.observe(s, "unknown", false); eq(st, "sharing", "a check before a card"); eq(warn, false)
    st, warn = Q.observe(s, "unknown", true); eq(st, "sharing"); eq(warn, false)
    st, warn = Q.observe(s, "unknown", true); eq(st, "unknown"); eq(warn, true)
    st, warn = Q.observe(s, "unknown", true); eq(st, "unknown"); eq(warn, false)
    st, warn = Q.observe(s, "idle", true); eq(st, "idle"); eq(warn, false)
end)

test("queue: stateOf", function()
    local Q = loadQ()
    local s = Q.new()
    eq(Q.stateOf(s, "k", false), "unknown")
    Q.markSeen(s, "k", 1)
    eq(Q.stateOf(s, "k", false), "gone")
    eq(Q.stateOf(s, "k", true), "open")
    Q.enqueue(s, { title = "t", key = "k" })
    eq(Q.stateOf(s, "k", false), "queued")
    Q.markSeen(s, "other", 1 + 8 * 24 * 3600)
    eq(Q.stateOf(s, "k", false), "queued")
    Q.remove(s.queue, "k")
    eq(Q.stateOf(s, "k", false), "unknown", "forgotten after a week")
end)

test("queue: update tells when the suppression begins", function()
    local Q = loadQ()
    local s = Q.new()
    local _, began = Q.update(s, { capture = "sharing" })
    eq(began, true)
    _, began = Q.update(s, { quiet = true })
    eq(began, false, "already suppressed")
    _, began = Q.update(s, { quiet = false })
    eq(began, false)
    _, began = Q.update(s, { capture = "idle" })
    eq(began, false)
end)

test("a card does not run the detector while a poll's run is still going", function()
    fresh()
    H.truth = "idle"; poll()
    H.now = H.now + 10
    H.timers[#H.timers].fn()  -- a poll starts and hangs
    H.executed = 0
    claudeNudge("A", "a", "", "", "ka")
    eq(H.executed, 0, "no blocking detector run next to a hanging one")
    eq(#live(), 1, "the card shows")
end)

test("state of no key is unknown", function()
    fresh()
    claudeNudge("A", "a", "", "", "")
    eq(claudeNudgeState(nil), "unknown")
end)

-- ---------------------------------------------------------------- run
local failed = 0
for _, name in ipairs(order) do
    local ok, err = pcall(tests[name])
    if ok then realPrint("ok   " .. name) else realPrint("FAIL " .. name .. "\n     " .. tostring(err)); failed = failed + 1 end
end
if failed == 0 then realPrint("all passed") else realPrint(failed .. " failed"); os.exit(1) end

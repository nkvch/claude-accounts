-- The decision part of the chat banner, kept free of Hammerspoon so it can be
-- tested with plain `lua` (nudge/test_nudge_queue.lua). claude_nudge.lua loads it.
-- A state holds the queue of cards held back while the screen is being captured
-- (shared, recorded) or the quiet mode is on; the functions answer "show or queue",
-- "what to show when it ends" and "where is this key".

local Q = {}

function Q.new()
    return Q.ensure({ queue = {}, quiet = false, capture = "idle" })
end

-- A state kept by an earlier load of this code may lack newer fields.
function Q.ensure(s)
    s.unknownRuns = s.unknownRuns or 0
    s.seen = s.seen or {}  -- key -> time it was last raised; this Lua session only
    return s
end

-- One detector answer in. A short `unknown` (a hiccup of the detector) does not end
-- a share: the earlier state holds until UNKNOWN_POLLS polls in a row failed, then the
-- state is `unknown` (cards show) and warn is true once. A failed check made
-- just before a card (not a poll) changes nothing.
local UNKNOWN_POLLS = 3
function Q.observe(s, word, isPoll)
    if word ~= "unknown" then
        s.unknownRuns = 0
        return word, false
    end
    if not isPoll then return s.capture, false end
    s.unknownRuns = s.unknownRuns + 1
    if s.unknownRuns < UNKNOWN_POLLS then return s.capture, false end
    return "unknown", s.unknownRuns == UNKNOWN_POLLS
end

local SEEN_TTL_S = 7 * 24 * 3600
function Q.markSeen(s, key, now)
    s.seen[key] = now
    for k, at in pairs(s.seen) do
        if now - at > SEEN_TTL_S then s.seen[k] = nil end
    end
end

-- The detector prints one word; anything else, or no answer, is `unknown`.
function Q.parseState(out)
    local word = type(out) == "string" and out:match("^%s*(%a+)%s*$") or nil
    if word == "sharing" or word == "idle" then return word end
    return "unknown"
end

-- `unknown` counts as "not sharing": the cards then show as they always did.
function Q.suppressed(s)
    return s.quiet or s.capture == "sharing"
end

-- Add an item to a list; the same non-empty key replaces the older entry.
function Q.add(list, item)
    if item.key then Q.remove(list, item.key) end
    table.insert(list, item)
end

function Q.remove(list, key)
    local removed = false
    for i = #list, 1, -1 do
        if list[i].key == key then
            table.remove(list, i)
            removed = true
        end
    end
    return removed
end

function Q.has(list, key)
    for _, it in ipairs(list) do
        if it.key == key then return true end
    end
    return false
end

-- Hold a card back. item = { title, body, session, action, key, at }.
function Q.enqueue(s, item)
    Q.add(s.queue, item)
end

-- Apply a change ({ quiet = bool } and/or { capture = "sharing"|"idle"|"unknown" }).
-- Returns the held-back items when this change ends the suppression and the queue
-- is not empty (the queue is then emptied), else nil; and true as the second value
-- when this change starts the suppression (cards on screen must then be hidden).
function Q.update(s, change)
    local was = Q.suppressed(s)
    if change.quiet ~= nil then s.quiet = change.quiet end
    if change.capture ~= nil then s.capture = change.capture end
    local now = Q.suppressed(s)
    if was and not now and #s.queue > 0 then
        local items = s.queue
        s.queue = {}
        return items, false
    end
    return nil, now and not was
end

-- Cards that were on screen when the suppression began become the queue, in the
-- order they stood on screen (a queue is empty when a suppression begins).
function Q.holdShown(s, items)
    for _, it in ipairs(items) do Q.add(s.queue, it) end
end

-- `open` is decided by the caller (it owns the canvases). `gone` only for a key this
-- session raised and has since lost; a key it never saw (a Hammerspoon reload
-- forgets them all) is `unknown`, not an answer.
function Q.stateOf(s, key, isOpen)
    if isOpen then return "open" end
    if Q.has(s.queue, key) then return "queued" end
    if key and s.seen[key] then return "gone" end
    return "unknown"
end

local function cut(text, max)
    if (utf8.len(text) or #text) <= max then return text end
    local stop = utf8.offset(text, max) or max  -- start of the max-th character; keep max-1 and the ellipsis
    return text:sub(1, stop - 1) .. "…"
end
Q.cut = cut

-- Rows of the summary card: "<title> — <first line of body>", cut to maxChars.
-- At most maxRows rows; `more` is how many items did not fit.
function Q.rows(items, maxRows, maxChars)
    local rows = {}
    for i = 1, math.min(#items, maxRows) do
        local it = items[i]
        local line = (it.body or ""):match("^[^\n]*")
        local text = it.title
        if line ~= "" then text = text .. " — " .. line end
        table.insert(rows, { text = cut(text:gsub("%s+", " "), maxChars), item = it })
    end
    return rows, #items - #rows
end

return Q

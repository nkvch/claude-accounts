-- The decision part of the chat banner, kept free of Hammerspoon so it can be
-- tested with plain `lua` (nudge/test_nudge_queue.lua). claude_nudge.lua loads it.
-- A state holds the queue of cards held back while the screen is being captured
-- (shared, recorded) or the quiet mode is on; the functions answer "show or queue",
-- "what to show when it ends" and "where is this key".

local Q = {}

function Q.new()
    return { queue = {}, quiet = false, capture = "idle" }
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
-- is not empty (the queue is then emptied), else nil.
function Q.update(s, change)
    local was = Q.suppressed(s)
    if change.quiet ~= nil then s.quiet = change.quiet end
    if change.capture ~= nil then s.capture = change.capture end
    if was and not Q.suppressed(s) and #s.queue > 0 then
        local items = s.queue
        s.queue = {}
        return items
    end
    return nil
end

-- `queued` while held back, `open` is decided by the caller (it owns the canvases).
function Q.stateOf(s, key, isOpen)
    if isOpen then return "open" end
    if Q.has(s.queue, key) then return "queued" end
    return "gone"
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

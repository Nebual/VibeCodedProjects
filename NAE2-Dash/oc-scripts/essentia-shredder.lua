-- Nebual's Essentia Overflow Shredder
-- Setup https://nebtown.info/ss/neb/2026_07_24_00-31-31_javaw.jpg

local component = require('component')
local os = require('os')
local term = require('term')
local sides = require("sides")
local event = require('event')
local io = require('io')
local serialization = require('serialization')
local internet = require('internet')
local JSON = require('json') -- from https://github.com/i-am-dies/OpenComputers/blob/master/lib/json.lua

-- local defaultLimit = 600
local defaultLimit = 999999999 -- to disable default cap (so it only shreds the below list)
local slowUpdateFrequency = 5 -- seconds between checks, when there's nothing to export

local file = io.open("/home/essentia-limits.json", "r")
local limits = JSON:decode((file and file:read("*a") or "{\"Herba\": 200}"))
if file then file:close() end
file = io.open("/home/essentia-minimums.json", "r")
local minimums = JSON:decode((file and file:read("*a") or "{\"Terra\": 200}"))
if file then file:close() end
file = nil
local updateFrequency = 1 -- will switch to slowUpdateFrequency while nothing to export, and back to 1 during export

local _print = print
local needsNewline = false
local function printNoNewline(s)
    term.write(s, true)
    needsNewline = true
end
local function print(...)
    if needsNewline then
        term.write("\n")
        needsNewline = false
    end
    _print(...)
end

local function clearExport()
    component.essentia_exportbus.setExportConfiguration(sides.south, 0)
end

local essentiaCpus = {}
local itemCpus = {}
local craftsInProgress = {}
local function canStartCrafting(name)
    if craftsInProgress[name] then
        if craftsInProgress[name].isDone() or craftsInProgress[name].isCanceled() then
            craftsInProgress[name] = nil
        else
            return false
        end
    end
    return true
end

local function findCraftingCpu(type, name)
    if not canStartCrafting(name) then
        return nil
    end

    local cpus = type == 'essentia' and essentiaCpus or itemCpus
    for _, cpu in ipairs(cpus) do
        if not cpu.cpu.isBusy() then
            return cpu
        end
    end
end

local essentiaCraftables = {}
local craftables = {}
local function attemptCraft(type, name)
    local craftingCpu = findCraftingCpu(type, name)
    if not craftingCpu then -- can also be nil if the craft is already in progress
    print("no cpu")
        return false
    end

    local recipes = type == 'essentia' and essentiaCraftables or craftables
    local recipe = recipes[name]
    if recipe == nil then
        local craftableWrapper = type == 'essentia' and component.me_interface.getCraftable({name = string.lower(name)}, 'essentia') or component.me_interface.getCraftables({label = name}, 'item')[1]
        if craftableWrapper then
            recipe = craftableWrapper.request
            recipes[name] = recipe
        else
            print("No craftable found for " .. name)
            recipes[name] = false
        end
    end
    if recipe then
        local numToCraft = type == 'essentia' and 8 or 1
        local job = recipe(numToCraft, false, craftingCpu.name)
        if job and not job.isCanceled() then
            print("Requested crafting of " .. numToCraft .. " " .. name)
            craftsInProgress[name] = job
            return true
        else
            print("Can't " .. name .. ", missing ingredients.")
        end
    end
end

local lastEssentiaIndex = 0
local essentiaAmounts = {}
local function checkEssentia()
    local essentiaTab = component.me_interface.getEssentiaInNetwork()
    if not essentiaTab then
        print("Error: Unable to retrieve essentia from the network.")
        return
    end
    local exported = false
	essentiaAmounts = {}
    local essentiaCount = #essentiaTab
    local loopUntilIndex = lastEssentiaIndex > 0 and lastEssentiaIndex or essentiaCount
    local i = lastEssentiaIndex
    repeat
        i = i + 1
        local essentia = essentiaTab[i]
        essentiaAmounts[essentia.name] = essentia.amount
        if not exported and essentia.amount > (limits[essentia.name] or defaultLimit) then
            -- component.me_interface.store({label = essentia.label}, db.address)
            component.essentia_exportbus.setExportConfiguration(sides.south, 0, {name = string.lower(essentia.name)})

            ---You can use a redstone control upgrade set to only on signal to make the export bus only export when called on by OC.
            -- function meExportbus.exportIntoSlot(side, slot) end

            exported = true
        end
        if essentia.amount < (minimums[essentia.name] or 0) then
            -- print("Attempting to craft " .. essentia.name, essentia.amount, "<", (minimums[essentia.name] or 0))
            if attemptCraft('essentia', essentia.name) then
                lastEssentiaIndex = i
            end
        end
        if i >= essentiaCount and loopUntilIndex ~= essentiaCount then
            i = 0
        end
    until i == loopUntilIndex

    if not exported then
        clearExport()
    end
    updateFrequency = (exported or next(craftsInProgress)) and 1 or slowUpdateFrequency
end

local items = {}
local lastItemIndex = 0
local function checkItems()
    local itemsTab = component.me_interface.getItemsInNetwork({isCraftable = true})
    -- consider trying component.me_interface.allItems (iterator)
    if not itemsTab then
        print("Error: Unable to retrieve items from the network.")
        return
    end
    local itemCount = #itemsTab
    local loopUntilIndex = lastItemIndex > 0 and lastItemIndex or itemCount
    local i = lastItemIndex
    repeat
        i = i + 1
        local item = itemsTab[i]
        if item ~= nil then
            items[item.label] = item.size

            if item.size < (minimums[item.label] or 0) and item.label ~= "Potentia" then
                print("Attempting to craft item " .. item.label .. " " .. tostring(item.size) .. " < " .. tostring(minimums[item.label] or 0))
                if attemptCraft('item', item.label) then
                    lastItemIndex = i
                    break
                end
            end
        end
        if i >= itemCount and loopUntilIndex ~= itemCount then
            i = 0
        end
        if (i % 100) == 0 then
          os.sleep(0.001)
        end
    until i == loopUntilIndex
end

local function jsonPOST(url, data)
    local postData = JSON:encode(data)
    local headers = {
        ["Content-Type"] = "application/json",
        ["Content-Length"] = string.len(postData)
    }

    printNoNewline('P')
    local success, response = pcall(internet.request, url, postData, headers)
    printNoNewline('D')
    if success then
        local success2, response_text = pcall(function()
            local response_text = ""
            for chunk in response do response_text = response_text .. chunk end
            return response_text
        end)
        if success2 then
            return response_text
        else
            print("HTTP Request failed: " .. tostring(response_text))
        end
    else
        print("HTTP Request failed: " .. tostring(response))
    end
end

local function updateGmanServerEssentia()
    local response_text = jsonPOST("https://ae2.nebtown.info/api/mc-update", {
        essentia = essentiaAmounts,
        minimums = minimums,
        maximums = limits,
        maxEssentiaTypes = 12*6,
        maxEssentiaAmount = 8192*4 + 8192*8*2,
    })

    local newMinMaxes = JSON:decode(response_text)
    if newMinMaxes.maximums and serialization.serialize(newMinMaxes.maximums) ~= serialization.serialize(limits) then
        limits = newMinMaxes.maximums
        local file = io.open("/home/essentia-limits.json", "w")
        file:write(JSON:encode_pretty(limits))
        file:close()
    end
    if newMinMaxes.minimums and serialization.serialize(newMinMaxes.minimums) ~= serialization.serialize(minimums) then
        minimums = newMinMaxes.minimums
        local file = io.open("/home/essentia-minimums.json", "w")
        file:write(JSON:encode_pretty(minimums))
        file:close()
    end
end

local function updateGmanServerItems()
    local response_text = jsonPOST("https://ae2.nebtown.info/api/mc-update", {
        items = items,
    })
end


local function runMinutely()
    essentiaCpus = {}
    itemCpus = {}
    local allCpus = component.me_interface.getCpus()
    for _, cpu in ipairs(allCpus) do
        if string.find(cpu.name, 'Essentia') ~= nil then
            table.insert(essentiaCpus, cpu)
        elseif string.find(cpu.name, 'Item') ~= nil then
            table.insert(itemCpus, cpu)
        end
    end
    if #essentiaCpus == 0 then
        table.insert(essentiaCpus, allCpus[1])
    end
    if #itemCpus == 0 then
        table.insert(itemCpus, allCpus[1])
    end
    essentiaCraftables = {} -- clear cache
    craftables = {}
end

local timers = {}
local function hasTimerPassed(timerName, seconds)
    local currentTime = os.time()/100
    if not timers[timerName] then
        timers[timerName] = currentTime
        return true
    end
    if (currentTime - timers[timerName]) >= seconds then
        timers[timerName] = currentTime
        return true
    end
    return false
end

print("Starting main loop. Press Ctrl+C to stop.")
while (true) do
    if hasTimerPassed("runMinutely", 60) then
        printNoNewline("m")
        runMinutely()
        os.sleep(0.001)
    end
    if hasTimerPassed("checkItems", 5) then
        printNoNewline("i")
        checkItems()
        updateGmanServerItems()
    end

    printNoNewline(".")
    checkEssentia()
    updateGmanServerEssentia()

    local eventId = event.pull(updateFrequency, "interrupted")
    if eventId then
        print("! Clearing export bus and stopping...")
        clearExport()
        break
    end
end

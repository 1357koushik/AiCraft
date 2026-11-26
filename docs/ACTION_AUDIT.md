# Action audit: CAPABILITIES.md sections 3 and 10 against the installed source

Scope: Mineflayer 4.39.0, prismarine-windows 2.10.0, prismarine-item 1.18.0, minecraft-protocol 1.68.0, minecraft-data 3.117.0, target Minecraft 1.21.6. All paths are under `node_modules/mineflayer/lib/plugins/` unless stated.

**Nothing in this document was tested on a live server.** Evidence is (a) reading the installed source, (b) the 1.21.6 protocol in minecraft-data, and (c) offline serialisation checks: feeding the exact packet bodies Mineflayer builds into `minecraft-protocol`'s 1.21.6 serializer and decoding them back (no server, no network). Statements about what the vanilla server does with a packet come from my memory of vanilla behaviour and are marked "(vanilla, unverified)".

Verdicts: **works by source**, **partial**, **missing**, **suspect**.

## Totals

43 rows (lines of CAPABILITIES section 3 that bundle several actions are split): works by source 24, partial 9, missing 3, suspect 7.

## 1. Action table

| Action (CAPABILITIES line) | Mineflayer implementation (file:line) | Packet(s) sent | Verdict | Notes |
| --- | --- | --- | --- | --- |
| look_at | `lookAt` physics.js:359, `look` :331; yaw eased per tick in `updatePosition` :158-205 | `look` / `position_look` (flags bitfield `{onGround, hasHorizontalCollision}`) | works by source | Packet bodies serialise correctly for 1.21.6. Yaw/pitch are rate limited (`physics.yawSpeed`), so `look` takes several ticks unless `force`. |
| step(direction) | `setControlState` physics.js:247 + physics tick :80-95 | `position`, `position_look`, `flying` (movement) | works by source | Movement is client-simulated by prismarine-physics and reported by position packets. |
| jump | `setControlState('jump')` physics.js:252 | none directly (position packets show the rise) | works by source | The `jump` flag of `player_input` is never sent while jumping; only matters for vehicles. |
| sneak(on/off) | physics.js:262-277 | `player_input` with only `shift` set | works by source | `newPlayerInputPacket` is true for 1.21.6. The packet always zeroes forward/back/left/right/jump/sprint. Physics models only the 0.3 speed factor and edge safety (prismarine-physics index.js:175, :746), not the 1.5 high sneak hitbox. |
| sprint(on/off) | physics.js:254-261 | `entity_action` with numeric id 3 / 4 | **suspect** | Feature `entityActionUsesStringMapper` exists nowhere in minecraft-data 3.117 (only physics.js uses it), so it is always false and numeric ids are sent. In 1.21.6 the mapper is 0 stop_sleeping, 1 start_sprinting, 2 stop_sprinting, 3 start_riding_jump, 4 stop_riding_jump, 5 open_inventory, 6 start_fall_flying. Offline decode: id 3 becomes `start_riding_jump`. The server therefore never sees sprint start/stop (vanilla would ignore ids 3/4 unless riding a jumping mount; unverified). Used in src/actions/combat/mob_tactics.ts:103 and src/actions/hazards.ts:404. Raw fix: write `entity_action {entityId, actionId:'start_sprinting'|'stop_sprinting', jumpBoost:0}`. |
| break(block) | `dig` digging.js:18, `stopDigging` :165, `canDigBlock`, `digTime` :228 | `block_dig` status 0 (:130), 2 (:149), 1 (:178), `arm_animation` every 350 ms | **suspect** | Packets are right for 1.21.6 (`sequence` omitted, encodes as 0). Bug: `digTime` reads `heldItem.enchants` (:238); for 1.21.6 items prismarine-item returns the raw component data `{enchantments:[{id,level}]}`, an object not an array (prismarine-item index.js:255-258). Offline check: `block.digTime(..., enchants)` throws "enchantments is not iterable", and `enchantments.concat(...)` (:244) throws when a helmet is worn. So any enchanted tool in hand breaks `dig`. Unenchanted tools work (stone with an iron pickaxe computed 400 ms). |
| place(item, against block, face, exact spot) | `placeBlock` place_block.js:155 -> `_placeBlockWithOptions` :119 -> `_genericPlace` generic_place.js:12 | `block_place` (generic_place.js:75: hand, location, direction, cursor floats, insideBlock false, sequence 0, worldBorderHit false) | partial | Waits for the block update and throws if the block did not change (5 s timeout, place_block.js:136). Public `placeBlock` only aims at the face centre. Exact spot (`delta`), `half`, `offhand` exist only on the private `bot._placeBlockWithOptions`. `sequence` is always 0 and `insideBlock` always false. |
| use_block(block) | `activateBlock` inventory.js:195 | `block_place` (inventory.js:231) then `arm_animation` | works by source | Main hand only (`hand:0`), `sequence` 0, `insideBlock` false. A source comment (:199) admits it does not control sneaking. |
| sneak_use(item, on block) | `setControlState('sneak', true)` then `placeBlock` | `player_input{shift}` then `block_place` | works by source | Both go down one ordered stream, so the server should see shift before the placement. The server reads sneak state from `player_input` (vanilla, unverified). Needs a live check on a chest. |
| use_off_hand | `activateItem(true)` inventory.js:120 | `use_item` hand 1 (:134) | works by source | Right body for 1.21.6 (hand, sequence, rotation). Placing with the off hand: only via private `_placeBlockWithOptions({offhand:true})`. `activateBlock` has no off-hand option. |
| use_item(hand) | `activateItem` inventory.js:120, `consume` :104 | `use_item` | works by source | `consume` completes on `entity_status` 9 (:75) with a 2.5 s limit; its "always edible" list (:19-23) lacks chorus_fruit and ominous_bottle. |
| stop_using | `deactivateItem` inventory.js:145 | `block_dig` status 5, location 0,0,0, face 0 (:157) | works by source | Matches vanilla release-use-item. |
| use_item_on_entity / interact | `useOn` entities.js:838, `activateEntity` inventory.js:248, `activateEntityAt` :260 | `use_entity` mouse 0 / mouse 2 with x,y,z | works by source | Hand always 0; `activateEntity`/`At` hard-code `sneaking:false` (:254, :267) while `useOn` passes the real sneak state (entities.js:906). Shift-right-click (horse inventory, some mobs) needs a raw `use_entity` with `sneaking:true`. Vanilla sends interact_at then interact for some entities; Mineflayer sends one or the other. |
| attack(entity) | `attack` entities.js:843 | `use_entity` mouse 1 (`attackUsesOwnPacket` false) then `arm_animation` | works by source | No cooldown or reach check; the caller must time swings. |
| select_slot(n) | `setQuickBarSlot` simple_inventory.js:51 | `held_item_slot` | works by source | No server confirmation is awaited. |
| equip(item, where) | `equip` simple_inventory.js:88 | `held_item_slot`, or a `window_click` pair via `moveSlotItem` | works by source | Hotbar to hand is a slot change only. Armor and off-hand (slot 45) use two back-to-back clicks; see section 4. |
| unequip(where) | `unequip` simple_inventory.js:43 (`equipEmpty` :62, `disrobe` :82) | `window_click`, `held_item_slot` | works by source | `disrobe` asserts no window is open. |
| swap_hands | none | would be `block_dig` status 6 (swap item with off hand), location 0,0,0, face 0, sequence 0 | **missing** | Offline check: that body serialises for 1.21.6. Mineflayer never sends statuses 3, 4 or 6. Moving an item into slot 45 by clicks works but is not a swap. In-GUI off-hand swap (window_click mode 2, button 40) is rejected locally by prismarine-windows (`mouseButton <= 8`, Window.js:28-31, :44). |
| drop(item, count) | `toss` simple_inventory.js:29, `tossStack` :22 | `window_click` slot -999, `close_window` | partial | Works through clicks only (pipelined, see section 4). Quick drop of the held item (`block_dig` status 4 one, 3 stack) is never sent. |
| open(block or entity) | `openContainer` chest.js:14, `openBlock` inventory.js:405, `openEntity` :412 | `block_place` or `use_entity` mouse 0 | partial | `openBlock` fires `activateBlock` without awaiting and waits 20 s for `windowOpen`; it times out if the bot is sneaking. Block whitelist is chest.js:6. Horse and donkey inventories need shift-click (see interact row), or `entity_action` 5 while riding, which is never sent. `open_horse_window` is handled (inventory.js:745) with a generic layout. |
| close_window | `closeWindow` inventory.js:433 | `close_window` | works by source | Copies the window's predicted inventory region into `bot.inventory` immediately (:437, :445), so unconfirmed clicks leak into the model. |
| click_slot(slot, button, mode) | `clickWindow` inventory.js:572 | `window_click` (:630) | **suspect** | In 1.21.6 `cursorItem` and `changedSlots[].item` are `HashedSlot` (itemId, count, components as `{type, hash:i32}`). Mineflayer sends `Item.toNotch` output, whose components are `{type, data}` with no hash. Offline check: it serialises without error, but any component (damage, enchantments, custom name, potion) is written with `hash:0`; an empty cursor is written as present with itemId 0. For plain items the body is fine. Effect on a real server is unverified; the expectation (vanilla) is that a hash mismatch makes the server resend slots, i.e. extra `set_slot`/`window_items` traffic rather than a rejected click. Also `stateId` is only updated from `set_slot`/`window_items` (:35-38). |
| move_items(from, to, count) | `transfer` inventory.js:275, `moveSlotItem` :696, `putAway` :677, `window.withdraw/deposit` :372-402 | `window_click` series | partial | Every click is sent without waiting for the server (no transaction packet exists since 1.17). See section 4. |
| window_button(n) | none | `enchant_item {windowId, enchantment: buttonId}` (this is `container_button_click`; minecraft-data names it `enchant_item`) | **missing** | Only the enchanting helper writes it (enchantment_table.js:78). Offline check: `{windowId:3, enchantment:1}` serialises to `10 03 01`. Stonecutter, loom and lectern have no helper. Button ids in section 2. |
| choose_trade(n) | `trade` villager.js:126, `openVillager` :72 | `select_trade` (:18), then clicks | partial | `trade_list` is the 1.21.6 packet and its shape is parsed. `openVillager` asserts the entity type is `villager` (:74), so the wandering trader is rejected. After `select_trade` it waits for `updateSlot` 0/1/2 (:154-158) with the 20 s default; times out if the server does not resend a slot. |
| rename(text) in an anvil | `openAnvil` anvil.js:12, `rename` :72, `combine` :45 | `name_item` (:27, one packet per prefix with 50 ms sleep), clicks | partial | Packet exists in 1.21.6. Cost check uses `Item.anvil` (prismarine-item lib/anvil.js:63-66), which iterates `item.enchants`; with enchanted items on 1.21.6 that is the object described in the `break` row, so enchanted inputs likely throw. Plain rename should work. Waits for an `experience` event (:84) with a 20 s limit, so a zero-cost rename times out. |
| write_sign(text) | `updateSign` blocks.js:471 | `update_sign {location, isFrontText, text1..4}` (:502) | partial | Front/back supported (`back` arg). Body is correct for 1.21.6 (plain strings; `sendStringifiedSignText` is false). Does not open the editor: the bot must first `activateBlock` the sign and wait for `signOpen` (blocks.js:447); vanilla only accepts the edit from the player it opened it for (unverified). Too many lines or a line over 45 chars calls `bot.emit('error')` instead of throwing (:474, :480), which crashes the process if no error listener exists. No dye or glow ink handling. |
| write_book(pages) | `writeBook` book.js:109, `signBook` :113 | `edit_book {hand: quickbar slot, pages, title}` (:28) | works by source | Body serialises. Moves the book to the hotbar by clicks, then calls `_syncWindow` (:48), waits up to 20 s for the item to show pages. Needs a `writable_book` in the inventory. |
| mount(entity) | `mount` entities.js:858 | `use_entity` mouse 0 | works by source | Passenger state comes from `attach_entity`/`set_passengers` (entities.js:750-800). |
| dismount | `dismount` entities.js:885 | `player_input {jump:true}` (:888) | **suspect** | In the new input packet the dismount control is `shift`, not `jump` (the old `steer_vehicle` flag 0x02 was dismount; the port sets the wrong bit). Safer path: `setControlState('sneak', true)` then false while mounted. When not mounted it calls `bot.emit('error')` (:901). |
| steer(left, forward) | `moveVehicle` entities.js:863 | `player_input` forward/back/left/right (:868) | partial | Only sends input flags. `vehicle_move` and `steer_boat` are never sent and no vehicle physics exists; player-controlled vehicles are client driven in vanilla (unverified), so boats, horses and pigs will probably not move. Also clears `shift`. |
| sleep(bed) | `sleep` bed.js:79 | `block_place` via `activateBlock` | works by source | Client-side checks for time, distance and monsters; 3 s wait for the `sleep` event (:158). |
| wake | `wake` bed.js:67 | `entity_action` id 2 (:73) | **suspect** | In 1.21.6 id 2 is `stop_sprinting`; stop_sleeping is 0. Never wakes the bot. Raw fix: `entity_action {actionId:'stop_sleeping'}`. |
| start_gliding | `elytraFly` physics.js:221 | `entity_action` id 8 (:240-244) | **suspect** | 1.21.6 has no id 8 (the mapper ends at 6 `start_fall_flying`). Offline: id 8 serialises as the raw byte 08. A vanilla server would likely fail to decode it (unverified). Raw fix: `actionId:'start_fall_flying'`. The helper's preconditions (airborne, elytra in the chest slot) are sound. |
| cast_and_reel | `fish` fishing.js:48 | `use_item` twice | works by source | Bite detection reads `world_particles` with `particle.type` 'fishing'/'bubble' and `amount` 6 within 1.23 blocks (:30); field names match the 1.21.6 packet. Does not check the rod is held. |
| chat(text) | `bot.chat` chat.js:212 -> minecraft-protocol `client.chat` | `chat_message`, `chat_command` / `chat_command_signed`, `message_acknowledgement` | works by source | Signing handled by minecraft-protocol src/client/chat.js:425-467. |
| whisper(player, text) | `whisper` chat.js:209 | same as chat, text `/tell name msg` | works by source | |
| charge_and_release | `activateItem` then `deactivateItem` | `use_item`, `block_dig` status 5 | works by source | Bow, trident, spyglass: hold then release. A crossbow needs a second `use_item` to fire. A brush needs `activateBlock` on the target block to start (vanilla: unverified), then hold the look and `deactivateItem`. `bot.usingHeldItem` is reset by `entity_status` and cooldown packets (:74-102). |
| crawl | none | none | **missing** | prismarine-physics uses a fixed 1.8 hitbox (index.js:77); no sneak (1.5) or swimming/crawl (0.6) pose. The bot cannot simulate or path through 1-high gaps. The `position` handler even resets height to 1.8 (physics.js:376-378). A physics gap, not a packet gap. |
| swim_through | water physics in prismarine-physics | position packets | partial | In-water movement and buoyancy are simulated; there is no swimming pose, so sprint-swimming through 1-high water gaps is not modelled. |
| respawn | `respawn` health.js:42 | `client_command` actionId 0 (perform_respawn) | works by source | Only when dead. `options.respawn` triggers it automatically (:34). `player_loaded` is sent on spawn (:14). |
| wait_for(event, limit) | `waitForTicks` physics.js:456, `once` promise_utils.js:105 | none | works by source | `once` has a 20 s default timeout. |
| place_entity (boats, minecarts, armor stands, end crystals) | `placeEntity` place_entity.js:60 | `block_place`, then for boats `use_item {hand}` (:39) | **suspect** | The boat `use_item` has no `rotation`; offline check: the serializer throws "Cannot read properties of undefined (reading 'x')". Boat placement therefore throws after `block_place`. Whitelist is end_crystal, boats (any `*_boat`, including chest boats), spawn_egg, armor_stand (:20); minecarts hit the 'Unimplemented' assert. Waits 5 s for the spawn. Not a line in CAPABILITIES section 3 (it is covered by "place"), added because it was asked for. |

## 2. Section 10 windows

prismarine-windows is keyed by the numeric menu id (registry order, `inventory` = -1). The order it uses matches the vanilla 1.21.6 menu registry. Offline `createWindow(id, n)` for n = 0..24 returned the layouts below ("inv" = player inventory range). Feature flags `village&pillageInventoryWindows` and `netherUpdateInventoryWindows` are true for 1.21.6. The task list omitted `smoker`; it is the 25th menu.

| Menu (id) | prismarine `type` | Known | Slot layout in prismarine | Helper | Buttons |
| --- | --- | --- | --- | --- | --- |
| generic_9x1..9x6 (0-5) | minecraft:generic_9xN | yes | chest slots 0..9N-1; inv 9N..9N+35 | `openContainer`/`openChest` chest.js:14, `withdraw`/`deposit` | none |
| generic_3x3 (6) | minecraft:generic_3x3 | yes | 0-8; inv 9-44 | `openDispenser` (same function) | none |
| crafter_3x3 (7) | minecraft:crafter_3x3 | yes, **likely wrong** | grid+result 0-9, inv 10-45, no result slot set | none | slot enable/disable is `set_slot_state` (never sent) |
| anvil (8) | minecraft:anvil | yes | 0 left, 1 right, 2 result; inv 3-38 | `openAnvil` anvil.js:12 | none (`name_item`) |
| beacon (9) | minecraft:beacon | yes | 0 payment; inv 1-36 | none | none; effect chosen with `set_beacon_effect` (never sent) |
| blast_furnace (10) | minecraft:blast_furnace | yes | 0 input, 1 fuel, 2 result; inv 3-38 | `openFurnace` furnace.js:15 | none |
| brewing_stand (11) | minecraft:brewing_stand | yes | 0-2 bottles, 3 ingredient, 4 fuel; inv 5-40 | none | none (progress via `craft_progress_bar`) |
| crafting (12) | minecraft:crafting | yes | 0 result, 1-9 grid; inv 10-45 | `craft` craft.js:11 | none |
| enchantment (13) | minecraft:enchantment | yes | 0 item, 1 lapis; inv 2-37 | `openEnchantmentTable` enchantment_table.js:7 | yes: button 0, 1, 2 = option (`enchant_item`) |
| furnace (14) | minecraft:furnace | yes | 0 input, 1 fuel, 2 result; inv 3-38 | `openFurnace` | none |
| grindstone (15) | minecraft:grindstone | yes | 0 top, 1 bottom, 2 result; inv 3-38 | none | none |
| hopper (16) | minecraft:hopper | yes | 0-4; inv 5-40 | `openContainer` | none |
| lectern (17) | minecraft:lectern | yes | 0 book; inv 1-36 | none | yes: 1 previous page, 2 next page, 3 take book, 100+n jump to page n (vanilla, unverified) |
| loom (18) | minecraft:loom | yes | 0 banner, 1 dye, 2 pattern item, 3 result; inv 4-39 | none | yes: pattern index (vanilla, unverified; list order depends on the banner and pattern item) |
| merchant (19) | minecraft:merchant | yes | 0 input1, 1 input2, 2 result; inv 3-38 | `openVillager` villager.js:72, `trade` | none (`select_trade`) |
| shulker_box (20) | minecraft:shulker_box | yes | 0-26; inv 27-62 | `openContainer` | none |
| smithing (21) | minecraft:smithing | yes, **wrong for 1.20+** | 0 base, 1 addition, 2 result; inv 3-38 (39 slots) | none | none |
| smoker (22) | minecraft:smoker | yes | 0 input, 1 fuel, 2 result; inv 3-38 | `openFurnace` | none |
| cartography_table (23) | **minecraft:cartography** (name differs from the registry) | yes | 0 map, 1 paper/glass pane, 2 result; inv 3-38 | none | none |
| stonecutter (24) | minecraft:stonecutter | yes | 0 input, 1 result; inv 2-37 | none | yes: button = index of the recipe in the offered list (vanilla, unverified) |

Corrections to prismarine-windows (vanilla, unverified; confirm via `window_items` length on a live server):
- **smithing**: since 1.20 the table has a template slot: 0 template, 1 base, 2 addition, 3 result, inventory 4-39 (40 slots). prismarine says 39 slots with inventory 3-38, so the last hotbar slot of a 40-slot sync lies outside `inventoryEnd`, and `craftingResultSlot` 2 points at the addition slot.
- **crafter_3x3**: vanilla CrafterMenu is grid 0-8, inventory 9-44, output slot 45. prismarine copies the crafting-table layout (inventory 10-45).

Windows with no Mineflayer helper: `bot.openBlock(block)` opens any of them, then `bot.clickWindow`/`bot.transfer({window, ...})`/`bot.putAway` with the layout above. Windows needing `container_button_click` (raw `enchant_item` write): enchantment (helper exists), stonecutter, loom, lectern. Windows needing other packets: beacon (`set_beacon_effect`), crafter (`set_slot_state`), merchant (`select_trade`, helper exists), anvil (`name_item`, helper exists).

Helper whitelists: furnace.js:6 (furnace, blast_furnace, smoker), anvil.js:10, enchantment_table.js:11 (`startsWith('minecraft:enchant')`), villager.js:80, chest.js:6 (block names are checked against this list at chest.js:18).

## 3. Client-to-server packets (play state, 1.21.6): 66 total

Sent by Mineflayer (30): teleport_confirm (physics.js:423), chunk_batch_received (blocks.js:296), client_command (health.js:44, game.js:126), settings (settings.js:56), tab_complete (chat.js:199), enchant_item (enchantment_table.js:78), window_click (inventory.js:630, :859), close_window (:434), custom_payload (command_block.js:113), edit_book (book.js:28), use_entity (entities.js:912, :922; inventory.js:251, :263), position / position_look / look / flying (physics.js:112, :138, :123, :198), block_dig (digging.js:130/:149/:178; inventory.js:157), entity_action (bed.js:71; physics.js:240/:255/:272), player_input (entities.js:868/:888; physics.js:265), player_loaded (health.js:14), pong (game.js:144), name_item (anvil.js:27), resource_pack_receive (resource_pack.js), select_trade (villager.js:18), held_item_slot (simple_inventory.js:56), update_command_block (command_block.js:118), set_creative_slot (creative.js:32), update_sign (blocks.js:502), arm_animation (entities.js:835), block_place (generic_place.js, inventory.js, place_entity.js:43), use_item (inventory.js:134, place_entity.js:39).

Sent by minecraft-protocol (7): message_acknowledgement, chat_command, chat_command_signed, chat_message, chat_session_update, keep_alive, configuration_acknowledged.

**Never sent (29), survival-relevant first:**
- `vehicle_move`, `steer_boat`: vehicle driving.
- `set_beacon_effect`: beacons.
- `set_slot_state`: crafter slot toggles.
- `craft_recipe_request`: recipe-book auto-fill (would replace the click-based crafting; the recipe id is a display id from `recipe_book_add`, not the registry id).
- `pick_item_from_block`, `pick_item_from_entity`: pick block.
- `select_bundle_item`: bundles.
- `tick_end`: sent by the vanilla client every tick since 1.21.2; harmless so far but a fingerprint difference.
- `custom_click_action`: dialogs (new in 1.21.6).
- `recipe_book`, `displayed_recipe`: recipe-book UI state.
- Inside packets that are sent: `block_dig` statuses 3, 4, 6 (drop stack, drop item, swap with off hand) and `entity_action` with the right meaning for 0 (stop_sleeping), 1/2 (named sprint), 3/4 (horse jump power), 5 (open inventory), 6 (fall flying) are never sent.
- Not survival (op, creative or debug): query_block_nbt, query_entity_nbt, set_difficulty, lock_difficulty, change_gamemode, abilities, generate_structure, update_command_block_minecart, update_jigsaw_block, update_structure_block, set_test_block, test_instance_block_action, debug_sample_subscription, ping_request, advancement_tab, spectate, cookie_response.

## 4. Click pipelining and slot-update waits (the `clickWindow` desync pattern)

Mechanism, from source: `clickWindow` (inventory.js:572-675) predicts the result locally (`window.acceptClick`), writes `window_click` with the last `stateId` seen from `set_slot`/`window_items` (:35-38, :630), and returns at once unless the window is the inventory (slots 0-4, waits `updateSlot:0`, :481-484), a crafting table (slots 0-9, waits `updateSlot:0`, :485-488) or a merchant (:489-505). Those `once` waits use the 20 s default (promise_utils.js:105). Every other click returns immediately, so the next click is sent with a stale `stateId`. In vanilla a stale `stateId` makes the server apply the click and then resend the full window (unverified), so the local model and the server can disagree between echoes. The only guard in the library is `_syncWindow` (inventory.js:856), called from just two places: craft.js:26 and book.js:48.

Helpers that share the risk:

| Helper | Where | What it pipelines or waits on |
| --- | --- | --- |
| `transfer` (core of chest withdraw/deposit, toss, furnace put, anvil put, villager deposit) | inventory.js:275-363; withdraw/deposit :372-402 | pickup, place, then repeated right clicks (:345-359) back to back; no sync |
| `putSelectedItemRange` | inventory.js:162-193 | loops clicks until the cursor is empty |
| `putAway` | inventory.js:677-694 | one or two clicks, then waits 20 s for `updateSlot:<slot>` (:679, :693); times out if the server does not change that slot (full inventory, rejected shift click) |
| `moveSlotItem` (equip armor and off-hand, enchant put, book move) | inventory.js:696-705; callers simple_inventory.js:107, :125, enchantment_table.js:94/:98, book.js:45/:67 | 2-3 clicks back to back |
| `craft` / `craftOnce` | craft.js:39-168 (clicks :102, :104, :118, :120; fake result :139-141; `putAway(0)` :141; leftovers :166) | the documented pattern: slot 0-9 waits on `updateSlot:0`, many pipelined clicks; the only helper with a final `_syncWindow` (:26) |
| furnace `putInput`/`putFuel`/`take*` | furnace.js:75-79 (`putAway`), :93-105 (`transfer`) | transfer and putAway, no sync |
| anvil `combine`/`rename` | anvil.js:38-43, :62-69, :85-89, `name_item` loop :33-36 | two `transfer`s, then `putAway(2)`, then a wait for `experience` (:61, :84) |
| enchantment `putTargetItem`/`putLapis`/`takeTargetItem`/`enchant` | enchantment_table.js:86-99; `enchant` :74-84 | `moveSlotItem`/`putAway` pipelined; `enchant` waits 20 s for `updateSlot:0` after the button packet |
| villager `trade` | villager.js:151-204 (`select_trade`, then waits `updateSlot` 0/1/2 :154-158; `transfer` :163, :229-241; `putAway(2)` :193, :202); merchant wait inside inventory.js:489-505 | waits on several slot updates without knowing which one the server will send |
| `toss` / `tossStack` / `equipEmpty` | simple_inventory.js:22-41, :62-80 | pickup then drop clicks back to back; `tossStack` then writes `close_window` |
| `closeWindow` | inventory.js:433-443 | copies the predicted window contents into `bot.inventory` before the server has echoed pending clicks |

Does the pattern apply to anything else? Yes. The stale-`stateId` hazard is generic to any use of `clickWindow`, so it applies to every row above, not just slots 0-4. The 20 s slot-update wait (a stall, then a throw if the server sends no matching update) applies specifically to `craft`, `trade`, `enchant`, every `putAway` user (furnace take, anvil, enchant take, equip/unequip, craft, trade) and the anvil `experience` wait. Only craft and book writing call `_syncWindow`.

## 5. Gaps to close in Phase 1 (by number of catalogue groups affected)

Counts are my estimate from the section list in CAPABILITIES.md (6 to 31).

1. **Reliable window clicks** (HashedSlot encoding, fresh `stateId` per click, per-click confirmation or `_syncWindow`, no 20 s slot waits). Affects windows, crafting, enchanting and repair, brewing, storage, trading, provisioning, equipment, dropping: about 10 groups (8, 10, 11, 12, 15, 17, 18, 21, 22, 30).
2. **Fix the `entity_action` ids** (sprint, wake, elytra) and use named values. Movement, escape, night survival, gliding: about 6 groups (6, 13, 14, 15, 20, 26).
3. **Hand and drop actions**: swap hands (`block_dig` 6), drop held item (3, 4), pick block, hand choice on blocks and entities, sneak flag on `use_entity`. About 6 groups (8, 12, 14, 15, 21, 30).
4. **Window buttons and other menu packets**: `enchant_item` as a generic button call (stonecutter, loom, lectern), `set_beacon_effect`, `set_slot_state`, `select_bundle_item`, and corrected smithing and crafter layouts. About 5 groups (9, 11, 17, 19, 23).
5. **Enchantment data bug** in `Item.enchants` for 1.21.6 (breaks `dig` and anvil with enchanted items). About 4 groups (7, 14, 17, 25).
6. **Vehicles**: `vehicle_move`, `steer_boat`, correct dismount, own boat simulation. About 3 groups (6, 16, 20).
7. **Placing entities**: boat `use_item` body, minecarts. 2 groups (6, 8).
8. **Crawl and swim poses** in physics. 2 groups (6, 25).
9. **Wandering trader** support in `openVillager`. 1 group (22).

## 6. Needs a live check

Nothing here was tested live. Looks right in source but must be confirmed on a server:
- Sneak-placing against a chest, and that `player_input{shift}` is what the server reads.
- HashedSlot effect: what the server does with `hash:0` components (extra resyncs or rejected clicks), and whether the empty-cursor encoding is accepted.
- Stale `stateId` behaviour on pipelined clicks.
- Sprint: whether the server tracks sprint at all given ids 3/4 (check hunger drain and sprint knockback), and the wake and elytra fixes.
- `block_dig` 6 and 3/4 behaviour, and the `edit_book` slot semantics for off-hand books.
- Brush, trident, crossbow and spyglass timing with `activateItem`/`deactivateItem`.
- Sign editing: whether `update_sign` is accepted without first right-clicking the sign.
- Button ids for stonecutter and loom; lectern ids 1/2/3/100+.
- Smithing and crafter slot layouts (compare `window_items` length with prismarine).
- Boat, horse and pig control (`vehicle_move` requirement), shift dismount, horse inventory via shift-click.
- Villager trade waits (`updateSlot` 0/1/2) and the anvil `experience` wait.
- `fish` bite detection with `world_particles` amount 6.
- Mining speed: whether the server accepts Mineflayer's `digTime` for tools with Efficiency or Haste once the enchants bug is fixed.

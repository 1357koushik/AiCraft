# AiCraft capability catalogue: everything a player can do in Minecraft 1.21.6 survival

This is the centre of the plan. It lists every kind of action and every kind of skill the body needs, so that any task an owner types is a combination of things listed here. [ROADMAP.md](ROADMAP.md) explains how the LLM uses them and in what order they are built.

**How the list was made.** It is derived from the game, not from example tasks:
- On 2026-11-11 the game's own data was exported from this repo's `server/server.jar` (1.21.6). The counts in this file come from that export.
- The actions come from the full list of messages a client can send to the server.
- The Mineflayer column comes from `node_modules/mineflayer/docs/api.md` (version 4.39).

**Scope.** Survival mode, no commands, no creative mode. Anything that needs operator rights is out of scope by design.

**Status.** Nothing in this file is implemented to the standard it describes. The only things seen working live are connecting, walking, chopping a tree and crafting a wooden pickaxe once. Every "Mineflayer" entry below means "the API exists", not "it works here"; each one is checked live in the phase that builds it.

---

## 1. Why this can be complete

A player can only affect the world through what the game client sends to the server. In 1.21.6 there are 66 such messages during play. About 25 of them are things a survival player does; the rest are housekeeping (keep-alive, settings) or operator and creative tools.

So every possible task, however large, is a sequence of these few inputs. If the body can produce all of them, **no task is out of reach**. What is left is making common sequences fast and reliable (skills) and knowing which sequence to use (knowledge and the LLM).

| What the player does | Server message | Covers |
| --- | --- | --- |
| Move and look | `move_player_*`, `player_input` | walk, sprint, jump, sneak, swim, climb, fall |
| Change movement state | `player_command` | start sprinting, start elytra flight, leave a bed, horse jump |
| Steer a vehicle | `move_vehicle`, `paddle_boat` | boats, minecarts, ridden animals |
| Left click | `player_action`, `swing`, `interact` | break a block, attack an entity |
| Right click with an item | `use_item` | eat, drink, throw, shoot, raise shield, use a rod |
| Right click on a block | `use_item_on` | place a block, use a door or lever, till, plant, light, fill a bucket |
| Right click on an entity | `interact` | trade, breed, tame, shear, milk, mount, leash |
| Stop using, drop, swap hands | `player_action` | release a bow, drop an item, move an item to the off hand |
| Choose a hotbar slot | `set_carried_item` | hold the right item |
| Click in a window | `container_click`, `container_close` | every chest, furnace, table and villager screen |
| Press a button in a window | `container_button_click` | pick an enchantment, a stonecutter or loom result, turn a lectern page |
| Window extras | `place_recipe`, `select_trade`, `rename_item`, `set_beacon`, `container_slot_state_changed`, `bundle_item_selected` | recipe book fill, villager trade choice, anvil rename, beacon power, crafter slots, bundles |
| Write | `sign_update`, `edit_book`, `chat` | signs, books, talking to players |
| Respawn, accept a teleport | `client_command`, `accept_teleportation` | death, portals, ender pearls |

---

## 2. The three layers

| Layer | What it is | Who chooses it |
| --- | --- | --- |
| **Actions** (section 3) | One input from the table above, with its target. Complete by construction | The LLM, when no skill fits |
| **Skills** (sections 6 to 31) | A purpose carried out by many actions, written once against game data so it works for every block, item, recipe or mob of its kind | The LLM, in most steps |
| **Reflexes** (section 15) | Skills that fire on their own within a tick to keep the bot alive | Code only |

**The rule for what must be a skill:** anything where a wrong or late move costs health or items. An action is one step, and a failed step is a round trip to the LLM of about two seconds. Fighting, falling, lava and fast travel cannot wait that long. Everything else may start as action sequences and become a skill later when it is used often.

---

## 3. Actions

Each action has a precondition that code checks, a result read back from the game, and a fixed list of failure causes.

| Action | Mineflayer 4.39 |
| --- | --- |
| `look_at(point or entity)` | `lookAt`, `look` |
| `step(direction)`, `jump`, `sneak(on/off)`, `sprint(on/off)` | `setControlState` |
| `break(block)` | `dig`, `stopDigging`, `canDigBlock`, `digTime` |
| `place(item, against block, face, exact spot on the face)` | `placeBlock`, `activateBlock` with a cursor position |
| `use_block(block)` | `activateBlock` |
| `sneak_use(item, on block)`: place against a block that would otherwise open (a chest, a table) | `setControlState('sneak')` with `placeBlock`; to verify |
| `use_off_hand`: use or place the item in the off hand | `activateItem(offHand)` |
| `use_item(hand)`, `stop_using` | `activateItem`, `deactivateItem`, `consume` |
| `use_item_on_entity(entity)`, `interact(entity)` | `useOn`, `activateEntity`, `activateEntityAt` |
| `attack(entity)` | `attack` |
| `select_slot(n)`, `equip(item, where)`, `unequip(where)`, `swap_hands` | `setQuickBarSlot`, `equip`, `unequip`; no direct call for swap hands, to verify |
| `drop(item, count)` | `toss`, `tossStack` |
| `open(block or entity)`, `close_window` | `openContainer`, `openBlock`, `openEntity`, `closeWindow` |
| `click_slot(slot, button, mode)`, `move_items(from, to, count)` | `clickWindow`, `transfer`, `moveSlotItem`, `putAway` |
| `window_button(n)` | no direct call; raw message, to verify |
| `choose_trade(n)` | `trade` |
| `rename(text)` in an anvil | `openAnvil` (`rename`) |
| `write_sign(text)`, `write_book(pages)` | `updateSign`, `writeBook` |
| `mount(entity)`, `dismount`, `steer(left, forward)` | `mount`, `dismount`, `moveVehicle` |
| `sleep(bed)`, `wake` | `sleep`, `wake` |
| `start_gliding` | `elytraFly` |
| `cast_and_reel` | `fish` |
| `chat(text)`, `whisper(player, text)` | `chat`, `whisper` |
| `charge_and_release(ticks)`: hold use for a set time (bow draw, trident, eating, spyglass, brush) | `activateItem` then `deactivateItem` |
| `crawl` and `swim_through` one-block gaps | physics states; to verify |
| `respawn` | `respawn` |
| `wait_for(event, limit)` | `waitForTicks` and game events |

---

## 4. What the body can sense

The LLM can only decide on what the body can see, and the body sees less than people assume.

| Sense | Source | Limit |
| --- | --- | --- |
| Blocks and their states | loaded chunks | only within view distance (10 chunks on our server); nothing about unloaded areas |
| Entities: type, position, look direction, equipment, some metadata | entity tracking | only within the server's tracking range |
| Other players: position, where they look, what they hold and wear | player entities | **not** their inventory |
| Own health, food, air, effects, experience, position, dimension | bot state | |
| Own inventory, and the window that is open | windows | a chest's contents are known only after opening it |
| Time of day, moon phase, weather | bot state | |
| Chat, titles, boss bars | events | |
| Sounds and particles | events | useful for fishing, creepers, hidden mobs; easy to misread |
| Block changes, explosions, digging by others | events | |
| Text in the world: signs, written books on lecterns, item names and lore | block and item data | books in a chest are readable only after taking them |
| Item details: enchantments, durability, potion contents, trim, stored items | item components | |
| Mob details: baby or adult, tamed and by whom, angry, sheared, colour, villager job and level, creeper about to explode, enderman carrying a block, dragon phase | entity metadata | which fields Mineflayer exposes is to verify per mob |
| What an item frame or armor stand holds | entity data | |
| A villager's offers and prices | the trade window | only while it is open |
| Own advancements and statistics | server messages on request | to verify |
| Biome at a position | chunk data | |
| Map contents | map data | to verify |
| Who can see the bot: a line-of-sight check from each mob or player to the bot | worked out by code from positions and blocks | piglins react to what they see, endermen to being looked at, so this decides many plans |
| Which variant of a structure this is, and where in it the bot stands | block patterns matched against the game's structure templates | to verify; needed to know where the loot and the dangers are |
| Who is online, and what other players are doing (swinging, sneaking, sleeping, taking damage) | player list and entity events | |

Things the body cannot sense, and what stands in for each:
- **Unloaded terrain:** memory of places seen, plus exploring.
- **Chest contents not yet opened:** the container index in memory.
- **The owner's inventory:** the bot knows only what it gave and what it sees held.
- **Light level and exact mob spawn rules:** partly computable from blocks; to verify.

---

## 5. Where game knowledge comes from

No single source is complete. Recipe data in particular does **not** cover brewing, trading, enchanting or anything about how mobs and blocks behave.

| Source | What it holds (1.21.6 export) | What it does not hold |
| --- | --- | --- |
| **Game data export** | 1,407 recipes of 7 types; 1,246 loot tables (1,023 block drops, 102 mob drops, 56 chest types, 22 shearing, 25 gameplay tables such as fishing and piglin bartering, 6 archaeology); 589 tag files; 42 enchantments; 34 structures; 1,520 advancements (124 of them real goals, the rest recipe unlocks); 1,105 blocks with every state; 1,415 items with their components; 952 world-generation files giving ore heights, which mobs and plants each biome has, and which biomes each structure appears in; 49 damage types; 28 trial spawner setups | brewing, villager trades, how blocks and mobs behave |
| **`minecraft-data` 3.117** | IDs, collision shapes, foods, entity sizes, protocol | its 1.21.6 drop tables point at 1.20 data, so drops must come from the export |
| **Mechanics book** (to be written) | Rules the data lacks, one short checked entry each: brewing recipes, villager trades by profession and level, mob-building patterns (snow golem, iron golem, wither), portal rules, crop and tree growth rules, mob behaviour (what angers or calms each one), enchanting-table and anvil rules, bed and respawn rules, raids, redstone component behaviour, and the world rules in section 29 | |
| **Design library** (to be built) | Known-good builds stored as block-by-block data: farms, redstone machines, villager halls, storage systems. Each with its site requirements, how to operate it, and the output measured on our server. Owners can add their own schematic files | |
| **Tricks book** (to be written) | Techniques that use the rules cleverly, one checked entry each (section 31): how to make a mob harmless, how to survive a fall without water, how to cook without fuel | |
| **The LLM's own knowledge** | Strategy, design, real-world shapes (what the Eiffel Tower looks like), common sense | exact numbers; it can be wrong about any game fact |

Rules:
- **Every mechanics-book entry is checked live on our server before it is trusted**, and records the version it was checked on. The Minecraft Wiki is the starting point, never the proof.
- **A game fact the LLM relies on is checked by code whenever code can check it.** If the LLM says a recipe needs 3 iron and the data says 4, the data wins and the LLM is told.
- **When the server version changes, the export is regenerated** and every mechanics-book and tricks-book entry is marked unchecked.
- **Every entry is tagged Java 1.21.6.** Guides and videos mix Java and Bedrock, and old and new versions. In the three videos reviewed on 2026-11-11, at least six tips were stated to work in only one edition. A tip is a candidate until it passes on our server.
- **The LLM does not invent machines.** A working farm or redstone device depends on exact block positions, facings and timings that took players years to find. The LLM chooses a design from the library and adapts size and materials. It designs freely only where exactness doesn't matter: houses, towers, landscaping.
- **Chances are data too.** Loot tables give drop rates, and the mechanics book records the ones the tables lack (an eye of ender breaks about one throw in five). Plans use them: section 30.

---

## 6 to 31. Skills, by game mechanic

Each group lists what must be possible, what drives it, whether it needs speed, and how the test server can confirm it without trusting the bot. The server already counts most of this: it keeps 76 general statistics and per-item counters for mined, crafted, used, broken, picked up, dropped and killed, and it has 57 advancement triggers our datapack can log.

### 6. Moving and travelling
- **On foot:** walk, sprint, jump, sneak, swim, climb ladders, vines and scaffolding, cross gaps, go through doors and gates.
- **Making a way:** bridge, pillar up, dig through, stair up or down, tunnel.
- **Long distance:** travel in legs with no distance cap, across unloaded terrain, at night, across water.
- **Vehicles and mounts:** boats and rafts (20 kinds), minecarts on rails, horse, donkey, mule, camel, llama, pig with a carrot on a stick, strider with a warped fungus on a stick, happy ghast.
- **Flight and throws:** elytra with firework rockets, ender pearl throws, riptide trident.
- **Between dimensions:** nether portals (build, light, link pairs), end portals, end gateways.
- **Landing safely:** water bucket, slow falling, hay or slime, never a blind drop.
- **Blocks that change movement:** soul sand and magma bubble columns as lifts, honey and slime blocks, ice and packed-ice boat roads, cobwebs, powder snow, sweet berries, scaffolding, and big dripleaf, which tilts and drops whoever stands on it for more than a moment (a step to cross quickly, or a trap).
- **Flying well:** shallow angles, turning to lose speed, flat landings, counting rockets, swapping to a spare elytra before the first one breaks.
- **Fall savers beyond the water bucket,** and where each works: boat, scaffolding, twisting vines, powder snow bucket, sweet berries, slime, ender pearl, chorus fruit. Water cannot be placed in the Nether.
- **Leaving a trail:** torches or an out-of-place block along the route, so the bot and the owner can both find the way back.
- **Tight spaces:** crawling through one-block gaps (an end gateway needs this, or a pearl), swimming through flooded tunnels, sneaking along an edge without falling.
- **Driven by:** block collision shapes; a danger map from memory.
- **Needs speed:** yes for falls, lava, elytra and anything near a ledge.
- **Server check:** the distance statistics per travel mode (walk, swim, boat, horse, aviate and so on), position from RCON, `changed_dimension`, `nether_travel`.

### 7. Breaking and gathering
- **Mine any of the 1,105 blocks** with the right tool, chosen from the item's `tool` data and the block's "needs stone, iron or diamond tool" tags. Never break a block whose drop would be lost.
- **Choose the drop** where it matters: silk touch against fortune, shears against hand.
- **Other ways to take things:** shears (22 kinds of target), buckets for water, lava, milk and powder snow, brush for suspicious sand and gravel, bottles for honey and water, bone meal to grow, glass bottles on dragon breath.
- **Change a block with a tool:** strip logs, scrape and wax copper, till soil, make paths, carve pumpkins.
- **Pick up drops,** including ones that fall or float away, and experience orbs.
- **Looting:** open structure chests, barrels and pots, take from item frames and armor stands, open vaults with trial keys, dig up buried treasure. Never loot what belongs to the owner or another player.
- **Rare finds that are not mined or crafted:** elytra and shulker shells (end cities), netherite scrap from ancient debris, heart of the sea, nautilus shells, music discs, echo shards, smithing templates, enchanted golden apples, the dragon egg and dragon head.
- **Trees of every kind,** including 2×2 trunks, huge mushrooms and nether fungi.
- **Driven by:** block loot tables, tags, tool components.
- **Needs speed:** only near lava, water and gravel.
- **Server check:** `mined:<block>` and `picked_up:<item>` counters, `filled_bucket`.

### 8. Placing and building
- **Place any block in any state:** slab top or bottom, stair direction, door and bed halves, torches and signs on walls, waterlogged blocks, rotated pillars, candles in stacks, heads and banners.
- **Fluids and falling blocks:** place and remove water and lava, use sand, gravel and concrete powder safely.
- **Entities that are placed:** boats, minecarts, armor stands, item frames, paintings (50 variants), end crystals.
- **Build from a design:** in a workable order, supports before overhangs, with scaffolding put up and taken down, every block checked and repaired.
- **Build from a schematic file** the owner supplies or the design library holds, including the game's own structure format.
- **Exactness where machines need it:** which way an observer, hopper, piston, comparator or stair faces, whether a trapdoor is open, placement order when order matters, temporary blocks put in and taken out, and containers pre-loaded with exact item counts (a hopper filter needs them).
- **Patterns that create mobs:** snow golem, iron golem, wither. The last block must go on last, and the pattern needs clear space.
- **Structures that grant power:** a beacon on its pyramid (1 to 4 layers, then choose the effect), a conduit in its prismarine frame, a nether portal frame, a respawn anchor, an enchanting table ringed with bookshelves, four end crystals on the exit portal to bring the dragon back.
- **Decoration:** item frames (put in, rotate), armor stands (dress), paintings, flower pots, banners with patterns, candles, signs with text and dye, heads.
- **Driven by:** the block state list; the design from the LLM (section 32); the mechanics book for patterns.
- **Needs speed:** no.
- **Server check:** block-by-block reads, `placed_block`, `used:<item>` counters, `summoned_entity` for golems and the wither.

### 9. Using blocks without a window
Doors, trapdoors and gates; levers and buttons; beds and respawn anchors; bells, note blocks and jukeboxes; cake; cauldrons; composters; campfires (cooking); flower pots; lecterns and chiselled bookshelves; decorated pots; beehives; end portal frames (placing eyes); lodestones; vaults and trial spawners (keys); TNT; candles; sign editing; repeater, comparator and daylight-detector settings; cauldron washing (dyed armor, banners, shulker boxes); sponges; spawners (light up, break, or keep for a farm); sculk shriekers and sensors (never trigger); turtle, sniffer and frog eggs; dried ghasts in water; targets; lightning rods.
- **Driven by:** the 255 block kinds in the game data, each mapped to "what a right click does" in the mechanics book.
- **Needs speed:** no.
- **Server check:** block state reads, statistics such as `bell_ring`, `play_record`, `fill_cauldron`, `sleep_in_bed`.

### 10. Windows
The game has exactly 25 window kinds. Every one needs to work.

| Window | Used for | Mineflayer 4.39 |
| --- | --- | --- |
| `crafting` (and the 2×2 grid in the inventory) | crafting | `craft`, `recipesFor` |
| `furnace`, `blast_furnace`, `smoker` | smelting and cooking | `openFurnace` |
| `generic_9x1` to `generic_9x6`, `generic_3x3`, `hopper`, `shulker_box` | chests, barrels, ender chests, dispensers, droppers, hoppers, chest boats and minecarts, donkey chests | `openContainer`, `openChest`, `openDispenser` |
| `enchantment` | enchanting table | `openEnchantmentTable` |
| `anvil` | combine, repair, rename | `openAnvil` |
| `merchant` | villagers and the wandering trader | `openVillager`, `trade` |
| `brewing_stand`, `grindstone`, `smithing`, `stonecutter`, `loom`, `cartography_table`, `beacon`, `lectern`, `crafter_3x3` | brewing, disenchanting, upgrades and trims, cutting, banners, maps, beacons, reading, automatic crafting | no dedicated call; generic slot clicks and window buttons, each to verify |

One generic skill, `use_station(kind, inputs, choice)`, covers all of them, with the slot layout of each window as data.
- **Needs speed:** no, but an open window leaves the bot defenceless, so reflexes close it.
- **Server check:** `interact_with_*` statistics (one per station), container contents by RCON, item components in the inventory.

### 11. Making things
- **All 1,407 recipes** across the 7 recipe types: crafting (673 shaped, 295 shapeless, 44 special), stonecutting (254), smelting (72), blasting (24), smoking (9), campfire cooking (9), smithing (27).
- **Ingredient choices:** any item in a tag (any planks, any coal), and the cheapest choice from what is held.
- **Special crafting that plain recipes can't describe:** firework rockets and stars, dyed armor, banner copying, shield patterns, map copying and extending, book copying, tipped arrows, tool repair by combining, decorated pots.
- **Chains:** work out the full tree for any item, including tools and stations needed along the way. This is the inside of `obtain`.
- **Every other way to get an item,** which `obtain` must also know: mine it, kill for it, find it in a chest, trade, barter, fish, farm, brew, shear, smelt.
- **Driven by:** recipes, loot tables, the mechanics book for trades and brewing.
- **Server check:** `crafted:<item>` counters, inventory by RCON.

### 12. Using items
Grouped by what a right click does. The item list and its components come from the export.
- **Eat and drink:** 40 foods, potions, milk, honey, suspicious stew; which effects each gives.
- **Throw:** snowball, egg, ender pearl, eye of ender, experience bottle, splash and lingering potions, wind charge.
- **Shoot:** bow, crossbow (load, then fire), trident; arrow kinds.
- **Tools used on the world:** flint and steel, fire charge, bone meal, shears, brush, hoe, shovel, axe, bucket (and buckets holding fish, axolotls or tadpoles), glass bottle, lead, name tag, saddle, dye, honeycomb, glow ink.
- **Wear and hold:** 73 equippable items, shield, elytra, totem in the off hand, carved pumpkin.
- **Carry and find:** maps, compass, lodestone compass, recovery compass, clock, spyglass, bundles (17 kinds), ender chest, shulker boxes.
- **Other:** goat horn, written books, firework rockets, fishing rod, ominous bottles, chorus fruit (teleports), trial keys.
- **Off hand:** torch, shield, totem, map or rockets in the off hand while the main hand works.
- **Weapons with their own rules:** mace (falling smash, wind charge jumps), trident (riptide, loyalty, channelling lightning), crossbow with fireworks, sweeping sword hits, axe against shields.
- **Needs speed:** throwing and shooting in a fight, yes.
- **Server check:** `used:<item>` counters, `consume_item`, `shot_crossbow`, `used_ender_eye`, `used_totem`.

### 13. Living with mobs
The game has 151 entity types, about 80 of them living mobs. Every peaceful interaction belongs here.
- **Breed** each animal with its own food (from tags), and wait out the cooldown.
- **Tame and keep:** wolf, cat, parrot, horse family, llama, camel, fox trust, axolotl in a bucket; sit and stand; heal; armor for wolves and horses.
- **Lead, tie up, name, ride, load a chest onto.**
- **Take from them:** shear sheep and others, milk cows and goats, brush armadillos, collect eggs, turtle scutes, honey.
- **Putting villagers to work:** get one into a cell (beds at night, a boat, temporary blocks), give it a job block, trade once to lock its offers, re-roll the job block until the offer wanted appears, breed more by supplying food and beds.
- **Cheaper trades:** let a zombie convert a villager and cure it. This kills the villager outright on some difficulty settings, so the setting is checked first.
- **Villagers:** find the job block, trade (13 working professions plus the wandering trader), level up, restock timing, cure a zombie villager, breed villagers, protect them.
- **Piglins:** wear gold, barter one ingot at a time, never open their chests in view.
- **Helpers:** iron and snow golems (heal with iron), allays (give an item), dolphins, cats against creepers.
- **Moving mobs from place to place:** leads, luring with food, boats and minecarts for villagers and others, a water stream, a nether portal trip; "bring two villagers to my base" is this.
- **Catching and holding:** pens, a boat as a trap, a pit, name tags so they stay, a bucket for fish, axolotls and tadpoles.
- **Raising:** hatch turtle and sniffer eggs, grow tadpoles into frogs (and frogs into froglights with magma cubes), grow a dried ghast into a happy ghast and harness it.
- **Villages:** raids and hero of the village, iron golem spawning, beds and job blocks, a trading hall.
- **Which mobs to leave alone:** neutral mobs such as endermen, bees, wolves, polar bears, zombified piglins, iron golems.
- **Driven by:** tags, mob loot tables, the mechanics book.
- **Server check:** `bred_animals`, `tame_animal`, `villager_trade`, `cured_zombie_villager`, `player_interacted_with_entity`, entity counts by RCON.

### 14. Fighting
All of this needs speed, so all of it is skills. The LLM chooses whether to fight, what with and when to leave; code does the fighting.
- **Basics:** attack timing with the cooldown, critical hits, sprint knockback, shield use, keeping distance, retreating, healing during a fight.
- **Melee at tick level:** resetting the sprint between hits for full knockback, spacing just outside the enemy's reach, a critical hit only while falling, sweeping hits against groups, strafing to be harder to hit, never attacking on a weak charge. These are movement keys pressed on exact ticks, so they live in the fight skill's inner loop.
- **Raiding a guarded structure:** from the top down, with a wall between the bot and anything that must not see it, spawners broken first, an escape route kept open, gold thrown to distract piglins.
- **Ranged:** bow and crossbow aim with gravity and target movement, tridents.
- **A tactic for every hostile mob,** derived from the entity list: zombie family, skeleton family, creeper, spiders, enderman, witch, slimes and magma cubes, phantom, drowned, guardians, blaze, ghast, wither skeleton, piglins and brutes, hoglin and zoglin, the raid mobs (pillager, vindicator, evoker, ravager, vex), shulker, silverfish, endermite, breeze, bogged, creaking, warden (avoid, never fight).
- **Bosses:** ender dragon (crystals, perch, breath), wither, elder guardian. Raids and trial chambers as multi-wave fights.
- **Protecting others:** guard a player, guard a place, escort, kill what attacks the owner, never hit the owner or pets.
- **Supporting a fighter:** hand over food and arrows, throw healing or regeneration splash potions, hold a doorway, draw a mob away, light the area.
- **Explosives as weapons:** beds in the Nether and the End, respawn anchors in the Overworld, end crystals, TNT. All can kill the bot or the owner, so each needs its own safety distance.
- **Using the terrain against a mob:** a two-block-high gap stops endermen and wither skeletons, three blocks up is out of a hoglin's reach, a block at foot height takes most of an explosion, water stops endermen and cancels a creeper's block damage, a pit holds a warden.
- **Shield details:** it covers only the front, takes a moment to raise, and wears out, so it is checked and replaced.
- **Making mobs fight each other,** and killing without blame: fire or lava does not count as the bot's hit for villager prices or golems.
- **Fighting players** is a real capability with its own difficulty: a human adapts, baits and punishes patterns, and network delay changes what works. **Whether the bot fights a player depends on the task the owner gave.** "Duel me", "defend me from Steve", "kill anyone who enters the base" and "fight on my team in this match" are all valid tasks, and the task says who the targets are. With no such task the bot never attacks a player; it defends itself only by blocking and getting away. Owners and the players on the config's friends list are never targets, whatever the task says.
- **Open-ended fighting:** "help me fight until I say stop" runs until the owner ends it (section 33).
- **Server check:** `killed:<mob>` counters, `player_killed_entity` events, damage statistics, deaths.

### 15. Staying alive
Runs on the reflex clock unless noted.
- **Health and food:** eat before starving, choose food by value, keep a reserve.
- **Dangers, each with a reflex:** lava, fire, drowning, falling, suffocating, cactus and berry bushes, powder snow freezing, the void, lightning, explosions.
- **The 39 status effects:** what each does and how to end it (milk, waiting, a counter-potion).
- **Night and spawns:** light up, shelter, sleep, set the spawn point.
- **Gear upkeep:** armor on, tools replaced before they break, a spare stack of blocks and food.
- **Death:** respawn, remember where, go back for the items before they despawn, if it is safe.
- **Inventory full:** a policy for what to drop or store, never silently losing the task item.
- **Items that burn:** drops are lost in lava and fire, so nearby lava is sealed before mining above it, and fire under a mob is put out before the kill. Netherite does not burn.
- **Digging blind:** never straight down on one block, never straight ahead in the Nether without a block ready in the off hand for hidden lava.
- **A death log decides which reflexes come first.** Every death in every run is recorded with its cause, and the commonest causes get the next reflex work. Outside claims about what kills players most are not used.
- **Server check:** deaths, `damage_taken`, health and food by RCON.

### 16. Farming and renewable resources
- **Crops:** wheat, carrot, potato, beetroot, melon, pumpkin, sugar cane, cactus, bamboo, cocoa, nether wart, sweet berries, glow berries, kelp, mushrooms, chorus fruit, torchflower and pitcher plant; each with its soil, water and light rule.
- **Trees:** plant, grow, harvest, replant; 2×2 kinds.
- **Animals and bees:** pens, breeding loops, honey with a campfire under the hive.
- **Fishing,** composting, bone meal.
- **Farms as builds:** a watered crop plot, an animal pen, simple automatic farms from a design.
- **Mob and experience farms:** spawner, dark-room, iron, gold, raid, enderman, creeper, drowned and wither-skeleton farms, and a trading loop for emeralds. Each comes from the design library; the LLM picks one and code builds it.
- **Survey the site first.** Designs have conditions: a biome, a height, a chunk corner, flat ground, no caves below, a set distance from any village, nothing spawnable nearby. Code checks them and reports which fail.
- **Operate it.** Many farms need a player in an exact spot, a lever pulled, or mobs hit through a gap. The design records the procedure.
- **Measure it.** After building, the bot runs the farm for a set time and counts the output. A farm that yields nothing is a failed build, whatever the blocks look like.
- **Farm or gather by hand?** For a small amount, gathering is quicker. For a large or repeated amount, building a farm pays off. Code gives the LLM both estimates.
- **Renewable blocks:** amethyst clusters that grow on budding amethyst (which breaks if mined, so it is harvested in place), a cobblestone or basalt generator, obsidian from water on lava, dripstone filling a cauldron with lava or water, an endless water source, ice, mud from water bottles, concrete from powder.
- **Driven by:** the mechanics book for growth rules; loot tables for yields.
- **Server check:** block states (crop age), entity counts, `fish_caught`, crafted and picked-up counters.

### 17. Enchanting, repair and upgrades
- **Enchanting table:** lapis, levels, bookshelves around it, choosing among the three offers.
- **Anvil:** combine items, apply books, repair with material, rename; cost limits.
- **Grindstone:** remove enchantments, repair.
- **Smithing table:** netherite upgrade, armor trims (18 patterns, 11 materials). Upgrade templates are found, then copied by a recipe so one is enough.
- **Gear plans:** which enchantments belong on which item, which exclude each other, and the order that costs least (enchant the diamond item first, upgrade it after).
- **Experience:** earn it, spend it wisely, mending. Levels are a budget: the LLM is told what each enchant costs before spending.
- **Table tricks:** blocking bookshelves to lower the level on offer, a cheap enchant to change the offers.
- **Anvil cost creep:** every anvil use makes the next one dearer, so books are combined in the cheapest order.
- **Driven by:** the 42 enchantment definitions in the export; the mechanics book for table and anvil rules.
- **Server check:** `enchanted_item`, `enchant_item`, item components by RCON.

### 18. Brewing
- **Brewing stand:** blaze powder fuel, water bottles, nether wart base, effect ingredient, redstone or glowstone, gunpowder for splash, dragon breath for lingering.
- **All 46 potion kinds,** and which ingredient makes which.
- **Driven by:** the mechanics book (brewing is not in the recipe data).
- **Server check:** `brewed_potion`, potion contents in the inventory by RCON.

### 19. Redstone and mechanisms
- **Use what exists:** levers, buttons, pressure plates, doors, pistons, rails.
- **Build from a design:** piston doors, hidden entrances, item sorters with hoppers, automatic smelters, crafters, farms with observers and pistons, powered rail lines, TNT devices, sculk-sensor triggers, lamps and copper bulbs.
- **Test what was built** by operating it and reading the block states.
- **Who does what:** the LLM chooses a design from the library and says where and how big. Code places and tests it. A build that fails its test returns to the LLM with what was observed.
- **Common machines the library should hold first:** item sorter, automatic smelter, villager breeder, trading hall, crop and bone-meal farms, a mob drop tower.
- **Server check:** block state reads before and after operating the device.

### 20. Exploring and finding
- **The 34 structure kinds,** what each looks like from outside, what it holds (56 chest loot tables) and what guards it: villages, strongholds, fortresses, bastions, end cities, ancient cities, monuments, mansions, trial chambers, temples, shipwrecks, ruined portals, mineshafts, outposts, igloos, swamp huts, trail ruins, buried treasure.
- **Biomes** and what each offers.
- **Know the inside of each structure:** its variants (a bastion has four), how to tell them apart, where the chests and hidden blocks are in each, which mobs guard it and whether they come back once killed.
- **Where things generate:** the height band for each ore, which structures share placement rules, which biome a structure avoids. From the world-generation data.
- **Ways to find things:** eye of ender throws with triangulation, explorer and treasure maps, compass and lodestone, following rivers and coasts, sweeping in the Nether, height and light cues for caves.
- **Remember and name** every place found.
- **Search a maze methodically:** strongholds, fortresses, mineshafts and end cities are searched room by room, with dead ends marked (in memory, and with a block if the owner will follow) and looted chests never opened twice.
- **Chunk arithmetic:** some things sit at fixed spots inside a chunk (the stronghold's stair is one), so the body exposes chunk coordinates.
- **Pick things up along the way:** on any trip the bot may collect what is on a short watch list (exposed ore, a village chest, gunpowder for rockets) within a detour limit the LLM sets.
- **Who does what:** the LLM picks where to look and why; code travels, scans and reports.
- **Server check:** the test server knows where structures are (`locate`), and the bot never sees that answer.

### 21. Storage and logistics
- **Put, take and count** across every container kind; double chests; ender chest; shulker boxes carried as luggage; bundles.
- **Know what is where:** an index of every container opened.
- **Organise:** sort chests by a rule, label with signs or item frames, keep a base stocked.
- **Move bulk:** many trips, shulker boxes, chest boats, hopper lines.
- **Hand over to a player:** walk up, face them, toss, confirm pick-up.
- **Server check:** container contents by RCON before and after.

### 22. Talking and working with players
- **Hear and answer** owners in chat and whispers; ignore instructions from anyone else.
- **Follow, come, stay, wait here, lead the way.**
- **Understand pointing:** the block or entity the owner is looking at.
- **Write:** signs and books, for notes or messages left in the world.
- **Share work:** take one part of a job while the owner does another; don't break what they just placed.
- **Server check:** bot and owner positions over time by RCON.

### 23. Design work
Tasks where the LLM invents the result: buildings and monuments from the real world, houses in a style, pixel art, map art, gardens and landscaping, interiors, banners, firework shows, note-block tunes, written books. Section 32 covers how a large design is carried out.

### 24. Liquids, fire and explosives
- **Water:** carry and place it, make an endless source, drain an area (sponges, sand fill, pumping by bucket), waterlog blocks, make a water lift or a stream that carries items and mobs.
- **Lava:** bucket it, block it off, turn it to obsidian or cobblestone, never mine into it blind.
- **Fire:** light and put out, fire spread near wood, campfire smoke, soul fire.
- **Explosives:** TNT for clearing, with a safe fuse distance; creeper damage repaired afterwards.
- **Mining by explosion:** beds in the Nether or TNT in a tunnel to expose ancient debris, from behind a blast-proof block.
- **Needs speed:** yes whenever lava or a lit fuse is near.
- **Server check:** block reads, `filled_bucket`, `used:<item>` counters, damage and death statistics.

### 25. Shaping the land
- **Flatten, fill, level, terrace.** Dig a pit, a moat, a canal, a mine shaft, a quarry, a staircase down to bedrock level.
- **Clear:** trees, grass, snow, a whole hill, an underwater floor.
- **Repair:** fill creeper holes, put back what was broken, take down scaffolding and temporary blocks afterwards.
- **Spawn-proof:** light an area on a grid so nothing hostile spawns, or slab it over.
- **Defences:** walls, fences, gates, a moat, a safe room.
- **Driven by:** a region and a rule, worked out by code into blocks to break and place.
- **Server check:** region block reads.

### 26. Staying unnoticed
- **Sculk:** sneak, use wool, never set off a shrieker; leave an ancient city alive. A sculk catalyst spreads sculk where mobs die nearby and takes their experience, so killing near one changes the terrain and is something to avoid or, for experience farming, to use on purpose.
- **Endermen:** don't look at them, or wear a carved pumpkin.
- **Piglins:** wear gold; don't mine gold or open chests in view.
- **Others:** invisibility potions, staying out of mob sight range, not waking a sleeping village's golem by hitting a villager.
- **Needs speed:** partly; the warden is a reflex-level threat.
- **Server check:** `avoid_vibration`, no warden spawned, damage statistics.

### 27. Watching, counting and reporting
Tasks where the result is information.
- **Look and tell:** "what is in this chest", "how many sheep are in the pen", "is there iron in this cave", "what is the owner holding".
- **Scout and report:** go somewhere, look, come back or message what was found, with coordinates.
- **Watch and warn:** "tell me if anyone comes near the base", "wake me when the crops are grown", "say when the furnace is done".
- **Recall:** "what did you do today", "where did we leave the horses", from the journal and places memory.
- **Check a build or a machine:** compare what stands there with the design and list the differences.
- **Server check:** the report is compared with a server read of the same thing.

### 28. Waiting and timing
- **Wait for something:** crops, smelting, a trade restock, daylight, rain to stop, a mob to arrive, the owner to return.
- **Stay loaded:** farms, furnaces and growing things only run while a player is near, so "wait here" is sometimes the whole job.
- **Skip time:** sleep through the night; avoid going three days without sleep (phantoms).
- **Do something at a time:** at dawn, every ten minutes, after the next trade.
- **Use the wait:** the LLM may give a filler job that can be dropped at once.
- **Server check:** game time by RCON, block and container states at the moment claimed.

### 29. World rules that shape every plan
These are not skills. They are facts the brief and the mechanics book must carry, because plans go wrong without them.
- **Only loaded chunks run.** Leave, and the furnace stops, the crops stop growing and the mob farm stops.
- **Dropped items vanish after five minutes** in loaded chunks.
- **Hostile mobs spawn in darkness** within a distance band around a player, and despawn when far away.
- **Hunger rules:** no sprinting at low food, no healing below a threshold, starvation by difficulty.
- **A bed sets the spawn point** and explodes outside the Overworld. A respawn anchor is the opposite.
- **Portals link by coordinates** divided by eight in the Nether.
- **Tools wear out**, and the anvil refuses repairs once the cost is too high.
- **Villagers restock twice a day** and only at their job block.
- **Peaceful mobs don't come back** once killed off in an area; hostile ones always do.
- **Where the bot stands is part of every farm.** Mobs spawn and despawn by distance from players, so the standing spot, and anything spawnable around it, changes the yield.
- **Some mechanics change with difficulty:** zombies break doors and villagers always convert only on hard.
- **Servers differ from plain vanilla.** Many run software that fixes duplication glitches or changes spawning. Anything the tricks book or design library relies on is re-checked on the server actually in use.
- **The server's settings matter:** difficulty, view distance, and whether PvP is on. The bot reads what it can and asks the owner for the rest.

### 30. Preparing, provisioning and protecting what it owns
The videos spend more time on this than on any fight. It was missing entirely.
- **A kit for each trip.** Before a cave, the Nether, a stronghold or the End, code lists what the trip needs (food, tools with enough durability, blocks, torches, a fall saver, a shield) against what the bot has. The LLM decides what to add and what to skip.
- **Leave valuables behind.** Anything not needed for the trip goes in a chest first. An ender chest keeps things safe even through death.
- **Scout light.** A first look through a new portal or into a structure with almost nothing to lose.
- **Put the spawn point near the job:** a bed by the portal, a second bed carried for the road.
- **Restock between stages,** not only when something runs out.
- **Plan for bad luck.** Drops and breakage are chances, so the bot gathers a margin (more eyes of ender than the portal needs, more arrows than there are crystals) and the brief shows the expected count, not a guess.
- **Carrying capacity is a constraint.** 36 slots fill fast. A full inventory is a reason to build storage or craft shulker boxes on the spot, not a reason to stop.
- **Fuel and food as budgets:** what burns for how long, which food gives the longest healing before a fight.
- **Don't use things up for good:** leave a breeding pair, replant, keep villagers alive and fenced from zombies.
- **Where to put a base:** near water, wood, a cave and a village when there is a choice.
- **Spend now to save later:** a farm, a nether portal link, an ender chest or a villager with the right trade costs time once and saves it every time after. Code estimates both sides; the LLM chooses.
- **Who decides:** the LLM decides. Code supplies the checklist, the counts and the odds.
- **Server check:** inventory and container reads before and after the trip; items lost on death counted against the plan.

### 31. Techniques
A rule says what the game does. A technique says how to use it. These are the "tricks" players pass around, and the LLM cannot be relied on to know them or to know which still work.
- **Kept in the tricks book,** each entry with: what it achieves, the steps, what it needs, the edition and version it was checked on, and the run that checked it.
- **Offered in the brief when relevant.** Fighting endermen brings up the low-ceiling shelter. Cooking with no fuel brings up the campfire.
- **Examples from the videos, all still to be checked on 1.21.6 Java:**
  - cook on a campfire with no fuel; a mob killed while burning drops cooked meat
  - string under sand or concrete powder keeps it from falling
  - a boat holding a mob can be pulled along on a lead
  - two-by-two spruce saplings grow one giant tree
  - a torch placed on the block under the dragon egg collects it safely
  - glass bottles collect dragon's breath during the fight
  - warped fungus scares hoglins; leather boots walk on powder snow
  - doors hung sideways stop zombies breaking in
  - a magma block under water gives air
  - a diamond pickaxe and armor can come from villager trades with no mining
  - alternating crop rows grow faster
- **Sources are leads, never proof.** Videos, the wiki and the LLM all suggest techniques. Only a pass on our server puts one in the book.
- **Glitches and exploits are a separate class, off by default.** Item duplication machines, chunk loading with a held ender pearl and similar tricks rely on bugs. They are often fixed between versions, blocked by server software, or against a server's rules. Entries of this kind are marked as exploits, and the bot uses one only if the owner has switched that on.
- **Some advice is for humans only** and is ignored: key settings, the debug screen, naming worlds.

---

## 32. Large tasks

"Build an Eiffel tower" is tens of thousands of blocks. No single reply can list them, and no single session will finish it.

- **Designs are written as shapes, not block lists.** The LLM describes the build in sections using a small set of shape words: box, hollow box, line, cylinder, cone, arch, stairs, repeat, mirror, with a material for each. Code turns the shapes into exact blocks. This is data, never code written by the LLM.
- **Designs are layered.** First the overall form and size (four legs, three platforms, a spire, 60 blocks tall). Then each section in detail, only when the build reaches it.
- **Code works out the bill of materials** from the design and the game data, and tells the LLM before anything starts. The owner hears the estimate and can change the size or the material.
- **Gathering is a task of its own,** with a staging chest at the site.
- **Building is done in sections,** each checked block by block, with scaffolding managed by code.
- **Everything is saved:** design, progress per section, where the materials are. The task survives a restart, a death or a week's pause.
- **Height, water and night** are handled by the same safety reflexes as anything else.

The same pattern covers any large job: "collect 20 eyes of ender" is a quantity goal split into pearls and blaze powder, each a sub-goal with its own progress count.

---

## 33. Task shapes

Not every task ends by reaching a state. The loop has to handle each of these shapes.

| Shape | Example | How it ends |
| --- | --- | --- |
| **Reach a state** | "build a snow golem", "get a diamond pickaxe" | the done-condition is true |
| **Reach a quantity** | "collect 20 eyes of ender", "build 3 iron golems" | a counter reaches the number; progress is shown along the way |
| **Until told to stop** | "come with me and fight mobs until I say stop" | the owner says stop. There is no done-condition. The LLM is asked again only on events, and the bot reports a summary at the end |
| **Standing order** | "keep the furnace fuelled" | never, until cancelled; runs between other tasks |
| **When something happens** | "when it gets dark, go home" | the trigger fires, then it becomes one of the shapes above |
| **A sequence** | "get iron armor, then help me build a wall" | each part ends in its own way, in order |
| **A question** | "how do I make a piston?" | an answer built from the game data |
| **Find out and report** | "how many sheep are in the pen?", "scout that cave" | a report is given; the test server checks it against its own read |
| **Watch for something** | "tell me if anyone comes near the base" | the owner cancels it, or the thing happens and the bot reports |
| **Earn an advancement** | "get the 'Hero of the Village' advancement" | the advancement is granted; all 124 real advancements are valid goals |
| **Unclear** | "beat the dragon at the end city" | the bot says what it understood (the dragon is on the main End island) or asks one question |
| **Not possible** | needs commands, creative mode, or something not in 1.21.6 | the bot says so and why, and offers the nearest thing it can do |
| **Not allowed** | attacking an owner, a listed friend or their pets; breaking an owner's builds without a yes | the bot refuses; code enforces it whatever the LLM says |

---

## Cross-check against the game's own lists

On 2026-11-11 this catalogue was compared by hand with five lists from the export, and the gaps found were added (sections 24 to 29, and additions throughout).

| Game list | Entries | What it catches |
| --- | --- | --- |
| Statistics | 76 | every activity the game itself counts: washing armor in a cauldron, ringing a bell, tuning a note block, trading |
| Advancement triggers | 57 | every event the game can detect: summoning a mob, building a beacon, curing a villager, channelling lightning |
| Block kinds | 255 | every block that behaves differently when used, stepped on or placed |
| Window kinds | 25 | every screen with slots |
| Entity types | 151 | every mob, vehicle and placed object |

A hand comparison can still miss things. Roadmap Phase 1 turns it into a script: every entry in these lists must be mapped to a catalogue group or marked "not reachable in survival", and the check fails when one is unmapped. After that, a game update that adds a block or a mob shows up as a failed check, not as a surprise.

---

## Cross-check against how people actually play

On 2026-11-11 three video transcripts were read in full and compared with this catalogue: a 1.21 guide from a new world to elytra, a guide to the commonest deaths and how to avoid them, and a list of sixteen survival tips. A fourth video had no transcript.

What they showed was missing:

| Gap | Now in |
| --- | --- |
| Preparing a kit, leaving valuables behind, scouting light, restocking between stages | section 30 |
| Spawn point placed near the job; a spare bed | section 30 |
| Planning for bad luck: drop rates and breakage | sections 5 and 30 |
| Carrying capacity, fuel and food as budgets | section 30 |
| Not using up animals, crops and villagers | section 30 |
| Techniques as their own kind of knowledge, separate from rules | sections 5 and 31 |
| Edition and version differences in almost every guide | section 5 |
| Using terrain against mobs; shield arc and delay; mobs fighting each other | section 14 |
| Fall savers other than water, and that water fails in the Nether | section 6 |
| Flying an elytra well | section 6 |
| Searching a maze methodically; marking dead ends and looted chests | section 20 |
| Leaving a trail; chunk arithmetic; picking things up along the way | sections 6 and 20 |
| Losing drops to lava and fire; digging blind | section 15 |
| Experience as a budget; enchanting-table and anvil cost tricks | section 17 |

### Second review, four videos the owner chose

A netherite guide, a bastion guide and a sword-fighting guide were read in full. A very long video of 25 farm tutorials (188,000 characters of transcript) was read in outline, with six of its sections in full.

| Gap | Now in |
| --- | --- |
| Farms and machines are exact recipes, not something to invent | section 5 (design library), sections 16 and 19 |
| Building from a schematic file; exact facings, order, temporary blocks, pre-loaded containers | section 8 |
| Surveying a site against a design's conditions | section 16 |
| Operating a machine and measuring what it yields | section 16 |
| Farm or gather by hand; spending now to save later | sections 16 and 30 |
| Where the bot stands changes what spawns | section 29 |
| Getting villagers into cells, locking and re-rolling trades, the cure discount | section 13 |
| Glitches and exploits need a policy | section 31 |
| Who can see the bot; which structure variant this is | section 4 |
| Structure interiors: variants, loot spots, guards | section 20 |
| Raiding from the top down behind walls; distracting piglins | section 14 |
| Melee technique at tick level | section 14 |
| Fighting human players | section 14 |
| Gear plans and the cheapest order of enchanting and upgrading | section 17 |
| Mining by explosion | section 24 |
| Difficulty-dependent rules; servers that differ from vanilla | section 29 |

Two things the videos themselves showed about using guides:
- The netherite guide opens by saying most guides on the subject are outdated, the author's own included.
- The farm video mixes Java-only and both-edition builds, and about a fifth of it is duplication glitches.

Still not reviewed: decorative building, and redstone logic beyond farms.

---

## 34. Honest limits

- **One bot, one body.** Several bots working together is not in this plan.
- **Whispering uses a server command** (`/tell`). It is the only command the bot ever sends.
- **Completeness is by construction, not by proof.** The action layer covers every input a survival player has. That means any task can be attempted, not that it will be done well.
- **Mineflayer is the ceiling.** Nine window kinds have no dedicated call, and window buttons and swap-hands have none either. Each is checked live in the phase that needs it. If something cannot be done through Mineflayer, it is listed in STATUS.md with the reason.
- **Timing-heavy play is the hardest part.** Elytra flight, the dragon fight, the warden and precise jumps depend on skill code quality, and none of it exists yet.
- **The mechanics book is a real piece of work.** It is hand-checked knowledge, entry by entry.
- **Big designs depend on the LLM's sense of shape.** An Eiffel tower will look like one only as far as the design language and the model allow. The owner sees the plan before the first block is placed.

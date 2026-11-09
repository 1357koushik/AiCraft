# Late-game modules: not connected, not verified

Nothing in the running agent (`src/main.ts` → `agent/loop.ts` → `actions/registry.ts`) imports this folder. Only unit tests with mocked bots touch it, so none of it has been shown to work in the game.

Known problems, from the 2026-11-09 audit. Each one is scheduled for rewrite in ROADMAP.md Phases 7-8:

**Report success without checking the world**
- `nether/portal_builder.ts` counts failed placements as placed.
- `nether/portal_bunker.ts`
- `the_end/dragon_combat_controller.ts`
- `the_end/end_crystal_destroyer.ts`
- `nether/wither_skeleton_tactics.ts`, which lives under `actions/combat/`.

**Already fixed to check the result**
- `stronghold/portal_activator.ts`: requires `end_portal` blocks to be present.
- `the_end/exit_portal_navigator.ts`: requires an actual dimension change.

**Other**
- `the_end/dragon_combat_controller.ts` writes `bot.entity.yaw` directly and guesses when the dragon is perched.
- `stronghold/triangulation.ts` has correct maths, but its inputs use vanilla yaw in degrees, while Mineflayer's yaw is radians in a different convention. No code throws or tracks an eye of ender yet.

Do not register any of these as actions until each has a live, server-judged test (`npm run task`).

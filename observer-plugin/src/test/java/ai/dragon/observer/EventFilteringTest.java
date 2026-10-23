package ai.dragon.observer;

import ai.dragon.observer.bridge.ActionContext;
import ai.dragon.observer.model.ObserverEvent;
import org.junit.jupiter.api.Test;

import java.util.HashMap;

import static org.junit.jupiter.api.Assertions.*;

public class EventFilteringTest {

    @Test
    public void testActionContextInheritance() {
        ActionContext context = new ActionContext();
        assertNull(context.get());

        // Bind an action
        context.bind("run_prod_01", "goal_craft_pickaxe", "act_craft_planks_01", "craft_item");
        assertNotNull(context.get());
        assertEquals("act_craft_planks_01", context.get().actionId);

        // Create event with context
        ObserverEvent event = new ObserverEvent(
                1L,
                "run_prod_01",
                "overworld",
                "u1",
                "dragonai",
                "CRAFT_ITEM",
                null,
                null,
                "oak_planks",
                4,
                null,
                context.get(),
                new HashMap<>()
        );

        assertNotNull(event.activeContext);
        assertEquals("act_craft_planks_01", event.activeContext.actionId);
        assertEquals("craft_item", event.activeContext.actionName);
        assertEquals("goal_craft_pickaxe", event.activeContext.goalId);

        // Clear action
        context.clear();
        assertNull(context.get());

        // Second event has no active context
        ObserverEvent idleEvent = new ObserverEvent(
                2L,
                "run_prod_01",
                "overworld",
                "u1",
                "dragonai",
                "PERIODIC_SNAPSHOT",
                null,
                null,
                null,
                null,
                null,
                context.get(),
                new HashMap<>()
        );

        assertNull(idleEvent.activeContext);
    }
}

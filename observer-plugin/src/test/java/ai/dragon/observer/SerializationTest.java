package ai.dragon.observer;

import ai.dragon.observer.model.ObserverEvent;
import ai.dragon.observer.model.PlayerSnapshot;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

public class SerializationTest {

    private final Gson gson = new Gson();

    @Test
    public void testObserverEventSerialization() {
        Map<String, Object> details = new HashMap<>();
        details.put("customKey", "customValue");
        details.put("numericVal", 42);

        ObserverEvent.Coordinates coords = new ObserverEvent.Coordinates(100.1234, 64.9876, -200.555);
        ObserverEvent.CancellationInfo cancel = new ObserverEvent.CancellationInfo(false, null);
        ObserverEvent.ActiveActionContext ctx = new ObserverEvent.ActiveActionContext("run_1", "goal_have_logs", "act_chop_1", "chop_tree");

        ObserverEvent event = new ObserverEvent(
                105L,
                "server_run_test",
                "minecraft:overworld",
                "42b70a38-e493-319b-94e3-4d4c6fee493e",
                "dragonai",
                "BLOCK_BREAK",
                coords,
                "oak_log",
                null,
                1,
                cancel,
                ctx,
                details
        );

        String json = gson.toJson(event);
        assertNotNull(json);

        JsonObject obj = JsonParser.parseString(json).getAsJsonObject();
        assertEquals(105L, obj.get("seq").getAsLong());
        assertEquals("server_run_test", obj.get("serverRunId").getAsString());
        assertEquals("minecraft:overworld", obj.get("dimension").getAsString());
        assertEquals("dragonai", obj.get("playerName").getAsString());
        assertEquals("BLOCK_BREAK", obj.get("eventType").getAsString());
        assertEquals("oak_log", obj.get("blockId").getAsString());

        // Check rounded coordinates
        JsonObject c = obj.get("coordinates").getAsJsonObject();
        assertEquals(100.12, c.get("x").getAsDouble(), 0.01);
        assertEquals(64.99, c.get("y").getAsDouble(), 0.01);
        assertEquals(-200.56, c.get("z").getAsDouble(), 0.01);

        // Check active context
        JsonObject actCtx = obj.get("activeContext").getAsJsonObject();
        assertEquals("act_chop_1", actCtx.get("actionId").getAsString());
        assertEquals("chop_tree", actCtx.get("actionName").getAsString());
    }

    @Test
    public void testPlayerSnapshotSerialization() {
        Map<String, String> armor = new HashMap<>();
        armor.put("head", "iron_helmet");
        armor.put("torso", "iron_chestplate");

        Map<String, Integer> inv = new HashMap<>();
        inv.put("oak_log", 16);
        inv.put("bread", 5);

        PlayerSnapshot snapshot = new PlayerSnapshot(
                18.5,
                20.0,
                16,
                5.0f,
                300,
                true,
                "SURVIVAL",
                "minecraft:overworld",
                new ObserverEvent.Coordinates(10.0, 65.0, 20.0),
                90.0f,
                0.0f,
                3,
                45,
                "iron_pickaxe",
                "shield",
                armor,
                inv,
                true
        );

        String json = gson.toJson(snapshot);
        JsonObject obj = JsonParser.parseString(json).getAsJsonObject();

        assertEquals(18.5, obj.get("health").getAsDouble(), 0.01);
        assertEquals(16, obj.get("food").getAsInt());
        assertEquals("iron_pickaxe", obj.get("heldItem").getAsString());
        assertEquals("shield", obj.get("offHand").getAsString());
        assertTrue(obj.get("chunkLoaded").getAsBoolean());
        assertEquals(16, obj.get("inventory").getAsJsonObject().get("oak_log").getAsInt());
    }
}

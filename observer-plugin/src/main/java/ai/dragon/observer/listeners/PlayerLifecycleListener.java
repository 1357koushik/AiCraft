package ai.dragon.observer.listeners;

import ai.dragon.observer.bridge.ActionContext;
import ai.dragon.observer.logging.RotatingJsonlWriter;
import ai.dragon.observer.model.ObserverEvent;
import ai.dragon.observer.model.PlayerSnapshot;
import org.bukkit.Location;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerChangedWorldEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerRespawnEvent;

import java.util.HashMap;
import java.util.Map;

/**
 * Observes player join, quit, respawn, and dimension changes without modifying player state.
 */
public class PlayerLifecycleListener implements Listener {

    private final String serverRunId;
    private final ActionContext actionContext;
    private final RotatingJsonlWriter writer;

    public PlayerLifecycleListener(String serverRunId, ActionContext actionContext, RotatingJsonlWriter writer) {
        this.serverRunId = serverRunId;
        this.actionContext = actionContext;
        this.writer = writer;
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPlayerJoin(PlayerJoinEvent event) {
        Player player = event.getPlayer();
        Location loc = player.getLocation();

        Map<String, Object> details = new HashMap<>();
        details.put("joinMessage", event.getJoinMessage());
        details.put("initialSnapshot", PlayerSnapshot.fromPlayer(player));

        ObserverEvent obsEvent = new ObserverEvent(
                writer.nextSequence(),
                serverRunId,
                player.getWorld().getName(),
                player.getUniqueId().toString(),
                player.getName(),
                "PLAYER_JOIN",
                new ObserverEvent.Coordinates(loc.getX(), loc.getY(), loc.getZ()),
                null,
                null,
                null,
                null,
                actionContext.get(),
                details
        );
        writer.enqueue(obsEvent);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPlayerQuit(PlayerQuitEvent event) {
        Player player = event.getPlayer();
        Location loc = player.getLocation();

        Map<String, Object> details = new HashMap<>();
        details.put("quitMessage", event.getQuitMessage());
        details.put("finalSnapshot", PlayerSnapshot.fromPlayer(player));

        ObserverEvent obsEvent = new ObserverEvent(
                writer.nextSequence(),
                serverRunId,
                player.getWorld().getName(),
                player.getUniqueId().toString(),
                player.getName(),
                "PLAYER_QUIT",
                new ObserverEvent.Coordinates(loc.getX(), loc.getY(), loc.getZ()),
                null,
                null,
                null,
                null,
                actionContext.get(),
                details
        );
        writer.enqueue(obsEvent);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPlayerRespawn(PlayerRespawnEvent event) {
        Player player = event.getPlayer();
        Location loc = event.getRespawnLocation();

        Map<String, Object> details = new HashMap<>();
        details.put("isBedSpawn", event.isBedSpawn());
        details.put("isAnchorSpawn", event.isAnchorSpawn());

        ObserverEvent obsEvent = new ObserverEvent(
                writer.nextSequence(),
                serverRunId,
                loc.getWorld() != null ? loc.getWorld().getName() : "unknown",
                player.getUniqueId().toString(),
                player.getName(),
                "PLAYER_RESPAWN",
                new ObserverEvent.Coordinates(loc.getX(), loc.getY(), loc.getZ()),
                null,
                null,
                null,
                null,
                actionContext.get(),
                details
        );
        writer.enqueue(obsEvent);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onWorldChange(PlayerChangedWorldEvent event) {
        Player player = event.getPlayer();
        Location loc = player.getLocation();

        Map<String, Object> details = new HashMap<>();
        details.put("fromWorld", event.getFrom().getName());
        details.put("toWorld", player.getWorld().getName());

        ObserverEvent obsEvent = new ObserverEvent(
                writer.nextSequence(),
                serverRunId,
                player.getWorld().getName(),
                player.getUniqueId().toString(),
                player.getName(),
                "DIMENSION_CHANGE",
                new ObserverEvent.Coordinates(loc.getX(), loc.getY(), loc.getZ()),
                null,
                null,
                null,
                null,
                actionContext.get(),
                details
        );
        writer.enqueue(obsEvent);
    }
}

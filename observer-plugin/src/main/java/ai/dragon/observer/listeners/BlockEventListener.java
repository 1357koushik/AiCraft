package ai.dragon.observer.listeners;

import ai.dragon.observer.bridge.ActionContext;
import ai.dragon.observer.logging.RotatingJsonlWriter;
import ai.dragon.observer.model.ObserverEvent;
import org.bukkit.Location;
import org.bukkit.block.Block;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.Action;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.inventory.ItemStack;

import java.util.HashMap;
import java.util.Map;

/**
 * Observes block break, place, and interaction outcomes strictly read-only at MONITOR priority.
 */
public class BlockEventListener implements Listener {

    private final String serverRunId;
    private final ActionContext actionContext;
    private final RotatingJsonlWriter writer;

    public BlockEventListener(String serverRunId, ActionContext actionContext, RotatingJsonlWriter writer) {
        this.serverRunId = serverRunId;
        this.actionContext = actionContext;
        this.writer = writer;
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onBlockBreak(BlockBreakEvent event) {
        Player player = event.getPlayer();
        Block block = event.getBlock();
        Location loc = block.getLocation();

        Map<String, Object> details = new HashMap<>();
        ItemStack tool = player.getInventory().getItemInMainHand();
        details.put("toolInHand", (tool != null && !tool.getType().isAir()) ? tool.getType().name().toLowerCase() : null);
        details.put("expToDrop", event.getExpToDrop());
        details.put("isDropItems", event.isDropItems());

        ObserverEvent.CancellationInfo cancelInfo = new ObserverEvent.CancellationInfo(
                event.isCancelled(),
                event.isCancelled() ? "Cancelled by server or protection handler" : null
        );

        ObserverEvent obsEvent = new ObserverEvent(
                writer.nextSequence(),
                serverRunId,
                block.getWorld().getName(),
                player.getUniqueId().toString(),
                player.getName(),
                "BLOCK_BREAK",
                new ObserverEvent.Coordinates(loc.getX(), loc.getY(), loc.getZ()),
                block.getType().name().toLowerCase(),
                null,
                1,
                cancelInfo,
                actionContext.get(),
                details
        );
        writer.enqueue(obsEvent);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onBlockPlace(BlockPlaceEvent event) {
        Player player = event.getPlayer();
        Block placed = event.getBlockPlaced();
        Block against = event.getBlockAgainst();
        Location loc = placed.getLocation();

        Map<String, Object> details = new HashMap<>();
        details.put("placedAgainst", against.getType().name().toLowerCase());
        details.put("hand", event.getHand() != null ? event.getHand().name() : "HAND");
        details.put("canBuild", event.canBuild());

        ObserverEvent.CancellationInfo cancelInfo = new ObserverEvent.CancellationInfo(
                event.isCancelled(),
                event.isCancelled() ? "Cancelled by server or protection handler" : null
        );

        ObserverEvent obsEvent = new ObserverEvent(
                writer.nextSequence(),
                serverRunId,
                placed.getWorld().getName(),
                player.getUniqueId().toString(),
                player.getName(),
                "BLOCK_PLACE",
                new ObserverEvent.Coordinates(loc.getX(), loc.getY(), loc.getZ()),
                placed.getType().name().toLowerCase(),
                event.getItemInHand().getType().name().toLowerCase(),
                1,
                cancelInfo,
                actionContext.get(),
                details
        );
        writer.enqueue(obsEvent);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPlayerInteract(PlayerInteractEvent event) {
        // Only observe block interactions (right-click or physical press)
        if (event.getAction() != Action.RIGHT_CLICK_BLOCK && event.getAction() != Action.PHYSICAL) {
            return;
        }

        Block clicked = event.getClickedBlock();
        if (clicked == null) return;

        Player player = event.getPlayer();
        Location loc = clicked.getLocation();

        Map<String, Object> details = new HashMap<>();
        details.put("action", event.getAction().name());
        details.put("blockFace", event.getBlockFace() != null ? event.getBlockFace().name() : null);
        details.put("useInteractedBlock", event.useInteractedBlock().name());
        details.put("useItemInHand", event.useItemInHand().name());

        ObserverEvent.CancellationInfo cancelInfo = new ObserverEvent.CancellationInfo(
                event.isCancelled(),
                event.isCancelled() ? "Cancelled by server" : null
        );

        ObserverEvent obsEvent = new ObserverEvent(
                writer.nextSequence(),
                serverRunId,
                clicked.getWorld().getName(),
                player.getUniqueId().toString(),
                player.getName(),
                "BLOCK_INTERACT",
                new ObserverEvent.Coordinates(loc.getX(), loc.getY(), loc.getZ()),
                clicked.getType().name().toLowerCase(),
                null,
                null,
                cancelInfo,
                actionContext.get(),
                details
        );
        writer.enqueue(obsEvent);
    }
}

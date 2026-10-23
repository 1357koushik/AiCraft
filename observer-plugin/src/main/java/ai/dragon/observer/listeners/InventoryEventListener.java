package ai.dragon.observer.listeners;

import ai.dragon.observer.bridge.ActionContext;
import ai.dragon.observer.logging.RotatingJsonlWriter;
import ai.dragon.observer.model.ObserverEvent;
import org.bukkit.Location;
import org.bukkit.block.Block;
import org.bukkit.entity.Item;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityPickupItemEvent;
import org.bukkit.event.inventory.*;
import org.bukkit.event.player.PlayerDropItemEvent;
import org.bukkit.event.player.PlayerItemConsumeEvent;
import org.bukkit.inventory.ItemStack;

import java.util.HashMap;
import java.util.Map;

/**
 * Observes item pickup, drop, consume, craft, and furnace events.
 */
public class InventoryEventListener implements Listener {

    private final String serverRunId;
    private final ActionContext actionContext;
    private final RotatingJsonlWriter writer;

    public InventoryEventListener(String serverRunId, ActionContext actionContext, RotatingJsonlWriter writer) {
        this.serverRunId = serverRunId;
        this.actionContext = actionContext;
        this.writer = writer;
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPickup(EntityPickupItemEvent event) {
        if (!(event.getEntity() instanceof Player player)) return;

        Item itemEntity = event.getItem();
        ItemStack stack = itemEntity.getItemStack();
        Location loc = player.getLocation();

        Map<String, Object> details = new HashMap<>();
        details.put("remainingOnGround", event.getRemaining());

        ObserverEvent.CancellationInfo cancelInfo = new ObserverEvent.CancellationInfo(
                event.isCancelled(),
                event.isCancelled() ? "Pickup cancelled" : null
        );

        ObserverEvent obsEvent = new ObserverEvent(
                writer.nextSequence(),
                serverRunId,
                player.getWorld().getName(),
                player.getUniqueId().toString(),
                player.getName(),
                "ITEM_PICKUP",
                new ObserverEvent.Coordinates(loc.getX(), loc.getY(), loc.getZ()),
                null,
                stack.getType().name().toLowerCase(),
                stack.getAmount(),
                cancelInfo,
                actionContext.get(),
                details
        );
        writer.enqueue(obsEvent);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onDrop(PlayerDropItemEvent event) {
        Player player = event.getPlayer();
        Item itemDrop = event.getItemDrop();
        ItemStack stack = itemDrop.getItemStack();
        Location loc = player.getLocation();

        ObserverEvent.CancellationInfo cancelInfo = new ObserverEvent.CancellationInfo(
                event.isCancelled(),
                event.isCancelled() ? "Drop cancelled" : null
        );

        ObserverEvent obsEvent = new ObserverEvent(
                writer.nextSequence(),
                serverRunId,
                player.getWorld().getName(),
                player.getUniqueId().toString(),
                player.getName(),
                "ITEM_DROP",
                new ObserverEvent.Coordinates(loc.getX(), loc.getY(), loc.getZ()),
                null,
                stack.getType().name().toLowerCase(),
                stack.getAmount(),
                cancelInfo,
                actionContext.get(),
                new HashMap<>()
        );
        writer.enqueue(obsEvent);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onConsume(PlayerItemConsumeEvent event) {
        Player player = event.getPlayer();
        ItemStack item = event.getItem();
        Location loc = player.getLocation();

        Map<String, Object> details = new HashMap<>();
        details.put("foodLevelBefore", player.getFoodLevel());
        details.put("healthBefore", player.getHealth());

        ObserverEvent.CancellationInfo cancelInfo = new ObserverEvent.CancellationInfo(
                event.isCancelled(),
                event.isCancelled() ? "Consume cancelled" : null
        );

        ObserverEvent obsEvent = new ObserverEvent(
                writer.nextSequence(),
                serverRunId,
                player.getWorld().getName(),
                player.getUniqueId().toString(),
                player.getName(),
                "ITEM_CONSUME",
                new ObserverEvent.Coordinates(loc.getX(), loc.getY(), loc.getZ()),
                null,
                item.getType().name().toLowerCase(),
                1,
                cancelInfo,
                actionContext.get(),
                details
        );
        writer.enqueue(obsEvent);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onCraft(CraftItemEvent event) {
        if (!(event.getWhoClicked() instanceof Player player)) return;

        ItemStack result = event.getRecipe() != null ? event.getRecipe().getResult() : null;
        if (result == null || result.getType().isAir()) return;

        Location loc = player.getLocation();
        Map<String, Object> details = new HashMap<>();
        details.put("clickType", event.getClick().name());
        details.put("slotType", event.getSlotType().name());

        ObserverEvent.CancellationInfo cancelInfo = new ObserverEvent.CancellationInfo(
                event.isCancelled(),
                event.isCancelled() ? "Crafting cancelled" : null
        );

        ObserverEvent obsEvent = new ObserverEvent(
                writer.nextSequence(),
                serverRunId,
                player.getWorld().getName(),
                player.getUniqueId().toString(),
                player.getName(),
                "CRAFT_ITEM",
                new ObserverEvent.Coordinates(loc.getX(), loc.getY(), loc.getZ()),
                null,
                result.getType().name().toLowerCase(),
                result.getAmount(),
                cancelInfo,
                actionContext.get(),
                details
        );
        writer.enqueue(obsEvent);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onFurnaceStart(FurnaceStartSmeltEvent event) {
        Block block = event.getBlock();
        Location loc = block.getLocation();

        Map<String, Object> details = new HashMap<>();
        details.put("totalCookTime", event.getTotalCookTime());
        details.put("sourceItem", event.getSource().getType().name().toLowerCase());

        ObserverEvent obsEvent = new ObserverEvent(
                writer.nextSequence(),
                serverRunId,
                block.getWorld().getName(),
                null,
                null,
                "FURNACE_START",
                new ObserverEvent.Coordinates(loc.getX(), loc.getY(), loc.getZ()),
                block.getType().name().toLowerCase(),
                event.getSource().getType().name().toLowerCase(),
                event.getSource().getAmount(),
                null,
                actionContext.get(),
                details
        );
        writer.enqueue(obsEvent);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onFurnaceSmelt(FurnaceSmeltEvent event) {
        Block block = event.getBlock();
        Location loc = block.getLocation();
        ItemStack result = event.getResult();

        Map<String, Object> details = new HashMap<>();
        details.put("sourceItem", event.getSource().getType().name().toLowerCase());

        ObserverEvent.CancellationInfo cancelInfo = new ObserverEvent.CancellationInfo(
                event.isCancelled(),
                event.isCancelled() ? "Smelting cancelled" : null
        );

        ObserverEvent obsEvent = new ObserverEvent(
                writer.nextSequence(),
                serverRunId,
                block.getWorld().getName(),
                null,
                null,
                "FURNACE_SMELT",
                new ObserverEvent.Coordinates(loc.getX(), loc.getY(), loc.getZ()),
                block.getType().name().toLowerCase(),
                result.getType().name().toLowerCase(),
                result.getAmount(),
                cancelInfo,
                actionContext.get(),
                details
        );
        writer.enqueue(obsEvent);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onFurnaceExtract(FurnaceExtractEvent event) {
        Player player = event.getPlayer();
        Block block = event.getBlock();
        Location loc = block.getLocation();

        Map<String, Object> details = new HashMap<>();
        details.put("expEarned", event.getExpToDrop());

        ObserverEvent obsEvent = new ObserverEvent(
                writer.nextSequence(),
                serverRunId,
                block.getWorld().getName(),
                player.getUniqueId().toString(),
                player.getName(),
                "FURNACE_EXTRACT",
                new ObserverEvent.Coordinates(loc.getX(), loc.getY(), loc.getZ()),
                block.getType().name().toLowerCase(),
                event.getItemType().name().toLowerCase(),
                event.getItemAmount(),
                null,
                actionContext.get(),
                details
        );
        writer.enqueue(obsEvent);
    }
}

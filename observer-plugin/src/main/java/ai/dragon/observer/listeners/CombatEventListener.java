package ai.dragon.observer.listeners;

import ai.dragon.observer.bridge.ActionContext;
import ai.dragon.observer.logging.RotatingJsonlWriter;
import ai.dragon.observer.model.ObserverEvent;
import org.bukkit.Location;
import org.bukkit.entity.Entity;
import org.bukkit.entity.LivingEntity;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.EntityDeathEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.inventory.ItemStack;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Observes entity damage, death, hostile encounters, and player death without altering combat mechanics.
 */
public class CombatEventListener implements Listener {

    private final String serverRunId;
    private final ActionContext actionContext;
    private final RotatingJsonlWriter writer;

    public CombatEventListener(String serverRunId, ActionContext actionContext, RotatingJsonlWriter writer) {
        this.serverRunId = serverRunId;
        this.actionContext = actionContext;
        this.writer = writer;
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onEntityDamage(EntityDamageEvent event) {
        Entity victim = event.getEntity();
        Location loc = victim.getLocation();

        // Only log damage if victim is a player or victim was damaged by a player
        boolean isPlayerVictim = victim instanceof Player;
        boolean isDamagedByPlayer = false;
        String damagerName = null;
        String damagerType = null;

        if (event instanceof EntityDamageByEntityEvent byEntity) {
            Entity damager = byEntity.getDamager();
            damagerName = damager.getName();
            damagerType = damager.getType().name().toLowerCase();
            isDamagedByPlayer = damager instanceof Player;
        }

        if (!isPlayerVictim && !isDamagedByPlayer) {
            // Keep hot mob-vs-mob damage events out of log to conserve CPU and disk
            return;
        }

        Map<String, Object> details = new HashMap<>();
        details.put("damageCause", event.getCause().name());
        details.put("damageAmount", Math.round(event.getFinalDamage() * 100.0) / 100.0);
        details.put("rawDamage", Math.round(event.getDamage() * 100.0) / 100.0);
        details.put("victimType", victim.getType().name().toLowerCase());
        details.put("victimName", victim.getName());

        if (victim instanceof LivingEntity le) {
            details.put("healthRemaining", Math.max(0.0, Math.round((le.getHealth() - event.getFinalDamage()) * 100.0) / 100.0));
        }
        if (damagerName != null) {
            details.put("damagerName", damagerName);
            details.put("damagerType", damagerType);
        }

        ObserverEvent.CancellationInfo cancelInfo = new ObserverEvent.CancellationInfo(
                event.isCancelled(),
                event.isCancelled() ? "Damage cancelled" : null
        );

        String playerUuid = isPlayerVictim ? victim.getUniqueId().toString() : null;
        String playerName = isPlayerVictim ? victim.getName() : null;

        ObserverEvent obsEvent = new ObserverEvent(
                writer.nextSequence(),
                serverRunId,
                victim.getWorld().getName(),
                playerUuid,
                playerName,
                "ENTITY_DAMAGE",
                new ObserverEvent.Coordinates(loc.getX(), loc.getY(), loc.getZ()),
                null,
                null,
                null,
                cancelInfo,
                actionContext.get(),
                details
        );
        writer.enqueue(obsEvent);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onEntityDeath(EntityDeathEvent event) {
        LivingEntity entity = event.getEntity();
        if (entity instanceof Player) {
            // Player death handled specifically in onPlayerDeath
            return;
        }

        Player killer = entity.getKiller();
        if (killer == null) {
            // Only observe entities killed by players
            return;
        }

        Location loc = entity.getLocation();
        Map<String, Object> details = new HashMap<>();
        details.put("entityType", entity.getType().name().toLowerCase());
        details.put("droppedExp", event.getDroppedExp());

        List<String> drops = new ArrayList<>();
        for (ItemStack drop : event.getDrops()) {
            if (drop != null && !drop.getType().isAir()) {
                drops.add(drop.getType().name().toLowerCase() + " x" + drop.getAmount());
            }
        }
        details.put("drops", drops);

        ObserverEvent obsEvent = new ObserverEvent(
                writer.nextSequence(),
                serverRunId,
                entity.getWorld().getName(),
                killer.getUniqueId().toString(),
                killer.getName(),
                "ENTITY_DEATH",
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
    public void onPlayerDeath(PlayerDeathEvent event) {
        Player player = event.getEntity();
        Location loc = player.getLocation();

        Map<String, Object> details = new HashMap<>();
        details.put("deathMessage", event.getDeathMessage());
        details.put("droppedExp", event.getDroppedExp());
        details.put("killer", player.getKiller() != null ? player.getKiller().getName() : null);

        List<String> drops = new ArrayList<>();
        for (ItemStack drop : event.getDrops()) {
            if (drop != null && !drop.getType().isAir()) {
                drops.add(drop.getType().name().toLowerCase() + " x" + drop.getAmount());
            }
        }
        details.put("droppedItems", drops);

        ObserverEvent obsEvent = new ObserverEvent(
                writer.nextSequence(),
                serverRunId,
                player.getWorld().getName(),
                player.getUniqueId().toString(),
                player.getName(),
                "PLAYER_DEATH",
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

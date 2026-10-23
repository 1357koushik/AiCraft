package ai.dragon.observer.listeners;

import ai.dragon.observer.bridge.ActionContext;
import ai.dragon.observer.logging.RotatingJsonlWriter;
import ai.dragon.observer.model.ObserverEvent;
import ai.dragon.observer.model.PlayerSnapshot;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.entity.Player;
import org.bukkit.scheduler.BukkitRunnable;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Periodically observes block-coordinate position shifts and records bounded health/vitals/inventory snapshots.
 */
public class PeriodicSnapshotTask extends BukkitRunnable {

    private final String serverRunId;
    private final ActionContext actionContext;
    private final RotatingJsonlWriter writer;
    private final int snapshotIntervalTicks;

    private final Map<UUID, BlockPos> lastBlockPositions = new HashMap<>();
    private long tickCounter = 0;

    private record BlockPos(int x, int y, int z, String world) {}

    public PeriodicSnapshotTask(String serverRunId, ActionContext actionContext, RotatingJsonlWriter writer, int snapshotIntervalTicks) {
        this.serverRunId = serverRunId;
        this.actionContext = actionContext;
        this.writer = writer;
        this.snapshotIntervalTicks = Math.max(5, snapshotIntervalTicks);
    }

    @Override
    public void run() {
        tickCounter++;
        boolean isSnapshotTick = (tickCounter % snapshotIntervalTicks) == 0;

        for (Player player : Bukkit.getOnlinePlayers()) {
            Location loc = player.getLocation();
            UUID uuid = player.getUniqueId();
            int bx = loc.getBlockX();
            int by = loc.getBlockY();
            int bz = loc.getBlockZ();
            String world = player.getWorld().getName();

            BlockPos currentPos = new BlockPos(bx, by, bz, world);
            BlockPos lastPos = lastBlockPositions.get(uuid);

            // 1. Observe position changes at block-coordinate boundary
            if (lastPos == null || !lastPos.equals(currentPos)) {
                lastBlockPositions.put(uuid, currentPos);

                Map<String, Object> details = new HashMap<>();
                if (lastPos != null) {
                    details.put("from", new ObserverEvent.Coordinates(lastPos.x, lastPos.y, lastPos.z));
                }
                details.put("to", new ObserverEvent.Coordinates(bx, by, bz));
                details.put("chunkX", bx >> 4);
                details.put("chunkZ", bz >> 4);
                details.put("chunkLoaded", player.getWorld().isChunkLoaded(bx >> 4, bz >> 4));

                ObserverEvent posEvent = new ObserverEvent(
                        writer.nextSequence(),
                        serverRunId,
                        world,
                        uuid.toString(),
                        player.getName(),
                        "POSITION_CHANGE",
                        new ObserverEvent.Coordinates(loc.getX(), loc.getY(), loc.getZ()),
                        null,
                        null,
                        null,
                        null,
                        actionContext.get(),
                        details
                );
                writer.enqueue(posEvent);
            }

            // 2. Periodic bounded snapshot
            if (isSnapshotTick) {
                PlayerSnapshot snapshot = PlayerSnapshot.fromPlayer(player);
                Map<String, Object> details = new HashMap<>();
                details.put("snapshot", snapshot);

                ObserverEvent snapEvent = new ObserverEvent(
                        writer.nextSequence(),
                        serverRunId,
                        world,
                        uuid.toString(),
                        player.getName(),
                        "PERIODIC_SNAPSHOT",
                        new ObserverEvent.Coordinates(loc.getX(), loc.getY(), loc.getZ()),
                        null,
                        null,
                        null,
                        null,
                        actionContext.get(),
                        details
                );
                writer.enqueue(snapEvent);
            }
        }
    }
}

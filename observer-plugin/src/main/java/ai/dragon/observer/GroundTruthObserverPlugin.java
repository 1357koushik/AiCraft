package ai.dragon.observer;

import ai.dragon.observer.bridge.ActionContext;
import ai.dragon.observer.bridge.BridgeServer;
import ai.dragon.observer.listeners.*;
import ai.dragon.observer.logging.RotatingJsonlWriter;
import ai.dragon.observer.model.ObserverEvent;
import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.plugin.PluginManager;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.File;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

/**
 * Main Paper plugin entry point for GroundTruthObserver.
 * Operates strictly read-only: does not modify world blocks, players, or gameplay events.
 */
public class GroundTruthObserverPlugin extends JavaPlugin {

    private String serverRunId;
    private RotatingJsonlWriter writer;
    private ActionContext actionContext;
    private BridgeServer bridgeServer;
    private PeriodicSnapshotTask snapshotTask;

    @Override
    public void onEnable() {
        long startTime = System.currentTimeMillis();
        saveDefaultConfig();
        FileConfiguration config = getConfig();

        serverRunId = config.getString("observer.run-id", "run_" + System.currentTimeMillis());
        String logDirPath = config.getString("observer.log-dir", "../logs/integration");
        long maxSizeBytes = config.getLong("observer.max-log-size-mb", 50) * 1024 * 1024;
        int maxFiles = config.getInt("observer.max-log-files", 5);
        int snapshotTicks = config.getInt("observer.snapshot-interval-ticks", 20);

        File logDir = new File(getDataFolder(), logDirPath);
        try {
            logDir = logDir.getCanonicalFile();
        } catch (IOException ignored) {
            logDir = logDir.getAbsoluteFile();
        }

        getLogger().info("============================================================");
        getLogger().info("   GroundTruthObserver Plugin v1.0.0 Initializing           ");
        getLogger().info("============================================================");
        getLogger().info("[Observer] Server Run ID: " + serverRunId);
        getLogger().info("[Observer] Output directory: " + logDir.getAbsolutePath());

        // 1. Initialize Log Writer
        writer = new RotatingJsonlWriter(logDir, serverRunId, maxSizeBytes, maxFiles, getLogger());
        try {
            writer.start();
        } catch (IOException e) {
            getLogger().severe("[Observer] CRITICAL: Failed to initialize RotatingJsonlWriter: " + e.getMessage());
            getServer().getPluginManager().disablePlugin(this);
            return;
        }

        // 2. Initialize Action Context
        actionContext = new ActionContext();

        // 3. Register Event Listeners
        PluginManager pm = getServer().getPluginManager();
        pm.registerEvents(new PlayerLifecycleListener(serverRunId, actionContext, writer), this);
        pm.registerEvents(new BlockEventListener(serverRunId, actionContext, writer), this);
        pm.registerEvents(new InventoryEventListener(serverRunId, actionContext, writer), this);
        pm.registerEvents(new CombatEventListener(serverRunId, actionContext, writer), this);

        // 4. Schedule Periodic Snapshot Task
        snapshotTask = new PeriodicSnapshotTask(serverRunId, actionContext, writer, snapshotTicks);
        snapshotTask.runTaskTimer(this, 10L, 5L);

        // 5. Initialize Authenticated Bridge Server (if enabled)
        boolean bridgeEnabled = config.getBoolean("observer.bridge.enabled", true);
        if (bridgeEnabled) {
            String bridgeHost = config.getString("observer.bridge.host", "127.0.0.1");
            int bridgePort = config.getInt("observer.bridge.port", 25580);
            String tokenPath = config.getString("observer.bridge.token-file", "../logs/integration/.bridge_token");
            File tokenFile = new File(getDataFolder(), tokenPath);
            try {
                tokenFile = tokenFile.getCanonicalFile();
            } catch (IOException ignored) {
                tokenFile = tokenFile.getAbsoluteFile();
            }

            bridgeServer = new BridgeServer(
                    bridgeHost,
                    bridgePort,
                    tokenFile,
                    actionContext,
                    writer::enqueue,
                    writer::nextSequence,
                    serverRunId,
                    getLogger()
            );

            try {
                bridgeServer.start();
                getLogger().info("[Observer] Authenticated loopback bridge started on " + bridgeHost + ":" + bridgePort);
            } catch (IOException e) {
                getLogger().severe("[Observer] Failed to start BridgeServer: " + e.getMessage());
            }
        }

        // 6. Record Startup Event
        Map<String, Object> startupDetails = new HashMap<>();
        startupDetails.put("serverVersion", getServer().getVersion());
        startupDetails.put("bukkitVersion", getServer().getBukkitVersion());
        startupDetails.put("bridgeEnabled", bridgeEnabled);
        startupDetails.put("initDurationMs", System.currentTimeMillis() - startTime);

        ObserverEvent startupEvent = new ObserverEvent(
                writer.nextSequence(),
                serverRunId,
                "server",
                null,
                "server",
                "OBSERVER_STARTUP",
                null,
                null,
                null,
                null,
                null,
                null,
                startupDetails
        );
        writer.enqueue(startupEvent);

        getLogger().info(String.format("[Observer] Successfully initialized in %dms. All events registered.", System.currentTimeMillis() - startTime));
    }

    @Override
    public void onDisable() {
        getLogger().info("[Observer] Shutting down GroundTruthObserver Plugin...");

        // Record Shutdown Event
        if (writer != null) {
            Map<String, Object> shutdownDetails = new HashMap<>();
            shutdownDetails.put("finalSequence", writer.getCurrentSequence());

            ObserverEvent shutdownEvent = new ObserverEvent(
                    writer.nextSequence(),
                    serverRunId,
                    "server",
                    null,
                    "server",
                    "OBSERVER_SHUTDOWN",
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    shutdownDetails
            );
            writer.enqueue(shutdownEvent);
        }

        if (snapshotTask != null) {
            snapshotTask.cancel();
            snapshotTask = null;
        }

        if (bridgeServer != null) {
            bridgeServer.stop();
            bridgeServer = null;
        }

        if (writer != null) {
            writer.stop(2000L);
            writer = null;
        }

        getLogger().info("[Observer] Clean shutdown complete.");
    }

    public RotatingJsonlWriter getWriter() {
        return writer;
    }

    public ActionContext getActionContext() {
        return actionContext;
    }

    public BridgeServer getBridgeServer() {
        return bridgeServer;
    }
}

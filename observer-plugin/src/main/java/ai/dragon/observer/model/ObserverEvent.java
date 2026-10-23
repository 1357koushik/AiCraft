package ai.dragon.observer.model;

import com.google.gson.annotations.SerializedName;
import java.time.Instant;
import java.util.Map;

/**
 * Immutable data transfer object representing a structured observer event.
 * Serialized directly to newline-delimited JSON (NDJSON).
 */
public class ObserverEvent {

    public static class Coordinates {
        public final double x;
        public final double y;
        public final double z;

        public Coordinates(double x, double y, double z) {
            this.x = Math.round(x * 100.0) / 100.0;
            this.y = Math.round(y * 100.0) / 100.0;
            this.z = Math.round(z * 100.0) / 100.0;
        }
    }

    public static class CancellationInfo {
        public final boolean cancelled;
        public final String reason;

        public CancellationInfo(boolean cancelled, String reason) {
            this.cancelled = cancelled;
            this.reason = reason;
        }
    }

    public static class ActiveActionContext {
        public final String runId;
        public final String goalId;
        public final String actionId;
        public final String actionName;

        public ActiveActionContext(String runId, String goalId, String actionId, String actionName) {
            this.runId = runId;
            this.goalId = goalId;
            this.actionId = actionId;
            this.actionName = actionName;
        }
    }

    @SerializedName("seq")
    public final long seq;

    @SerializedName("timestamp")
    public final String timestamp;

    @SerializedName("serverRunId")
    public final String serverRunId;

    @SerializedName("dimension")
    public final String dimension;

    @SerializedName("playerUuid")
    public final String playerUuid;

    @SerializedName("playerName")
    public final String playerName;

    @SerializedName("eventType")
    public final String eventType;

    @SerializedName("coordinates")
    public final Coordinates coordinates;

    @SerializedName("blockId")
    public final String blockId;

    @SerializedName("itemId")
    public final String itemId;

    @SerializedName("amount")
    public final Integer amount;

    @SerializedName("cancellation")
    public final CancellationInfo cancellation;

    @SerializedName("activeContext")
    public final ActiveActionContext activeContext;

    @SerializedName("details")
    public final Map<String, Object> details;

    public ObserverEvent(
            long seq,
            String serverRunId,
            String dimension,
            String playerUuid,
            String playerName,
            String eventType,
            Coordinates coordinates,
            String blockId,
            String itemId,
            Integer amount,
            CancellationInfo cancellation,
            ActiveActionContext activeContext,
            Map<String, Object> details
    ) {
        this.seq = seq;
        this.timestamp = Instant.now().toString();
        this.serverRunId = serverRunId;
        this.dimension = dimension != null ? dimension : "unknown";
        this.playerUuid = playerUuid;
        this.playerName = playerName;
        this.eventType = eventType;
        this.coordinates = coordinates;
        this.blockId = blockId;
        this.itemId = itemId;
        this.amount = amount;
        this.cancellation = cancellation;
        this.activeContext = activeContext;
        this.details = details;
    }
}

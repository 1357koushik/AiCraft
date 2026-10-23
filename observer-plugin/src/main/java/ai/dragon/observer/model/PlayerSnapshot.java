package ai.dragon.observer.model;

import com.google.gson.annotations.SerializedName;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.attribute.Attribute;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;

import java.util.HashMap;
import java.util.Map;

/**
 * Captures an authoritative instantaneous snapshot of player state directly from the server engine.
 */
public class PlayerSnapshot {

    @SerializedName("health")
    public final double health;

    @SerializedName("maxHealth")
    public final double maxHealth;

    @SerializedName("food")
    public final int food;

    @SerializedName("saturation")
    public final float saturation;

    @SerializedName("oxygen")
    public final int oxygen;

    @SerializedName("isAlive")
    public final boolean isAlive;

    @SerializedName("gameMode")
    public final String gameMode;

    @SerializedName("dimension")
    public final String dimension;

    @SerializedName("position")
    public final ObserverEvent.Coordinates position;

    @SerializedName("yaw")
    public final float yaw;

    @SerializedName("pitch")
    public final float pitch;

    @SerializedName("xpLevel")
    public final int xpLevel;

    @SerializedName("totalExp")
    public final int totalExp;

    @SerializedName("heldItem")
    public final String heldItem;

    @SerializedName("offHand")
    public final String offHand;

    @SerializedName("armor")
    public final Map<String, String> armor;

    @SerializedName("inventory")
    public final Map<String, Integer> inventory;

    @SerializedName("chunkLoaded")
    public final boolean chunkLoaded;

    public PlayerSnapshot(
            double health,
            double maxHealth,
            int food,
            float saturation,
            int oxygen,
            boolean isAlive,
            String gameMode,
            String dimension,
            ObserverEvent.Coordinates position,
            float yaw,
            float pitch,
            int xpLevel,
            int totalExp,
            String heldItem,
            String offHand,
            Map<String, String> armor,
            Map<String, Integer> inventory,
            boolean chunkLoaded
    ) {
        this.health = Math.round(health * 100.0) / 100.0;
        this.maxHealth = Math.round(maxHealth * 100.0) / 100.0;
        this.food = food;
        this.saturation = Math.round(saturation * 100.0f) / 100.0f;
        this.oxygen = oxygen;
        this.isAlive = isAlive;
        this.gameMode = gameMode;
        this.dimension = dimension;
        this.position = position;
        this.yaw = Math.round(yaw * 100.0f) / 100.0f;
        this.pitch = Math.round(pitch * 100.0f) / 100.0f;
        this.xpLevel = xpLevel;
        this.totalExp = totalExp;
        this.heldItem = heldItem;
        this.offHand = offHand;
        this.armor = armor != null ? armor : new HashMap<>();
        this.inventory = inventory != null ? inventory : new HashMap<>();
        this.chunkLoaded = chunkLoaded;
    }

    public static PlayerSnapshot fromPlayer(Player player) {
        if (player == null) return null;

        Location loc = player.getLocation();
        double maxHp = 20.0;
        try {
            Attribute attr = Attribute.MAX_HEALTH;
            if (player.getAttribute(attr) != null) {
                maxHp = player.getAttribute(attr).getValue();
            }
        } catch (Throwable ignored) {
        }

        Map<String, String> armorMap = new HashMap<>();
        ItemStack helmet = player.getInventory().getHelmet();
        ItemStack chestplate = player.getInventory().getChestplate();
        ItemStack leggings = player.getInventory().getLeggings();
        ItemStack boots = player.getInventory().getBoots();

        if (helmet != null && !helmet.getType().isAir()) armorMap.put("head", helmet.getType().name().toLowerCase());
        if (chestplate != null && !chestplate.getType().isAir()) armorMap.put("torso", chestplate.getType().name().toLowerCase());
        if (leggings != null && !leggings.getType().isAir()) armorMap.put("legs", leggings.getType().name().toLowerCase());
        if (boots != null && !boots.getType().isAir()) armorMap.put("feet", boots.getType().name().toLowerCase());

        Map<String, Integer> invMap = new HashMap<>();
        for (ItemStack item : player.getInventory().getContents()) {
            if (item != null && !item.getType().isAir()) {
                String name = item.getType().name().toLowerCase();
                invMap.put(name, invMap.getOrDefault(name, 0) + item.getAmount());
            }
        }

        ItemStack mainHand = player.getInventory().getItemInMainHand();
        ItemStack offHandItem = player.getInventory().getItemInOffHand();

        String mainHandName = (mainHand != null && !mainHand.getType().isAir()) ? mainHand.getType().name().toLowerCase() : null;
        String offHandName = (offHandItem != null && !offHandItem.getType().isAir()) ? offHandItem.getType().name().toLowerCase() : null;

        boolean isLoaded = loc.getWorld() != null && loc.getWorld().isChunkLoaded(loc.getBlockX() >> 4, loc.getBlockZ() >> 4);

        return new PlayerSnapshot(
                player.getHealth(),
                maxHp,
                player.getFoodLevel(),
                player.getSaturation(),
                player.getRemainingAir(),
                !player.isDead() && player.getHealth() > 0,
                player.getGameMode().name(),
                loc.getWorld() != null ? loc.getWorld().getName() : "unknown",
                new ObserverEvent.Coordinates(loc.getX(), loc.getY(), loc.getZ()),
                loc.getYaw(),
                loc.getPitch(),
                player.getLevel(),
                player.getTotalExperience(),
                mainHandName,
                offHandName,
                armorMap,
                invMap,
                isLoaded
        );
    }
}

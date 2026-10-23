package ai.dragon.observer.bridge;

import ai.dragon.observer.model.ObserverEvent;
import ai.dragon.observer.model.PlayerSnapshot;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;

import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import java.util.function.Supplier;
import java.util.logging.Logger;

/**
 * Loopback-only, token-authenticated HTTP bridge for correlating agent action IDs with server events.
 * Strictly read-only: exposes NO endpoints that can mutate players, blocks, or world state.
 */
public class BridgeServer {

    private static final int MAX_REQUEST_BODY_BYTES = 16384; // 16 KB max

    private final String host;
    private final int port;
    private final File tokenFile;
    private final ActionContext actionContext;
    private final Consumer<ObserverEvent> eventSink;
    private final Supplier<Long> sequenceSupplier;
    private final String serverRunId;
    private final Logger logger;
    private final Gson gson = new Gson();

    private HttpServer server;
    private ExecutorService executor;
    private String authToken;

    public BridgeServer(
            String host,
            int port,
            File tokenFile,
            ActionContext actionContext,
            Consumer<ObserverEvent> eventSink,
            Supplier<Long> sequenceSupplier,
            String serverRunId,
            Logger logger
    ) {
        this.host = host != null ? host : "127.0.0.1";
        this.port = port > 0 ? port : 25580;
        this.tokenFile = tokenFile;
        this.actionContext = actionContext;
        this.eventSink = eventSink;
        this.sequenceSupplier = sequenceSupplier;
        this.serverRunId = serverRunId;
        this.logger = logger;
    }

    public synchronized void start() throws IOException {
        this.authToken = generateOrLoadToken();

        // Bind strictly to loopback IP (127.0.0.1)
        server = HttpServer.create(new InetSocketAddress(host, port), 0);
        executor = Executors.newFixedThreadPool(2);
        server.setExecutor(executor);

        server.createContext("/status", new AuthHandler(this::handleStatus));
        server.createContext("/action/start", new AuthHandler(this::handleActionStart));
        server.createContext("/action/end", new AuthHandler(this::handleActionEnd));
        server.createContext("/snapshot", new AuthHandler(this::handleSnapshot));

        server.start();

        if (logger != null) {
            logger.info(String.format("[BridgeServer] Listening on http://%s:%d (loopback only, auth required)", host, port));
        }
    }

    public synchronized void stop() {
        if (server != null) {
            server.stop(0);
            server = null;
        }
        if (executor != null) {
            executor.shutdownNow();
            executor = null;
        }
        if (logger != null) {
            logger.info("[BridgeServer] Stopped bridge HTTP server.");
        }
    }

    public String getAuthToken() {
        return authToken;
    }

    private String generateOrLoadToken() throws IOException {
        if (tokenFile != null && tokenFile.exists() && tokenFile.length() > 0) {
            try (BufferedReader r = new BufferedReader(new FileReader(tokenFile, StandardCharsets.UTF_8))) {
                String line = r.readLine();
                if (line != null && !line.trim().isEmpty()) {
                    return line.trim();
                }
            }
        }

        // Generate cryptographic 32-character random token
        SecureRandom sr = new SecureRandom();
        byte[] bytes = new byte[24];
        sr.nextBytes(bytes);
        String generated = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);

        if (tokenFile != null) {
            File parent = tokenFile.getParentFile();
            if (parent != null && !parent.exists()) {
                parent.mkdirs();
            }
            try (BufferedWriter w = new BufferedWriter(new FileWriter(tokenFile, StandardCharsets.UTF_8))) {
                w.write(generated);
                w.newLine();
            }
            // Set file readable only by owner on supported platforms
            tokenFile.setReadable(false, false);
            tokenFile.setReadable(true, true);
        }

        return generated;
    }

    private class AuthHandler implements HttpHandler {
        private final HttpHandler next;

        public AuthHandler(HttpHandler next) {
            this.next = next;
        }

        @Override
        public void handle(HttpExchange exchange) throws IOException {
            // 1. Strict loopback enforcement
            if (!exchange.getRemoteAddress().getAddress().isLoopbackAddress()) {
                sendResponse(exchange, 403, "{\"error\":\"Forbidden: Bridge accepts local loopback connections only\"}");
                return;
            }

            // 2. Authentication check
            String authHeader = exchange.getRequestHeaders().getFirst("X-Observer-Token");
            if (authHeader == null) {
                String bearer = exchange.getRequestHeaders().getFirst("Authorization");
                if (bearer != null && bearer.startsWith("Bearer ")) {
                    authHeader = bearer.substring(7).trim();
                }
            }

            if (authHeader == null || !authHeader.equals(authToken)) {
                sendResponse(exchange, 401, "{\"error\":\"Unauthorized: Invalid or missing observer token\"}");
                return;
            }

            next.handle(exchange);
        }
    }

    private void handleStatus(HttpExchange exchange) throws IOException {
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendResponse(exchange, 405, "{\"error\":\"Method Not Allowed\"}");
            return;
        }

        Map<String, Object> resp = new HashMap<>();
        resp.put("status", "ACTIVE");
        resp.put("version", "1.0.0");
        resp.put("serverRunId", serverRunId);
        resp.put("currentSeq", sequenceSupplier.get());
        resp.put("loopbackOnly", true);
        resp.put("activeContext", actionContext.get());

        sendResponse(exchange, 200, gson.toJson(resp));
    }

    private void handleActionStart(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendResponse(exchange, 405, "{\"error\":\"Method Not Allowed\"}");
            return;
        }

        String body = readBodyBounded(exchange);
        if (body == null) return;

        try {
            JsonObject json = JsonParser.parseString(body).getAsJsonObject();
            String runId = json.has("runId") ? json.get("runId").getAsString() : serverRunId;
            String goalId = json.has("goalId") ? json.get("goalId").getAsString() : "unspecified_goal";
            String actionId = json.has("actionId") ? json.get("actionId").getAsString() : "act_" + System.currentTimeMillis();
            String actionName = json.has("actionName") ? json.get("actionName").getAsString() : "unknown_action";

            actionContext.bind(runId, goalId, actionId, actionName);

            // Record ACTION_BOUND event
            Map<String, Object> details = new HashMap<>();
            details.put("actionName", actionName);
            details.put("actionId", actionId);
            details.put("goalId", goalId);
            details.put("runId", runId);

            long seq = sequenceSupplier.get();
            ObserverEvent event = new ObserverEvent(
                    seq,
                    serverRunId,
                    "server",
                    null,
                    "agent",
                    "ACTION_BOUND",
                    null,
                    null,
                    null,
                    null,
                    null,
                    actionContext.get(),
                    details
            );
            eventSink.accept(event);

            Map<String, Object> resp = new HashMap<>();
            resp.put("ok", true);
            resp.put("seq", seq);
            resp.put("actionId", actionId);
            sendResponse(exchange, 200, gson.toJson(resp));
        } catch (Exception e) {
            sendResponse(exchange, 400, "{\"error\":\"Bad Request: " + e.getMessage() + "\"}");
        }
    }

    private void handleActionEnd(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendResponse(exchange, 405, "{\"error\":\"Method Not Allowed\"}");
            return;
        }

        String body = readBodyBounded(exchange);
        if (body == null) return;

        ObserverEvent.ActiveActionContext prev = actionContext.get();
        actionContext.clear();

        Map<String, Object> details = new HashMap<>();
        if (prev != null) {
            details.put("completedActionId", prev.actionId);
            details.put("completedActionName", prev.actionName);
        }

        long seq = sequenceSupplier.get();
        ObserverEvent event = new ObserverEvent(
                seq,
                serverRunId,
                "server",
                null,
                "agent",
                "ACTION_UNBOUND",
                null,
                null,
                null,
                null,
                null,
                prev,
                details
        );
        eventSink.accept(event);

        Map<String, Object> resp = new HashMap<>();
        resp.put("ok", true);
        resp.put("seq", seq);
        resp.put("clearedActionId", prev != null ? prev.actionId : null);
        sendResponse(exchange, 200, gson.toJson(resp));
    }

    private void handleSnapshot(HttpExchange exchange) throws IOException {
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendResponse(exchange, 405, "{\"error\":\"Method Not Allowed\"}");
            return;
        }

        // Query player snapshot from main thread or Bukkit API safely
        Map<String, Object> resp = new HashMap<>();
        resp.put("timestamp", System.currentTimeMillis());

        Map<String, PlayerSnapshot> snapshots = new HashMap<>();
        for (Player p : Bukkit.getOnlinePlayers()) {
            snapshots.put(p.getName(), PlayerSnapshot.fromPlayer(p));
        }
        resp.put("players", snapshots);
        resp.put("onlineCount", snapshots.size());

        sendResponse(exchange, 200, gson.toJson(resp));
    }

    private String readBodyBounded(HttpExchange exchange) throws IOException {
        InputStream is = exchange.getRequestBody();
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        byte[] buffer = new byte[1024];
        int read;
        int total = 0;

        while ((read = is.read(buffer)) != -1) {
            total += read;
            if (total > MAX_REQUEST_BODY_BYTES) {
                sendResponse(exchange, 413, "{\"error\":\"Payload Too Large: exceeds 16KB limit\"}");
                return null;
            }
            baos.write(buffer, 0, read);
        }

        return baos.toString(StandardCharsets.UTF_8);
    }

    private void sendResponse(HttpExchange exchange, int status, String jsonBody) throws IOException {
        byte[] bytes = jsonBody.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }
}

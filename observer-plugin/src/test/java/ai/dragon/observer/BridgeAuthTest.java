package ai.dragon.observer;

import ai.dragon.observer.bridge.ActionContext;
import ai.dragon.observer.bridge.BridgeServer;
import ai.dragon.observer.model.ObserverEvent;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.*;

public class BridgeAuthTest {

    private BridgeServer bridgeServer;
    private ActionContext actionContext;
    private List<ObserverEvent> capturedEvents;
    private File tempTokenFile;
    private int testPort = 25588;

    @BeforeEach
    public void setup() throws Exception {
        tempTokenFile = File.createTempFile("test_bridge_token", ".txt");
        actionContext = new ActionContext();
        capturedEvents = new ArrayList<>();
        AtomicLong seq = new AtomicLong(1);

        bridgeServer = new BridgeServer(
                "127.0.0.1",
                testPort,
                tempTokenFile,
                actionContext,
                capturedEvents::add,
                seq::getAndIncrement,
                "test_run_auth",
                null
        );
        bridgeServer.start();
    }

    @AfterEach
    public void teardown() {
        if (bridgeServer != null) {
            bridgeServer.stop();
        }
        if (tempTokenFile != null && tempTokenFile.exists()) {
            tempTokenFile.delete();
        }
    }

    private HttpURLConnection makeRequest(String path, String method, String token, String body) throws Exception {
        URL url = new URL("http://127.0.0.1:" + testPort + path);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(2000);
        conn.setReadTimeout(2000);

        if (token != null) {
            conn.setRequestProperty("X-Observer-Token", token);
        }

        if (body != null) {
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            try (OutputStream os = conn.getOutputStream()) {
                os.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }
        return conn;
    }

    @Test
    public void testUnauthorizedWithoutToken() throws Exception {
        HttpURLConnection conn = makeRequest("/status", "GET", null, null);
        assertEquals(401, conn.getResponseCode());
    }

    @Test
    public void testUnauthorizedWithWrongToken() throws Exception {
        HttpURLConnection conn = makeRequest("/status", "GET", "invalid_token_12345", null);
        assertEquals(401, conn.getResponseCode());
    }

    @Test
    public void testAuthorizedGetStatus() throws Exception {
        String token = bridgeServer.getAuthToken();
        HttpURLConnection conn = makeRequest("/status", "GET", token, null);
        assertEquals(200, conn.getResponseCode());

        String resp = new String(conn.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        JsonObject json = JsonParser.parseString(resp).getAsJsonObject();
        assertEquals("ACTIVE", json.get("status").getAsString());
        assertEquals("test_run_auth", json.get("serverRunId").getAsString());
        assertTrue(json.get("loopbackOnly").getAsBoolean());
    }

    @Test
    public void testActionLifecycleBinding() throws Exception {
        String token = bridgeServer.getAuthToken();

        // 1. Start Action
        String startPayload = "{\"runId\":\"r1\",\"goalId\":\"g1\",\"actionId\":\"act_mine_01\",\"actionName\":\"dig_block\"}";
        HttpURLConnection startConn = makeRequest("/action/start", "POST", token, startPayload);
        assertEquals(200, startConn.getResponseCode());

        assertNotNull(actionContext.get());
        assertEquals("act_mine_01", actionContext.get().actionId);
        assertEquals("dig_block", actionContext.get().actionName);
        assertEquals(1, capturedEvents.size());
        assertEquals("ACTION_BOUND", capturedEvents.get(0).eventType);

        // 2. End Action
        String endPayload = "{\"actionId\":\"act_mine_01\"}";
        HttpURLConnection endConn = makeRequest("/action/end", "POST", token, endPayload);
        assertEquals(200, endConn.getResponseCode());

        assertNull(actionContext.get());
        assertEquals(2, capturedEvents.size());
        assertEquals("ACTION_UNBOUND", capturedEvents.get(1).eventType);
    }

    @Test
    public void testPayloadTooLargeRejection() throws Exception {
        String token = bridgeServer.getAuthToken();
        // Create 20KB payload (> 16KB limit)
        String largeString = "a".repeat(20 * 1024);
        String largePayload = "{\"runId\":\"r1\",\"data\":\"" + largeString + "\"}";

        HttpURLConnection conn = makeRequest("/action/start", "POST", token, largePayload);
        assertEquals(413, conn.getResponseCode());
    }
}

package ai.dragon.observer;

import ai.dragon.observer.logging.RotatingJsonlWriter;
import ai.dragon.observer.model.ObserverEvent;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

public class LogRotationTest {

    private File tempDir;
    private RotatingJsonlWriter writer;

    @BeforeEach
    public void setup() throws Exception {
        tempDir = Files.createTempDirectory("observer_log_test").toFile();
    }

    @AfterEach
    public void teardown() {
        if (writer != null) {
            writer.stop(1000L);
        }
        if (tempDir != null && tempDir.exists()) {
            File[] files = tempDir.listFiles();
            if (files != null) {
                for (File f : files) f.delete();
            }
            tempDir.delete();
        }
    }

    @Test
    public void testSequentialWritingAndMonotonicSeq() throws Exception {
        writer = new RotatingJsonlWriter(tempDir, "seq_test", 1024 * 1024, 5, null);
        writer.start();

        for (int i = 0; i < 10; i++) {
            long seq = writer.nextSequence();
            ObserverEvent event = new ObserverEvent(
                    seq,
                    "run_seq",
                    "minecraft:overworld",
                    "p-uuid",
                    "player1",
                    "TEST_EVENT",
                    new ObserverEvent.Coordinates(i, 64, i),
                    null,
                    null,
                    i,
                    null,
                    null,
                    new HashMap<>()
            );
            writer.enqueue(event);
        }

        // Stop to flush
        writer.stop(2000L);

        File[] files = tempDir.listFiles((dir, name) -> name.endsWith(".jsonl"));
        assertNotNull(files);
        assertEquals(1, files.length);

        try (BufferedReader reader = new BufferedReader(new FileReader(files[0]))) {
            String line;
            int count = 0;
            long expectedSeq = 1;
            while ((line = reader.readLine()) != null) {
                assertTrue(line.contains("\"seq\":" + expectedSeq));
                expectedSeq++;
                count++;
            }
            assertEquals(10, count);
        }
    }

    @Test
    public void testFileRotationAndMaxFileCap() throws Exception {
        // Set low size threshold (300 bytes) and max 3 files
        writer = new RotatingJsonlWriter(tempDir, "rot_test", 300, 3, null);
        writer.start();

        // Write 25 events (each event is ~200 bytes, so it will rotate several times)
        for (int i = 0; i < 25; i++) {
            Map<String, Object> details = new HashMap<>();
            details.put("padding", "x".repeat(100)); // Ensure substantial event size

            ObserverEvent event = new ObserverEvent(
                    writer.nextSequence(),
                    "run_rot",
                    "overworld",
                    "uuid",
                    "player",
                    "ROTATE_TEST",
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    details
            );
            writer.enqueue(event);
            Thread.sleep(20); // Small sleep so file rotation timestamp ordering is clear
        }

        writer.stop(2000L);

        File[] files = tempDir.listFiles((dir, name) -> name.endsWith(".jsonl"));
        assertNotNull(files);
        assertTrue(files.length > 1, "Expected multiple rotated files, found: " + files.length);
        assertTrue(files.length <= 3, "Expected at most 3 files due to maxFiles cap, found: " + files.length);
    }

    @Test
    public void testSecretRedaction() {
        String sensitive = "{\"message\":\"Authorization: Bearer sk-antigravitySecretKey1234567890 password=superSecretPassword123\"}";
        String redacted = RotatingJsonlWriter.redact(sensitive);

        assertFalse(redacted.contains("sk-antigravitySecretKey1234567890"));
        assertFalse(redacted.contains("superSecretPassword123"));
        assertTrue(redacted.contains("sk-***REDACTED***"));
        assertTrue(redacted.contains("password=***REDACTED***"));
    }
}

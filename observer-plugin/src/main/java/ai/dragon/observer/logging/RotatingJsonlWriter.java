package ai.dragon.observer.logging;

import ai.dragon.observer.model.ObserverEvent;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.logging.Logger;
import java.util.regex.Pattern;

/**
 * High-performance, non-blocking asynchronous JSONL writer with file rotation and size capping.
 * Ensures the Minecraft server tick loop is never blocked by disk I/O.
 */
public class RotatingJsonlWriter {

    private static final Pattern REDACT_TOKEN_PATTERN = Pattern.compile("(?i)(token|password|secret|bearer)\\s*[:=]\\s*['\"]?([^'\"\\s]+)['\"]?");
    private static final Pattern REDACT_API_KEY_PATTERN = Pattern.compile("sk-[a-zA-Z0-9_-]{20,}");

    private final File logDir;
    private final String runId;
    private final long maxFileSizeBytes;
    private final int maxFiles;
    private final Logger logger;

    private final Gson gson = new GsonBuilder().disableHtmlEscaping().create();
    private final AtomicLong sequence = new AtomicLong(1);
    private final BlockingQueue<ObserverEvent> queue = new LinkedBlockingQueue<>(50000);
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final Object fileLock = new Object();

    private Thread workerThread;
    private File currentFile;
    private BufferedWriter currentWriter;
    private int currentFileIndex = 0;

    public RotatingJsonlWriter(File logDir, String runId, long maxFileSizeBytes, int maxFiles, Logger logger) {
        this.logDir = logDir;
        this.runId = runId;
        this.maxFileSizeBytes = maxFileSizeBytes;
        this.maxFiles = maxFiles;
        this.logger = logger;
    }

    public synchronized void start() throws IOException {
        if (!logDir.exists()) {
            if (!logDir.mkdirs()) {
                throw new IOException("Failed to create observer log directory: " + logDir.getAbsolutePath());
            }
        }

        rotateFile();
        running.set(true);

        workerThread = new Thread(this::runWorker, "Observer-JsonlWriter");
        workerThread.setDaemon(true);
        workerThread.start();

        if (logger != null) {
            logger.info("[ObserverWriter] Started asynchronous JSONL writer at " + currentFile.getAbsolutePath());
        }
    }

    public long nextSequence() {
        return sequence.getAndIncrement();
    }

    public void enqueue(ObserverEvent event) {
        if (!running.get()) return;
        boolean accepted = queue.offer(event);
        if (!accepted && logger != null) {
            logger.warning("[ObserverWriter] Event queue full! Dropping event seq=" + event.seq);
        }
    }

    private void runWorker() {
        while (running.get() || !queue.isEmpty()) {
            try {
                ObserverEvent event = queue.poll(100, TimeUnit.MILLISECONDS);
                if (event != null) {
                    writeEvent(event);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                if (logger != null) {
                    logger.severe("[ObserverWriter] Error writing event: " + e.getMessage());
                }
            }
        }
        flushAndCloseWriter();
    }

    private void writeEvent(ObserverEvent event) throws IOException {
        String json = gson.toJson(event);
        String redacted = redact(json);

        synchronized (fileLock) {
            if (currentFile != null && currentFile.length() >= maxFileSizeBytes) {
                rotateFile();
            }

            if (currentWriter != null) {
                currentWriter.write(redacted);
                currentWriter.newLine();
                currentWriter.flush();
            }
        }
    }

    public static String redact(String text) {
        if (text == null) return null;
        String s = REDACT_API_KEY_PATTERN.matcher(text).replaceAll("sk-***REDACTED***");
        return REDACT_TOKEN_PATTERN.matcher(s).replaceAll("$1=***REDACTED***");
    }

    private void rotateFile() throws IOException {
        synchronized (fileLock) {
            flushAndCloseWriter();

            currentFileIndex++;
            currentFile = new File(logDir, String.format("observer-%s-part%02d.jsonl", runId, currentFileIndex));
            currentWriter = new BufferedWriter(new FileWriter(currentFile, true));

            // Purge files exceeding maxFiles
            purgeOldFiles();
        }
    }

    private void purgeOldFiles() {
        File[] files = logDir.listFiles((dir, name) -> name.startsWith("observer-" + runId + "-part") && name.endsWith(".jsonl"));
        if (files != null && files.length > maxFiles) {
            java.util.Arrays.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
            int toDelete = files.length - maxFiles;
            for (int i = 0; i < toDelete; i++) {
                if (files[i].delete() && logger != null) {
                    logger.info("[ObserverWriter] Rotated out old log file: " + files[i].getName());
                }
            }
        }
    }

    private void flushAndCloseWriter() {
        synchronized (fileLock) {
            if (currentWriter != null) {
                try {
                    currentWriter.flush();
                    currentWriter.close();
                } catch (IOException ignored) {
                }
                currentWriter = null;
            }
        }
    }

    public void stop(long timeoutMs) {
        if (!running.getAndSet(false)) return;

        if (workerThread != null) {
            try {
                workerThread.join(timeoutMs);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        flushAndCloseWriter();
        if (logger != null) {
            logger.info("[ObserverWriter] Flushed and cleanly shut down observer JSONL writer.");
        }
    }

    public File getCurrentFile() {
        return currentFile;
    }

    public long getCurrentSequence() {
        return sequence.get();
    }
}

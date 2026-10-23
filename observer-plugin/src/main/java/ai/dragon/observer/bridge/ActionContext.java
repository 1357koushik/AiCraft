package ai.dragon.observer.bridge;

import ai.dragon.observer.model.ObserverEvent;

import java.util.concurrent.atomic.AtomicReference;

/**
 * Thread-safe holder for the agent's current active action context.
 */
public class ActionContext {

    private final AtomicReference<ObserverEvent.ActiveActionContext> current = new AtomicReference<>(null);

    public void bind(String runId, String goalId, String actionId, String actionName) {
        current.set(new ObserverEvent.ActiveActionContext(runId, goalId, actionId, actionName));
    }

    public void clear() {
        current.set(null);
    }

    public ObserverEvent.ActiveActionContext get() {
        return current.get();
    }
}

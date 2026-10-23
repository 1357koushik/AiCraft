import net from 'net';

export interface ServerReachabilityResult {
  reachable: boolean;
  host: string;
  port: number;
  error?: string;
}

/**
 * Probes the target Minecraft server TCP port before live test execution.
 * Fails fast with status BLOCKED if server is not reachable.
 */
export async function checkServerReachability(
  host: string = '127.0.0.1',
  port: number = 25565,
  timeoutMs: number = 2000
): Promise<ServerReachabilityResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      resolved = true;
      socket.destroy();
      resolve({ reachable: true, host, port });
    });

    socket.on('timeout', () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve({
          reachable: false,
          host,
          port,
          error: `Connection timed out after ${timeoutMs}ms`,
        });
      }
    });

    socket.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve({
          reachable: false,
          host,
          port,
          error: err.message,
        });
      }
    });

    socket.connect(port, host);
  });
}

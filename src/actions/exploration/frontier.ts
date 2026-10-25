import { Vec3 } from 'vec3';

export type ChunkExplorationStatus = 'UNEXPLORED' | 'MAPPED' | 'EXHAUSTED';

export interface IExplorationGrid {
  chunkStatus: Map<string, ChunkExplorationStatus>;
  detectedBiomes: Map<string, string>;
  knownOreExposures: Map<string, Vec3[]>;
  getNextFrontier(origin: Vec3, preferredBiome?: string): Vec3;
}

/**
 * 2D Chunk Grid Frontier Tracker.
 * Manages systematic chunk-based exploration, frontier boundary discovery,
 * biome cataloging, and exposed ore landmark mapping.
 */
export class ExplorationGrid implements IExplorationGrid {
  public chunkStatus: Map<string, ChunkExplorationStatus> = new Map();
  public detectedBiomes: Map<string, string> = new Map();
  public knownOreExposures: Map<string, Vec3[]> = new Map();

  public static toChunkCoord(val: number): number {
    return Math.floor(val / 16);
  }

  public static chunkKey(cx: number, cz: number): string {
    return `${cx},${cz}`;
  }

  public static parseChunkKey(key: string): { cx: number; cz: number } {
    const parts = key.split(',').map((p) => parseInt(p, 10));
    return { cx: parts[0] || 0, cz: parts[1] || 0 };
  }

  /**
   * Records or updates the exploration status of a chunk.
   */
  public markChunk(cx: number, cz: number, status: ChunkExplorationStatus, biome?: string): void {
    const key = ExplorationGrid.chunkKey(cx, cz);
    this.chunkStatus.set(key, status);
    if (biome) {
      this.detectedBiomes.set(key, biome);
    }
  }

  /**
   * Records a confirmed exposed ore vein at coordinates.
   */
  public recordOre(type: string, pos: Vec3): void {
    const normalizedType = type.toLowerCase().trim();
    const list = this.knownOreExposures.get(normalizedType) || [];
    if (!list.some((p) => Math.hypot(p.x - pos.x, p.y - pos.y, p.z - pos.z) < 2)) {
      list.push(pos.clone());
      this.knownOreExposures.set(normalizedType, list);
    }
  }

  /**
   * Retrieves all recorded exposed ores for a specific ore type.
   */
  public getOres(type: string): Vec3[] {
    return this.knownOreExposures.get(type.toLowerCase().trim()) || [];
  }

  /**
   * Calculates the next optimal frontier target coordinate using frontier exploration:
   * Identifies unmapped boundary chunks adjacent to mapped territory, ranked by
   * proximity, unexplored neighbor volume, and optional preferred biome.
   */
  public getNextFrontier(origin: Vec3, preferredBiome?: string): Vec3 {
    const originCx = ExplorationGrid.toChunkCoord(origin.x);
    const originCz = ExplorationGrid.toChunkCoord(origin.z);

    // Auto-mark the current player chunk as MAPPED if unrecorded
    const currentKey = ExplorationGrid.chunkKey(originCx, originCz);
    if (!this.chunkStatus.has(currentKey)) {
      this.chunkStatus.set(currentKey, 'MAPPED');
    }

    let bestScore = -Infinity;
    let bestTarget: Vec3 | null = null;

    // Expand search in concentric chunk rings (radius 1 to 16 chunks = 16 to 256m)
    for (let r = 1; r <= 16; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;

          const cx = originCx + dx;
          const cz = originCz + dz;
          const key = ExplorationGrid.chunkKey(cx, cz);
          const status = this.chunkStatus.get(key) || 'UNEXPLORED';

          if (status === 'EXHAUSTED') continue;

          // Count unexplored adjacent neighbor chunks
          let unexploredNeighbors = 0;
          for (const [nx, nz] of [
            [cx + 1, cz],
            [cx - 1, cz],
            [cx, cz + 1],
            [cx, cz - 1],
          ]) {
            const nKey = ExplorationGrid.chunkKey(nx, nz);
            const nStatus = this.chunkStatus.get(nKey);
            if (!nStatus || nStatus === 'UNEXPLORED') {
              unexploredNeighbors++;
            }
          }

          if (unexploredNeighbors === 0 && status === 'MAPPED') {
            this.chunkStatus.set(key, 'EXHAUSTED');
            continue;
          }

          const distChunks = Math.hypot(dx, dz);
          let score = 100 - distChunks * 3.5 + unexploredNeighbors * 8;

          if (preferredBiome) {
            const chunkBiome = this.detectedBiomes.get(key);
            if (chunkBiome && chunkBiome.toLowerCase().includes(preferredBiome.toLowerCase())) {
              score += 60;
            }
          }

          if (score > bestScore) {
            bestScore = score;
            bestTarget = new Vec3(cx * 16 + 8, origin.y, cz * 16 + 8);
          }
        }
      }

      // Early break if a solid nearby frontier candidate has been found
      if (bestTarget && bestScore >= 70) {
        break;
      }
    }

    if (bestTarget) {
      return bestTarget;
    }

    // Fallback: If all local chunks exhausted, explore outward in positive X/Z
    return new Vec3(origin.x + 32, origin.y, origin.z);
  }
}

export const globalExplorationGrid = new ExplorationGrid();

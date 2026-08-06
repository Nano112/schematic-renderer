import * as THREE from "three";
import { SchematicRenderer } from "./SchematicRenderer";
import { SchematicObject } from "./managers/SchematicObject";
import { MaterialRegistry } from "./MaterialRegistry";
import type {
	ChunkMeshes,
	ProcessedBlockGeometry,
	PaletteMaterialGroup,
	PaletteBlockData,
	PaletteCache,
	ChunkGeometryData,
} from "./types";
// @ts-ignore
import { Cubane } from "./cubane";
import { InstancedBlockRenderer } from "./InstancedBlockRenderer";
import { performanceMonitor } from "./performance/PerformanceMonitor";
// Worker imports - Vite handles bundling
// @ts-ignore
import MeshBuilderWorker from "./workers/MeshBuilder.worker?worker&inline";
// @ts-ignore
import MeshBuilderWasmWorker from "./workers/MeshBuilderWasm.worker?worker&inline";
import { GPUCapabilityManager } from "./gpu/GPUCapabilityManager";
import { ComputeMeshBuilder } from "./gpu/ComputeMeshBuilder";
import { getSharedMemoryPool, SharedMemoryPool } from "./workers/SharedMemoryManager";

export const INVISIBLE_BLOCKS = new Set([
	"minecraft:air",
	"minecraft:cave_air",
	"minecraft:void_air",
	"minecraft:structure_void",
	"minecraft:light",
	"minecraft:barrier",
]);

// Constants matching worker
const POSITION_SCALE = 1024;

/**
 * Convert Int8 normals to Float32 for WebGPU compatibility.
 * WebGPU requires vertex buffer strides to be multiples of 4 bytes.
 * Int8 with 3 components has stride 3, which is invalid for WebGPU.
 */
function convertInt8NormalsToFloat32(int8Normals: Int8Array): Float32Array {
	const float32Normals = new Float32Array(int8Normals.length);
	for (let i = 0; i < int8Normals.length; i++) {
		// Normalize from [-128, 127] to [-1.0, 1.0]
		float32Normals[i] = int8Normals[i] / 127.0;
	}
	return float32Normals;
}

export class WorldMeshBuilder {
	// @ts-ignore
	private schematicRenderer: SchematicRenderer;
	private cubane: Cubane;
	private paletteCache: PaletteCache | null = null;
	private instancedRenderer: InstancedBlockRenderer | null = null;
	private useInstancedRendering: boolean = false;

	// Worker Pool. Each builder has a unique meshContextId so that when several
	// builders share one context's worker pool, their palettes stay separate in
	// the workers (one WASM MeshBuilder per id). Single-instance use is unaffected.
	private static nextMeshContextId = 0;
	private readonly meshContextId = `mctx-${WorldMeshBuilder.nextMeshContextId++}`;
	private workers: Worker[] = [];
	private freeWorkers: Worker[] = [];
	private workerQueue: ((worker: Worker) => void)[] = []; // Queue for waiting tasks
	private workerWaiters = new Map<(worker: Worker) => void, (reason?: unknown) => void>();
	private borrowedWorkers = new Set<Worker>();
	private disposed = false;
	private pendingRequests = new Map<
		string,
		{ resolve: (value: any) => void; reject: (reason?: any) => void; worker: Worker }
	>();
	// Cap at 8 workers - more than that has diminishing returns and increases startup overhead
	private maxWorkers: number = Math.min(navigator.hardwareConcurrency || 4, 8);

	// Chunk size configuration for buffer sizing
	private chunkSize: number = 16; // Default Minecraft chunk size

	// Phase 2 optimizations configuration
	private useQuantization: boolean = false;

	// WebGPU Compute
	private useGPUCompute: boolean = false;
	private computeMeshBuilder: ComputeMeshBuilder | null = null;
	private gpuInitPromise: Promise<boolean> | null = null;

	// WASM Mesh Builder
	private useWasmMeshBuilder: boolean = false;

	// Timing stats for performance debugging
	private _timingStats: {
		count: number;
		worker: number;
		buffer: number;
		maxWorker: number;
		maxBuffer: number;
	} | null = null;

	// SharedArrayBuffer for zero-copy transfers
	private sharedMemoryPool: SharedMemoryPool | null = null;
	private useSharedMemory: boolean = false;

	constructor(schematicRenderer: SchematicRenderer, cubane: Cubane) {
		this.cubane = cubane;
		this.schematicRenderer = schematicRenderer;
		// Check WASM option (enabled by default)
		this.useWasmMeshBuilder = schematicRenderer.options.wasmMeshBuilderOptions?.enabled ?? true;
		// Check for custom maxWorkers setting
		const configuredMaxWorkers = schematicRenderer.options.wasmMeshBuilderOptions?.maxWorkers;
		if (configuredMaxWorkers && configuredMaxWorkers > 0) {
			this.maxWorkers = configuredMaxWorkers;
		}
		// Try GPU compute first, fall back to workers
		this.initializeGPUCompute();
	}

	/**
	 * Initialize WebGPU compute for mesh building
	 * Falls back to workers if WebGPU is not available
	 */
	private async initializeGPUCompute(): Promise<boolean> {
		if (this.gpuInitPromise) {
			return this.gpuInitPromise;
		}

		this.gpuInitPromise = this._doInitializeGPU();
		return this.gpuInitPromise;
	}

	private async _doInitializeGPU(): Promise<boolean> {
		let initializingBuilder: ComputeMeshBuilder | null = null;
		try {
			if (this.disposed) return false;

			// Check if GPU compute is enabled in options
			const gpuOptions = this.schematicRenderer.options.gpuComputeOptions;
			if (!gpuOptions?.enabled) {
				this.initializeWorkers();
				return false;
			}

			// Check if WebGPU is available
			const isAvailable = await GPUCapabilityManager.isWebGPUAvailable();
			if (this.disposed) return false;
			if (!isAvailable) {
				this.initializeWorkers();
				return false;
			}

			// Initialize compute mesh builder
			initializingBuilder = new ComputeMeshBuilder();
			this.computeMeshBuilder = initializingBuilder;
			const success = await initializingBuilder.initialize();
			if (this.disposed) {
				// dispose() may have run while initialize() was allocating GPU buffers.
				// Dispose again after the continuation so late resources cannot escape.
				initializingBuilder.dispose();
				if (this.computeMeshBuilder === initializingBuilder) this.computeMeshBuilder = null;
				return false;
			}

			if (success) {
				this.useGPUCompute = true;
				console.warn("  WARNING: GPU compute is ~6x SLOWER than workers due to GPU→CPU readback!");
				console.warn("  Textures will not render correctly (wireframe only).");
				console.warn("  Set gpuComputeOptions.enabled = false for better performance.");
				return true;
			} else {
				console.warn("[WorldMeshBuilder] GPU compute init failed, using worker fallback");
				initializingBuilder.dispose();
				this.computeMeshBuilder = null;
				this.initializeWorkers();
				return false;
			}
		} catch (error) {
			initializingBuilder?.dispose();
			if (this.disposed) return false;
			console.warn("[WorldMeshBuilder] GPU compute error, using worker fallback:", error);
			this.computeMeshBuilder = null;
			this.initializeWorkers();
			return false;
		}
	}

	/**
	 * Check if GPU compute is being used
	 */
	public isUsingGPUCompute(): boolean {
		return this.useGPUCompute && this.computeMeshBuilder !== null;
	}

	private initializeWorkers() {
		if (this.disposed) return;
		if (this.workers.length > 0) return;

		// Initialize shared memory pool for zero-copy transfers
		this.sharedMemoryPool = getSharedMemoryPool();
		this.useSharedMemory = this.sharedMemoryPool.usingSharedMemory();

		const context = this.schematicRenderer.options.context;
		// Sharing is supported only for the WASM worker (the default), whose palette
		// is namespaced per meshContextId. The JS worker stays per-renderer.
		if (context && this.useWasmMeshBuilder) {
			// Share one worker pool across every renderer on this context (WASM is
			// initialized once per worker; palettes are namespaced by meshContextId).
			// onmessage is (re)bound per acquire in getFreeWorker, since workers are
			// borrowed exclusively by one builder at a time.
			this.workers = context.getSharedWorkers(this.maxWorkers, true);
			this.freeWorkers = context.sharedFreeWorkers;
			this.workerQueue = context.sharedWorkerQueue;
			return;
		}

		for (let i = 0; i < this.maxWorkers; i++) {
			// Use WASM worker if enabled, otherwise use JavaScript worker
			const worker = this.useWasmMeshBuilder
				? new MeshBuilderWasmWorker()
				: new MeshBuilderWorker();
			worker.onmessage = (event: MessageEvent) => this.handleWorkerMessage(worker, event);
			this.workers.push(worker);
			this.freeWorkers.push(worker);
		}
	}

	/**
	 * Check if using WASM mesh builder
	 */
	public isUsingWasmMeshBuilder(): boolean {
		return this.useWasmMeshBuilder && this.workers.length > 0;
	}

	/**
	 * Check if using SharedArrayBuffer
	 */
	public isUsingSharedMemory(): boolean {
		return this.useSharedMemory && this.sharedMemoryPool !== null;
	}

	// Greedy meshing state
	private greedyMeshingEnabled = false;

	/**
	 * Enable or disable greedy meshing optimization
	 * Greedy meshing merges coplanar faces into larger quads, reducing vertex count significantly
	 */
	public setGreedyMeshing(enabled: boolean): void {
		this.greedyMeshingEnabled = enabled;

		// Notify all workers
		for (const worker of this.workers) {
			worker.postMessage({ type: "setGreedyMeshing", enabled });
		}
	}

	/**
	 * Check if greedy meshing is enabled
	 */
	public isGreedyMeshingEnabled(): boolean {
		return this.greedyMeshingEnabled;
	}

	// Static stats collector
	static stats = {
		totalSetup: 0,
		totalSort: 0,
		totalMerge: 0,
		totalWorkerTime: 0,
		chunkCount: 0,
	};

	static resetStats() {
		this.stats = {
			totalSetup: 0,
			totalSort: 0,
			totalMerge: 0,
			totalWorkerTime: 0,
			chunkCount: 0,
		};
	}

	// Batch mode state
	private batchPendingChunks: Map<string, { resolve: () => void; reject: (err: any) => void }> =
		new Map();
	private batchFinishResolve: ((data: any) => void) | null = null;
	private _batchFinishReject: ((err: any) => void) | null = null;

	private handleWorkerMessage(worker: Worker, event: MessageEvent) {
		const { type, chunkId, error, timings, ...data } = event.data;

		if (type === "chunkBuilt") {
			if (timings) {
				WorldMeshBuilder.stats.totalSetup += timings.setup;
				WorldMeshBuilder.stats.totalSort += timings.sort;
				WorldMeshBuilder.stats.totalMerge += timings.merge;
				WorldMeshBuilder.stats.totalWorkerTime += timings.total;
				WorldMeshBuilder.stats.chunkCount++;

				if (WorldMeshBuilder.stats.chunkCount % 50 === 0) {
					const avg = (val: number) => (val / WorldMeshBuilder.stats.chunkCount).toFixed(2);
					console.log(
						`[WorkerStats] Avg (n=${WorldMeshBuilder.stats.chunkCount}): Setup ${avg(WorldMeshBuilder.stats.totalSetup)}ms, Sort ${avg(WorldMeshBuilder.stats.totalSort)}ms, Merge ${avg(WorldMeshBuilder.stats.totalMerge)}ms, Total ${avg(WorldMeshBuilder.stats.totalWorkerTime)}ms`
					);
				}
			}

			const request = this.pendingRequests.get(chunkId);
			if (request) {
				request.resolve(data);
				this.pendingRequests.delete(chunkId);

				// Return worker to pool
				this.returnWorker(worker);
			} else if (this.disposed) {
				// A shared worker can finish after this builder rejected its request.
				// Return that outstanding lease to the context for sibling renderers.
				this.returnWorker(worker);
			}
		} else if (type === "chunkAccumulated") {
			// Batch mode: chunk accumulated. The batch holds its worker for the whole
			// run (released in processChunksBatched's `finally`) — do NOT return it
			// here, or with a shared pool another build grabs it mid-batch and rebinds
			// onmessage, misrouting this build's remaining responses (deadlock at 0/N).
			const request = this.batchPendingChunks.get(chunkId);
			if (request) {
				if (this.disposed) request.reject(new Error("WorldMeshBuilder disposed during batch"));
				else request.resolve();
				this.batchPendingChunks.delete(chunkId);
				if (this.disposed) this.returnWorker(worker);
			}
		} else if (type === "batchFinished") {
			// Batch mode complete - return accumulated meshes
			if (this.batchFinishResolve || this._batchFinishReject) {
				if (this.disposed) {
					this._batchFinishReject?.(new Error("WorldMeshBuilder disposed during batch"));
					this.returnWorker(worker);
				} else {
					this.batchFinishResolve?.(data);
				}
				this.batchFinishResolve = null;
				this._batchFinishReject = null;
			}
		} else if (type === "error") {
			if (chunkId) {
				const request = this.pendingRequests.get(chunkId);
				if (request) {
					request.reject(new Error(error));
					this.pendingRequests.delete(chunkId);
					this.returnWorker(worker);
				} else {
					const batchRequest = this.batchPendingChunks.get(chunkId);
					batchRequest?.reject(new Error(error));
					if (batchRequest) this.batchPendingChunks.delete(chunkId);
					if (batchRequest || this.disposed) this.returnWorker(worker);
				}
			} else if (this._batchFinishReject) {
				this._batchFinishReject(new Error(error));
				this.batchFinishResolve = null;
				this._batchFinishReject = null;
				this.returnWorker(worker);
			} else if (this.disposed) {
				this.returnWorker(worker);
			} else {
				console.error("[WorldMeshBuilder] Worker error:", error);
			}
		} else if (type === "paletteUpdated") {
			// Optional: handle palette update confirmation
		}
	}

	private returnWorker(worker: Worker) {
		// A timeout or late worker response can try to return the same lease twice.
		if (!this.borrowedWorkers.delete(worker)) return;

		const context = this.schematicRenderer.options.context;
		if (context && this.useWasmMeshBuilder) {
			const resolve = context.sharedWorkerQueue.shift();
			if (resolve) resolve(worker);
			else if (!context.sharedFreeWorkers.includes(worker)) context.sharedFreeWorkers.push(worker);
			return;
		}

		if (!this.workers.includes(worker)) return; // Worker might have been terminated

		if (this.workerQueue.length > 0) {
			const resolve = this.workerQueue.shift()!;
			resolve(worker);
		} else {
			this.freeWorkers.push(worker);
		}
	}

	public setChunkSize(newChunkSize: number): void {
		if (newChunkSize <= 0 || newChunkSize > 64) {
			throw new Error("Chunk size must be between 1 and 64");
		}
		this.chunkSize = newChunkSize;
	}

	public getChunkSize(): number {
		return this.chunkSize;
	}

	public setQuantization(enabled: boolean): void {
		this.useQuantization = enabled;
	}

	public getQuantization(): boolean {
		return this.useQuantization;
	}

	// Removed unused isBlockOccluding method
	private rotateOcclusionFlags(flags: number, rotation: { x?: number; y?: number } = {}): number {
		const x = Number(rotation.x || 0);
		const y = Number(rotation.y || 0);
		if (x % 90 !== 0 || y % 90 !== 0) return 0;

		const directions: Array<[number, number, number]> = [
			[-1, 0, 0],
			[1, 0, 0],
			[0, -1, 0],
			[0, 1, 0],
			[0, 0, -1],
			[0, 0, 1],
		];
		const bitByDirection: Record<string, number> = {
			"-1,0,0": 0,
			"1,0,0": 1,
			"0,-1,0": 2,
			"0,1,0": 3,
			"0,0,-1": 4,
			"0,0,1": 5,
		};
		const xTurns = (((x % 360) + 360) % 360) / 90;
		const yTurns = (((y % 360) + 360) % 360) / 90;
		let rotated = 0;

		for (let bit = 0; bit < directions.length; bit++) {
			if (!(flags & (1 << bit))) continue;
			let [dx, dy, dz] = directions[bit];
			for (let turn = 0; turn < xTurns; turn++) [dy, dz] = [dz, -dy];
			for (let turn = 0; turn < yTurns; turn++) [dx, dz] = [-dz, dx];
			rotated |= 1 << bitByDirection[[dx, dy, dz].join(",")];
		}

		return rotated;
	}

	private async computeOcclusionFlags(
		blockString: string,
		category: keyof ChunkMeshes = "solid"
	): Promise<number> {
		// Liquids get their own render category and must cull against themselves,
		// like glass-on-glass. Their synthesized model carries no `cullface` and is
		// sub-cube height (14/16), so the generic opaque/full-face path below never
		// flags them and adjacent water faces are never hidden. Treat every face as
		// self-occluding: the worker only culls a face when the SAME-category
		// neighbour has the opposite bit set, so water still won't cull solids, and
		// the worker's flush test keeps the 14/16-high top surface visible.
		if (category === "water") {
			return 0b111111; // all six faces occlude same-category (water) neighbours
		}

		try {
			// @ts-ignore - Accessing Cubane's optimization data
			const data = await this.cubane.getBlockOptimizationData(blockString, "plains", true);

			if (!data || !data.cullableFaces) {
				return 0;
			}

			let flags = 0;
			const mapping: Record<string, number> = {
				west: 0,
				east: 1,
				down: 2,
				up: 3,
				north: 4,
				south: 5,
			};

			// @ts-ignore
			for (const [dir, faces] of data.cullableFaces.entries()) {
				const bit = mapping[dir];
				if (bit === undefined) continue;

				let isOpaque = true;
				let isFullFace = false;

				if (Array.isArray(faces)) {
					for (const face of faces) {
						// Check opacity
						if (face.material && face.material.transparent && face.material.opacity < 1.0) {
							isOpaque = false;
							break;
						}

						// Check bounds if available to ensure it's a full face
						if (face.elementBounds) {
							const [min, max] = face.elementBounds;
							// min and max are [x, y, z] in 0..16 coordinates typically

							let width = 0,
								height = 0;

							if (dir === "up" || dir === "down") {
								// Check X and Z
								width = max[0] - min[0];
								height = max[2] - min[2];
							} else if (dir === "north" || dir === "south") {
								// Check X and Y
								width = max[0] - min[0];
								height = max[1] - min[1];
							} else if (dir === "east" || dir === "west") {
								// Check Y and Z
								width = max[1] - min[1];
								height = max[2] - min[2];
							}

							// Assume 16 is the full block size.
							// Allow small epsilon for float precision.
							if (width > 15.9 && height > 15.9) {
								isFullFace = true;
							}
						} else {
							// Fallback if no bounds: trust 'isCube' property if available.
							// If it's a cube, all cullable faces are full faces.
							// @ts-ignore
							if (data.isCube) isFullFace = true;
						}
					}
				}

				if (isOpaque && isFullFace) {
					flags |= 1 << bit;
				}
			}

			const block = this.cubane.parseBlockString(blockString);
			// Trapdoors are cutout surfaces. They must never hide the full face of
			// an adjacent block, regardless of their open/half/facing state.
			if (block.name.endsWith("_trapdoor")) return 0;
			return this.rotateOcclusionFlags(flags, data.modelRotation);
		} catch {
			return 0;
		}
	}

	/**
	 * Invalidate the palette cache to force re-computation of geometries.
	 * Call this when textures/materials change (e.g., resource pack change).
	 */
	public invalidateCache(): void {
		console.log("[WorldMeshBuilder] Invalidating cache");
		if (this.paletteCache) {
			this.paletteCache.blockData.forEach((blockData) => {
				blockData.materialGroups.forEach((group) => {
					if (group.baseGeometry) {
						group.baseGeometry.dispose();
					}
				});
			});
			this.paletteCache = null;
		}
	}

	public async precomputePaletteGeometries(palette: any[]): Promise<void> {
		performanceMonitor.startOperation("precomputePaletteGeometries");

		// Check if palette is effectively the same
		if (this.paletteCache?.isReady && this.paletteCache.palette.length === palette.length) {
			// Quick heuristic check: if length is same and first/last items match, assume same palette
			// (Since palette order is usually deterministic from WASM)
			const firstMatch =
				palette.length === 0 ||
				(palette[0].name === this.paletteCache.palette[0].name &&
					JSON.stringify(palette[0].properties) ===
						JSON.stringify(this.paletteCache.palette[0].properties));
			const lastIdx = palette.length - 1;
			const lastMatch =
				palette.length === 0 ||
				(palette[lastIdx].name === this.paletteCache.palette[lastIdx].name &&
					JSON.stringify(palette[lastIdx].properties) ===
						JSON.stringify(this.paletteCache.palette[lastIdx].properties));

			if (firstMatch && lastMatch) {
				performanceMonitor.endOperation("precomputePaletteGeometries");
				return;
			}
		}

		// Reset stats on start
		WorldMeshBuilder.resetStats();

		// Re-initialize GPU compute if it was disposed (e.g., during cleanup between runs)
		// This must happen BEFORE worker initialization to allow GPU to take precedence
		if (!this.gpuInitPromise && this.schematicRenderer.options.gpuComputeOptions?.enabled) {
			this.gpuInitPromise = this._doInitializeGPU();
		}

		// Wait for GPU init if in progress - GPU init will create workers as fallback if needed
		if (this.gpuInitPromise) {
			await this.gpuInitPromise;
		} else {
			// Only initialize workers if GPU is not being used
			this.initializeWorkers();
		}

		const paletteBlockData: PaletteBlockData[] = new Array(palette.length);
		const globalMaterialMap = new Map<string, THREE.Material>();
		const globalMaterials: THREE.Material[] = [];
		const paletteGeometryData: any[] = [];

		// Process all palette entries
		const CONCURRENCY_LIMIT = 8;
		let currentIndex = 0;
		const workerPromises: Promise<void>[] = [];

		const processBlock = async (index: number) => {
			const blockState = palette[index];
			const blockString = this.createBlockStringFromPaletteEntry(blockState);
			const biome = "plains";

			try {
				// Get geometry from Cubane (Main Thread)
				const cubaneObj = await this.cubane.getBlockMesh(blockString, biome, true);
				const extractedGeometries = cubaneObj
					? this.extractAllMeshData(cubaneObj)
					: this.extractAllMeshData(this.createFallbackObject3D(blockString));

				// Create material groups for this block type
				const materialGroups: PaletteMaterialGroup[] = [];
				const geometryData: any[] = [];

				for (const { geometry, material } of extractedGeometries) {
					if (geometry.attributes.position.count === 0) continue;

					// Get or create shared material
					const sharedMaterial = MaterialRegistry.getMaterial(material);
					const materialKey = sharedMaterial.uuid;

					// Get or assign global material index
					let globalMaterial = globalMaterialMap.get(materialKey);
					if (!globalMaterial) {
						globalMaterial = sharedMaterial;
						globalMaterialMap.set(materialKey, globalMaterial);
						globalMaterials.push(globalMaterial);
					}

					const materialIndex = globalMaterials.indexOf(globalMaterial);

					materialGroups.push({
						material: globalMaterial,
						baseGeometry: geometry,
						positions: [],
						materialIndex: materialIndex,
					});

					// Extract buffers for worker
					geometryData.push({
						positions: geometry.attributes.position.array,
						normals: geometry.attributes.normal?.array,
						uvs: geometry.attributes.uv?.array,
						indices: geometry.index?.array || null,
						materialIndex: materialIndex,
					});
				}

				const category = this.getBlockCategory(blockState.name, blockState.properties);

				paletteBlockData[index] = {
					blockName: blockState.name,
					materialGroups,
					category,
				};

				// Add to worker payload
				if (geometryData.length > 0) {
					const occlusionFlags = await this.computeOcclusionFlags(blockString, category);
					paletteGeometryData.push({
						index,
						category,
						occlusionFlags: occlusionFlags,
						isCubic: occlusionFlags === 63, // Optimization: All 6 faces are occluding = full cube
						geometries: geometryData,
					});
				}
			} catch (error) {
				console.warn(`Error processing palette index ${index}:`, error);
			}
		};

		// Process with concurrency limit
		while (currentIndex < palette.length || workerPromises.length > 0) {
			while (workerPromises.length < CONCURRENCY_LIMIT && currentIndex < palette.length) {
				const index = currentIndex++;
				const promise = processBlock(index).then(() => {
					const idx = workerPromises.indexOf(promise);
					if (idx > -1) workerPromises.splice(idx, 1);
				});
				workerPromises.push(promise);
			}

			if (workerPromises.length > 0) {
				await Promise.race(workerPromises.map((p) => p.catch(() => {})));
			} else if (currentIndex >= palette.length) {
				break;
			}
		}

		this.paletteCache = {
			palette: palette,
			blockData: paletteBlockData,
			globalMaterials,
			isReady: true,
		};

		// Wait for GPU init to complete
		if (this.gpuInitPromise) {
			await this.gpuInitPromise;
		}

		// Upload to GPU if using GPU compute, otherwise broadcast to workers
		if (this.useGPUCompute && this.computeMeshBuilder) {
			await this.computeMeshBuilder.uploadPaletteData(this.paletteCache);
		} else {
			this.workers.forEach((worker) => {
				worker.postMessage({
					type: "updatePalette",
					paletteData: paletteGeometryData,
					meshContextId: this.meshContextId,
				});
			});
		}
	}

	// Helper to acquire a worker. Rebinds onmessage to THIS builder so that, with a
	// shared pool, responses route back to the builder that borrowed the worker
	// (workers are lent exclusively until returnWorker).
	private async getFreeWorker(): Promise<Worker> {
		if (this.disposed) throw new Error("WorldMeshBuilder disposed while waiting for a worker");

		const bind = (worker: Worker): Worker => {
			worker.onmessage = (event: MessageEvent) => this.handleWorkerMessage(worker, event);
			this.borrowedWorkers.add(worker);
			return worker;
		};
		if (this.freeWorkers.length > 0) {
			return bind(this.freeWorkers.pop()!);
		}
		// Wait for a worker to become free
		return new Promise<Worker>((resolve, reject) => {
			const waiter = (worker: Worker) => {
				this.workerWaiters.delete(waiter);
				if (this.disposed) {
					// Disposal may race a sibling returning a shared worker. Hand the lease
					// straight back instead of binding it to this dead builder.
					const context = this.schematicRenderer.options.context;
					if (context && this.useWasmMeshBuilder) {
						const next = context.sharedWorkerQueue.shift();
						if (next) next(worker);
						else if (!context.sharedFreeWorkers.includes(worker)) {
							context.sharedFreeWorkers.push(worker);
						}
					}
					reject(new Error("WorldMeshBuilder disposed while waiting for a worker"));
					return;
				}
				resolve(bind(worker));
			};
			this.workerWaiters.set(waiter, reject);
			this.workerQueue.push(waiter);
		});
	}

	/**
	 * Process all chunks in batch mode - returns merged meshes
	 * instead of one mesh per chunk. This reduces main thread work significantly.
	 *
	 * CRITICAL: We split into sub-batches to avoid creating meshes that are too large.
	 * Without this, a 256³ schematic creates 3 meshes with millions of vertices = crash.
	 *
	 * @param allChunks - Iterator or array of chunk data
	 * @param onProgress - Optional progress callback
	 * @returns Promise with merged meshes
	 */
	public async processChunksBatched(
		allChunks: Array<{
			blocks: Int32Array | number[][];
			chunk_x: number;
			chunk_y: number;
			chunk_z: number;
			// Neighbouring chunks' boundary blocks for cross-chunk face culling (occlusion only).
			apronBlocks?: Int32Array;
		}>,
		onProgress?: (processed: number, total: number) => void
	): Promise<THREE.Mesh[]> {
		if (!this.paletteCache?.isReady) {
			throw new Error("Palette cache not ready. Call precomputePaletteGeometries() first.");
		}

		if (this.workers.length === 0) {
			this.initializeWorkers();
		}

		const totalChunks = allChunks.length;
		let globalProcessedCount = 0;

		// CRITICAL: Split into sub-batches to avoid creating meshes that are too large
		// Each sub-batch creates ~3 meshes (solid, transparent, etc.)
		// Without this, a 256³ schematic creates 3 meshes with millions of vertices each = crash
		const SUB_BATCH_SIZE = 64; // ~64 chunks per sub-batch = manageable mesh sizes
		const allResultMeshes: THREE.Mesh[] = [];

		const numSubBatches = Math.ceil(totalChunks / SUB_BATCH_SIZE);

		// Acquire one worker exclusively for the whole batch so this works with a
		// shared pool (other builders use other workers). Released in `finally`.
		const batchWorker = await this.getFreeWorker();
		try {
			for (let subBatchIdx = 0; subBatchIdx < numSubBatches; subBatchIdx++) {
				if (this.disposed) throw new Error("WorldMeshBuilder disposed during batch");
				const subBatchStart = subBatchIdx * SUB_BATCH_SIZE;
				const subBatchEnd = Math.min(subBatchStart + SUB_BATCH_SIZE, totalChunks);
				const subBatchChunks = allChunks.slice(subBatchStart, subBatchEnd);

				// Start batch mode on worker for this sub-batch
				batchWorker.postMessage({ type: "startBatch", meshContextId: this.meshContextId });

				// Process this sub-batch's chunks through the batch worker
				for (const chunkData of subBatchChunks) {
					if (this.disposed) throw new Error("WorldMeshBuilder disposed during batch");
					const chunkId = `batch_${chunkData.chunk_x}_${chunkData.chunk_y}_${chunkData.chunk_z}`;

					// Convert blocks to Int32Array if needed
					let blocksArray: Int32Array;
					if (chunkData.blocks instanceof Int32Array) {
						blocksArray = chunkData.blocks;
					} else {
						blocksArray = new Int32Array(chunkData.blocks.length * 4);
						for (let i = 0; i < chunkData.blocks.length; i++) {
							const block = chunkData.blocks[i];
							blocksArray[i * 4] = block[0];
							blocksArray[i * 4 + 1] = block[1];
							blocksArray[i * 4 + 2] = block[2];
							blocksArray[i * 4 + 3] = block[3];
						}
					}

					// Calculate origin
					let minX = Infinity,
						minY = Infinity,
						minZ = Infinity;
					for (let i = 0; i < blocksArray.length; i += 4) {
						minX = Math.min(minX, blocksArray[i]);
						minY = Math.min(minY, blocksArray[i + 1]);
						minZ = Math.min(minZ, blocksArray[i + 2]);
					}
					const originX = isFinite(minX) ? minX : 0;
					const originY = isFinite(minY) ? minY : 0;
					const originZ = isFinite(minZ) ? minZ : 0;

					// Wait for chunk to be accumulated
					await new Promise<void>((resolve, reject) => {
						this.batchPendingChunks.set(chunkId, { resolve, reject });

						// Use SharedArrayBuffer if available
						if (this.useSharedMemory && this.sharedMemoryPool) {
							const sharedBuffer = this.sharedMemoryPool.writeChunkInput(
								chunkId,
								blocksArray,
								originX,
								originY,
								originZ
							);
							batchWorker.postMessage({
								type: "buildChunkBatched",
								chunkId,
								sharedInputBuffer: sharedBuffer,
								chunkOrigin: [originX, originY, originZ],
								apronBlocks: chunkData.apronBlocks, // occlusion-only neighbour shell
								meshContextId: this.meshContextId,
							});
						} else {
							batchWorker.postMessage(
								{
									type: "buildChunkBatched",
									chunkId,
									blocks: blocksArray,
									chunkOrigin: [originX, originY, originZ],
									apronBlocks: chunkData.apronBlocks, // occlusion-only neighbour shell
									meshContextId: this.meshContextId,
								},
								[blocksArray.buffer]
							);
						}
					});

					globalProcessedCount++;
					if (onProgress) {
						onProgress(globalProcessedCount, totalChunks);
					}
				}

				// Finish this sub-batch and get merged results
				const batchResult = await new Promise<any>((resolve, reject) => {
					this.batchFinishResolve = resolve;
					this._batchFinishReject = reject;
					batchWorker.postMessage({ type: "finishBatch", meshContextId: this.meshContextId });
				});

				// Create Three.js meshes from this sub-batch's merged data
				const subBatchMeshes = this.createMeshesFromBatchResult(batchResult);
				allResultMeshes.push(...subBatchMeshes);

				// Let browser breathe between sub-batches - use requestAnimationFrame for real breathing
				// This allows the browser to render and process events
				if (subBatchIdx < numSubBatches - 1) {
					await new Promise<void>((r) => {
						requestAnimationFrame(() => {
							setTimeout(r, 0);
						});
					});
				}
			}

			return allResultMeshes;
		} finally {
			// Release the batch worker back to the (possibly shared) pool.
			this.returnWorker(batchWorker);
		}
	}

	/**
	 * Helper to create Three.js meshes from a batch result
	 */
	private createMeshesFromBatchResult(batchResult: any): THREE.Mesh[] {
		const meshes: THREE.Mesh[] = [];

		for (const meshData of batchResult.meshes) {
			// OPTIMIZATION: Sort geometry by material index to minimize draw calls
			// Even within a single mesh, multiple groups cause multiple draw calls
			const optimized = this.optimizeGeometryGroups(meshData);

			const geometry = new THREE.BufferGeometry();

			if (optimized.positions) {
				const posAttr = new THREE.BufferAttribute(optimized.positions, 3);
				geometry.setAttribute("position", posAttr);
			}

			if (optimized.normals) {
				const normAttr = new THREE.BufferAttribute(optimized.normals, 3);
				geometry.setAttribute("normal", normAttr);
			}

			if (optimized.uvs) {
				const uvAttr = new THREE.BufferAttribute(optimized.uvs, 2);
				geometry.setAttribute("uv", uvAttr);
			}

			if (optimized.indices) {
				geometry.setIndex(new THREE.BufferAttribute(optimized.indices, 1));
			}

			if (optimized.groups) {
				for (const group of optimized.groups) {
					geometry.addGroup(group.start, group.count, group.materialIndex);
				}
			}

			const mesh = new THREE.Mesh(geometry, this.paletteCache!.globalMaterials);
			mesh.name = `batched_${meshData.category}`;

			this.configureMeshForCategory(mesh, meshData.category as keyof ChunkMeshes);
			meshes.push(mesh);
		}

		return meshes;
	}

	/**
	 * OPTIMIZATION: Sort geometry data by material index to merge groups
	 * This reduces draw calls from N_blocks to N_materials per mesh
	 */
	private optimizeGeometryGroups(meshData: any): any {
		if (!meshData.groups || meshData.groups.length <= 1) {
			// Pre-convert normals if needed
			if (meshData.normals && meshData.normals instanceof Int8Array) {
				meshData.normals = convertInt8NormalsToFloat32(meshData.normals);
			}
			return meshData;
		}

		// Check if already sorted/minimal (heuristic: count groups vs materials)
		// If groups.length is huge but unique materials is small, we need to optimize
		const uniqueMaterials = new Set(meshData.groups.map((g: any) => g.materialIndex)).size;
		if (meshData.groups.length <= uniqueMaterials * 1.5) {
			// Already optimized enough
			if (meshData.normals && meshData.normals instanceof Int8Array) {
				meshData.normals = convertInt8NormalsToFloat32(meshData.normals);
			}
			return meshData;
		}

		// Prepare new arrays
		const positions = meshData.positions;
		const normals = meshData.normals; // Int8Array usually
		const uvs = meshData.uvs;
		const indices = meshData.indices;

		// const vertexCount = positions.length / 3;
		// const indexCount = indices ? indices.length : vertexCount;

		// We need to reorder everything based on material index
		// 1. Group all existing groups by material index
		const groupsByMaterial = new Map<number, any[]>();
		for (const group of meshData.groups) {
			if (!groupsByMaterial.has(group.materialIndex)) {
				groupsByMaterial.set(group.materialIndex, []);
			}
			groupsByMaterial.get(group.materialIndex)!.push(group);
		}

		// 2. Calculate new size (same as old)
		// const newPositions = new Float32Array(positions.length);
		// const newNormals = normals ? new Float32Array(normals.length) : null;
		// const newUVs = uvs ? new Float32Array(uvs.length) : null;
		// Use same type for indices (Uint16 or Uint32)
		const NewIndexType = indices instanceof Uint16Array ? Uint16Array : Uint32Array;
		const newIndices = indices ? new NewIndexType(indices.length) : null;

		const newGroups: any[] = [];
		let currentIndexOffset = 0;
		const currentVertexOffset = 0; // Only relevant if not using indices (unlikely)

		// 3. Iterate materials and rebuild buffers
		for (const [materialIndex, groups] of groupsByMaterial.entries()) {
			const groupStart = newIndices ? currentIndexOffset : currentVertexOffset;
			let groupCount = 0;

			for (const group of groups) {
				// Copy data for this group
				// Note: Groups refer to INDICES range (start, count)
				// But vertices are not necessarily contiguous for the group!
				// Wait, standard Three.js groups just define a range of the INDEX buffer to render.
				// If the index buffer points to vertices all over the place, that's fine.
				// BUT we want to make the INDEX buffer contiguous for this material.

				if (newIndices && indices) {
					// Copy indices for this group
					// We can copy them directly, but we need to verify if vertices need reordering.
					// If we just reorder indices, that's enough for draw calls!
					// Vertices can stay where they are.
					// Optimization: Just reorder indices.

					const sourceStart = group.start;
					const count = group.count;

					// Copy slice of indices
					const subIndices = indices.subarray(sourceStart, sourceStart + count);
					newIndices.set(subIndices, currentIndexOffset);

					currentIndexOffset += count;
					groupCount += count;
				} else {
					// Non-indexed geometry: we must move vertices.
					// This is rarer but possible.
					// We assume indexed for now as WorldMeshBuilder generates indices.
				}
			}

			newGroups.push({
				start: groupStart,
				count: groupCount,
				materialIndex: materialIndex,
			});
		}

		// 4. Handle Normals conversion
		let finalNormals = normals;
		if (normals && normals instanceof Int8Array) {
			finalNormals = convertInt8NormalsToFloat32(normals);
		}

		// If we only reordered indices, we can reuse vertex buffers!
		// This is much faster than moving vertices.
		if (newIndices) {
			return {
				positions: positions, // Unchanged
				normals: finalNormals, // Converted but order unchanged
				uvs: uvs, // Unchanged
				indices: newIndices, // REORDERED
				groups: newGroups, // OPTIMIZED
				category: meshData.category,
			};
		}

		// Fallback for non-indexed (should not happen with current builder)
		return meshData;
	}

	public async getChunkGeometries(
		chunkData: {
			blocks: Array<number[]> | Int32Array;
			chunk_x: number;
			chunk_y: number;
			chunk_z: number;
		},
		renderingBounds?: {
			min: THREE.Vector3;
			max: THREE.Vector3;
			enabled?: boolean;
		}
	): Promise<{ geometries: ChunkGeometryData[]; origin: number[] }> {
		const chunkId = `${chunkData.chunk_x},${chunkData.chunk_y},${chunkData.chunk_z}`;

		if (!this.paletteCache?.isReady) {
			throw new Error("Palette cache not ready. Call precomputePaletteGeometries() first.");
		}

		if (chunkData.blocks.length === 0) return { geometries: [], origin: [0, 0, 0] };

		// Filter blocks based on bounds
		let blocksToProcess = chunkData.blocks;
		const skipBoundsCheck = !renderingBounds?.enabled;

		if (!skipBoundsCheck) {
			if (chunkData.blocks instanceof Int32Array) {
				const filtered: number[] = [];
				const blocks = chunkData.blocks;
				for (let i = 0; i < blocks.length; i += 4) {
					const x = blocks[i];
					const y = blocks[i + 1];
					const z = blocks[i + 2];
					if (
						x >= renderingBounds!.min.x &&
						x < renderingBounds!.max.x &&
						y >= renderingBounds!.min.y &&
						y < renderingBounds!.max.y &&
						z >= renderingBounds!.min.z &&
						z < renderingBounds!.max.z
					) {
						filtered.push(x, y, z, blocks[i + 3]);
					}
				}
				blocksToProcess = new Int32Array(filtered);
			} else {
				blocksToProcess = chunkData.blocks.filter((block) => {
					const [x, y, z] = block;
					return (
						x >= renderingBounds!.min.x &&
						x < renderingBounds!.max.x &&
						y >= renderingBounds!.min.y &&
						y < renderingBounds!.max.y &&
						z >= renderingBounds!.min.z &&
						z < renderingBounds!.max.z
					);
				});
			}
		}

		if (blocksToProcess.length === 0) return { geometries: [], origin: [0, 0, 0] };

		const originX = chunkData.chunk_x * this.chunkSize;
		const originY = chunkData.chunk_y * this.chunkSize;
		const originZ = chunkData.chunk_z * this.chunkSize;

		// GPU Compute path
		if (this.useGPUCompute && this.computeMeshBuilder?.isReady) {
			try {
				const gpuResult = await this.computeMeshBuilder.buildChunk(
					blocksToProcess as Int32Array,
					[originX, originY, originZ],
					chunkId
				);

				if (gpuResult) {
					return {
						geometries: gpuResult.geometries,
						origin: gpuResult.origin,
					};
				}
			} catch (error) {
				console.warn("[WorldMeshBuilder] GPU compute failed, falling back to workers:", error);
				// Fall through to worker path
			}
		}

		// Worker fallback path
		const workerBlocks = blocksToProcess;

		const workerPromise = new Promise<any>(async (resolve, reject) => {
			if (workerBlocks.length === 0) {
				resolve({ meshes: [] });
				return;
			}

			// Ensure workers exist
			if (this.workers.length === 0) {
				this.initializeWorkers();
			}

			// Get a free worker. The wait is cancellable when this builder is disposed.
			let worker: Worker;
			try {
				worker = await this.getFreeWorker();
			} catch (error) {
				reject(error);
				return;
			}

			// Add timeout to prevent hanging
			const timeoutId = setTimeout(() => {
				if (this.pendingRequests.has(chunkId)) {
					const req = this.pendingRequests.get(chunkId);
					this.pendingRequests.delete(chunkId);
					// Release worker even on timeout
					if (req) {
						this.returnWorker(req.worker);
					}
					reject(new Error(`Chunk build timeout for ${chunkId}`));
				}
			}, 30000); // 30 seconds timeout

			this.pendingRequests.set(chunkId, {
				resolve: (data) => {
					clearTimeout(timeoutId);
					// Clean up shared memory buffer if used
					if (this.sharedMemoryPool) {
						this.sharedMemoryPool.releaseBuffers(chunkId);
					}
					resolve(data);
				},
				reject: (err) => {
					clearTimeout(timeoutId);
					// Clean up shared memory buffer if used
					if (this.sharedMemoryPool) {
						this.sharedMemoryPool.releaseBuffers(chunkId);
					}
					reject(err);
				},
				worker: worker,
			});

			// Use SharedArrayBuffer for zero-copy transfer if available
			if (this.useSharedMemory && this.sharedMemoryPool && workerBlocks instanceof Int32Array) {
				// Write data to shared memory - worker reads directly, no copy!
				const sharedBuffer = this.sharedMemoryPool.writeChunkInput(
					chunkId,
					workerBlocks,
					originX,
					originY,
					originZ
				);

				worker.postMessage({
					type: "buildChunk",
					chunkId,
					sharedInputBuffer: sharedBuffer, // Worker reads from this directly
					chunkOrigin: [originX, originY, originZ],
					meshContextId: this.meshContextId,
				});
			} else {
				// Fallback: transfer via postMessage (copies data)
				const transferList: Transferable[] = [];
				if (workerBlocks instanceof Int32Array) {
					transferList.push(workerBlocks.buffer);
				}

				worker.postMessage(
					{
						type: "buildChunk",
						chunkId,
						blocks: workerBlocks,
						chunkOrigin: [originX, originY, originZ],
						meshContextId: this.meshContextId,
					},
					transferList
				);
			}
		});

		try {
			const workerResult = await workerPromise;
			return {
				geometries: workerResult.meshes as ChunkGeometryData[],
				origin: workerResult.origin || [originX, originY, originZ],
			};
		} catch (error) {
			console.error("Error building chunk geometry:", error);
			return { geometries: [], origin: [0, 0, 0] };
		}
	}

	/**
	 * Render sign block entities as standalone meshes, independent of the build mode.
	 *
	 * The `batched` and `instanced` build paths don't process block entities at all,
	 * and even the chunk path's tile-entity handling lacks the blockstate properties
	 * (facing/rotation) signs need. Signs require BOTH per-instance NBT (the text) and
	 * the blockstate (orientation), so we render them here once per schematic build and
	 * the caller adds the results to the schematic group. The greedy/palette paths emit
	 * nothing for signs (cubane returns empty when called without NBT), so there's no
	 * doubling.
	 */
	public async buildSignMeshes(schematicObject: SchematicObject): Promise<THREE.Object3D[]> {
		const beMap = schematicObject.getBlockEntitiesMap();
		if (beMap.size === 0) return [];

		const wrapper = schematicObject.schematicWrapper;
		const out: THREE.Object3D[] = [];

		for (const entity of beMap.values()) {
			const pos = entity.position;
			if (!pos) continue;

			// Resolve the blockstate (name + facing/rotation) at this position.
			let name: string | undefined;
			const props: Record<string, string> = {};
			try {
				const bs = wrapper.get_block_with_properties(pos[0], pos[1], pos[2]);
				if (bs) {
					name = bs.name();
					const p = bs.properties();
					if (p && typeof p === "object") {
						for (const [k, v] of Object.entries(p)) props[k] = String(v);
					}
				}
			} catch {
				/* fall through */
			}
			if (!name || !name.includes("sign")) continue;

			const propStr = Object.entries(props)
				.map(([k, v]) => `${k}=${v}`)
				.join(",");
			const blockString = propStr ? `${name}[${propStr}]` : name;
			const nbt = entity.nbt || entity;

			try {
				const mesh = await this.cubane.getBlockMesh(blockString, "plains", false, nbt);
				if (!mesh) continue;
				// cubane builds block geometry centred on the integer coordinate (c/16 - 0.5),
				// so the sign (already centred [-0.5,0.5]) goes straight at the block position
				// to line up with the surrounding blocks.
				const off = mesh.position.clone();
				mesh.position.set(pos[0] + off.x, pos[1] + off.y, pos[2] + off.z);
				mesh.name = `sign_${name}_${pos[0]}_${pos[1]}_${pos[2]}`;
				out.push(mesh);
			} catch (e) {
				console.warn("[WorldMeshBuilder] sign build failed", blockString, e);
			}
		}

		return out;
	}

	public async getChunkMesh(
		chunkData: {
			blocks: Array<number[]> | Int32Array;
			chunk_x: number;
			chunk_y: number;
			chunk_z: number;
			// Neighbouring chunks' boundary blocks for cross-chunk face culling (occlusion only).
			apronBlocks?: Int32Array;
		},
		_schematicObject: SchematicObject,
		renderingBounds?: {
			min: THREE.Vector3;
			max: THREE.Vector3;
			enabled?: boolean;
		},
		_preFilteredEntities?: any[] // Kept for API compatibility; block entities use dedicated passes.
	): Promise<THREE.Object3D[]> {
		const chunkId = `${chunkData.chunk_x},${chunkData.chunk_y},${chunkData.chunk_z}`;

		if (!this.paletteCache?.isReady) {
			throw new Error("Palette cache not ready. Call precomputePaletteGeometries() first.");
		}

		if (chunkData.blocks.length === 0) return [];

		// Filter blocks based on bounds
		let blocksToProcess = chunkData.blocks;
		// Optimization: Skip main-thread filtering if bounds are disabled or cover full chunk
		const skipBoundsCheck = !renderingBounds?.enabled;

		if (!skipBoundsCheck) {
			if (chunkData.blocks instanceof Int32Array) {
				const filtered: number[] = [];
				const blocks = chunkData.blocks;
				for (let i = 0; i < blocks.length; i += 4) {
					const x = blocks[i];
					const y = blocks[i + 1];
					const z = blocks[i + 2];
					if (
						x >= renderingBounds!.min.x &&
						x < renderingBounds!.max.x &&
						y >= renderingBounds!.min.y &&
						y < renderingBounds!.max.y &&
						z >= renderingBounds!.min.z &&
						z < renderingBounds!.max.z
					) {
						filtered.push(x, y, z, blocks[i + 3]);
					}
				}
				blocksToProcess = new Int32Array(filtered);
			} else {
				blocksToProcess = chunkData.blocks.filter((block) => {
					const [x, y, z] = block;
					return (
						x >= renderingBounds!.min.x &&
						x < renderingBounds!.max.x &&
						y >= renderingBounds!.min.y &&
						y < renderingBounds!.max.y &&
						z >= renderingBounds!.min.z &&
						z < renderingBounds!.max.z
					);
				});
			}
		}

		if (blocksToProcess.length === 0) return [];

		// Pass all blocks to worker directly. Worker filters invisible blocks. NBT-aware
		// blocks are rendered by dedicated sign and block-entity overlay passes.
		const workerBlocks = blocksToProcess;

		// Determine chunk origin
		const originX = chunkData.chunk_x * this.chunkSize;
		const originY = chunkData.chunk_y * this.chunkSize;
		const originZ = chunkData.chunk_z * this.chunkSize;

		const resultMeshes: THREE.Object3D[] = [];

		// TIMING: Track operation timings
		const timings = {
			workerDispatch: 0,
			bufferGeometry: 0,
		};
		let timingStart = performance.now();

		// Try GPU compute first, then fall back to workers
		let buildResult: { meshes: any[]; origin: number[] } | null = null;

		// GPU Compute path
		if (this.useGPUCompute && this.computeMeshBuilder?.isReady) {
			try {
				const gpuResult = await this.computeMeshBuilder.buildChunk(
					workerBlocks as Int32Array,
					[originX, originY, originZ],
					chunkId
				);

				if (gpuResult) {
					buildResult = {
						meshes: gpuResult.geometries,
						origin: gpuResult.origin,
					};
				}
			} catch (error) {
				console.warn("[WorldMeshBuilder] GPU compute failed, falling back to workers:", error);
				// Fall through to worker path
			}
		}

		// Worker fallback path
		if (!buildResult) {
			const workerPromise = new Promise<any>(async (resolve, reject) => {
				if (workerBlocks.length === 0) {
					resolve({ meshes: [] });
					return;
				}

				// Ensure workers exist
				if (this.workers.length === 0) {
					this.initializeWorkers();
				}

				// TIMING: Measure getFreeWorker wait time
				const getFreeWorkerStart = performance.now();

				// Get a free worker. The wait is cancellable when this builder is disposed.
				let worker: Worker;
				try {
					worker = await this.getFreeWorker();
				} catch (error) {
					reject(error);
					return;
				}

				const getFreeWorkerTime = performance.now() - getFreeWorkerStart;
				if (getFreeWorkerTime > 10) {
					console.warn(
						`[WorkerPool] getFreeWorker took ${getFreeWorkerTime.toFixed(0)}ms (free: ${this.freeWorkers.length}/${this.workers.length}, queue: ${this.workerQueue.length})`
					);
				}

				// Add timeout to prevent hanging
				const timeoutId = setTimeout(() => {
					if (this.pendingRequests.has(chunkId)) {
						const req = this.pendingRequests.get(chunkId);
						this.pendingRequests.delete(chunkId);
						// Release worker even on timeout
						if (req) {
							this.returnWorker(req.worker);
						}
						reject(new Error(`Chunk build timeout for ${chunkId}`));
					}
				}, 30000); // 30 seconds timeout

				this.pendingRequests.set(chunkId, {
					resolve: (data) => {
						clearTimeout(timeoutId);
						// Clean up shared memory buffer if used
						if (this.sharedMemoryPool) {
							this.sharedMemoryPool.releaseBuffers(chunkId);
						}
						resolve(data);
					},
					reject: (err) => {
						clearTimeout(timeoutId);
						// Clean up shared memory buffer if used
						if (this.sharedMemoryPool) {
							this.sharedMemoryPool.releaseBuffers(chunkId);
						}
						reject(err);
					},
					worker: worker,
				});

				// TIMING: Record when we send the message
				const sendTime = performance.now();

				// Use SharedArrayBuffer for zero-copy transfer if available
				if (this.useSharedMemory && this.sharedMemoryPool && workerBlocks instanceof Int32Array) {
					// Write data to shared memory - worker reads directly, no copy!
					const sharedBuffer = this.sharedMemoryPool.writeChunkInput(
						chunkId,
						workerBlocks,
						originX,
						originY,
						originZ
					);

					worker.postMessage({
						type: "buildChunk",
						chunkId,
						sharedInputBuffer: sharedBuffer,
						chunkOrigin: [originX, originY, originZ],
						apronBlocks: chunkData.apronBlocks, // occlusion-only neighbour shell
						meshContextId: this.meshContextId,
						_sendTime: sendTime, // Pass timestamp for round-trip measurement
					});
				} else {
					// Fallback: transfer via postMessage (copies data)
					const transferList: Transferable[] = [];
					if (workerBlocks instanceof Int32Array) {
						transferList.push(workerBlocks.buffer);
					}

					worker.postMessage(
						{
							type: "buildChunk",
							chunkId,
							blocks: workerBlocks,
							chunkOrigin: [originX, originY, originZ],
							apronBlocks: chunkData.apronBlocks, // occlusion-only neighbour shell
							meshContextId: this.meshContextId,
						},
						transferList
					);
				}
			});

			buildResult = await workerPromise;
		}
		timings.workerDispatch = performance.now() - timingStart;
		timingStart = performance.now();

		try {
			// Process build result (same for GPU and worker)
			const workerResult = buildResult;

			if (!workerResult) {
				console.warn("[WorldMeshBuilder] No build result available");
				return resultMeshes;
			}

			// Reconstruct meshes from worker buffers
			if (workerResult.meshes) {
				for (const meshData of workerResult.meshes) {
					const geometry = new THREE.BufferGeometry();

					// Handle quantized positions
					// Worker sends Int16Array, we load it as BufferAttribute
					if (meshData.positions) {
						// BufferAttribute(array, itemSize, normalized)
						// Int16Array with normalized=false sends raw integer values to shader, which are cast to float
						const posAttr = new THREE.BufferAttribute(meshData.positions, 3, false);
						geometry.setAttribute("position", posAttr);
					}

					if (meshData.normals) {
						// Convert Int8 normals to Float32 for WebGPU compatibility
						const float32Normals = convertInt8NormalsToFloat32(meshData.normals);
						const normAttr = new THREE.BufferAttribute(float32Normals, 3);
						geometry.setAttribute("normal", normAttr);
					}

					if (meshData.uvs) {
						// Float32Array for UVs to support tiling > 1.0
						const uvAttr = new THREE.BufferAttribute(meshData.uvs, 2);
						geometry.setAttribute("uv", uvAttr);
					}

					if (meshData.indices) {
						geometry.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
					}

					// Groups
					if (meshData.groups) {
						for (const group of meshData.groups) {
							geometry.addGroup(group.start, group.count, group.materialIndex);
						}
					}

					const mesh = new THREE.Mesh(geometry, this.paletteCache.globalMaterials);
					mesh.name = `${meshData.category}_chunk`;

					// Apply de-quantization scale for position
					// 1.0 / POSITION_SCALE
					const scale = 1.0 / POSITION_SCALE;
					mesh.scale.setScalar(scale);

					// Apply chunk origin offset
					// The worker produces geometry relative to this origin
					if (workerResult.origin) {
						mesh.position.set(
							workerResult.origin[0],
							workerResult.origin[1],
							workerResult.origin[2]
						);
					}

					this.configureMeshForCategory(mesh, meshData.category as keyof ChunkMeshes);
					resultMeshes.push(mesh);
				}
			}
			timings.bufferGeometry = performance.now() - timingStart;
		} catch (error) {
			console.error("Error building chunk mesh:", error);
		}

		// Log detailed timing every 10 chunks
		if (!this._timingStats) {
			this._timingStats = {
				count: 0,
				worker: 0,
				buffer: 0,
				maxWorker: 0,
				maxBuffer: 0,
			};
		}
		this._timingStats.count++;
		this._timingStats.worker += timings.workerDispatch;
		this._timingStats.buffer += timings.bufferGeometry;
		this._timingStats.maxWorker = Math.max(this._timingStats.maxWorker, timings.workerDispatch);
		this._timingStats.maxBuffer = Math.max(this._timingStats.maxBuffer, timings.bufferGeometry);

		if (this._timingStats.count % 10 === 0) {
			const n = this._timingStats.count;
			console.log(
				`[ChunkTiming n=${n}] avg: worker=${(this._timingStats.worker / n).toFixed(1)}ms, buffer=${(this._timingStats.buffer / n).toFixed(1)}ms | max: w=${this._timingStats.maxWorker.toFixed(0)}, b=${this._timingStats.maxBuffer.toFixed(0)}`
			);
		}

		return resultMeshes;
	}

	// Helper methods...
	private createBlockStringFromPaletteEntry(blockState: any): string {
		let blockString = blockState.name || "minecraft:stone";
		if (!blockString.includes(":")) blockString = `minecraft:${blockString}`;

		if (blockState.properties && Object.keys(blockState.properties).length > 0) {
			const props = Object.entries(blockState.properties)
				.map(([k, v]) => `${k}=${v}`)
				.join(",");
			blockString += `[${props}]`;
		}
		return blockString;
	}

	// Blocks that hold water without ever exposing a `waterlogged` property. Mirrors
	// BlockMeshBuilder.ALWAYS_WATERLOGGED so their generated water joins the water pass.
	private static readonly IMPLICIT_WATERLOGGED = new Set<string>([
		"minecraft:kelp",
		"minecraft:kelp_plant",
		"minecraft:seagrass",
		"minecraft:tall_seagrass",
		"minecraft:bubble_column",
	]);

	private getBlockCategory(
		blockName: string,
		properties?: Record<string, string>
	): keyof ChunkMeshes {
		if (blockName.includes("water") || blockName.includes("lava")) return "water";
		// Waterlogged blocks carry a surrounding water cube that must cull against
		// neighbouring water (real water or other waterlogged cells), so they render
		// in the water category. Their own geometry is unaffected: cross/non-flush
		// faces never cull, and solid faces simply draw in the water pass.
		if (
			properties?.waterlogged === "true" ||
			WorldMeshBuilder.IMPLICIT_WATERLOGGED.has(blockName)
		) {
			return "water";
		}
		if (
			blockName.includes("glass") ||
			blockName.includes("leaves") ||
			blockName.includes("ice") ||
			blockName === "minecraft:barrier"
		)
			return "transparent";
		return "solid";
	}

	private configureMeshForCategory(mesh: THREE.Mesh, category: keyof ChunkMeshes): void {
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		mesh.frustumCulled = true;

		// Optimization: Material properties are now handled in precomputePaletteGeometries via MaterialRegistry keys.
		// We only set mesh-level properties here.
		switch (category) {
			case "water":
				mesh.renderOrder = 3;
				break;
			case "transparent":
				mesh.renderOrder = 2;
				break;
			case "emissive":
				mesh.renderOrder = 1;
				break;
			case "redstone":
				mesh.userData.isDynamic = true;
				break;
		}
	}

	private extractAllMeshData(rootCubaneObject: THREE.Object3D): ProcessedBlockGeometry[] {
		const allMeshData: ProcessedBlockGeometry[] = [];
		rootCubaneObject.updateMatrixWorld(true);

		rootCubaneObject.traverse((child) => {
			if (
				child instanceof THREE.Mesh &&
				child.geometry &&
				child.material &&
				child.visible &&
				child !== rootCubaneObject
			) {
				const material = Array.isArray(child.material) ? child.material[0] : child.material;
				if (!material || !(material instanceof THREE.Material)) return;

				const geometry = child.geometry.clone();
				const matrixRelativeToRoot = child.matrixWorld
					.clone()
					.multiply(new THREE.Matrix4().copy(rootCubaneObject.matrixWorld).invert());
				geometry.applyMatrix4(matrixRelativeToRoot);

				if (geometry.attributes.position.count > 0) {
					allMeshData.push({ geometry, material });
				} else {
					geometry.dispose();
				}
			}
		});
		return allMeshData;
	}

	private createFallbackObject3D(blockString: string): THREE.Object3D {
		const mesh = new THREE.Mesh(
			new THREE.BoxGeometry(0.7, 0.7, 0.7),
			new THREE.MeshBasicMaterial({
				color: 0xee00ee,
				wireframe: true,
				name: `fallback-mat-${blockString}`,
			})
		);
		mesh.name = `fallback-mesh-${blockString}`;
		const group = new THREE.Group();
		group.add(mesh);
		group.name = `fallback-object-${blockString}`;
		return group;
	}

	public getPaletteStats() {
		return {
			isReady: this.paletteCache?.isReady || false,
			paletteSize: this.paletteCache?.blockData.length || 0,
			uniqueMaterials: this.paletteCache?.globalMaterials.length || 0,
			memoryEstimate:
				this.paletteCache?.blockData.reduce((total, blockData) => {
					return (
						total +
						blockData.materialGroups.reduce((subtotal, group) => {
							return subtotal + (group.baseGeometry.attributes.position?.count || 0) * 3 * 4;
						}, 0)
					);
				}, 0) || 0,
		};
	}

	public enableInstancedRendering(group: THREE.Group, merged: boolean = false): void {
		this.useInstancedRendering = true;
		this.instancedRenderer = new InstancedBlockRenderer(group, this.paletteCache);

		if (merged) {
			this.instancedRenderer.initializeInstancedMeshesMerged();
		} else {
			this.instancedRenderer.initializeInstancedMeshes();
		}
	}

	public disableInstancedRendering(): void {
		this.useInstancedRendering = false;
		if (this.instancedRenderer) {
			this.instancedRenderer.disposeInstancedMeshes();
			this.instancedRenderer = null;
		}
	}

	public async renderSchematicInstanced(schematicObject: SchematicObject): Promise<void> {
		if (!this.useInstancedRendering || !this.instancedRenderer) {
			throw new Error("Instanced rendering not enabled. Call enableInstancedRendering() first.");
		}

		const schematic = schematicObject.schematicWrapper;

		const allBlockIndices = schematic.blocks_indices();

		const allBlocks: Array<{
			x: number;
			y: number;
			z: number;
			paletteIndex: number;
		}> = [];

		for (const blockData of allBlockIndices) {
			const [x, y, z, paletteIndex] = blockData;

			const renderingBounds = schematicObject.renderingBounds;
			if (renderingBounds?.enabled) {
				if (
					x < renderingBounds.min.x ||
					x > renderingBounds.max.x ||
					y < renderingBounds.min.y ||
					y > renderingBounds.max.y ||
					z < renderingBounds.min.z ||
					z > renderingBounds.max.z
				) {
					continue;
				}
			}

			allBlocks.push({ x, y, z, paletteIndex });
		}

		this.instancedRenderer.renderBlocksInstanced(allBlocks);
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const disposalError = new Error("WorldMeshBuilder disposed before worker completion");

		// Reject any pending requests before destroying workers
		this.pendingRequests.forEach((request) => {
			request.reject(disposalError);
		});
		this.pendingRequests.clear();

		// Remove only this builder's waiters. In shared mode the queue belongs to the
		// context; replacing/clearing it would either leak our callbacks or cancel
		// sibling renderers' work.
		for (const [waiter, reject] of this.workerWaiters) {
			const index = this.workerQueue.indexOf(waiter);
			if (index >= 0) this.workerQueue.splice(index, 1);
			reject(disposalError);
		}
		this.workerWaiters.clear();

		const usesSharedWorkers = Boolean(
			this.schematicRenderer.options.context && this.useWasmMeshBuilder
		);
		if (!usesSharedWorkers) {
			this.batchPendingChunks.forEach((request) => request.reject(disposalError));
			this.batchPendingChunks.clear();
			this._batchFinishReject?.(disposalError);
			this.batchFinishResolve = null;
			this._batchFinishReject = null;
		}

		if (this.paletteCache) {
			this.paletteCache.blockData.forEach((blockData) => {
				blockData.materialGroups.forEach((group) => {
					if (group.baseGeometry) {
						group.baseGeometry.dispose();
					}
				});
			});
			this.paletteCache = null;
		}

		// Dispose GPU compute resources
		if (this.computeMeshBuilder) {
			this.computeMeshBuilder.dispose();
			this.computeMeshBuilder = null;
		}
		this.useGPUCompute = false;
		this.gpuInitPromise = null;

		// Terminate workers only if we own them. A shared-context pool is owned by
		// the context (and terminated when it disposes), so a context-backed builder
		// must not terminate workers still used by sibling renderers.
		if (!usesSharedWorkers) {
			this.workers.forEach((w) => w.terminate());
			this.borrowedWorkers.clear();
		}
		this.workers = [];
		this.freeWorkers = [];

		console.log("[WorldMeshBuilder] Disposed palette cache, GPU compute, and workers.");
		console.log("[WorldMeshBuilder] dispose() called from:", new Error().stack);
	}
}

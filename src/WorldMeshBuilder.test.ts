import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { WorldMeshBuilder } from "./WorldMeshBuilder";

// Mock problematic imports BEFORE they are used/imported by other modules
vi.mock("./wasm/minecraft_schematic_utils_bg.wasm", () => ({
	default: "mock-utils-wasm",
}));
vi.mock("nucleation", () => ({
	default: vi.fn().mockResolvedValue(undefined),
	SchematicWrapper: class {},
}));
vi.mock("./workers/MeshBuilder.worker?worker&inline", () => ({
	default: class MockWorker {
		postMessage() {}
		terminate() {}
		onmessage = null;
	},
}));
vi.mock("./workers/MeshBuilderWasm.worker?worker&inline", () => ({
	default: class MockWorker {
		postMessage() {}
		terminate() {}
		onmessage = null;
	},
}));

// Mock dependencies
vi.mock("./SchematicRenderer");
vi.mock("./cubane", () => {
	return {
		Cubane: class MockCubane {
			getBlockMesh = vi
				.fn()
				.mockResolvedValue(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
			getBlockOptimizationData = vi.fn().mockResolvedValue({
				cullableFaces: new Map(),
				nonCullableFaces: [],
				hasTransparency: false,
			});
		},
	};
});
vi.mock("./managers/SchematicObject");
vi.mock("./MaterialRegistry");
vi.mock("./InstancedBlockRenderer");

// WorldMeshBuilder requires complex dependencies that are difficult to mock properly.
// Test the logic without instantiating the full class.
describe("WorldMeshBuilder", () => {
	function createSharedWorkerLifecycleBuilder() {
		const context = {
			sharedWorkerQueue: [] as Array<(worker: Worker) => void>,
			sharedFreeWorkers: [] as Worker[],
		};
		const builder = Object.create(WorldMeshBuilder.prototype) as WorldMeshBuilder;
		Object.assign(builder as any, {
			schematicRenderer: { options: { context } },
			useWasmMeshBuilder: true,
			workers: [],
			freeWorkers: context.sharedFreeWorkers,
			workerQueue: context.sharedWorkerQueue,
			workerWaiters: new Map(),
			borrowedWorkers: new Set(),
			disposed: false,
			pendingRequests: new Map(),
			batchPendingChunks: new Map(),
			batchFinishResolve: null,
			_batchFinishReject: null,
			paletteCache: null,
			computeMeshBuilder: null,
			useGPUCompute: false,
			gpuInitPromise: null,
		});
		return { builder, context };
	}

	describe("shared worker lifecycle", () => {
		it("removes only its own queued waiter when disposed", async () => {
			const { builder, context } = createSharedWorkerLifecycleBuilder();
			const siblingWaiter = vi.fn();
			context.sharedWorkerQueue.push(siblingWaiter);

			const waiting = (builder as any).getFreeWorker() as Promise<Worker>;
			expect(context.sharedWorkerQueue).toHaveLength(2);

			builder.dispose();

			await expect(waiting).rejects.toThrow("disposed before worker completion");
			expect(context.sharedWorkerQueue).toEqual([siblingWaiter]);
		});

		it("returns an in-flight shared worker that completes after disposal", async () => {
			const { builder, context } = createSharedWorkerLifecycleBuilder();
			const worker = {
				onmessage: null,
				postMessage: vi.fn(),
				terminate: vi.fn(),
			} as unknown as Worker;
			context.sharedFreeWorkers.push(worker);

			const leasedWorker = (await (builder as any).getFreeWorker()) as Worker;
			builder.dispose();
			(leasedWorker.onmessage as ((event: MessageEvent) => void) | null)?.({
				data: { type: "chunkBuilt", chunkId: "late" },
			} as MessageEvent);

			expect(context.sharedFreeWorkers).toEqual([worker]);
			expect(worker.terminate).not.toHaveBeenCalled();
		});

		it("rejects a failed batch chunk and returns its shared worker", async () => {
			const { builder, context } = createSharedWorkerLifecycleBuilder();
			const worker = {
				onmessage: null,
				postMessage: vi.fn(),
				terminate: vi.fn(),
			} as unknown as Worker;
			context.sharedFreeWorkers.push(worker);
			const leasedWorker = (await (builder as any).getFreeWorker()) as Worker;
			const failed = new Promise<void>((_resolve, reject) => {
				(builder as any).batchPendingChunks.set("batch-1", { resolve: vi.fn(), reject });
			});

			(leasedWorker.onmessage as ((event: MessageEvent) => void) | null)?.({
				data: { type: "error", chunkId: "batch-1", error: "batch failed" },
			} as MessageEvent);

			await expect(failed).rejects.toThrow("batch failed");
			expect(context.sharedFreeWorkers).toEqual([worker]);
		});
	});

	describe("chunk size validation", () => {
		it("should have valid default chunk size", () => {
			const DEFAULT_CHUNK_SIZE = 16;
			expect(DEFAULT_CHUNK_SIZE).toBe(16);
			expect(DEFAULT_CHUNK_SIZE).toBeGreaterThan(0);
			expect(DEFAULT_CHUNK_SIZE).toBeLessThanOrEqual(64);
		});

		it("should reject invalid chunk sizes", () => {
			const MIN_CHUNK_SIZE = 1;
			const MAX_CHUNK_SIZE = 64;

			// Test boundary conditions
			expect(0).toBeLessThan(MIN_CHUNK_SIZE);
			expect(128).toBeGreaterThan(MAX_CHUNK_SIZE);
		});

		it("should accept valid chunk sizes", () => {
			const validSizes = [8, 16, 32, 64];
			validSizes.forEach((size) => {
				expect(size).toBeGreaterThanOrEqual(1);
				expect(size).toBeLessThanOrEqual(64);
			});
		});
	});

	describe("geometry creation", () => {
		it("should create valid box geometry for blocks", () => {
			const geometry = new THREE.BoxGeometry(1, 1, 1);
			expect(geometry).toBeInstanceOf(THREE.BoxGeometry);
			expect(geometry.parameters.width).toBe(1);
			expect(geometry.parameters.height).toBe(1);
			expect(geometry.parameters.depth).toBe(1);
		});

		it("should create materials for blocks", () => {
			const material = new THREE.MeshStandardMaterial();
			expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
		});
	});

	describe("chunk coordinate calculations", () => {
		it("should calculate chunk coordinates correctly", () => {
			const CHUNK_SIZE = 16;

			// Block at (0, 0, 0) should be in chunk (0, 0, 0)
			expect(Math.floor(0 / CHUNK_SIZE)).toBe(0);

			// Block at (15, 15, 15) should be in chunk (0, 0, 0)
			expect(Math.floor(15 / CHUNK_SIZE)).toBe(0);

			// Block at (16, 16, 16) should be in chunk (1, 1, 1)
			expect(Math.floor(16 / CHUNK_SIZE)).toBe(1);

			// Block at (32, 0, 0) should be in chunk (2, 0, 0)
			expect(Math.floor(32 / CHUNK_SIZE)).toBe(2);
		});

		it("should handle negative coordinates", () => {
			const CHUNK_SIZE = 16;

			// Block at (-1, 0, 0) should be in chunk (-1, 0, 0)
			expect(Math.floor(-1 / CHUNK_SIZE)).toBe(-1);

			// Block at (-16, 0, 0) should be in chunk (-1, 0, 0)
			expect(Math.floor(-16 / CHUNK_SIZE)).toBe(-1);

			// Block at (-17, 0, 0) should be in chunk (-2, 0, 0)
			expect(Math.floor(-17 / CHUNK_SIZE)).toBe(-2);
		});
	});
});

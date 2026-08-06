import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as THREE from "three";

// Mock all problematic imports before they are used
vi.mock("../../wasm/minecraft_schematic_utils_bg.wasm", () => ({
	default: "mock-utils-wasm",
}));
vi.mock("nucleation", () => ({
	default: vi.fn().mockResolvedValue(undefined),
	SchematicWrapper: class MockSchematicWrapper {
		from_data = vi.fn();
		get_dimensions = vi.fn().mockReturnValue([16, 16, 16]);
		get_block = vi.fn();
		set_block = vi.fn();
		to_schematic = vi.fn();
	},
}));
vi.mock("../../workers/MeshBuilder.worker?worker&inline", () => ({
	default: class MockWorker {
		postMessage() {}
		terminate() {}
		onmessage = null;
	},
}));

vi.mock("../SchematicObject", () => ({
	SchematicObject: class MockSchematicObject {
		id: string;
		group = new THREE.Group();
		schematicWrapper: any;

		constructor(_renderer: any, id: string, schematicWrapper: any) {
			this.id = id;
			this.schematicWrapper = schematicWrapper;
		}

		getMeshes = vi.fn().mockResolvedValue([]);
		dispose = vi.fn();
		containsPosition = vi.fn().mockReturnValue(false);
		getBoundingBox = vi.fn().mockReturnValue([
			[0, 0, 0],
			[16, 16, 16],
		]);
		getTightWorldBox = vi.fn().mockReturnValue(new THREE.Box3());
		getTightDimensions = vi.fn().mockReturnValue([16, 16, 16]);
		loadDefinitionRegions = vi.fn().mockReturnValue([]);
	},
}));

vi.mock("../../utils/MemoryLeakFix", () => ({
	MemoryLeakFix: {
		monitorMemory: vi.fn().mockReturnValue({ used: 100 }),
	},
	disposeGroup: vi.fn(),
	clearAllCaches: vi.fn(),
	forceGarbageCollection: vi.fn(),
}));

vi.mock("../../GeometryBufferPool", () => ({
	GeometryBufferPool: {
		clear: vi.fn(),
	},
}));

vi.mock("../../performance/PerformanceMonitor", () => ({
	performanceMonitor: {
		clearAllSessions: vi.fn(),
	},
}));

import { SchematicManager } from "../SchematicManager";
import { SchematicWrapper } from "nucleation";

describe("SchematicManager", () => {
	let manager: SchematicManager;
	let mockRenderer: any;
	let mockEventEmitter: any;

	beforeEach(() => {
		mockEventEmitter = {
			emit: vi.fn(),
			on: vi.fn(),
		};

		mockRenderer = {
			eventEmitter: mockEventEmitter,
			invalidate: vi.fn(),
			sceneManager: {
				scene: new THREE.Scene(),
				schematicRenderer: {},
			},
			worldMeshBuilder: {
				invalidateCache: vi.fn(),
			},
			options: {
				enableProgressBar: false,
			},
			uiManager: {
				showEmptyState: vi.fn(),
				hideEmptyState: vi.fn(),
				showProgressBar: vi.fn(),
				hideProgressBar: vi.fn(),
				updateProgress: vi.fn(),
			},
			regionManager: {
				removeDefinitionRegions: vi.fn(),
			},
		};

		manager = new SchematicManager(mockRenderer);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("initialization", () => {
		it("should create with empty schematics map", () => {
			expect(manager.schematics.size).toBe(0);
			expect(manager.isEmpty()).toBe(true);
		});

		it("should throw if SchematicRenderer is not provided", () => {
			expect(() => new SchematicManager(null as any)).toThrow("SchematicRenderer is required");
		});

		it("should throw if WorldMeshBuilder is not available", () => {
			const rendererWithoutBuilder = {
				...mockRenderer,
				worldMeshBuilder: null,
			};
			expect(() => new SchematicManager(rendererWithoutBuilder as any)).toThrow(
				"WorldMeshBuilder is required"
			);
		});
	});

	describe("loadSchematic", () => {
		it("should load schematic from ArrayBuffer", async () => {
			const arrayBuffer = new ArrayBuffer(100);
			await manager.loadSchematic("test", arrayBuffer);

			expect(manager.isEmpty()).toBe(false);
			expect(manager.schematicExists("test")).toBe(true);
		});

		it("should load schematic from SchematicWrapper", async () => {
			const wrapper = new SchematicWrapper();
			await manager.loadSchematic("test-wrapper", wrapper);

			expect(manager.schematicExists("test-wrapper")).toBe(true);
		});

		it("should emit schematicAdded event on load", async () => {
			const arrayBuffer = new ArrayBuffer(100);
			await manager.loadSchematic("test", arrayBuffer);

			expect(mockEventEmitter.emit).toHaveBeenCalledWith(
				"schematicAdded",
				expect.objectContaining({
					schematic: expect.any(Object),
				})
			);
		});

		it("should call onProgress callback during loading", async () => {
			const onProgress = vi.fn();
			const arrayBuffer = new ArrayBuffer(100);
			await manager.loadSchematic("test", arrayBuffer, undefined, {
				onProgress,
			});

			expect(onProgress).toHaveBeenCalled();
			expect(onProgress).toHaveBeenCalledWith(
				expect.objectContaining({
					stage: expect.any(String),
					progress: expect.any(Number),
					message: expect.any(String),
				})
			);
		});

		it("should throw for invalid schematic data", async () => {
			await expect(manager.loadSchematic("test", "invalid" as any)).rejects.toThrow(
				"Invalid schematic data type"
			);
		});

		it("should hide empty state when loading schematic", async () => {
			const arrayBuffer = new ArrayBuffer(100);
			await manager.loadSchematic("test", arrayBuffer);

			expect(mockRenderer.uiManager.hideEmptyState).toHaveBeenCalled();
		});

		it("should remove existing schematic in single schematic mode", async () => {
			const singleModeManager = new SchematicManager(mockRenderer, {
				singleSchematicMode: true,
			});

			const arrayBuffer = new ArrayBuffer(100);
			await singleModeManager.loadSchematic("first", arrayBuffer);
			await singleModeManager.loadSchematic("second", arrayBuffer);

			expect(singleModeManager.schematics.size).toBe(1);
			expect(singleModeManager.schematicExists("second")).toBe(true);
			expect(singleModeManager.schematicExists("first")).toBe(false);
		});
	});

	describe("removeSchematic", () => {
		it("should remove schematic by name", async () => {
			const arrayBuffer = new ArrayBuffer(100);
			await manager.loadSchematic("test", arrayBuffer);
			expect(manager.isEmpty()).toBe(false);

			await manager.removeSchematic("test");
			expect(manager.isEmpty()).toBe(true);
		});

		it("should emit schematicRemoved event", async () => {
			const arrayBuffer = new ArrayBuffer(100);
			await manager.loadSchematic("test", arrayBuffer);
			await manager.removeSchematic("test");

			expect(mockEventEmitter.emit).toHaveBeenCalledWith("schematicRemoved", {
				id: "test",
			});
		});

		it("should dispose the schematic before waiting for its meshes", async () => {
			await manager.loadSchematic("test", new ArrayBuffer(100));
			const schematic = manager.getSchematic("test")!;
			const dispose = vi.mocked(schematic.dispose);
			const getMeshes = vi.mocked(schematic.getMeshes);

			await manager.removeSchematic("test");

			expect(dispose).toHaveBeenCalledOnce();
			expect(getMeshes).toHaveBeenCalledOnce();
			expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(
				getMeshes.mock.invocationCallOrder[0]
			);
		});

		it("should show empty state when last schematic is removed", async () => {
			const arrayBuffer = new ArrayBuffer(100);
			await manager.loadSchematic("test", arrayBuffer);
			await manager.removeSchematic("test");

			expect(mockRenderer.uiManager.showEmptyState).toHaveBeenCalled();
		});

		it("should handle removing non-existent schematic gracefully", async () => {
			await expect(manager.removeSchematic("non-existent")).resolves.not.toThrow();
		});
	});

	describe("removeAllSchematics", () => {
		it("should remove all schematics", async () => {
			const arrayBuffer = new ArrayBuffer(100);
			await manager.loadSchematic("test1", arrayBuffer);
			await manager.loadSchematic("test2", arrayBuffer);
			expect(manager.schematics.size).toBe(2);

			await manager.removeAllSchematics();
			expect(manager.isEmpty()).toBe(true);
		});
	});

	describe("getSchematic", () => {
		it("should return schematic by id", async () => {
			const arrayBuffer = new ArrayBuffer(100);
			await manager.loadSchematic("test", arrayBuffer);

			const schematic = manager.getSchematic("test");
			expect(schematic).toBeDefined();
			expect(schematic?.id).toBe("test");
		});

		it("should return undefined for non-existent schematic", () => {
			const schematic = manager.getSchematic("non-existent");
			expect(schematic).toBeUndefined();
		});
	});

	describe("getAllSchematics", () => {
		it("should return all schematics", async () => {
			const arrayBuffer = new ArrayBuffer(100);
			await manager.loadSchematic("test1", arrayBuffer);
			await manager.loadSchematic("test2", arrayBuffer);

			const schematics = manager.getAllSchematics();
			expect(schematics).toHaveLength(2);
		});
	});

	describe("getFirstSchematic", () => {
		it("should return first schematic", async () => {
			const arrayBuffer = new ArrayBuffer(100);
			await manager.loadSchematic("first", arrayBuffer);
			await manager.loadSchematic("second", arrayBuffer);

			const first = manager.getFirstSchematic();
			expect(first).toBeDefined();
		});

		it("should return undefined when no schematics", () => {
			const first = manager.getFirstSchematic();
			expect(first).toBeUndefined();
		});
	});

	describe("createEmptySchematic", () => {
		it("should create an empty schematic", () => {
			const schematic = manager.createEmptySchematic("empty");

			expect(schematic).toBeDefined();
			expect(manager.schematicExists("empty")).toBe(true);
		});

		it("should emit schematicLoaded event", () => {
			manager.createEmptySchematic("empty");

			expect(mockEventEmitter.emit).toHaveBeenCalledWith("schematicLoaded", {
				id: "empty",
			});
		});
	});

	describe("bounding box methods", () => {
		it("should return empty vector for empty manager", () => {
			const position = manager.getSchematicsAveragePosition();
			expect(position).toEqual(new THREE.Vector3());
		});

		it("should return empty vector for max dimensions when empty", () => {
			const dimensions = manager.getMaxSchematicDimensions();
			expect(dimensions).toEqual(new THREE.Vector3());
		});
	});

	describe("performDeepCleanup", () => {
		it("should invalidate mesh builder cache", () => {
			manager.performDeepCleanup();
			expect(mockRenderer.worldMeshBuilder.invalidateCache).toHaveBeenCalled();
		});
	});
});

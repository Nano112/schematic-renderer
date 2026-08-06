import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { EventEmitter } from "events";
import { SchematicObject } from "../SchematicObject";
import { BlockEntityRendererRegistry, type BlockEntityOverlay } from "../../block-entities/index";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createHiddenSchematic(rendererOverrides: Record<string, unknown> = {}): SchematicObject {
	const scene = new THREE.Scene();
	const renderer: any = {
		worldMeshBuilder: { buildSignMeshes: async () => [] },
		eventEmitter: new EventEmitter(),
		options: { blockEntityOptions: { enabled: false } },
		blockEntityRenderers: { size: 0 },
		invalidate: vi.fn(),
		cubane: {
			getEntityMesh: vi.fn(),
			getAssetLoader: () => ({ getTexture: vi.fn() }),
		},
		...rendererOverrides,
	};
	renderer.sceneManager = {
		schematicRenderer: renderer,
		scene,
		add: (object: THREE.Object3D) => scene.add(object),
	};
	const wrapper = {
		get_dimensions: () => [1, 1, 1],
		get_tight_dimensions: () => [1, 1, 1],
	} as any;
	return new SchematicObject(renderer, "lifecycle", wrapper, { visible: false });
}

describe("SchematicObject lifecycle", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("stops its property watcher and releases scene meshes idempotently", () => {
		vi.useFakeTimers();
		const schematic = createHiddenSchematic();
		const geometry = new THREE.BoxGeometry();
		const disposeGeometry = vi.spyOn(geometry, "dispose");
		schematic.group.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));

		schematic.dispose();
		schematic.dispose();

		expect(vi.getTimerCount()).toBe(0);
		expect(schematic.group.parent).toBeNull();
		expect(schematic.group.children).toHaveLength(0);
		expect(disposeGeometry).toHaveBeenCalledOnce();
	});

	it("discards a mesh build that completes after disposal", async () => {
		const schematic = createHiddenSchematic();
		const geometry = new THREE.BoxGeometry();
		const disposeGeometry = vi.spyOn(geometry, "dispose");
		const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
		let finishBuild!: (result: any) => void;
		const buildResult = new Promise((resolve) => {
			finishBuild = resolve;
		});
		(schematic as any).visible = true;
		(schematic as any).buildSchematicMeshes = vi.fn(() => buildResult);

		const build = (schematic as any).buildMeshes();
		schematic.dispose();
		finishBuild({ meshes: [mesh], chunkMap: new Map() });
		await build;

		expect(schematic.group.children).toHaveLength(0);
		expect(disposeGeometry).toHaveBeenCalledOnce();
	});

	it("settles a mesh build when disposal aborts an uncooperative block-entity renderer", async () => {
		const started = deferred<void>();
		const lateResult = deferred<BlockEntityOverlay>();
		const disposeLateOverlay = vi.fn();
		const registry = new BlockEntityRendererRegistry([
			{
				id: "deferred",
				render: () => {
					started.resolve();
					return lateResult.promise;
				},
			},
		]);
		const schematic = createHiddenSchematic({
			blockEntityRenderers: registry,
			options: { blockEntityOptions: { enabled: true } },
		});
		const geometry = new THREE.BoxGeometry();
		const disposeGeometry = vi.spyOn(geometry, "dispose");
		const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
		(schematic as any).visible = true;
		(schematic as any).buildSchematicMeshes = vi.fn(async () => ({
			meshes: [mesh],
			chunkMap: new Map(),
		}));

		const build = (schematic as any).buildMeshes();
		await started.promise;
		schematic.dispose();
		await build;

		expect(schematic.group.children).toHaveLength(0);
		expect(disposeGeometry).toHaveBeenCalledOnce();
		lateResult.resolve({ count: 1, dispose: disposeLateOverlay });
		await Promise.resolve();
		await Promise.resolve();
		expect(disposeLateOverlay).toHaveBeenCalledOnce();
	});

	it("silences a rejected overlay refresh after a newer refresh supersedes it", async () => {
		const staleResult = deferred<BlockEntityOverlay>();
		let staleSignal: AbortSignal | undefined;
		const currentDispose = vi.fn();
		const registry = {
			size: 1,
			render: vi
				.fn()
				.mockImplementationOnce((_schematic, _resources, signal: AbortSignal) => {
					staleSignal = signal;
					return staleResult.promise;
				})
				.mockResolvedValueOnce({ count: 1, dispose: currentDispose }),
		};
		const onError = vi.fn();
		const invalidate = vi.fn();
		const schematic = createHiddenSchematic({
			blockEntityRenderers: registry,
			invalidate,
			options: { blockEntityOptions: { enabled: true, onError } },
		});

		const staleRefresh = schematic.rebuildBlockEntities();
		await Promise.resolve();
		const currentRefresh = schematic.rebuildBlockEntities();
		await currentRefresh;
		expect(staleSignal?.aborted).toBe(true);

		staleResult.reject(new Error("stale failure"));
		await staleRefresh;

		expect(onError).not.toHaveBeenCalled();
		expect(invalidate).toHaveBeenCalledOnce();
		schematic.dispose();
		expect(currentDispose).toHaveBeenCalledOnce();
	});
});

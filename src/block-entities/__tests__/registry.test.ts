import { Group, Object3D, Texture } from "three";
import { describe, expect, it, vi } from "vitest";

import { BlockEntityRendererRegistry, type BlockEntityRenderer } from "../registry.js";
import { captureSchematicBlockEntitySnapshot, type BlockEntityResources } from "../snapshot.js";

const resources: BlockEntityResources = {
	getEntityMesh: async () => new Object3D(),
	getTexture: async () => new Texture(),
};

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function schematic() {
	return {
		group: new Group(),
		schematicWrapper: {
			get_palette: () => ["minecraft:stone", "minecraft:red_banner"],
			blocks_indices: () => [[0, 0, 0, 1]],
			get_all_block_entities: () => [{ id: "minecraft:banner", position: [0, 0, 0], nbt: {} }],
		},
	};
}

describe("BlockEntityRendererRegistry", () => {
	it("supports multi-ID matching and isolates renderer failures", async () => {
		const dispose = vi.fn();
		const good: BlockEntityRenderer = {
			id: "good",
			blockIds: ["minecraft:blue_banner", "minecraft:red_banner"],
			render: async () => ({ count: 2, dispose }),
		};
		const broken: BlockEntityRenderer = {
			id: "broken",
			blockEntityIds: ["minecraft:banner", "minecraft:sign"],
			render: async () => {
				throw new Error("broken renderer");
			},
		};
		const skipped = vi.fn(async () => ({ count: 99, dispose: vi.fn() }));
		const errors: string[] = [];
		const registry = new BlockEntityRendererRegistry([
			good,
			broken,
			{ id: "skipped", blockIds: ["minecraft:chest"], render: skipped },
		]);
		const controller = new AbortController();

		const overlay = await registry.render(schematic(), resources, controller.signal, {
			onError: (id) => errors.push(id),
		});

		expect(overlay.count).toBe(2);
		expect(errors).toEqual(["broken"]);
		expect(skipped).not.toHaveBeenCalled();
		controller.abort();
		expect(dispose).toHaveBeenCalledOnce();
		overlay.dispose();
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("disposes successful overlays in reverse registration order", async () => {
		const order: string[] = [];
		const registry = new BlockEntityRendererRegistry([
			{ id: "first", render: async () => ({ count: 1, dispose: () => order.push("first") }) },
			{ id: "second", render: async () => ({ count: 1, dispose: () => order.push("second") }) },
		]);
		const controller = new AbortController();
		const overlay = await registry.render(schematic(), resources, controller.signal);

		overlay.dispose();
		expect(order).toEqual(["second", "first"]);
	});

	it("keeps renderer and disposal failures isolated when onError throws", async () => {
		const finalDispose = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const registry = new BlockEntityRendererRegistry([
			{
				id: "render-failure",
				render: async () => {
					throw new Error("render failed");
				},
			},
			{
				id: "dispose-failure",
				render: async () => ({
					count: 1,
					dispose: () => {
						throw new Error("dispose failed");
					},
				}),
			},
			{ id: "final", render: async () => ({ count: 1, dispose: finalDispose }) },
		]);

		const overlay = await registry.render(schematic(), resources, new AbortController().signal, {
			onError: () => {
				throw new Error("callback failed");
			},
		});
		expect(overlay.count).toBe(2);

		overlay.dispose();
		expect(finalDispose).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("settles on abort when a renderer ignores the signal and disposes its late result", async () => {
		let finishRenderer!: (overlay: { count: number; dispose: () => void }) => void;
		const rendererResult = new Promise<{ count: number; dispose: () => void }>((resolve) => {
			finishRenderer = resolve;
		});
		const started = deferred<void>();
		const dispose = vi.fn();
		const registry = new BlockEntityRendererRegistry([
			{
				id: "ignores-abort",
				render: () => {
					started.resolve();
					return rendererResult;
				},
			},
		]);
		const controller = new AbortController();
		const rendering = registry.render(schematic(), resources, controller.signal);
		await started.promise;

		controller.abort();
		const overlay = await rendering;

		expect(overlay.count).toBe(0);
		finishRenderer({ count: 1, dispose });
		await Promise.resolve();
		await Promise.resolve();
		expect(dispose).toHaveBeenCalledOnce();
		overlay.dispose();
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("disposes completed overlays immediately and late overlays once after abort", async () => {
		const fastDispose = vi.fn();
		const lateDispose = vi.fn();
		let finishSlow!: (overlay: { count: number; dispose: () => void }) => void;
		const slowResult = new Promise<{ count: number; dispose: () => void }>((resolve) => {
			finishSlow = resolve;
		});
		const slowStarted = deferred<void>();
		const registry = new BlockEntityRendererRegistry([
			{ id: "fast", render: async () => ({ count: 1, dispose: fastDispose }) },
			{
				id: "slow",
				render: () => {
					slowStarted.resolve();
					return slowResult;
				},
			},
		]);
		const controller = new AbortController();
		const rendering = registry.render(schematic(), resources, controller.signal);
		await slowStarted.promise;
		await Promise.resolve();

		controller.abort();
		expect(fastDispose).toHaveBeenCalledOnce();
		expect((await rendering).count).toBe(0);

		finishSlow({ count: 1, dispose: lateDispose });
		await Promise.resolve();
		await Promise.resolve();
		expect(lateDispose).toHaveBeenCalledOnce();
		controller.abort();
		expect(fastDispose).toHaveBeenCalledOnce();
		expect(lateDispose).toHaveBeenCalledOnce();
	});

	it("can reuse an already captured snapshot", async () => {
		const source = schematic();
		const snapshot = captureSchematicBlockEntitySnapshot(source.schematicWrapper);
		const reader = vi.spyOn(source.schematicWrapper, "get_palette");
		const render = vi.fn(async () => ({ count: 1, dispose: vi.fn() }));
		const registry = new BlockEntityRendererRegistry([{ id: "all", render }]);

		await registry.render(source, resources, new AbortController().signal, { snapshot });
		expect(reader).not.toHaveBeenCalled();
		expect(render).toHaveBeenCalledOnce();
	});

	it("rejects duplicate renderer IDs", () => {
		const registry = new BlockEntityRendererRegistry([{ id: "same", render: async () => null }]);
		expect(() => registry.register({ id: "same", render: async () => null })).toThrow(
			/already registered/
		);
	});
});

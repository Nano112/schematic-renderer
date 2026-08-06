import * as THREE from "three";
import { Cubane } from "./cubane/Cubane";
import { ResourcePackManager, DefaultPackCallback } from "./managers/ResourcePackManager";
import MeshBuilderWorker from "./workers/MeshBuilder.worker?worker&inline";
import MeshBuilderWasmWorker from "./workers/MeshBuilderWasm.worker?worker&inline";
import { getClampedPixelRatio } from "./utils/pixelRatio";
import type { ResourcePackOptions } from "./types/resourcePack";

export interface SchematicRendererContextOptions {
	/** Render unknown blocks as a purple placeholder (defaults to false). */
	showUnknownBlocks?: boolean;
	/** Passed through to the internal ResourcePackManager. */
	resourcePackOptions?: ResourcePackOptions;
	/**
	 * Render every attached view through ONE shared WebGL context (render-and-blit)
	 * instead of one context per renderer. Bypasses the browser's ~8–16 context
	 * limit so you can show many viewports. Off by default.
	 */
	sharedRenderer?: boolean;
}

/**
 * Shared resource pipeline for running multiple {@link SchematicRenderer}
 * instances on one page.
 *
 * A context owns a single {@link Cubane} (asset loader + texture atlas + models)
 * with resource packs already loaded. Pass it to several renderers via
 * `options.context` and they all mesh against the *same* atlas — the pack is
 * parsed and the atlas is built once instead of once per renderer.
 *
 * ```ts
 * const ctx = await SchematicRendererContext.create({
 *   vanillaPack: async () => fetchPackBlob(),
 * });
 * const before = new SchematicRenderer(beforeCanvas, {}, {}, { context: ctx });
 * const after  = new SchematicRenderer(afterCanvas,  {}, {}, { context: ctx });
 * ```
 *
 * When no context is supplied, a `SchematicRenderer` creates its own private
 * pipeline exactly as before (fully backward compatible).
 */
export class SchematicRendererContext {
	/** The shared asset pipeline (atlas, models, textures). */
	public readonly cubane: Cubane;
	/** The pack manager used to load the shared packs. */
	public readonly resourcePackManager: ResourcePackManager;

	// Renderers attached to this context, so pack changes can invalidate them all.
	private readonly renderers = new Set<{ invalidate(): void }>();

	// Shared mesh-builder worker pool, created once and borrowed by every renderer's
	// WorldMeshBuilder. The free-list/queue are shared so workers are lent exclusively;
	// each borrower rebinds onmessage and tags messages with its own meshContextId.
	private sharedWorkers: Worker[] | null = null;
	public readonly sharedFreeWorkers: Worker[] = [];
	public readonly sharedWorkerQueue: ((worker: Worker) => void)[] = [];

	/**
	 * Get (or lazily create) the shared mesh-builder worker pool. WASM is compiled
	 * once per worker here instead of once per renderer.
	 */
	public getSharedWorkers(maxWorkers: number, useWasm: boolean): Worker[] {
		if (!this.sharedWorkers) {
			this.sharedWorkers = [];
			for (let i = 0; i < maxWorkers; i++) {
				const worker = useWasm ? new MeshBuilderWasmWorker() : new MeshBuilderWorker();
				this.sharedWorkers.push(worker);
				this.sharedFreeWorkers.push(worker);
			}
		}
		return this.sharedWorkers;
	}

	// One shared WebGL renderer (offscreen) for render-and-blit, when enabled.
	private readonly useSharedRenderer: boolean;
	private sharedGLRenderer: THREE.WebGLRenderer | null = null;

	private constructor(
		cubane: Cubane,
		resourcePackManager: ResourcePackManager,
		useSharedRenderer: boolean
	) {
		this.cubane = cubane;
		this.resourcePackManager = resourcePackManager;
		this.useSharedRenderer = useSharedRenderer;
	}

	/**
	 * The shared WebGL renderer for render-and-blit, or null when not enabled.
	 * Created lazily on an offscreen canvas; views render into it then blit the
	 * result onto their own 2D canvas. `preserveDrawingBuffer` is required so the
	 * drawn frame can be copied via drawImage.
	 */
	public getSharedGLRenderer(): THREE.WebGLRenderer | null {
		if (!this.useSharedRenderer) return null;
		if (!this.sharedGLRenderer) {
			const canvas = document.createElement("canvas");
			this.sharedGLRenderer = new THREE.WebGLRenderer({
				canvas,
				alpha: true,
				antialias: true,
				powerPreference: "high-performance",
				preserveDrawingBuffer: true,
			});
			this.sharedGLRenderer.setPixelRatio(getClampedPixelRatio());
		}
		return this.sharedGLRenderer;
	}

	/**
	 * Create a ready-to-use shared context: builds a Cubane, loads the given
	 * resource packs, and builds the atlas once. Await this before constructing
	 * the renderers that will share it.
	 */
	public static async create(
		defaultResourcePacks: Record<string, DefaultPackCallback> = {},
		options: SchematicRendererContextOptions = {}
	): Promise<SchematicRendererContext> {
		const cubane = new Cubane({
			autoRestore:
				options.resourcePackOptions?.restoreCachedPacks ??
				Object.keys(defaultResourcePacks).length === 0,
			showUnknownBlocks: options.showUnknownBlocks,
		});
		const resourcePackManager = new ResourcePackManager(options.resourcePackOptions);
		await resourcePackManager.initPromise;

		const blobs = await resourcePackManager.getResourcePackBlobs(defaultResourcePacks);
		if (blobs.length > 0) {
			// Batch mode → single atlas rebuild after all packs load.
			cubane.beginPackBatchUpdate();
			try {
				for (let i = 0; i < blobs.length; i++) {
					try {
						await cubane.loadResourcePack(blobs[i] as Blob);
					} catch (error) {
						console.error(
							`[SchematicRendererContext] Failed to load resource pack ${i + 1}:`,
							error
						);
					}
				}
			} finally {
				await cubane.endPackBatchUpdate();
			}
		} else {
			console.info(
				"[SchematicRendererContext] No resource pack provided — blocks will render with placeholder textures."
			);
		}

		return new SchematicRendererContext(
			cubane,
			resourcePackManager,
			options.sharedRenderer ?? false
		);
	}

	/** Register a renderer so pack changes can invalidate it. */
	public attachRenderer(renderer: { invalidate(): void }): void {
		this.renderers.add(renderer);
	}

	/** Unregister a renderer (call on the renderer's dispose). */
	public detachRenderer(renderer: { invalidate(): void }): void {
		this.renderers.delete(renderer);
	}

	/** Number of renderers currently sharing this context. */
	public get rendererCount(): number {
		return this.renderers.size;
	}

	/** Mark every attached renderer dirty (e.g. after a shared pack/atlas change). */
	public invalidateAll(): void {
		this.renderers.forEach((r) => r.invalidate());
	}

	// ── Persistent registry (survives SPA navigation) ───────────────────────────

	/**
	 * Global registry of live contexts keyed by id. Stored on `globalThis` so it
	 * survives SPA navigations (Livewire `wire:navigate`, Turbo, htmx boost) that keep
	 * the JS VM alive — the heavy pipeline (atlas, WASM, worker pool, GL context) is
	 * reused across page views instead of rebuilt on every navigation.
	 */
	private static get registry(): Map<
		string,
		{ promise: Promise<SchematicRendererContext>; ctx?: SchematicRendererContext; refs: number }
	> {
		const g = globalThis as unknown as { __schematicRendererContexts?: Map<string, any> };
		if (!g.__schematicRendererContexts) g.__schematicRendererContexts = new Map();
		return g.__schematicRendererContexts as Map<string, any>;
	}

	/**
	 * Get a shared context by `key`, creating it once via `factory` and caching it on
	 * the global registry. Subsequent calls with the same key — including after an SPA
	 * navigation — return the existing context without rebuilding anything. Increments
	 * a reference count; pair each `acquire` with a {@link release}.
	 *
	 * ```ts
	 * const ctx = await SchematicRendererContext.acquire("viewer", () =>
	 *   SchematicRendererContext.create(packs, { sharedRenderer: true })
	 * );
	 * ```
	 */
	public static async acquire(
		key: string,
		factory: () => Promise<SchematicRendererContext>
	): Promise<SchematicRendererContext> {
		const reg = this.registry;
		let entry = reg.get(key);
		if (!entry) {
			const created = { promise: factory(), refs: 0 } as {
				promise: Promise<SchematicRendererContext>;
				ctx?: SchematicRendererContext;
				refs: number;
			};
			reg.set(key, created);
			created.promise
				.then((ctx) => {
					created.ctx = ctx;
				})
				.catch(() => {
					reg.delete(key); // failed build — let the next acquire retry
				});
			entry = created;
		}
		entry.refs++;
		return entry.promise;
	}

	/** The live context for `key`, if one has finished building. */
	public static peek(key: string): SchematicRendererContext | undefined {
		return this.registry.get(key)?.ctx;
	}

	/**
	 * Drop one reference taken via {@link acquire}. By default the context is kept warm
	 * even at zero references — the whole point is to survive navigation — so the next
	 * view reuses it instantly. Pass `{ dispose: true }` to tear it down and free its
	 * resources once the last reference is released (e.g. when the user leaves the app).
	 */
	public static release(key: string, options: { dispose?: boolean } = {}): void {
		const reg = this.registry;
		const entry = reg.get(key);
		if (!entry) return;
		entry.refs = Math.max(0, entry.refs - 1);
		if (entry.refs === 0 && options.dispose) {
			entry.ctx?.dispose();
			reg.delete(key);
		}
	}

	/** Dispose the shared pipeline. Call once all renderers have detached. */
	public dispose(): void {
		this.renderers.clear();
		if (this.sharedWorkers) {
			this.sharedWorkers.forEach((w) => w.terminate());
			this.sharedWorkers = null;
			this.sharedFreeWorkers.length = 0;
			this.sharedWorkerQueue.length = 0;
		}
		if (this.sharedGLRenderer) {
			this.sharedGLRenderer.dispose();
			this.sharedGLRenderer = null;
		}
		this.cubane.dispose();
	}
}

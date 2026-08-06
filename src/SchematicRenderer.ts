import initializeNucleationWasm from "nucleation";

import * as THREE from "three";
import { CameraManager } from "./managers/CameraManager";
import { SceneManager } from "./managers/SceneManager";
import { RenderManager } from "./managers/RenderManager";
import { DragAndDropManager, DragAndDropManagerOptions } from "./managers/DragAndDropManager";
import { InteractionManager, InteractionManagerOptions } from "./managers/InteractionManager";
import { HighlightManager } from "./managers/HighlightManager";
import { shouldRenderFrame, pickFrameSchedule, scheduleDelayMs } from "./utils/renderGate";
import { RenderLoopScheduler } from "./utils/renderLoopScheduler";
import { SchematicManager, SchematicManagerOptions } from "./managers/SchematicManager";
import { WorldMeshBuilder } from "./WorldMeshBuilder";
import { MaterialRegistry } from "./MaterialRegistry";
import { EventEmitter } from "events";
import { ResourcePackManager, DefaultPackCallback } from "./managers/ResourcePackManager";
import { ResourcePackManagerProxy } from "./managers/ResourcePackManagerProxy";
import { SidebarManager } from "./ui/sidebar/SidebarManager";
import { SlicerOverlay, type SlicerOverlayOptions } from "./ui/SlicerOverlay";
import { ResourcePackNotice } from "./ui/ResourcePackNotice";
import type { SidebarTabId } from "./ui/sidebar/types";
import type {
	PacksChangedEvent,
	PackToggledEvent,
	PackAddedEvent,
	PackRemovedEvent,
	LoadProgressEvent,
	LoadCompleteEvent,
	LoadErrorEvent,
	PackErrorEvent,
} from "./types/resourcePack";

import { GizmoManager } from "./managers/GizmoManager";
import { SchematicRendererOptions, DEFAULT_OPTIONS } from "./SchematicRendererOptions";
import { merge } from "lodash";
import { UIManager } from "./managers/UIManager";
import { SimulationManager } from "./managers/SimulationManager";
import { BlockInteractionHandler } from "./managers/highlight/BlockInteractionHandler";
import { InsignManager } from "./managers/InsignManager";
import { InsignIoManager } from "./managers/InsignIoManager";
import { OverlayManager } from "./managers/OverlayManager";
// @ts-ignore
import { CreativeControls } from "three-creative-controls";

import { Cubane } from "./cubane";
import { KeyboardControls } from "./managers/KeyboardControls";
import { InspectorManager } from "./managers/InspectorManager";
import { RegionManager } from "./managers/RegionManager";
import { RegionInteractionHandler } from "./managers/highlight/RegionInteractionHandler";
import {
	BlockEntityRendererRegistry,
	createDefaultBlockEntityRenderers,
} from "./block-entities/index";

export class SchematicRenderer {
	public canvas: HTMLCanvasElement;
	public timer: THREE.Timer;
	public options: SchematicRendererOptions;
	public eventEmitter: EventEmitter;
	public cameraManager: CameraManager;
	public sceneManager: SceneManager;
	public uiManager: UIManager | undefined;
	public renderManager: RenderManager | undefined;
	public interactionManager: InteractionManager | undefined;
	public dragAndDropManager?: DragAndDropManager;
	public highlightManager: HighlightManager | undefined;
	public schematicManager: SchematicManager | undefined;
	public worldMeshBuilder: WorldMeshBuilder | undefined;
	public gizmoManager: GizmoManager | undefined;
	public simulationManager: SimulationManager | undefined;
	public blockInteractionHandler: BlockInteractionHandler | undefined;
	public insignManager: InsignManager | undefined;
	public insignIoManager: InsignIoManager | undefined;
	public regionManager: RegionManager | undefined;
	public regionInteractionHandler: RegionInteractionHandler | undefined;
	public overlayManager: OverlayManager | undefined;
	public keyboardControls: KeyboardControls | undefined;
	public inspectorManager: InspectorManager | undefined;
	public materialMap: Map<string, THREE.Material>;
	public timings: Map<string, number> = new Map();
	public fps: number = 0;
	private resourcePackManager: ResourcePackManager;
	public packs!: ResourcePackManagerProxy;
	/** Unified sidebar UI manager */
	public sidebar: SidebarManager | undefined;
	public slicerOverlay: SlicerOverlay | undefined;
	public resourcePackNotice: ResourcePackNotice | undefined;
	public cubane: Cubane;
	/** Registry used for NBT-aware block entities rendered with each schematic. */
	public readonly blockEntityRenderers: BlockEntityRendererRegistry;
	public state: {
		cameraPosition: THREE.Vector3;
	};
	private static isNucleationInitialized = false;

	constructor(
		canvas: HTMLCanvasElement,
		schematicData: { [key: string]: () => Promise<ArrayBuffer> } = {},
		defaultResourcePacks: Record<string, DefaultPackCallback> = {},
		options: SchematicRendererOptions = {}
	) {
		this.canvas = canvas;

		this.options = merge({}, DEFAULT_OPTIONS, options);
		const blockEntityOptions = this.options.blockEntityOptions;
		this.blockEntityRenderers = new BlockEntityRendererRegistry([
			...(blockEntityOptions?.includeDefaultRenderers === false
				? []
				: createDefaultBlockEntityRenderers({
						playerHeads: blockEntityOptions?.playerHeads,
					})),
			...(blockEntityOptions?.renderers ?? []),
		]);

		// targetFPS is an upper cap on rendered frames; on-demand rendering decides
		// *whether* to render. enableAdaptiveFPS/idleThreshold are legacy no-ops
		// (kept in the options type for backward compatibility); idleFPS is live
		// again below as the idle slow-poll rate.
		this.targetFPS = this.options.targetFPS ?? 60;
		this.frameInterval = this.targetFPS > 0 ? 1000 / this.targetFPS : 0;
		// When fully idle the loop slow-polls (via setTimeout) at idleFPS instead of
		// pinning requestAnimationFrame to the display refresh — this lets the whole
		// browser frame pipeline (style/layout/composite) go quiet. invalidate() wakes
		// it instantly, so idleFPS is only a backstop for direct camera mutations.
		this.idleFPS = this.options.idleFPS ?? 1;
		// Animated textures (off by default). When on, rendering is event-driven: we
		// poll the texture timers at animatedPollFps and only redraw on a frame flip.
		this.enableAnimatedTextures = this.options.enableAnimatedTextures ?? false;

		this.timer = new THREE.Timer();
		this.materialMap = new Map();
		this.eventEmitter = new EventEmitter();

		// Attach this instance to the canvas for external access
		(this.canvas as any).schematicRenderer = this;

		// Initialize managers that don't depend on initialization process
		this.sceneManager = new SceneManager(this);

		this.uiManager = new UIManager(this);

		// Initialize camera manager
		this.cameraManager = new CameraManager(this, options.cameraOptions);

		// Initialize keyboard controls (always create, but disabled by default)
		this.keyboardControls = new KeyboardControls(
			this.cameraManager.activeCamera.camera,
			this.canvas,
			options.keyboardControlsOptions
		);

		this.sceneManager.updateHelpers();
		this.eventEmitter.emit("sceneReady");

		// Initialize ResourcePackManager with options
		this.resourcePackManager = new ResourcePackManager(this.options.resourcePackOptions);

		// Create proxy for external API access
		this.packs = new ResourcePackManagerProxy(this.resourcePackManager);

		// Wire up resource pack callbacks
		this.setupResourcePackCallbacks();

		// Initialize unified sidebar UI
		if (this.options.sidebarOptions?.enabled !== false) {
			this.sidebar = new SidebarManager(this, this.options.sidebarOptions);
		}

		// Initialize floating slicer overlay if requested. Always constructed
		// lazily via the API methods; this only auto-opens it on startup.
		if (this.options.showSlicerOverlay) {
			this.slicerOverlay = new SlicerOverlay(this, this.options.slicerOverlayOptions);
		}

		this.state = {
			cameraPosition: new THREE.Vector3(),
		};

		// Show initialization progress bar
		if (this.options.enableProgressBar && this.uiManager) {
			this.uiManager.showProgressBar("Initializing renderer...");
			this.uiManager.updateProgress(0.1);
		}

		// Use a shared context's asset pipeline when provided; otherwise create a
		// private one (default single-instance behavior — unchanged).
		if (this.options.context) {
			this.cubane = this.options.context.cubane;
			this.options.context.attachRenderer(this);
		} else {
			this.cubane = new Cubane({
				autoRestore:
					this.options.resourcePackOptions?.restoreCachedPacks ??
					Object.keys(defaultResourcePacks).length === 0,
				showUnknownBlocks: this.options.debugOptions?.showUnknownBlocks,
			});
		}

		// In-viewport notice shown when no resource pack is loaded. The renderer
		// toggles it via updateMissingPackNotice() once pack loading settles.
		if (this.options.resourcePackOptions?.showMissingPackNotice !== false) {
			this.resourcePackNotice = new ResourcePackNotice(this, {
				docsUrl: "https://github.com/Schem-at/schematic-renderer#resource-packs",
			});
		}

		// Bind pointer events for immediate wake-up from idle mode
		this.bindPointerEvents();

		// Start the initialization process
		this.initialize(schematicData, defaultResourcePacks);
	}

	public updateCameraPosition(): void {
		this.state.cameraPosition.copy(this.cameraManager.activeCamera.position as THREE.Vector3);
	}

	/**
	 * Sets whether auto-orbit is enabled
	 * @param enabled True to enable auto-orbit, false to disable
	 */
	public setAutoOrbit(enabled: boolean): void {
		this.options.enableAutoOrbit = enabled;

		if (enabled) {
			this.cameraManager.startAutoOrbit();
		} else {
			this.cameraManager.stopAutoOrbit();
		}
	}

	/**
	 * Sets the duration of a full auto-orbit rotation
	 * @param duration Duration in seconds
	 */
	public setAutoOrbitDuration(duration: number): void {
		this.options.autoOrbitDuration = duration;
		this.cameraManager.setAutoOrbitDuration(duration);
	}

	/**
	 * Toggles the auto-orbit feature
	 * @returns The new state of auto-orbit (true = enabled, false = disabled)
	 */
	public toggleAutoOrbit(): boolean {
		const newState = this.cameraManager.toggleAutoOrbit();
		this.options.enableAutoOrbit = newState;
		return newState;
	}

	/**
	 * Enable or create the inspector GUI
	 * Can be called at any time to show the debug panel
	 */
	public enableInspector(): InspectorManager {
		if (!this.inspectorManager) {
			this.inspectorManager = new InspectorManager(this, {
				enableInspector: true,
				showOnStartup: true,
				...this.options.debugOptions,
			});
		} else {
			this.inspectorManager.show();
		}
		return this.inspectorManager;
	}

	/**
	 * Disable/hide the inspector GUI
	 */
	public disableInspector(): void {
		if (this.inspectorManager) {
			this.inspectorManager.hide();
		}
	}

	/**
	 * Toggle the inspector GUI visibility
	 * Creates the inspector if it doesn't exist
	 */
	public toggleInspector(): boolean {
		if (!this.inspectorManager) {
			this.enableInspector();
			return true;
		}
		this.inspectorManager.toggle();
		return this.inspectorManager.visible;
	}

	private async initialize(
		schematicData: { [key: string]: () => Promise<ArrayBuffer> },
		defaultResourcePacks: Record<string, DefaultPackCallback>
	): Promise<void> {
		try {
			// Update progress bar for each initialization step
			const showProgress = (message: string, progress: number) => {
				if (this.options.enableProgressBar && this.uiManager) {
					this.uiManager.updateProgress(progress, message);
				}
			};

			// Steps 1 & 2: WASM init and resource-pack/atlas loading are independent, so
			// run them concurrently — the (often slow) pack decode/atlas build overlaps
			// WASM instantiation instead of being serialized behind it. With a shared
			// context the packs are already in the shared Cubane, so that half is a no-op.
			showProgress("Loading assets...", 0.15);
			const wasmReady = SchematicRenderer.isNucleationInitialized
				? Promise.resolve()
				: initializeNucleationWasm().then(() => {
						SchematicRenderer.isNucleationInitialized = true;
					});
			const packsReady = this.options.context
				? Promise.resolve()
				: this.initializeResourcePacks(defaultResourcePacks);
			await Promise.all([wasmReady, packsReady]);
			if (this.isDisposed) {
				// A private pack load can finish after dispose(). Dispose once more to
				// release any atlas/textures published by that late continuation.
				if (!this.options.context) this.cubane.dispose();
				return;
			}
			this.updateMissingPackNotice();

			// Step 4: Initialize builders and managers
			showProgress("Setting up renderer components...", 0.6);
			this.worldMeshBuilder = new WorldMeshBuilder(this, this.cubane);

			// Enable greedy meshing if configured
			if (this.options.wasmMeshBuilderOptions?.greedyMeshingEnabled) {
				this.worldMeshBuilder.setGreedyMeshing(true);
			}

			const schematicManagerOptions: SchematicManagerOptions = {
				singleSchematicMode: this.options.singleSchematicMode,
				callbacks: {
					onSchematicFileLoaded: this.options?.callbacks?.onSchematicFileLoaded,
					onSchematicFileLoadFailure: this.options?.callbacks?.onSchematicFileLoadFailure,
				},
			};
			this.schematicManager = new SchematicManager(this, schematicManagerOptions);

			// Initialize RenderManager (async for WebGPU support)
			this.renderManager = new RenderManager(this);
			await this.renderManager.initialize();
			if (this.isDisposed) return;

			this.highlightManager = new HighlightManager(this);
			this.insignManager = new InsignManager(this);
			this.insignIoManager = new InsignIoManager(this);
			this.regionManager = new RegionManager(this);
			this.regionInteractionHandler = new RegionInteractionHandler(this);
			this.overlayManager = new OverlayManager(this);

			// Initialize optional components
			if (this.options.enableGizmos) {
				this.gizmoManager = new GizmoManager(this);
			}

			// Step 5: Load initial schematics if provided
			if (Object.keys(schematicData).length > 0) {
				showProgress("Loading initial schematics...", 0.75);
				await this.schematicManager.loadSchematics(schematicData);
				if (this.isDisposed) return;
			}

			// Step 6: Setup camera and interaction
			showProgress("Finalizing setup...", 0.9);
			// Use the improved focusOnSchematics for better auto-framing
			if (!this.schematicManager.isEmpty()) {
				this.cameraManager.focusOnSchematics({ animationDuration: 0 });
			}
			this.initializeInteractionComponents();

			// Initialization complete
			showProgress("Ready", 1.0);

			// Start rendering
			this.animate();

			// Initialize inspector if enabled
			if (this.options.debugOptions?.enableInspector) {
				this.inspectorManager = new InspectorManager(this, this.options.debugOptions);
			}

			// Trigger callbacks and events
			this.options.callbacks?.onRendererInitialized?.(this);
			this.canvas.dispatchEvent(new CustomEvent("rendererInitialized"));

			// Hide the progress bar as soon as the renderer is ready — no artificial
			// delay. The old 500ms "show completion state" pause kept the dimming overlay
			// over an already-rendered scene, which read as slower than it was (and
			// dominated the perceived time on the fast warm-context / SPA path).
			if (this.options.enableProgressBar && this.uiManager) {
				this.uiManager.hideProgressBar();
			}
		} catch (error) {
			if (this.isDisposed) return;
			console.error("Failed to initialize SchematicRenderer:", error);

			// Show error in progress bar
			if (this.options.enableProgressBar && this.uiManager) {
				this.uiManager.updateProgress(1.0, "Initialization failed");
				setTimeout(() => this.uiManager?.hideProgressBar(), 2000);
			}

			console.error(error);
		}
	}

	private initializeInteractionComponents(): void {
		// Initialize simulation manager if enabled
		if (this.options.simulationOptions?.enableSimulation) {
			this.simulationManager = new SimulationManager(this.eventEmitter);

			// Hook up simulation callbacks through eventEmitter
			this.eventEmitter.on("simulationInitialized", () => {
				if (this.schematicManager) {
					const firstSchematic = this.schematicManager.getFirstSchematic();
					if (firstSchematic) {
						this.options.callbacks?.onSimulationInitialized?.(firstSchematic.id);
					}
				}
			});
			this.eventEmitter.on("blockInteracted", (data: any) => {
				const [x, y, z] = data.position || [0, 0, 0];
				this.options.callbacks?.onBlockInteracted?.(x, y, z);
			});
			this.eventEmitter.on("simulationTicked", (data: any) => {
				this.options.callbacks?.onSimulationTicked?.(data.tickCount || 0);
			});
			this.eventEmitter.on("simulationSynced", (data: any) => {
				this.options.callbacks?.onSimulationSynced?.();
				// Update the schematic wrapper with the synced state before rebuilding
				const updatedSchematic = data.updatedSchematic;
				if (updatedSchematic) {
					const firstSchematic = this.schematicManager?.getFirstSchematic();
					if (firstSchematic) {
						firstSchematic.schematicWrapper = updatedSchematic;
					}
				}
				// Rebuild meshes after sync
				this.rebuildAllChunks();
			});
			this.eventEmitter.on("simulationError", (data: any) => {
				this.options.callbacks?.onSimulationError?.(data.error);
			});

			// Configure auto-tick if specified
			if (this.options.simulationOptions.autoTickSpeed) {
				this.simulationManager.setTickSpeed(this.options.simulationOptions.autoTickSpeed);
			}
		}

		// Initialize block interaction handler
		if (this.schematicManager) {
			this.blockInteractionHandler = new BlockInteractionHandler(
				this.eventEmitter,
				this.schematicManager,
				this.simulationManager
			);
		}

		if (this.options.enableInteraction) {
			const interactionOptions: InteractionManagerOptions = {
				enableSelection: this.options.interactionOptions?.enableSelection || false,
				enableMovingSchematics: this.options.interactionOptions?.enableMovingSchematics || false,
			};
			this.interactionManager = new InteractionManager(this, interactionOptions);
		}

		if (this.options.enableDragAndDrop) {
			const dragAndDropOptions: DragAndDropManagerOptions = {
				acceptedFileTypes: this.options.dragAndDropOptions?.acceptedFileTypes || [
					"schematic",
					"nbt",
					"schem",
					"litematic",
					"mcstructure",
				],
				gridLayout: this.options.dragAndDropOptions?.gridLayout,
				callbacks: {
					// Schematic callbacks
					onSchematicLoaded: this.options.callbacks?.onSchematicLoaded,
					onSchematicDropped: this.options.callbacks?.onSchematicDropped,
					onSchematicDropSuccess: this.options.callbacks?.onSchematicDropSuccess,
					onSchematicDropFailed: this.options.callbacks?.onSchematicDropFailed,

					// Resource pack callbacks
					onResourcePackLoaded: this.options.callbacks?.onResourcePackLoaded,
					onResourcePackDropped: this.options.callbacks?.onResourcePackDropped,
					onResourcePackDropSuccess: this.options.callbacks?.onResourcePackDropSuccess,
					onResourcePackDropFailed: this.options.callbacks?.onResourcePackDropFailed,

					// General callbacks
					onInvalidFileType: this.options.callbacks?.onInvalidFileType,
					onLoadingProgress: this.options.callbacks?.onLoadingProgress,
				},
			};
			this.dragAndDropManager = new DragAndDropManager(this, dragAndDropOptions);
		}
	}

	/**
	 * Set up callbacks for resource pack events
	 */
	private setupResourcePackCallbacks(): void {
		const callbacks = this.options.callbacks;
		const rpCallbacks = this.options.resourcePackOptions;

		// Pack changed events
		this.resourcePackManager.on("packsChanged", (event: PacksChangedEvent) => {
			callbacks?.onPacksChanged?.(event.reason);
			rpCallbacks?.onPacksChanged?.(event);
		});

		// Pack toggled events
		this.resourcePackManager.on("packToggled", (event: PackToggledEvent) => {
			callbacks?.onPackToggled?.(event.packId, event.enabled);
			rpCallbacks?.onPackToggled?.(event.packId, event.enabled);
		});

		// Atlas rebuild events
		this.resourcePackManager.on("atlasRebuilt", (event: { textureCount: number }) => {
			callbacks?.onAtlasRebuilt?.(event.textureCount);
			rpCallbacks?.onAtlasRebuilt?.();
		});

		// Pack added events
		this.resourcePackManager.on("packAdded", (event: PackAddedEvent) => {
			rpCallbacks?.onPackAdded?.(event);
		});

		// Pack removed events
		this.resourcePackManager.on("packRemoved", (event: PackRemovedEvent) => {
			rpCallbacks?.onPackRemoved?.(event.packId);
		});

		// Load progress events
		this.resourcePackManager.on("loadProgress", (event: LoadProgressEvent) => {
			rpCallbacks?.onLoadProgress?.(event);
		});

		// Load complete events
		this.resourcePackManager.on("loadComplete", (event: LoadCompleteEvent) => {
			rpCallbacks?.onLoadComplete?.(event);
		});

		// Load error events
		this.resourcePackManager.on("loadError", (event: LoadErrorEvent) => {
			rpCallbacks?.onLoadError?.(event);
		});

		// Error events
		this.resourcePackManager.on("error", (event: PackErrorEvent) => {
			rpCallbacks?.onError?.(event);
		});

		// Set atlas rebuild callback to reload resources
		// This is called when packs are toggled/changed, so always force reload
		this.resourcePackManager.setAtlasRebuildCallback(async () => {
			console.log("[SchematicRenderer] Atlas rebuild callback invoked - forcing reload");
			await this.reloadResourcePacksIntoCubane(true); // Force reload when packs change
		});
	}

	/**
	 * Reload all enabled resource packs into Cubane
	 * @param force - Force reload even if Cubane already has packs loaded
	 */
	private async reloadResourcePacksIntoCubane(force: boolean = false): Promise<void> {
		if (!this.cubane) return;

		try {
			const enabledPacks = this.resourcePackManager.getEnabledPacksWithBlobs();

			// Only skip on initial load (not forced) if Cubane already has the same number of packs
			if (!force) {
				const cubanePackCount = this.cubane.getPackCount?.() ?? 0;
				if (cubanePackCount > 0 && cubanePackCount >= enabledPacks.length) {
					console.log(
						`[SchematicRenderer] Cubane already has ${cubanePackCount} pack(s) loaded, skipping reload`
					);
					return;
				}
			}

			// IMPORTANT: In Cubane/Minecraft, packs loaded LAST override earlier packs.
			// Our priority system: lower number = higher priority = should override others.
			// So we need to REVERSE the order: load low-priority packs first, high-priority last.
			const packsToLoad = [...enabledPacks].reverse();

			console.log(
				`[SchematicRenderer] Reloading ${packsToLoad.length} resource pack(s) into Cubane...`
			);

			// Use batch mode to clear and reload all packs at once (single atlas rebuild at end)
			this.cubane.beginPackBatchUpdate();

			try {
				// Clear existing packs first (important when packs are disabled)
				await this.cubane.removeAllPacks();

				// Load enabled packs
				for (const pack of packsToLoad) {
					try {
						await this.cubane.loadResourcePack(pack.blob);
						console.log(`  ✓ Loaded: ${pack.name}`);
					} catch (error) {
						console.error(`  ✗ Failed to load pack ${pack.name}:`, error);
					}
				}
			} finally {
				// End batch mode - this triggers a single atlas rebuild with all packs
				await this.cubane.endPackBatchUpdate();
			}

			// Clear MaterialRegistry cache so new textures are used
			MaterialRegistry.clear();

			// Invalidate WorldMeshBuilder cache so new textures are used
			if (this.worldMeshBuilder) {
				this.worldMeshBuilder.invalidateCache();
			}

			// Rebuild all loaded schematics with new textures
			await this.rebuildAllSchematics();

			// Trigger event for external listeners
			this.eventEmitter.emit("resourcePacksReloaded");
			console.log("Resource pack reload complete");
		} catch (error) {
			console.error("Failed to reload resource packs into Cubane:", error);
		}
	}

	/**
	 * Rebuild all loaded schematics (e.g., after resource pack changes)
	 */
	public async rebuildAllSchematics(): Promise<void> {
		if (!this.schematicManager) return;

		const schematics = this.schematicManager.getAllSchematics();
		console.log(`Rebuilding ${schematics.length} schematic(s) with updated textures...`);

		for (const schematic of schematics) {
			try {
				await schematic.rebuildMesh();
			} catch (error) {
				console.error(`Failed to rebuild schematic ${schematic.name}:`, error);
			}
		}

		// Mark scene as needing update
		if (this.sceneManager?.scene) {
			this.sceneManager.scene.traverse((obj) => {
				if ((obj as any).material) {
					const mat = (obj as any).material;
					if (Array.isArray(mat)) {
						mat.forEach((m: any) => {
							if (m) m.needsUpdate = true;
						});
					} else {
						mat.needsUpdate = true;
					}
				}
			});
		}

		console.log("Schematic rebuild complete");
	}

	/**
	 * Show or hide the in-viewport "no resource pack loaded" notice based on how
	 * many packs are currently loaded. Safe to call any time; a no-op when the
	 * notice is disabled (`resourcePackOptions.showMissingPackNotice: false`) or
	 * the user has dismissed it.
	 */
	public updateMissingPackNotice(): void {
		if (!this.resourcePackNotice) return;
		const packCount = this.cubane?.getPackCount?.() ?? 0;
		if (packCount > 0) this.resourcePackNotice.hide();
		else this.resourcePackNotice.show();
	}

	private async initializeResourcePacks(
		defaultResourcePacks?: Record<string, DefaultPackCallback>
	): Promise<void> {
		await this.resourcePackManager.initPromise;

		// Check if Cubane already has packs loaded (from auto-restore)
		const cubanePackCount = this.cubane.getPackCount?.() ?? 0;
		if (cubanePackCount > 0) {
			return;
		}

		// Get resource pack blobs from your existing system
		const resourcePackBlobs = await this.resourcePackManager.getResourcePackBlobs(
			defaultResourcePacks || {}
		);

		if (resourcePackBlobs.length === 0) {
			console.info(
				"[SchematicRenderer] No resource pack loaded — blocks will render with " +
					"placeholder textures.\n  Add one with `renderer.addResourcePack(file)` " +
					"or drop a Minecraft resource pack (.zip) onto the canvas."
			);
			return;
		}

		console.log(`[SchematicRenderer] Loading ${resourcePackBlobs.length} resource pack(s)...`);

		// Use batch mode to load all packs at once (single atlas rebuild at the end)
		this.cubane.beginPackBatchUpdate();

		try {
			for (let i = 0; i < resourcePackBlobs.length; i++) {
				const blob = resourcePackBlobs[i];
				try {
					await this.cubane.loadResourcePack(blob as Blob);
				} catch (error) {
					console.error(`Failed to load resource pack ${i + 1}:`, error);
				}
			}
		} finally {
			// End batch mode - triggers single atlas rebuild with all packs
			await this.cubane.endPackBatchUpdate();
		}

		// Store the blobs for backward compatibility if needed
		this.options.resourcePackBlobs = resourcePackBlobs;
	}

	private lastFrameTime = 0;
	private targetFPS: number;
	private idleFPS: number;
	// Poll rate (Hz) for advancing animated textures while otherwise idle. 20Hz
	// comfortably covers Minecraft's fastest animations (1-tick frametime = 20fps)
	// without redrawing every vsync. The actual redraw only happens on a frame flip.
	private readonly animatedPollFps = 20;
	private enableAnimatedTextures: boolean;
	private frameInterval: number;
	// Owns the rAF/idle-poll handles and the re-arm logic. Clearing the spent frame
	// handle each tick (beginTick) is what lets invalidate() wake the loop after it
	// has idled — see RenderLoopScheduler.
	private loop = new RenderLoopScheduler(
		{
			requestFrame: (cb) => requestAnimationFrame(cb),
			cancelFrame: (id) => cancelAnimationFrame(id),
			setTimer: (cb, ms) => window.setTimeout(cb, ms),
			clearTimer: (id) => clearTimeout(id),
		},
		() => this.animate()
	);
	private isDisposed = false;
	private isSuspended = false;
	private frameCount = 0;
	private lastDebugTime = 0;
	private throttledFrames = 0;

	// Adaptive FPS tracking
	private lastCameraPosition = new THREE.Vector3();
	private lastCameraQuaternion = new THREE.Quaternion();
	private pointerEventBound = false;
	private wakeUpHandler: (() => void) | null = null;
	private pointerDownHandler: (() => void) | null = null;
	private pointerReleaseHandler: (() => void) | null = null;

	// On-demand rendering: only render when the scene is dirty or something is
	// continuously animating. `needsRender` starts true so the first frame draws.
	private needsRender = true;
	private continuousReasons = new Set<string>();

	/**
	 * Bind pointer events to canvas for immediate wake-up from idle mode
	 */
	private bindPointerEvents(): void {
		if (this.pointerEventBound) return;

		// Wake the (possibly stopped) render loop on real interaction. We do NOT bind
		// plain pointermove: hovering the canvas shouldn't force renders — OrbitControls
		// emits its own "change" event (wired in CameraManager) for actual camera moves.
		this.wakeUpHandler = () => this.invalidate();

		// While a pointer is HELD (a drag), keep the loop running every frame. With
		// OrbitControls damping a pointermove only accumulates rotate/pan deltas — the
		// camera actually moves (and emits "change") on the next controls.update(), which
		// runs only inside the render loop. Since pointermove is intentionally not a wake
		// event, a drag begun after the loop has idled would accumulate deltas that never
		// apply — the drag looks frozen until some other action invalidates. Pinning the
		// loop continuous makes update() run, which applies the drag and re-arms the
		// "change" → invalidate chain. On release we drop the reason and invalidate once
		// so the damping inertia starts; it then self-sustains via "change" until settled.
		this.pointerDownHandler = () => this.setContinuous("interaction", true);
		this.pointerReleaseHandler = () => {
			this.setContinuous("interaction", false);
			this.invalidate();
		};

		this.canvas.addEventListener("pointerdown", this.pointerDownHandler);
		// Release can land off-canvas (pointer capture) or be pre-empted — listen wide.
		window.addEventListener("pointerup", this.pointerReleaseHandler);
		window.addEventListener("pointercancel", this.pointerReleaseHandler);
		window.addEventListener("blur", this.pointerReleaseHandler);

		this.canvas.addEventListener("wheel", this.wakeUpHandler);
		this.canvas.addEventListener("touchstart", this.wakeUpHandler);
		this.canvas.addEventListener("touchmove", this.wakeUpHandler);

		this.pointerEventBound = true;
	}

	/**
	 * Unbind pointer events
	 */
	private unbindPointerEvents(): void {
		if (!this.pointerEventBound) return;

		if (this.pointerDownHandler) {
			this.canvas.removeEventListener("pointerdown", this.pointerDownHandler);
		}
		if (this.pointerReleaseHandler) {
			window.removeEventListener("pointerup", this.pointerReleaseHandler);
			window.removeEventListener("pointercancel", this.pointerReleaseHandler);
			window.removeEventListener("blur", this.pointerReleaseHandler);
		}
		if (this.wakeUpHandler) {
			this.canvas.removeEventListener("wheel", this.wakeUpHandler);
			this.canvas.removeEventListener("touchstart", this.wakeUpHandler);
			this.canvas.removeEventListener("touchmove", this.wakeUpHandler);
		}

		// Never leave the loop pinned continuous if we tear down mid-drag.
		this.setContinuous("interaction", false);

		this.wakeUpHandler = null;
		this.pointerDownHandler = null;
		this.pointerReleaseHandler = null;
		this.pointerEventBound = false;
	}

	/**
	 * Mark the scene dirty so the next scheduled frame renders. If the render loop
	 * has stopped (fully idle), this restarts it. Call after any change that should
	 * be visible: camera/controls moves, schematic load/rebuild, resize, hover, etc.
	 */
	public invalidate(): void {
		this.needsRender = true;
		// A suspended renderer keeps the dirty flag (so it redraws on resume) but does
		// not restart the loop.
		if (this.isDisposed || this.isSuspended) return;
		// If the loop is slow-polling while idle, cancel the poll and wake immediately
		// on a vsync-aligned frame — interaction must feel instant, not wait out the
		// idle poll interval. wake() is a no-op if a frame is already queued.
		this.loop.wake();
	}

	/**
	 * Pause the render loop without tearing anything down — the scene, GPU resources,
	 * workers, and assets all stay in memory. Use this when the viewport scrolls
	 * off-screen or during SPA navigation (e.g. `wire:navigate`) when the canvas is
	 * kept alive (Livewire `@persist`, Turbo permanent). Cheap and instantly
	 * reversible with `resume()`. To free resources entirely, use `dispose()`.
	 */
	public suspend(): void {
		if (this.isSuspended) return;
		this.isSuspended = true;
		// Cancel any pending frame AND idle poll, or the loop would silently resume.
		this.loop.stop();
	}

	/** Resume a suspended render loop and request a redraw. */
	public resume(): void {
		if (!this.isSuspended) return;
		this.isSuspended = false;
		this.invalidate();
	}

	/** Whether the render loop is currently paused (see `suspend`). */
	public get suspended(): boolean {
		return this.isSuspended;
	}

	/**
	 * Keep rendering continuously while `reason` is active. Used for things that
	 * animate every frame (animated textures, auto-orbit, camera-path tweens, video
	 * recording, redstone simulation). Call with `active=false` to release.
	 */
	public setContinuous(reason: string, active: boolean): void {
		if (active) {
			this.continuousReasons.add(reason);
			this.invalidate();
		} else {
			this.continuousReasons.delete(reason);
		}
	}

	private get continuous(): boolean {
		return this.continuousReasons.size > 0;
	}

	private animate(): void {
		// The frame/poll that invoked this tick has fired — clear its spent handle so
		// the scheduler's pending-state is accurate and invalidate() can re-arm after
		// an idle poll. (This is the fix for the "drag freezes after the scene settles"
		// bug.) Must run before any early return that leaves the loop stopped.
		this.loop.beginTick();

		// Stop animation loop if disposed
		if (this.isDisposed) {
			console.log("[Renderer] Animation loop stopped - disposed");
			return;
		}

		// Paused (off-screen / SPA navigation): stop the loop without rescheduling.
		// resume() restarts it.
		if (this.isSuspended) {
			return;
		}

		const now = performance.now();

		// Initialize lastDebugTime on first frame
		if (this.lastDebugTime === 0) {
			this.lastDebugTime = now;
		}

		// Detect camera movement → mark dirty. Runs every tick (independent of the
		// legacy adaptive-FPS flag); also catches OrbitControls inertial damping,
		// since the camera keeps moving for a few frames after release.
		const camera = this.cameraManager.activeCamera.camera;
		const cameraMoved =
			!camera.position.equals(this.lastCameraPosition) ||
			!camera.quaternion.equals(this.lastCameraQuaternion);
		if (cameraMoved) {
			this.lastCameraPosition.copy(camera.position);
			this.lastCameraQuaternion.copy(camera.quaternion);
			this.needsRender = true;
		}

		// targetFPS stays an upper cap (0 = uncapped). The idle-FPS path is retired
		// by on-demand rendering; enableAdaptiveFPS/idleThreshold are now no-ops.
		this.frameInterval = this.targetFPS > 0 ? 1000 / this.targetFPS : 0;

		// THREE.Timer requires an explicit update() per frame before reading the delta.
		this.timer.update();
		const deltaTime = this.timer.getDelta();

		// ALWAYS update controls for smooth interaction (critical for responsiveness)
		// This runs at full refresh rate for immediate feedback
		// CameraManager.update() handles all control types: orbit, creative, and fly
		this.cameraManager.update(deltaTime);

		// Update legacy keyboard controls (WASD movement while right-clicking)
		// This is the old workaround; FlyControls is now the preferred method
		if (this.keyboardControls && !this.cameraManager.isFlyControlsEnabled()) {
			this.keyboardControls.update(deltaTime);
		}

		// Animated textures (water/lava/fire/…) are event-driven and off by default.
		// When enabled we poll the texture timers each tick (cheap time math) and mark
		// the scene dirty only on the tick a frame actually flips (~10fps for water) —
		// no per-vsync redraws, so a static view with water still idles to 0fps.
		const texturesAnimating = this.enableAnimatedTextures && !!this.cubane?.hasAnimatedTextures();
		if (texturesAnimating && this.cubane.updateAnimations()) {
			this.needsRender = true;
		}

		// Decide whether to render: the FPS cap must allow it AND the scene must be
		// dirty or continuously animating.
		const elapsed = now - this.lastFrameTime;
		const fpsAllows = this.frameInterval === 0 || elapsed >= this.frameInterval;
		const wantsRender = shouldRenderFrame({
			needsRender: this.needsRender,
			continuous: this.continuous,
		});
		const shouldRender = fpsAllows && wantsRender;

		// Schedule the next tick. When something needs drawing we use vsync-aligned
		// requestAnimationFrame; otherwise we slow-poll via setTimeout so the browser
		// frame pipeline (style/layout/composite) can go quiet — this is the heat fix.
		// invalidate() cancels the poll and wakes us instantly on any real change, so
		// the idle poll is just a backstop. `wantsRender` (not `shouldRender`) drives
		// the choice so an fps-capped-but-dirty frame still reschedules promptly.
		const schedule = pickFrameSchedule({ wantsRender, texturesAnimating });
		if (schedule === "raf") {
			this.loop.requestFrame();
		} else {
			this.loop.requestPoll(
				scheduleDelayMs(schedule, {
					idleFps: this.idleFPS,
					animatedPollFps: this.animatedPollFps,
				})
			);
		}

		if (!shouldRender) {
			// FPS-capped this tick; nothing to render.
			this.throttledFrames++;
			return;
		}

		// Update lastFrameTime for next throttle calculation
		this.lastFrameTime = this.frameInterval === 0 ? now : now - (elapsed % this.frameInterval);

		// Count only rendered frames for FPS calculation
		this.frameCount++;

		// Debug logging every 2 seconds
		if (now - this.lastDebugTime > 2000) {
			const renderedFPS = this.frameCount / ((now - this.lastDebugTime) / 1000);
			this.fps = renderedFPS;

			if (this.options.logFPS) {
				const reasons = [...this.continuousReasons].join(",") || "none";
				console.log(
					`[Renderer] FPS: ${renderedFPS.toFixed(1)} rendered (${this.throttledFrames} throttled) | continuous: ${reasons}`
				);
			}

			this.frameCount = 0;
			this.throttledFrames = 0;
			this.lastDebugTime = now;
		}

		// Rest of your existing updates (only when not throttled)
		if (!this.highlightManager) return;
		if (!this.renderManager) return;

		this.highlightManager.update(deltaTime);
		this.gizmoManager?.update();
		this.renderManager.render();
		// Rendered the current scene state — clear the dirty flag.
		this.needsRender = false;

		this.interactionManager?.update();
	}

	// Schematic rendering bounds management

	/**
	 * Gets the rendering bounds for a schematic
	 * @param schematicId ID of the schematic
	 * @param asArrays If true, returns min/max as arrays instead of Vector3s
	 * @returns The rendering bounds or null if schematic not found
	 */
	public getRenderingBounds(
		schematicId: string,
		asArrays: boolean = true
	): { min: THREE.Vector3 | number[]; max: THREE.Vector3 | number[] } | null {
		const schematic = this.schematicManager?.getSchematic(schematicId);
		if (!schematic) {
			console.error(`Schematic with ID ${schematicId} not found`);
			return null;
		}

		if (asArrays) {
			return {
				min: schematic.renderingBounds.min.toArray(),
				max: schematic.renderingBounds.max.toArray(),
			};
		} else {
			return {
				min: schematic.renderingBounds.min.clone(),
				max: schematic.renderingBounds.max.clone(),
			};
		}
	}

	/**
	 * Sets the rendering bounds for a schematic and enables them
	 * @param schematicId ID of the schematic
	 * @param min Minimum coordinates (Vector3 or array [x,y,z])
	 * @param max Maximum coordinates (Vector3 or array [x,y,z])
	 * @param showHelper Whether to show a visual helper for the bounds
	 */
	public setRenderingBounds(
		schematicId: string,
		min: THREE.Vector3 | number[],
		max: THREE.Vector3 | number[],
		showHelper: boolean = true
	): void {
		const schematic = this.schematicManager?.getSchematic(schematicId);
		if (!schematic) {
			console.error(`Schematic with ID ${schematicId} not found`);
			return;
		}

		schematic.setRenderingBounds(min, max, showHelper);
		// Enable the bounds when explicitly set
		schematic.renderingBounds.enabled = true;
	}

	/**
	 * Sets a specific axis of the rendering bounds
	 * @param schematicId ID of the schematic
	 * @param axis The axis to set ('x', 'y', or 'z')
	 * @param minValue Minimum value for the axis
	 * @param maxValue Maximum value for the axis
	 */
	public setRenderingBoundsAxis(
		schematicId: string,
		axis: "x" | "y" | "z",
		minValue: number,
		maxValue: number
	): void {
		const schematic = this.schematicManager?.getSchematic(schematicId);
		if (!schematic) {
			console.error(`Schematic with ID ${schematicId} not found`);
			return;
		}

		const bounds = this.getRenderingBounds(schematicId, false);
		if (!bounds) return;

		const min = bounds.min as THREE.Vector3;
		const max = bounds.max as THREE.Vector3;

		// Update just the specified axis
		min[axis] = minValue;
		max[axis] = maxValue;

		schematic.setRenderingBounds(min, max);
	}

	/**
	 * Resets the rendering bounds to include the full schematic or disables them
	 * @param schematicId ID of the schematic
	 * @param disable Whether to disable the rendering bounds (default: true)
	 */
	public resetRenderingBounds(schematicId: string, disable: boolean = true): void {
		const schematic = this.schematicManager?.getSchematic(schematicId);
		if (!schematic) {
			console.error(`Schematic with ID ${schematicId} not found`);
			return;
		}

		schematic.resetRenderingBounds();
		// By default, disable the bounds when reset
		schematic.renderingBounds.enabled = !disable;
	}

	/**
	 * Shows or hides the rendering bounds helper
	 * @param schematicId ID of the schematic
	 * @param visible Whether the helper should be visible
	 */
	public showRenderingBoundsHelper(schematicId: string, visible: boolean): void {
		const schematic = this.schematicManager?.getSchematic(schematicId);
		if (!schematic) {
			console.error(`Schematic with ID ${schematicId} not found`);
			return;
		}

		schematic.showRenderingBoundsHelper(visible);
	}

	/**
	 * Gets the dimensions of a schematic
	 * @param schematicId ID of the schematic
	 * @returns The dimensions as an array [width, height, depth] or null if schematic not found
	 */
	public getSchematicDimensions(schematicId: string): Int32Array | number[] | null {
		const schematic = this.schematicManager?.getSchematic(schematicId);
		if (!schematic) {
			console.error(`Schematic with ID ${schematicId} not found`);
			return null;
		}

		return Array.from(schematic.schematicWrapper.get_dimensions());
	}

	/**
	 * Gets all currently loaded schematics
	 * @returns Array of schematic IDs
	 */
	public getLoadedSchematics(): string[] {
		if (!this.schematicManager) return [];
		return this.schematicManager.getAllSchematics().map((schematic) => schematic.id);
	}

	/**
	 * Creates console-friendly settings for working with rendering bounds
	 * Delegates to the SchematicObject's createBoundsControls method
	 * @param schematicId ID of the schematic
	 * @returns Functions for easy console usage
	 */
	public createBoundsControls(schematicId: string): any {
		const schematic = this.schematicManager?.getSchematic(schematicId);
		if (!schematic) {
			console.error(`Schematic with ID ${schematicId} not found`);
			return null;
		}

		return schematic.createBoundsControls();
	}

	/**
	 * Show the floating slicer overlay (rendering-bounds controls).
	 * Lazily constructs the overlay if it hasn't been created yet.
	 */
	public showSlicerOverlay(options?: SlicerOverlayOptions): SlicerOverlay {
		if (!this.slicerOverlay) {
			this.slicerOverlay = new SlicerOverlay(this, options ?? this.options.slicerOverlayOptions);
		}
		this.slicerOverlay.show();
		return this.slicerOverlay;
	}

	/** Hide the floating slicer overlay (no-op if it hasn't been created). */
	public hideSlicerOverlay(): void {
		this.slicerOverlay?.hide();
	}

	/** Toggle the floating slicer overlay, constructing it on first call. */
	public toggleSlicerOverlay(): void {
		if (!this.slicerOverlay) {
			this.showSlicerOverlay();
			return;
		}
		this.slicerOverlay.toggle();
	}

	/**
	 * Provides direct access to a schematic's bounds for easy manipulation
	 * @param schematicId ID of the schematic
	 * @returns The schematic's reactive bounds object or null if not found
	 */
	public getBounds(schematicId: string): any {
		const schematic = this.schematicManager?.getSchematic(schematicId);
		if (!schematic) {
			console.error(`Schematic with ID ${schematicId} not found`);
			return null;
		}

		return schematic.bounds;
	}

	// Resource pack management methods
	public async getResourcePacks(): Promise<
		Array<{ name: string; enabled: boolean; order: number }>
	> {
		await this.resourcePackManager.initPromise;
		return await this.resourcePackManager.listPacks();
	}

	public async addResourcePack(file: File): Promise<void> {
		// Show progress for resource pack upload
		if (this.options.enableProgressBar && this.uiManager) {
			this.uiManager.showProgressBar(`Adding resource pack: ${file.name}`);
			this.uiManager.updateProgress(0.1, "Processing pack file...");
		}

		// Add to your existing system
		await this.resourcePackManager.uploadPack(file);

		if (this.options.enableProgressBar && this.uiManager) {
			this.uiManager.updateProgress(0.3, "Loading into Cubane...");
		}

		// Also load directly into Cubane for immediate use
		try {
			await this.cubane.loadResourcePack(file);
			await (this.cubane.getAssetLoader() as any).buildTextureAtlas?.();
		} catch (error) {
			console.error("Failed to load new resource pack into Cubane:", error);
		}

		if (this.options.enableProgressBar && this.uiManager) {
			this.uiManager.updateProgress(0.6, "Rebuilding meshes...");
		}

		// Rebuild world meshes if needed
		if (this.worldMeshBuilder && this.schematicManager) {
			// for (const schematic of this.schematicManager.getAllSchematics()) {
			// 	await this.worldMeshBuilder.rebuildSchematic(schematic.id);
			// }
		}

		if (this.options.enableProgressBar && this.uiManager) {
			this.uiManager.updateProgress(1.0, "Resource pack added");
			setTimeout(() => this.uiManager?.hideProgressBar(), 500);
		}

		this.updateMissingPackNotice();
	}

	public async toggleResourcePackEnabled(name: string, enabled: boolean): Promise<void> {
		// Show progress for resource pack toggling
		if (this.options.enableProgressBar && this.uiManager) {
			const actionText = enabled ? "Enabling" : "Disabling";
			this.uiManager.showProgressBar(`${actionText} resource pack: ${name}`);
			this.uiManager.updateProgress(0.2, `${actionText} ${name}...`);
		}

		await this.resourcePackManager.togglePackEnabled(name, enabled);
		await this.reloadResources();
	}

	public async removeResourcePack(name: string): Promise<void> {
		// Show progress for resource pack removal
		if (this.options.enableProgressBar && this.uiManager) {
			this.uiManager.showProgressBar(`Removing resource pack: ${name}`);
			this.uiManager.updateProgress(0.2, `Removing ${name}...`);
		}

		await this.resourcePackManager.removePack(name);
		await this.reloadResources();
	}

	private async reloadResources(): Promise<void> {
		// Show progress bar for resource reload
		if (this.options.enableProgressBar && this.uiManager) {
			this.uiManager.showProgressBar("Reloading resources...");
			this.uiManager.updateProgress(0.2, "Processing resource packs...");
		}

		// Clear Cubane's existing resources
		this.cubane.dispose();
		this.cubane = new Cubane({
			autoRestore: false,
			showUnknownBlocks: this.options.debugOptions?.showUnknownBlocks,
		}); // Recreate fresh instance

		// Reinitialize resource packs in Cubane
		await this.initializeResourcePacks();
		this.updateMissingPackNotice();

		if (this.options.enableProgressBar && this.uiManager) {
			this.uiManager.updateProgress(0.5, "Loading textures and models...");
		}

		// Rebuild world meshes with new resources
		if (this.worldMeshBuilder && this.schematicManager) {
			this.uiManager?.updateProgress(0.7, "Rebuilding schematic meshes...");

			// Trigger rebuild of all schematic meshes
			// for (const schematic of this.schematicManager.getAllSchematics()) {
			// 	await this.worldMeshBuilder.rebuildSchematic(schematic.id);
			// }
		}

		if (this.options.enableProgressBar && this.uiManager) {
			this.uiManager.updateProgress(1.0, "Resources loaded");

			// Hide progress bar after a short delay
			setTimeout(() => {
				this.uiManager?.hideProgressBar();
			}, 500);
		}

		this.materialMap.clear();
	}

	/**
	 * Shows the performance dashboard via the sidebar
	 */
	public showPerformanceDashboard(): void {
		this.sidebar?.show("performance");
	}

	/**
	 * Hides the sidebar (hides performance dashboard if active)
	 */
	public hidePerformanceDashboard(): void {
		this.sidebar?.hide();
	}

	/**
	 * Toggles the performance dashboard via the sidebar
	 */
	public togglePerformanceDashboard(): void {
		if (this.sidebar?.getActiveTab() === "performance" && !this.sidebar?.isCollapsed()) {
			this.sidebar?.hide();
		} else {
			this.sidebar?.show("performance");
		}
	}

	/**
	 * Set SSAO preset for a specific camera mode
	 * @param mode Camera mode ('perspective' or 'isometric')
	 * @param params SSAO parameters
	 */
	public setSSAOPreset(
		mode: "perspective" | "isometric",
		params: {
			aoRadius?: number;
			distanceFalloff?: number;
			intensity?: number;
		}
	): void {
		if (this.renderManager) {
			this.renderManager.setSSAOPreset(mode, params);
		}
	}

	/**
	 * Get current SSAO presets
	 */
	public getSSAOPresets(): {
		perspective: { aoRadius: number; distanceFalloff: number; intensity: number };
		isometric: { aoRadius: number; distanceFalloff: number; intensity: number };
	} | null {
		return this.renderManager?.getSSAOPresets() ?? null;
	}

	/**
	 * Set SSAO parameters for the current camera mode
	 * @param params SSAO parameters
	 */
	public setSSAOParameters(params: {
		aoRadius?: number;
		distanceFalloff?: number;
		intensity?: number;
		qualityMode?: "Performance" | "Low" | "Medium" | "High" | "Ultra";
	}): void {
		if (this.renderManager) {
			this.renderManager.setSSAOParameters(params);
		}
	}

	/**
	 * Set custom isometric viewing angles
	 * @param pitchDegrees Vertical angle in degrees (0-90, default ~35.264 for true isometric)
	 * @param yawDegrees Horizontal rotation in degrees (default 45)
	 * @param refocus Whether to refocus on schematics after changing angles (default true)
	 */
	public setIsometricAngles(
		pitchDegrees: number,
		yawDegrees: number = 45,
		refocus: boolean = true
	): void {
		this.cameraManager.setIsometricAngles(pitchDegrees, yawDegrees, refocus);
	}

	/**
	 * Reset isometric angles to true isometric view
	 * @param refocus Whether to refocus on schematics (default true)
	 */
	public resetIsometricAngles(refocus: boolean = true): void {
		this.cameraManager.resetIsometricAngles(refocus);
	}

	/**
	 * Get current isometric viewing angles
	 * @returns Object with pitch and yaw in degrees, or null if not in isometric mode
	 */
	public getIsometricAngles(): { pitch: number; yaw: number } | null {
		return this.cameraManager.getIsometricAngles();
	}

	/**
	 * Initializes simulation for the first schematic
	 */
	public async initializeSimulation(): Promise<boolean> {
		if (!this.simulationManager) {
			console.warn("Simulation is not enabled");
			return false;
		}

		const firstSchematic = this.schematicManager?.getFirstSchematic();
		if (!firstSchematic) {
			console.warn("No schematic loaded to simulate");
			return false;
		}

		const schematic = firstSchematic.getSchematicWrapper();
		if (!schematic) {
			console.warn("Could not get schematic wrapper");
			return false;
		}

		return await this.simulationManager.initializeSimulation(schematic);
	}

	/**
	 * Manually ticks the simulation
	 * @param numTicks Number of ticks to advance (default: 1)
	 */
	public tickSimulation(numTicks: number = 1): void {
		this.simulationManager?.tick(numTicks);
	}

	/**
	 * Syncs simulation state back to schematic and rebuilds meshes
	 */
	public async syncSimulation(): Promise<void> {
		const updatedSchematic = this.simulationManager?.syncToSchematic();
		if (updatedSchematic) {
			// Update the schematic wrapper and rebuild mesh
			const firstSchematic = this.schematicManager?.getFirstSchematic();
			if (firstSchematic) {
				firstSchematic.schematicWrapper = updatedSchematic;
				await firstSchematic.rebuildMesh();
			} else {
				console.error("[syncSimulation] No first schematic found!");
			}
		} else {
			console.error("[syncSimulation] No updated schematic returned from sync!");
		}
	}

	/**
	 * Starts auto-ticking the simulation
	 */
	public startAutoTick(): void {
		this.simulationManager?.startAutoTick();
	}

	/**
	 * Stops auto-ticking the simulation
	 */
	public stopAutoTick(): void {
		this.simulationManager?.stopAutoTick();
	}

	/**
	 * Resets the simulation
	 */
	public async resetSimulation(): Promise<boolean> {
		if (!this.simulationManager) return false;
		this.simulationManager.reset();
		this.rebuildAllChunks();
		return true;
	}

	/**
	 * Gets the current simulation state
	 */
	public getSimulationState() {
		return this.simulationManager?.getState();
	}

	/**
	 * Rebuilds all chunks in all schematics
	 */
	private rebuildAllChunks(): void {
		const schematics = this.schematicManager?.getAllSchematics();
		if (!schematics) return;

		for (const schematic of schematics) {
			schematic.rebuildAllChunks();
		}
	}

	// ===== CAPTURE API =====

	/**
	 * Take a screenshot of the current view
	 * @param options Screenshot options (width, height, quality, format)
	 * @returns Promise<Blob> The screenshot as a Blob
	 */
	public async takeScreenshot(options?: {
		width?: number;
		height?: number;
		quality?: number;
		format?: "image/png" | "image/jpeg" | "image/webp";
		transparent?: boolean;
	}): Promise<Blob> {
		return this.cameraManager.recordingManager.takeScreenshot(options);
	}

	/**
	 * Take a screenshot and automatically download it
	 * @param filename Filename (without extension)
	 * @param options Screenshot options
	 */
	public async downloadScreenshot(
		filename: string = "schematic_screenshot",
		options?: {
			width?: number;
			height?: number;
			quality?: number;
			format?: "image/png" | "image/jpeg";
		}
	): Promise<void> {
		const format = options?.format ?? "image/png";
		const blob = await this.takeScreenshot(options);
		const extension = format === "image/png" ? "png" : "jpg";
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${filename}.${extension}`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	/**
	 * Start video recording along the camera path
	 * @param duration Duration in seconds
	 * @param options Recording options
	 */
	public async startRecording(
		duration: number,
		options?: {
			width?: number;
			height?: number;
			frameRate?: number;
			quality?: number;
			onProgress?: (progress: number) => void;
			onComplete?: (blob: Blob) => void;
		}
	): Promise<void> {
		return this.cameraManager.recordingManager.startRecording(duration, options);
	}

	/**
	 * Stop the current recording
	 */
	public stopRecording(): void {
		this.cameraManager.recordingManager.stopRecording();
	}

	/**
	 * Check if currently recording
	 */
	public isRecording(): boolean {
		return this.cameraManager.recordingManager.isRecording;
	}

	// ===== RENDER SETTINGS API =====

	/**
	 * Set the background color (for non-HDRI backgrounds)
	 * @param color Color as hex string (e.g., "#87ceeb") or number (e.g., 0x87ceeb)
	 */
	public setBackgroundColor(color: string | number): void {
		this.sceneManager.setBackgroundColor(color);
		this.renderManager?.setIsometricBackgroundColor(color);
	}

	/**
	 * Set camera mode (perspective, isometric, or first-person)
	 * @param mode Camera mode
	 */
	public setCameraMode(mode: "perspective" | "isometric" | "perspective_fpv"): void {
		this.cameraManager.switchCameraPreset(mode);
	}

	/**
	 * Get current camera mode
	 */
	public getCameraMode(): string {
		return (this.cameraManager as any).activeCameraKey;
	}

	/**
	 * Enable or disable SSAO (ambient occlusion)
	 * @param enabled Whether SSAO should be enabled
	 */
	public setSSAOEnabled(enabled: boolean): void {
		this.renderManager?.setSSAOEnabled(enabled);
	}

	/**
	 * Check if SSAO is enabled
	 */
	public isSSAOEnabled(): boolean {
		return this.renderManager?.isSSAOEnabled() ?? false;
	}

	/**
	 * Enable or disable the grid helper
	 * @param visible Whether the grid should be visible
	 */
	public setGridVisible(visible: boolean): void {
		this.sceneManager.showGrid = visible;
	}

	/**
	 * Enable or disable the axes helper
	 * @param visible Whether the axes should be visible
	 */
	public setAxesVisible(visible: boolean): void {
		this.sceneManager.showAxes = visible;
	}

	// ===== CAMERA PATH API =====

	/**
	 * Show or hide the camera path visualization
	 * @param visible Whether the path should be visible
	 * @param pathName Name of the path (default: "circularPath")
	 */
	public setCameraPathVisible(visible: boolean, pathName: string = "circularPath"): void {
		if (visible) {
			this.cameraManager.showPathVisualization(pathName);
		} else {
			this.cameraManager.hidePathVisualization(pathName);
		}
	}

	/**
	 * Fit the camera path to frame all loaded schematics
	 * @param pathName Name of the path (default: "circularPath")
	 */
	public fitCameraPath(pathName: string = "circularPath"): void {
		this.cameraManager.cameraPathManager.fitCircularPathToSchematics(pathName);
	}

	/**
	 * Animate the camera along a path (for previews or recordings)
	 * @param options Animation options
	 */
	public async animateCameraAlongPath(options?: {
		pathName?: string;
		totalFrames?: number;
		targetFps?: number;
		onUpdate?: (progress: number) => void;
		onComplete?: () => void;
	}): Promise<void> {
		return this.cameraManager.animateCameraAlongPath(options);
	}

	// ===== SIDEBAR API =====

	/**
	 * Show the sidebar with the specified tab (or current tab if none)
	 */
	public showSidebar(tab?: SidebarTabId): void {
		this.sidebar?.show(tab);
	}

	/**
	 * Hide/collapse the sidebar
	 */
	public hideSidebar(): void {
		this.sidebar?.hide();
	}

	/**
	 * Toggle the sidebar visibility
	 */
	public toggleSidebar(): void {
		this.sidebar?.toggle();
	}

	/**
	 * Switch to a specific sidebar tab
	 */
	public showSidebarTab(tab: SidebarTabId): void {
		this.sidebar?.showTab(tab);
	}

	/**
	 * Enable keyboard shortcuts
	 */
	public enableKeyboardShortcuts(): void {
		this.sidebar?.enableShortcuts();
	}

	/**
	 * Disable keyboard shortcuts
	 */
	public disableKeyboardShortcuts(): void {
		this.sidebar?.disableShortcuts();
	}

	/**
	 * Get the current sidebar state
	 */
	public getSidebarState(): {
		visible: boolean;
		collapsed: boolean;
		activeTab: SidebarTabId | null;
	} {
		return {
			visible: this.sidebar !== undefined,
			collapsed: this.sidebar?.isCollapsed() ?? true,
			activeTab: this.sidebar?.getActiveTab() ?? null,
		};
	}

	public dispose(): void {
		if (this.isDisposed) return;

		// Mark first: every async continuation checks this flag before publishing work.
		this.isDisposed = true;

		// Cancel any pending frame/idle-poll to stop the loop immediately
		this.loop.stop();

		// Unbind pointer events
		this.unbindPointerEvents();

		this.schematicManager?.dispose();
		this.schematicManager = undefined;

		// Reject pending mesh jobs and terminate only workers owned by this renderer.
		// WorldMeshBuilder itself preserves shared-context workers.
		this.worldMeshBuilder?.dispose();
		this.worldMeshBuilder = undefined;

		this.keyboardControls?.dispose();
		this.keyboardControls = undefined;
		this.inspectorManager?.dispose();
		this.inspectorManager = undefined;
		this.regionManager?.dispose();
		this.regionManager = undefined;
		this.regionInteractionHandler?.dispose();
		this.regionInteractionHandler = undefined;
		this.highlightManager?.dispose();
		this.highlightManager = undefined;
		this.renderManager?.dispose();
		this.renderManager = undefined;
		this.interactionManager?.dispose();
		this.interactionManager = undefined;
		this.dragAndDropManager?.dispose();
		this.dragAndDropManager = undefined;
		this.gizmoManager?.dispose();
		this.gizmoManager = undefined;
		this.simulationManager?.destroy();
		this.simulationManager = undefined;
		this.blockInteractionHandler?.dispose();
		this.blockInteractionHandler = undefined;
		this.insignIoManager?.dispose();
		this.insignIoManager = undefined;
		this.overlayManager?.dispose();
		this.overlayManager = undefined;
		this.resourcePackNotice?.dispose();
		this.resourcePackNotice = undefined;
		this.slicerOverlay?.dispose();
		this.slicerOverlay = undefined;
		this.uiManager?.dispose();
		this.uiManager = undefined;
		this.cameraManager?.dispose();
		this.sidebar?.dispose();
		this.sidebar = undefined;
		this.resourcePackManager?.dispose();

		if ((this.canvas as any).schematicRenderer === this) {
			delete (this.canvas as any).schematicRenderer;
		}

		// Clean up Cubane resources. When using a shared context, the Cubane is owned
		// by the context (and shared with other renderers) — just detach, don't dispose.
		if (this.options.context) {
			this.options.context.detachRenderer(this);
		} else {
			this.cubane.dispose();
		}

		// Cleanup event listeners
		this.eventEmitter.removeAllListeners();
	}
}

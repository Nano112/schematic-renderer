import * as THREE from "three";
import { SchematicObject } from "./SchematicObject";
import { SchematicWrapper } from "nucleation"; // Adjust the import path
import { WorldMeshBuilder } from "../WorldMeshBuilder"; // Adjust the import path
import { EventEmitter } from "events";
import { SceneManager } from "./SceneManager"; // Adjust the import path
import { SchematicRenderer } from "../SchematicRenderer";
import { MemoryLeakFix, clearAllCaches, forceGarbageCollection } from "../utils/MemoryLeakFix";
import { GeometryBufferPool } from "../GeometryBufferPool";
import { performanceMonitor } from "../performance/PerformanceMonitor";
interface LoadingProgress {
	stage: "file_reading" | "parsing" | "mesh_building" | "scene_setup";
	progress: number; // 0-100
	message: string;
}

export interface SchematicManagerOptions {
	singleSchematicMode?: boolean;
	callbacks?: {
		onSchematicFileLoaded?: (file: File) => void | Promise<void>;
		onSchematicFileLoadFailure?: (file: File) => void | Promise<void>;
	};
}
export class SchematicManager {
	public schematics: Map<string, SchematicObject> = new Map();
	public schematicRenderer: SchematicRenderer;
	public eventEmitter: EventEmitter;
	//@ts-ignore
	private worldMeshBuilder: WorldMeshBuilder;
	private options: SchematicManagerOptions;
	private sceneManager: SceneManager;
	private singleSchematicMode: boolean;
	private disposed = false;
	private activeFileReaders = new Set<FileReader>();
	private activeFetches = new Set<AbortController>();

	constructor(schematicRenderer: SchematicRenderer, options: SchematicManagerOptions = {}) {
		this.schematicRenderer = schematicRenderer;
		this.options = options;
		if (!this.schematicRenderer) {
			throw new Error("SchematicRenderer is required.");
		}
		if (!this.schematicRenderer.worldMeshBuilder) {
			throw new Error("WorldMeshBuilder is required.");
		}
		this.worldMeshBuilder = schematicRenderer.worldMeshBuilder as WorldMeshBuilder;
		this.eventEmitter = schematicRenderer.eventEmitter;
		this.sceneManager = schematicRenderer.sceneManager;
		this.singleSchematicMode = options.singleSchematicMode || false;
	}

	private readFileWithProgress(
		file: File,
		onProgress?: (progress: number) => void
	): Promise<ArrayBuffer> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			this.activeFileReaders.add(reader);
			const finish = () => this.activeFileReaders.delete(reader);

			reader.onprogress = (event) => {
				if (event.lengthComputable) {
					const progress = (event.loaded / event.total) * 100;
					onProgress?.(progress);
				}
			};

			reader.onload = () => {
				finish();
				resolve(reader.result as ArrayBuffer);
			};
			reader.onerror = () => {
				finish();
				reject(reader.error);
			};
			reader.onabort = () => {
				finish();
				reject(new DOMException("Schematic load cancelled", "AbortError"));
			};

			reader.readAsArrayBuffer(file);
		});
	}

	private isSchematicWrapper(obj: any): obj is SchematicWrapper {
		// Duck typing: check for SchematicWrapper-specific methods/properties
		return (
			obj &&
			typeof obj === "object" &&
			(typeof obj.to_schematic === "function" ||
				typeof obj.from_data === "function" ||
				typeof obj.get_block === "function" ||
				typeof obj.set_block === "function" ||
				(typeof obj.__wbg_ptr === "number" && obj.__wbg_ptr > 0) ||
				(obj.constructor &&
					obj.constructor.name &&
					obj.constructor.name.includes("SchematicWrapper")))
		);
	}

	public async loadSchematic(
		name: string,
		schematicData: ArrayBuffer | SchematicWrapper,
		properties?: Partial<{
			position: THREE.Vector3 | number[];
			rotation: THREE.Euler | number[];
			scale: THREE.Vector3 | number[] | number;
			opacity: number;
			visible: boolean;
			focused: boolean;
		}>,
		options?: {
			onProgress?: (progress: LoadingProgress) => void;
		}
	): Promise<void> {
		if (this.disposed) return;

		if (this.singleSchematicMode) {
			await this.removeAllSchematics();
			if (this.disposed) return;
		}

		// Parsing stage - 20% of total progress
		options?.onProgress?.({
			stage: "parsing",
			progress: 0,
			message: "Parsing schematic data...",
		});
		let schematicWrapper: SchematicWrapper;
		if (schematicData instanceof ArrayBuffer) {
			schematicWrapper = new SchematicWrapper();
			schematicWrapper.from_data(new Uint8Array(schematicData));
		} else if (this.isSchematicWrapper(schematicData)) {
			schematicWrapper = schematicData as SchematicWrapper;
		} else {
			throw new Error(
				`Invalid schematic data type. Expected ArrayBuffer or SchematicWrapper. Found: ${typeof schematicData}. Object: ${JSON.stringify(
					Object.getOwnPropertyNames(schematicData)
				)}`
			);
		}

		options?.onProgress?.({
			stage: "parsing",
			progress: 20,
			message: "Schematic parsed",
		});

		// Mesh building stage - 40% of total progress
		options?.onProgress?.({
			stage: "mesh_building",
			progress: 20,
			message: "Building meshes...",
		});

		const schematicObject = new SchematicObject(
			this.schematicRenderer,
			name,
			schematicWrapper,
			properties
		);
		if (this.disposed) {
			schematicObject.dispose();
			return;
		}

		options?.onProgress?.({
			stage: "mesh_building",
			progress: 60,
			message: "Meshes built",
		});

		// Scene setup stage - final 40%
		options?.onProgress?.({
			stage: "scene_setup",
			progress: 60,
			message: "Setting up scene...",
		});

		if (this.schematicRenderer && this.schematicRenderer.uiManager) {
			this.schematicRenderer.uiManager.hideEmptyState();
		}
		this.addSchematic(schematicObject);
		if (properties?.focused || !properties || properties.focused === undefined) {
			this.eventEmitter.emit("schematicAdded", { schematic: schematicObject });
		}

		options?.onProgress?.({
			stage: "scene_setup",
			progress: 100,
			message: "Complete",
		});
	}

	public async removeAllSchematics() {
		const promises = Array.from(this.schematics.keys()).map((name) => this.removeSchematic(name));
		await Promise.all(promises);

		// After removing all schematics, perform cleanup
		// Note: We do NOT call performDeepCleanup() here because it disrupts
		// the mesh building for the next schematic. The individual removeSchematic
		// calls already clean up their own resources.
	}

	/**
	 * Performs comprehensive memory cleanup after schematic operations
	 * This should be called between test runs to prevent memory leaks
	 * NOTE: Does NOT dispose WorldMeshBuilder as it's shared and needed for future builds
	 */
	public performDeepCleanup(): void {
		// Clear all caches and registries
		clearAllCaches();

		// DON'T dispose WorldMeshBuilder here - it's shared and needed for future schematic builds
		// Only invalidate its cache so new textures are used
		this.worldMeshBuilder.invalidateCache();

		// Clear buffer pool
		GeometryBufferPool.clear();

		// Clear all performance monitoring sessions
		performanceMonitor.clearAllSessions();

		// Force single garbage collection
		forceGarbageCollection();
	}

	public async loadSchematics(
		schematicDataMap: { [key: string]: () => Promise<ArrayBuffer> },
		propertiesMap?: {
			[key: string]: Partial<{
				position: THREE.Vector3 | number[];
				rotation: THREE.Euler | number[];
				scale: THREE.Vector3 | number[] | number;
				opacity: number;
				visible: boolean;
			}>;
		}
	): Promise<void> {
		for (const key in schematicDataMap) {
			if (this.disposed) return;
			if (schematicDataMap.hasOwnProperty(key)) {
				const arrayBuffer = await schematicDataMap[key]();
				if (this.disposed) return;
				const properties = propertiesMap ? propertiesMap[key] : undefined;
				await this.loadSchematic(key, arrayBuffer, properties).then(() => {
					if (!this.disposed) {
						this.sceneManager.schematicRenderer.options?.callbacks?.onSchematicLoaded?.(key);
					}
				});
			}
		}
	}

	public async loadSchematicFromFile(
		file: File,
		options?: {
			onProgress?: (progress: LoadingProgress) => void;
		}
	): Promise<void> {
		if (this.disposed) return;
		try {
			// Start showing progress in UI if enabled
			if (this.schematicRenderer.options.enableProgressBar && this.schematicRenderer.uiManager) {
				this.schematicRenderer.uiManager.showProgressBar(`Loading ${file.name}`);
			}

			// File reading stage
			const arrayBuffer = await this.readFileWithProgress(file, (progress) => {
				if (this.disposed) return;
				// Update progress callback if provided
				options?.onProgress?.({
					stage: "file_reading",
					progress,
					message: "Reading file...",
				});

				// Update UI progress bar
				if (this.schematicRenderer.options.enableProgressBar && this.schematicRenderer.uiManager) {
					this.schematicRenderer.uiManager.updateProgress(
						progress / 100, // Convert to 0-1 range
						`Reading ${file.name}...`
					);
				}
			});
			if (this.disposed) return;

			// Load the schematic with progress tracking
			const id = file.name;
			await this.loadSchematic(id, arrayBuffer, undefined, {
				onProgress: (progress) => {
					// Update progress callback if provided
					options?.onProgress?.(progress);

					// Update UI progress bar
					if (
						this.schematicRenderer.options.enableProgressBar &&
						this.schematicRenderer.uiManager
					) {
						// Calculate overall progress (file reading is 20%, schematic loading is 80%)
						const overallProgress = 0.2 + (progress.progress / 100) * 0.8;

						this.schematicRenderer.uiManager.updateProgress(overallProgress, progress.message);
					}
				},
			});

			// Hide progress bar when complete
			if (this.schematicRenderer.options.enableProgressBar && this.schematicRenderer.uiManager) {
				this.schematicRenderer.uiManager.hideProgressBar();
			}

			await this.options.callbacks?.onSchematicFileLoaded?.(file);

			// Emit completion event
			this.eventEmitter.emit("schematicLoaded", { id });
		} catch (error) {
			if (this.disposed) return;
			// Hide progress bar on error
			if (this.schematicRenderer.options.enableProgressBar && this.schematicRenderer.uiManager) {
				this.schematicRenderer.uiManager.hideProgressBar();
			}
			await this.options.callbacks?.onSchematicFileLoadFailure?.(file);

			this.eventEmitter.emit("schematicLoadError", { error });
			throw error;
		}
	}

	public async loadSchematicFromURL(
		url: string,
		name?: string,
		properties?: Partial<{
			position: THREE.Vector3 | number[];
			rotation: THREE.Euler | number[];
			scale: THREE.Vector3 | number[] | number;
			opacity: number;
			visible: boolean;
			focused: boolean;
		}>,
		options?: {
			onProgress?: (progress: LoadingProgress) => void;
		}
	): Promise<void> {
		if (this.disposed) return;
		const controller = new AbortController();
		this.activeFetches.add(controller);
		try {
			// Generate a name for display
			const displayName = name || new URL(url).pathname.split("/").pop() || "schematic";

			// Start showing progress in UI if enabled
			if (this.schematicRenderer.options.enableProgressBar && this.schematicRenderer.uiManager) {
				this.schematicRenderer.uiManager.showProgressBar(`Loading ${displayName}`);
				this.schematicRenderer.uiManager.updateProgress(0, "Fetching schematic from URL...");
			}

			// File reading stage
			options?.onProgress?.({
				stage: "file_reading",
				progress: 0,
				message: "Fetching schematic from URL...",
			});

			// Fetch the schematic
			const response = await fetch(url, { signal: controller.signal });
			if (this.disposed) return;
			if (!response.ok) {
				throw new Error(`HTTP error! status: ${response.status}`);
			}

			// Update progress to 20% after fetch completes
			if (this.schematicRenderer.options.enableProgressBar && this.schematicRenderer.uiManager) {
				this.schematicRenderer.uiManager.updateProgress(
					0.2,
					"Download complete, processing schematic..."
				);
			}

			options?.onProgress?.({
				stage: "file_reading",
				progress: 100,
				message: "Download complete, processing schematic...",
			});

			const arrayBuffer = await response.arrayBuffer();
			if (this.disposed) return;

			// Generate a name if none provided
			const schematicName = name || new URL(url).pathname.split("/").pop() || "schematic_from_url";

			// Load the schematic with progress tracking
			await this.loadSchematic(schematicName, arrayBuffer, properties, {
				onProgress: (progress) => {
					// Update progress callback if provided
					options?.onProgress?.(progress);

					// Update UI progress bar
					if (
						this.schematicRenderer.options.enableProgressBar &&
						this.schematicRenderer.uiManager
					) {
						// Calculate overall progress (file reading is 20%, schematic loading is 80%)
						const overallProgress = 0.2 + (progress.progress / 100) * 0.8;

						this.schematicRenderer.uiManager.updateProgress(overallProgress, progress.message);
					}
				},
			});

			// Hide progress bar when complete
			if (this.schematicRenderer.options.enableProgressBar && this.schematicRenderer.uiManager) {
				this.schematicRenderer.uiManager.hideProgressBar();
			}

			// Emit completion event
			this.eventEmitter.emit("schematicLoaded", { id: schematicName });
		} catch (error) {
			if (this.disposed) return;
			// Hide progress bar on error
			if (this.schematicRenderer.options.enableProgressBar && this.schematicRenderer.uiManager) {
				this.schematicRenderer.uiManager.hideProgressBar();
			}

			this.eventEmitter.emit("schematicLoadError", { error });
			throw error;
		} finally {
			this.activeFetches.delete(controller);
		}
	}

	public async removeSchematic(name: string) {
		const schematicObject = this.schematics.get(name);
		if (!schematicObject) return;

		console.log(`🗑️ Starting removal of schematic: ${name}`);
		const startMemory = MemoryLeakFix.monitorMemory();

		try {
			// Remove definition regions associated with this schematic
			if (this.schematicRenderer.regionManager) {
				this.schematicRenderer.regionManager.removeDefinitionRegions(name);
			}

			// Remove from map first to prevent any new operations on this schematic
			this.schematics.delete(name);
			// Mark disposed before awaiting its in-flight mesh build. Any late worker or
			// sign result is discarded by SchematicObject instead of rejoining the scene.
			schematicObject.dispose();

			// Wait for cancellation/cleanup to settle so this async API still means the
			// schematic no longer owns pending work when it resolves.
			const meshes = await schematicObject.getMeshes();
			console.log("Before removal - scene children:", this.sceneManager.scene.children.length);
			console.log("Meshes to remove:", meshes.length);

			// On-demand rendering: the scene changed, redraw it.
			this.schematicRenderer.invalidate();

			// Remove from scene if still there
			this.sceneManager.scene.remove(schematicObject.group);

			// Clear any user data that might hold references
			schematicObject.group.userData = {};

			// Emit removal event
			this.eventEmitter.emit("schematicRemoved", { id: name });

			// Force garbage collection to help with memory cleanup
			forceGarbageCollection();

			// Log memory improvement
			const endMemory = MemoryLeakFix.monitorMemory();
			if (startMemory && endMemory) {
				const memoryFreed = startMemory.used - endMemory.used;
				console.log(
					`💾 Memory freed: ${memoryFreed}MB (${startMemory.used}MB → ${endMemory.used}MB)`
				);
			}
		} catch (error) {
			console.error("Error removing schematic:", error);
			// Don't re-add to map since we already have enhanced cleanup
			// The disposal should have worked even if there was an error
		}

		console.log("After removal - scene children:", this.sceneManager.scene.children.length);

		if (this.isEmpty() && this.schematicRenderer.uiManager) {
			this.schematicRenderer.uiManager.showEmptyState();
		}
	}

	addSchematic(schematic: SchematicObject): void {
		if (this.disposed) {
			schematic.dispose();
			return;
		}
		this.schematics.set(schematic.id, schematic);

		// Auto-load definition regions from schematic metadata if enabled
		const defRegionOptions = this.schematicRenderer.options.definitionRegionOptions;
		if (defRegionOptions?.showOnLoad !== false) {
			// Defer loading to ensure schematic is fully initialized
			// Use queueMicrotask for better performance than setTimeout
			queueMicrotask(() => {
				if (this.disposed || !this.schematics.has(schematic.id)) return;
				try {
					const regionNames = schematic.loadDefinitionRegions();
					if (regionNames.length > 0) {
					}
				} catch (e) {
					console.warn(
						`[SchematicManager] Failed to auto-load definition regions for '${schematic.id}':`,
						e
					);
				}
			});
		}
	}

	getSchematic(id: string): SchematicObject | undefined {
		return this.schematics.get(id);
	}

	getAllSchematics(): SchematicObject[] {
		return Array.from(this.schematics.values());
	}

	getFirstSchematic(): SchematicObject | undefined {
		return this.getAllSchematics()[0];
	}

	public getSchematicAtPosition(position: THREE.Vector3): SchematicObject | null {
		for (const schematic of this.schematics.values()) {
			if (schematic.containsPosition(position)) {
				return schematic;
			}
		}
		return null;
	}

	public isEmpty(): boolean {
		return this.schematics.size === 0;
	}

	public schematicExists(id: string): boolean {
		return this.schematics.has(id);
	}

	public getSchematicsAveragePosition(): THREE.Vector3 {
		if (this.isEmpty()) return new THREE.Vector3();
		const box = this.getGlobalTightWorldBox();
		return box.getCenter(new THREE.Vector3());
	}

	/**
	 * Get the combined world-space bounding box of all schematics
	 */
	public getGlobalTightWorldBox(): THREE.Box3 {
		const globalBox = new THREE.Box3();
		const schematics = this.getAllSchematics();

		for (const schematic of schematics) {
			globalBox.union(schematic.getTightWorldBox());
		}

		return globalBox;
	}

	public getMaxSchematicDimensions(): THREE.Vector3 {
		if (this.isEmpty()) return new THREE.Vector3();
		const maxDimensions = new THREE.Vector3();
		const schematics = this.getAllSchematics();
		for (const schematic of schematics) {
			const dimensions = schematic.schematicWrapper.get_dimensions();
			maxDimensions.max(new THREE.Vector3(dimensions[0], dimensions[1], dimensions[2]));
		}
		return maxDimensions;
	}

	/**
	 * Get maximum tight dimensions across all schematics
	 * Uses actual block content, not pre-allocated space
	 * Falls back to allocated dimensions if tight bounds are not available
	 */
	public getMaxSchematicTightDimensions(): THREE.Vector3 {
		if (this.isEmpty()) return new THREE.Vector3();
		const maxDimensions = new THREE.Vector3();
		const schematics = this.getAllSchematics();
		for (const schematic of schematics) {
			const tightDimensions = schematic.getTightDimensions();
			// Fall back to allocated dimensions if tight bounds are empty (no blocks)
			if (tightDimensions[0] === 0 && tightDimensions[1] === 0 && tightDimensions[2] === 0) {
				const dimensions = schematic.schematicWrapper.get_dimensions();
				maxDimensions.max(new THREE.Vector3(dimensions[0], dimensions[1], dimensions[2]));
			} else {
				maxDimensions.max(
					new THREE.Vector3(tightDimensions[0], tightDimensions[1], tightDimensions[2])
				);
			}
		}
		return maxDimensions;
	}

	public getGlobalBoundingBox(): [number[], number[]] {
		const min = [0, 0, 0];
		const max = [0, 0, 0];

		for (const schematic of this.schematics.values()) {
			console.log("getBoundingBox", schematic.getBoundingBox());
			const [schematicMin, schematicMax] = schematic.getBoundingBox();
			for (let i = 0; i < 3; i++) {
				min[i] = Math.min(min[i], schematicMin[i]);
				max[i] = Math.max(max[i], schematicMax[i]);
			}
		}

		return [min, max];
	}

	/**
	 * Arrange all loaded schematics in a grid layout.
	 * Uses uniform cell sizes based on the largest schematic dimensions.
	 * Centers the grid around the origin.
	 */
	public arrangeInGrid(options?: { spacing?: number; columns?: number }): void {
		const schematics = this.getAllSchematics();
		const count = schematics.length;
		if (count <= 1) return;

		const spacing = options?.spacing ?? 2;
		const cols = options?.columns ?? Math.ceil(Math.sqrt(count));
		const rows = Math.ceil(count / cols);
		const maxDims = this.getMaxSchematicTightDimensions();

		const cellWidth = maxDims.x + spacing;
		const cellDepth = maxDims.z + spacing;
		const totalWidth = cols * cellWidth;
		const totalDepth = rows * cellDepth;

		schematics.forEach((schematic, i) => {
			const col = i % cols;
			const row = Math.floor(i / cols);
			const tightDims = schematic.getTightDimensions();
			const dims = tightDims[0] > 0 ? tightDims : schematic.getDimensions();

			const x = col * cellWidth - totalWidth / 2 + cellWidth / 2 - dims[0] / 2 + 0.5;
			const z = row * cellDepth - totalDepth / 2 + cellDepth / 2 - dims[2] / 2 + 0.5;

			schematic.setPosition([x, 0.5, z]);
		});

		this.eventEmitter.emit("schematicAdded", { schematic: schematics[0] });
	}

	public getSelectableObjects(): THREE.Object3D[] {
		return Array.from(this.schematics.values()).map((schematic) => schematic.group);
	}

	public createEmptySchematic(
		name: string,
		options?: Partial<{
			visible: boolean;
			position: THREE.Vector3 | number[];
		}>
	): SchematicObject {
		if (this.disposed) {
			throw new Error("Cannot create a schematic after SchematicManager disposal");
		}
		const schematicWrapper = new SchematicWrapper();
		const schematicObject = new SchematicObject(
			this.schematicRenderer,
			name,
			schematicWrapper,
			options
		);
		this.addSchematic(schematicObject);
		// Note: focusOnSchematics is NOT called here - caller is responsible for camera control
		// This avoids duplicate focus calls during initialization

		// Emit an event to notify that a schematic has been loaded
		this.eventEmitter.emit("schematicLoaded", { id: name });

		return schematicObject;
	}

	/** Cancel pending loads and release every schematic owned by this manager. */
	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;

		this.activeFileReaders.forEach((reader) => {
			if (reader.readyState === FileReader.LOADING) reader.abort();
		});
		this.activeFileReaders.clear();
		this.activeFetches.forEach((controller) => controller.abort());
		this.activeFetches.clear();

		this.schematics.forEach((schematic) => schematic.dispose());
		this.schematics.clear();
	}
}

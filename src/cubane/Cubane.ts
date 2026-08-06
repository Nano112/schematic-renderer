import * as THREE from "three";
import { AssetLoader } from "./AssetLoader";
import { EntityRenderer } from "./EntityRenderer";
import { SignRenderer } from "./SignRenderer";
import {
	Block,
	BlockGeometryInfo,
	BlockModel,
	BlockOptimizationData,
	ModelData,
	ResourcePackLoader,
	ResourcePackLoadOptions,
	ResourcePackInfo,
	PackFetchOptions,
	PackEventType,
	PackEventCallback,
	AssetConflict,
	PackAssetList,
	PackConfiguration,
	MemoryStats,
} from "./types";
import { ModelResolver } from "./ModelResolver";
import { BlockMeshBuilder } from "./BlockMeshBuilder";
import { ResourcePackManager } from "./ResourcePackManager";

// Define a type for dynamic parts of hybrid blocks
export interface HybridBlockDynamicPart {
	entityType: string; // The "entity" name for this part (e.g., "lectern_book", "bell_body")
	// Optional: offset, rotation if the dynamic part needs fixed adjustment relative to the static model's origin
	offset?: [number, number, number]; // In 0-1 block units
	rotation?: [number, number, number]; // Euler angles in degrees [x, y, z]
	// You might add more properties here if needed, e.g., scale
}

/**
 * Cubane - A Minecraft block and entity renderer for Three.js
 */
export class Cubane {
	private assetLoader: AssetLoader;
	public modelResolver: ModelResolver;
	private blockMeshBuilder: BlockMeshBuilder;
	private entityRenderer: EntityRenderer; // Will be used for the dynamic parts
	private signRenderer: SignRenderer; // Vanilla-accurate sign geometry + baked text
	// When false (default), unhandled blocks/entities render nothing instead of
	// a purple/magenta debug placeholder. Set via debugOptions.showUnknownBlocks.
	private showUnknownBlocks: boolean = false;
	private initialized: boolean = false;
	private initPromise: Promise<void>;
	private db: IDBDatabase | null = null;
	private dbName: string = "cubane-cache";
	private dbVersion: number = 1;

	// Resource Pack Manager - new unified pack management
	private packManager: ResourcePackManager;

	// Mesh caching
	private blockMeshCache: Map<string, THREE.Object3D> = new Map();
	private entityMeshCache: Map<string, THREE.Object3D> = new Map();
	private optimizationDataCache: Map<string, BlockOptimizationData> = new Map();

	// Block entity mapping for blocks that are *purely* entities
	private pureBlockEntityMap: Record<string, string> = {
		"minecraft:chest": "chest",
		"minecraft:trapped_chest": "trapped_chest",
		"minecraft:ender_chest": "ender_chest",

		// Note: "minecraft:bell" is removed from here as it's now hybrid
	};

	// New map for hybrid blocks: blockId -> configuration for its dynamic part(s)
	private hybridBlockConfig: Record<string, HybridBlockDynamicPart[]> = {
		"minecraft:lectern": [
			{
				entityType: "lectern_book", // This will map to a specific model in your EntityRenderer
				// The lectern book is often placed based on the model's geometry,
				// but an offset might be needed if your BookModel origin isn't perfectly aligned.
				// Example (adjust these values based on your lectern and book models):
				// offset: [0.5, 0.6875, 0.5], // Centered X/Z, Y based on lectern top height (11/16)
			},
		],
		"minecraft:bell": [
			{
				entityType: "bell", // This will map to the swinging bell model
				// The bell body's attachment point might vary slightly depending on the
				// static support model (floor, ceiling, wall). For simplicity, start with one.
				// Example (adjust based on your bell_body model's pivot and static model):
				// offset: [0.5, 0.875, 0.5], // Centered X/Z, Y for hanging point (e.g., 14/16)
			},
		],
		// Add other hybrid blocks here
	};

	constructor(options?: { autoRestore?: boolean; showUnknownBlocks?: boolean }) {
		this.showUnknownBlocks = options?.showUnknownBlocks ?? false;
		this.assetLoader = new AssetLoader();
		this.modelResolver = new ModelResolver(this.assetLoader);
		this.blockMeshBuilder = new BlockMeshBuilder(this.assetLoader, {
			showUnknownBlocks: this.showUnknownBlocks,
		});
		this.entityRenderer = new EntityRenderer(); // Make sure EntityRenderer can load "lectern_book", "bell_body"
		this.signRenderer = new SignRenderer(this.assetLoader);

		// Initialize ResourcePackManager
		this.packManager = new ResourcePackManager();
		this.assetLoader.setPackManager(this.packManager);

		// Set up mesh rebuild callback
		this.packManager.setMeshRebuildCallback(() => {
			this.clearMeshCaches();
		});

		const autoRestore = options?.autoRestore ?? true;
		const packManager = this.packManager; // Capture for async closure

		// Auto-save state when packs change
		packManager.on("packAdded", () => {
			// Save state in background after pack is added
			packManager.saveState().catch((err) => {
				console.warn("[Cubane] Failed to auto-save state:", err);
			});
		});
		packManager.on("packRemoved", () => {
			packManager.saveState().catch((err) => {
				console.warn("[Cubane] Failed to auto-save state:", err);
			});
		});

		this.initPromise = (async () => {
			// Try to auto-restore previous session's packs and atlas
			if (autoRestore) {
				try {
					const restored = await packManager.loadState();
					if (restored) {
						console.log("[Cubane] Auto-restored resource packs from cache");
						this.lastPackLoadedFromCache = true;
					}
				} catch (error) {
					console.warn("[Cubane] Failed to auto-restore state:", error);
				}
			}
			this.initialized = true;
		})();

		// Signs are handled by SignRenderer (see getBlockMesh), not registered as
		// GLTF block entities.
	}

	// --- Database and Resource Pack methods (assumed to be correct and complete) ---
	private async initDatabase(): Promise<IDBDatabase | null> {
		const isBrowser = typeof window !== "undefined";
		if (!isBrowser) {
			return Promise.resolve(null);
		}
		if (this.db) return this.db;
		if (!window.indexedDB) {
			throw new Error("IndexedDB not supported");
		}
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(this.dbName, this.dbVersion);
			request.onerror = (event) =>
				reject(new Error("Failed to open IndexedDB: " + (event.target as any)?.error));
			request.onsuccess = () => {
				this.db = request.result;
				resolve(this.db);
			};
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains("resourcePacks")) {
					db.createObjectStore("resourcePacks", { keyPath: "id" }).createIndex(
						"timestamp",
						"timestamp",
						{ unique: false }
					);
				}
			};
		});
	}
	private async storeResourcePack(packId: string, blob: Blob): Promise<void> {
		try {
			const db = await this.initDatabase();
			if (!db) return;
			return new Promise((resolve, reject) => {
				// reject on error
				const transaction = db.transaction(["resourcePacks"], "readwrite");
				const store = transaction.objectStore("resourcePacks");
				const request = store.put({
					id: packId,
					blob: blob,
					timestamp: Date.now(),
				});
				request.onsuccess = () => resolve();
				request.onerror = (e) =>
					reject(new Error("Failed to store pack: " + (e.target as any)?.error));
			});
		} catch (error) {
			console.error("Error storing resource pack:", error);
		}
	}
	private async getResourcePackFromCache(
		packId: string,
		expirationTime?: number | null
	): Promise<Blob | null> {
		try {
			const db = await this.initDatabase();
			if (!db) return null;
			return new Promise((resolve, reject) => {
				// reject on error
				const transaction = db.transaction(["resourcePacks"], "readonly");
				const store = transaction.objectStore("resourcePacks");
				const request = store.get(packId);
				request.onsuccess = () => {
					const data = request.result;
					if (!data || (expirationTime && Date.now() - data.timestamp > expirationTime)) {
						resolve(null);
					} else {
						resolve(data.blob);
					}
				};
				request.onerror = (e) =>
					reject(new Error("Failed to get pack from cache: " + (e.target as any)?.error));
			});
		} catch (error) {
			console.error("Error getting resource pack from cache:", error);
			return null;
		}
	}
	private async cleanupExpiredResourcePacks(expirationTime: number): Promise<void> {
		try {
			const db = await this.initDatabase();
			if (!db) return;
			const transaction = db.transaction(["resourcePacks"], "readwrite");
			const store = transaction.objectStore("resourcePacks");
			const index = store.index("timestamp");
			const cutoffTime = Date.now() - expirationTime;
			const request = index.openCursor(IDBKeyRange.upperBound(cutoffTime));
			request.onsuccess = () => {
				const cursor = request.result;
				if (cursor) {
					store.delete(cursor.primaryKey);
					cursor.continue();
				}
			};
		} catch (error) {
			console.error("Error cleaning up expired resource packs:", error);
		}
	}
	public async loadResourcePack(
		options: ResourcePackLoadOptions | Blob,
		loader?: ResourcePackLoader
	): Promise<void> {
		if (!this.initialized) await this.initPromise;

		// Route through ResourcePackManager for proper caching and deduplication
		if (options instanceof Blob) {
			// Check if this blob's hash is already loaded (deduplication happens in packManager)
			await this.packManager.loadPackFromBlob(options);
			this.lastPackLoadedFromCache = false;
			return;
		}

		// Legacy options-based loading with loader function
		const defaultOptions: ResourcePackLoadOptions = {
			packId: `pack_${Date.now()}`,
			useCache: true,
			forceReload: false,
			cacheExpiration: 7 * 24 * 60 * 60 * 1000,
		};
		const finalOptions = { ...defaultOptions, ...options };

		// Use loader function to get blob
		let resourcePackBlob: Blob | null = null;
		this.lastPackLoadedFromCache = false;

		if (finalOptions.useCache && !finalOptions.forceReload) {
			try {
				resourcePackBlob = await this.getResourcePackFromCache(
					finalOptions.packId!,
					finalOptions.cacheExpiration
				);
				if (resourcePackBlob) this.lastPackLoadedFromCache = true;
			} catch (error) {
				console.warn("Cubane: Error accessing cache:", error);
			}
		}

		if (!resourcePackBlob) {
			if (!loader) throw new Error("No loader and pack not in cache");
			resourcePackBlob = await loader();
			if (finalOptions.useCache && resourcePackBlob) {
				try {
					await this.storeResourcePack(finalOptions.packId!, resourcePackBlob);
					if (finalOptions.cacheExpiration)
						await this.cleanupExpiredResourcePacks(finalOptions.cacheExpiration);
				} catch (storeError) {
					console.warn("Cubane: Failed to cache resource pack:", storeError);
				}
			}
		}

		if (!resourcePackBlob) throw new Error("Failed to load or retrieve resource pack blob");

		// Route through packManager for deduplication
		await this.packManager.loadPackFromBlob(resourcePackBlob, finalOptions.packId);
	}
	public async listCachedResourcePacks(): Promise<
		Array<{ id: string; name: string; size: number; timestamp: number }>
	> {
		try {
			const db = await this.initDatabase();
			if (!db) return [];
			return new Promise((resolve, reject) => {
				const transaction = db.transaction(["resourcePacks"], "readonly");
				const store = transaction.objectStore("resourcePacks");
				const request = store.openCursor(null, "prev"); // Sort by newest first (if IDBKey is timestamp or similar)
				const results: Array<{
					id: string;
					name: string;
					size: number;
					timestamp: number;
				}> = [];
				request.onsuccess = () => {
					const cursor = request.result;
					if (cursor) {
						const { id, timestamp, blob } = cursor.value;
						results.push({
							id,
							name: id.replace(/^cubane_pack_/, "").replace(/_/g, " "),
							size: blob.size,
							timestamp,
						});
						cursor.continue();
					} else {
						results.sort((a, b) => b.timestamp - a.timestamp); // Explicit sort just in case
						resolve(results);
					}
				};
				request.onerror = (e) =>
					reject(new Error("Failed to list packs: " + (e.target as any)?.error));
			});
		} catch (error) {
			console.error("Error listing cached packs:", error);
			return [];
		}
	}
	public async loadMostRecentPack(): Promise<boolean> {
		try {
			const packs = await this.listCachedResourcePacks();
			if (packs.length === 0) return false;
			await this.loadCachedPack(packs[0].id); // Assumes list is sorted by recency
			return true;
		} catch (error) {
			console.error("Error loading most recent pack:", error);
			return false;
		}
	}
	public async loadCachedPack(packId: string): Promise<boolean> {
		try {
			const blob = await this.getResourcePackFromCache(packId);
			if (!blob) {
				console.warn(`Pack ${packId} not found in cache for direct load.`);
				return false;
			}
			await this.assetLoader.loadResourcePack(blob);
			await this.assetLoader.buildTextureAtlas(); // Ensure textures are ready
			this.lastPackLoadedFromCache = true;
			// Clear mesh caches when new resource pack is loaded
			this.clearMeshCaches();
			return true;
		} catch (error) {
			console.error(`Error loading cached pack ${packId}:`, error);
			return false;
		}
	}
	public async deleteCachedPack(packId: string): Promise<boolean> {
		try {
			const db = await this.initDatabase();
			if (!db) return false;
			return new Promise((resolve, reject) => {
				const transaction = db.transaction(["resourcePacks"], "readwrite");
				const store = transaction.objectStore("resourcePacks");
				const request = store.delete(packId);
				request.onsuccess = () => resolve(true);
				request.onerror = (e) =>
					reject(new Error(`Failed to delete pack ${packId}: ` + (e.target as any)?.error));
			});
		} catch (error) {
			console.error(`Error deleting pack ${packId}:`, error);
			return false;
		}
	}
	// --- End Legacy Database and Resource Pack methods ---

	// ============================================
	// NEW: Resource Pack Manager API
	// ============================================

	/**
	 * Get the ResourcePackManager instance for direct access
	 */
	public get packs(): ResourcePackManager {
		return this.packManager;
	}

	// --- Fetching & Loading ---

	/**
	 * Load a resource pack from a URL
	 */
	public async loadPackFromUrl(url: string, options?: PackFetchOptions): Promise<string> {
		return this.packManager.loadPackFromUrl(url, options);
	}

	/**
	 * Load a resource pack from a Blob
	 */
	public async loadPackFromBlob(blob: Blob, name?: string): Promise<string> {
		return this.packManager.loadPackFromBlob(blob, name);
	}

	/**
	 * Load a resource pack from a File (drag-drop, file input)
	 */
	public async loadPackFromFile(file: File): Promise<string> {
		return this.packManager.loadPackFromFile(file);
	}

	// --- Pack Management ---

	/**
	 * Remove a resource pack
	 */
	public async removePack(packId: string): Promise<void> {
		return this.packManager.removePack(packId);
	}

	/**
	 * Remove all resource packs
	 */
	public async removeAllPacks(): Promise<void> {
		return this.packManager.removeAllPacks();
	}

	/**
	 * Enable a resource pack
	 */
	public async enablePack(packId: string): Promise<void> {
		return this.packManager.enablePack(packId);
	}

	/**
	 * Disable a resource pack
	 */
	public async disablePack(packId: string): Promise<void> {
		return this.packManager.disablePack(packId);
	}

	/**
	 * Toggle a resource pack's enabled state
	 */
	public async togglePack(packId: string): Promise<boolean> {
		return this.packManager.togglePack(packId);
	}

	/**
	 * Set a pack's priority
	 */
	public async setPackPriority(packId: string, priority: number): Promise<void> {
		return this.packManager.setPackPriority(packId, priority);
	}

	/**
	 * Move a pack up in priority
	 */
	public async movePackUp(packId: string): Promise<void> {
		return this.packManager.movePackUp(packId);
	}

	/**
	 * Move a pack down in priority
	 */
	public async movePackDown(packId: string): Promise<void> {
		return this.packManager.movePackDown(packId);
	}

	/**
	 * Reorder packs (for drag-drop UI)
	 */
	public async reorderPacks(packIds: string[]): Promise<void> {
		return this.packManager.reorderPacks(packIds);
	}

	// --- Querying ---

	/**
	 * Get info for a specific pack
	 */
	public getPackInfo(packId: string): ResourcePackInfo | null {
		return this.packManager.getPack(packId);
	}

	/**
	 * Get all packs sorted by priority
	 */
	public getAllPacks(): ResourcePackInfo[] {
		return this.packManager.getAllPacks();
	}

	/**
	 * Get only enabled packs
	 */
	public getEnabledPacks(): ResourcePackInfo[] {
		return this.packManager.getEnabledPacks();
	}

	/**
	 * Get pack count
	 */
	public getPackCount(): number {
		return this.packManager.getPackCount();
	}

	/**
	 * Get assets provided by a specific pack
	 */
	public async getPackAssets(packId: string): Promise<PackAssetList> {
		return this.packManager.getPackAssets(packId);
	}

	/**
	 * Get which pack provides a specific asset
	 */
	public getAssetSource(
		assetPath: string,
		type: "texture" | "blockstate" | "model"
	): string | null {
		return this.packManager.getAssetSource(assetPath, type);
	}

	/**
	 * Get all asset conflicts
	 */
	public async getAssetConflicts(): Promise<AssetConflict[]> {
		return this.packManager.getAssetConflicts();
	}

	/**
	 * Preview a texture from a specific pack
	 */
	public async previewPackTexture(packId: string, texturePath: string): Promise<string | null> {
		return this.packManager.previewTexture(packId, texturePath);
	}

	// --- Events ---

	/**
	 * Subscribe to pack events
	 */
	public onPackEvent<T extends PackEventType>(event: T, callback: PackEventCallback<T>): void {
		this.packManager.on(event, callback);
	}

	/**
	 * Unsubscribe from pack events
	 */
	public offPackEvent<T extends PackEventType>(event: T, callback: PackEventCallback<T>): void {
		this.packManager.off(event, callback);
	}

	/**
	 * Subscribe to pack event once
	 */
	public oncePackEvent<T extends PackEventType>(event: T, callback: PackEventCallback<T>): void {
		this.packManager.once(event, callback);
	}

	// --- Batch Operations ---

	/**
	 * Begin a batch update (pauses auto-rebuild)
	 */
	public beginPackBatchUpdate(): void {
		this.packManager.beginBatchUpdate();
	}

	/**
	 * End a batch update (commits changes, triggers rebuild)
	 */
	public async endPackBatchUpdate(): Promise<void> {
		return this.packManager.endBatchUpdate();
	}

	/**
	 * Set auto-rebuild mode
	 */
	public setPackAutoRebuild(enabled: boolean): void {
		this.packManager.setAutoRebuild(enabled);
	}

	/**
	 * Manually trigger atlas rebuild
	 */
	public async rebuildPackAtlas(): Promise<void> {
		return this.packManager.rebuildAtlas();
	}

	// --- Persistence ---

	/**
	 * Save pack state to IndexedDB
	 */
	public async savePackState(): Promise<void> {
		return this.packManager.saveState();
	}

	/**
	 * Load pack state from IndexedDB
	 */
	public async loadPackState(): Promise<boolean> {
		return this.packManager.loadState();
	}

	/**
	 * Export pack configuration
	 */
	public exportPackConfig(): PackConfiguration {
		return this.packManager.exportConfig();
	}

	/**
	 * Import pack configuration
	 */
	public async importPackConfig(config: PackConfiguration): Promise<void> {
		return this.packManager.importConfig(config);
	}

	// --- Cache Management ---

	/**
	 * Get total pack cache size
	 */
	public async getPackCacheSize(): Promise<number> {
		return this.packManager.getCacheSize();
	}

	/**
	 * Clear all pack cache
	 */
	public async clearPackCache(): Promise<void> {
		return this.packManager.clearAllCache();
	}

	/**
	 * Check if a pack URL is cached
	 */
	public async isPackCached(sourceUrl: string): Promise<boolean> {
		return this.packManager.isPackCached(sourceUrl);
	}

	// --- Memory & Stats ---

	/**
	 * Get memory usage statistics
	 */
	public getPackMemoryUsage(): MemoryStats {
		const stats = this.packManager.getMemoryUsage();
		// Add additional stats from AssetLoader
		stats.cachedMeshes = this.blockMeshCache.size + this.entityMeshCache.size;
		return stats;
	}

	// --- Validation ---

	/**
	 * Validate a pack without loading it
	 */
	public async validatePack(blob: Blob) {
		return this.packManager.validatePack(blob);
	}

	// ============================================
	// END: Resource Pack Manager API
	// ============================================

	public lastPackLoadedFromCache: boolean = false;

	/**
	 * Get a block mesh with optional caching
	 * @param blockString The block string (e.g., "minecraft:stone[variant=smooth]")
	 * @param biome The biome for tinting (default: "plains")
	 * @param useCache Whether to use cached meshes (default: true)
	 * @param nbtData Optional NBT data for tile entities (e.g., sign text, chest contents)
	 * @returns Promise<THREE.Object3D> The block mesh
	 */
	public async getBlockMesh(
		blockString: string,
		biome: string = "plains",
		useCache: boolean = true,
		nbtData?: Record<string, any>
	): Promise<THREE.Object3D> {
		if (!this.initialized) {
			await this.initPromise;
		}

		const cacheKey = `${blockString}:${biome}`;

		if (useCache && this.blockMeshCache.has(cacheKey)) {
			const cachedMesh = this.blockMeshCache.get(cacheKey)!;
			return cachedMesh.clone(); // Return a clone for safety
		}

		const block = this.parseBlockString(blockString);
		const blockId = `${block.namespace}:${block.name}`;

		// Signs are rendered by the dedicated SignRenderer (vanilla cube model + baked
		// text), not the GLTF entity path. They carry per-instance NBT (text) and are
		// rendered by the block-entity pass (WorldMeshBuilder.buildSignMeshes), which
		// always passes nbtData. The palette/greedy paths call getBlockMesh WITHOUT
		// nbtData — emit nothing there so we don't draw a blank, text-less board that
		// would double up with the block-entity pass.
		if (this.signRenderer.isSign(blockId)) {
			if (!nbtData) return new THREE.Group();
			const signMesh = await this.signRenderer.buildSignMesh(
				blockId,
				block.properties ?? {},
				nbtData
			);
			if (signMesh) return signMesh;
			// Fall through to default handling if the sign couldn't be built.
		}

		if (this.pureBlockEntityMap[blockId]) {
			const entityMesh = await this.getEntityMesh(this.pureBlockEntityMap[blockId], useCache);

			// For pure entities, the entityMesh is the final block mesh.
			// It might already have its own internal origin and structure.
			if (useCache) {
				// Clone before caching as getEntityMesh might also return a clone from its cache
				this.blockMeshCache.set(cacheKey, entityMesh.clone());
			}
			return entityMesh; // Already cloned if from entity cache, or the original if newly created
		}

		const rootGroup = new THREE.Group();
		rootGroup.name = `block_${block.name.replace("minecraft:", "")}`;
		(rootGroup as any).blockData = block;
		(rootGroup as any).biome = biome;

		try {
			const modelDataList = await this.modelResolver.resolveBlockModel(block);
			if (modelDataList.length > 0) {
				const objectPromises = modelDataList.map(async (modelData) => {
					try {
						const modelJson = await this.assetLoader.getModel(modelData.model);

						// --- MODIFICATION START ---
						// Pass only uvlock and block data for BlockMeshBuilder to use internally.
						// x and y rotations will be applied to the object returned by BlockMeshBuilder.
						const baseBlockPartObject = await this.blockMeshBuilder.createBlockMesh(
							modelJson,
							{
								// x: undefined, // Explicitly not passing x rotation
								// y: undefined, // Explicitly not passing y rotation
								uvlock: modelData.uvlock,
							},
							block, // Pass block data for context
							biome
						);

						// Apply blockstate rotations (modelData.x, modelData.y) here
						// to the Object3D returned by BlockMeshBuilder.
						if (modelData.y !== undefined && modelData.y !== 0) {
							baseBlockPartObject.rotateY(-(modelData.y * Math.PI) / 180);
						}
						if (modelData.x !== undefined && modelData.x !== 0) {
							baseBlockPartObject.rotateX(-(modelData.x * Math.PI) / 180);
						}
						// --- MODIFICATION END ---

						return baseBlockPartObject; // This is the (now rotated if needed) part
					} catch (modelError) {
						console.error(
							`Error creating mesh for sub-model ${modelData.model} of ${blockString}:`,
							modelError
						);
						return null;
					}
				});

				const staticParts = (await Promise.all(objectPromises)).filter(Boolean) as THREE.Object3D[];

				// Add all static parts to the rootGroup.
				// Each part is now an Object3D that has its blockstate rotation applied.
				// Their internal element rotations were baked by BlockMeshBuilder.
				staticParts.forEach((part) => {
					// Ensure part is valid before adding
					if (part && part.isObject3D) {
						rootGroup.add(part);
					}
				});
			}
		} catch (error) {
			console.warn(
				`Cubane: Error resolving/rendering static model for ${blockId} (${blockString}):`,
				error
			);
		}

		if (this.hybridBlockConfig[blockId]) {
			const dynamicPartsConfig = this.hybridBlockConfig[blockId];
			for (const partConfig of dynamicPartsConfig) {
				try {
					const dynamicMesh = await this.getEntityMesh(partConfig.entityType, useCache);
					if (dynamicMesh) {
						if (blockId === "minecraft:lectern") {
							// Vanilla only renders the book for occupied lecterns. Align the
							// entity model with the sloped top and the block's facing.
							if (block.properties.has_book !== "true") continue;
							const facingRotation: Record<string, number> = {
								north: 0,
								east: -90,
								south: 180,
								west: 90,
							};
							dynamicMesh.position.set(0, 9 / 16, 0);
							dynamicMesh.rotation.order = "YXZ";
							dynamicMesh.rotation.set(
								THREE.MathUtils.degToRad(67.5),
								THREE.MathUtils.degToRad(facingRotation[block.properties.facing || "north"] || 0),
								0
							);
						} else if (partConfig.offset) {
							dynamicMesh.position.set(
								partConfig.offset[0] - 0.5, // Assuming hybrid offsets are 0-1, convert to -0.5 to 0.5 if block is centered
								partConfig.offset[1] - 0.5,
								partConfig.offset[2] - 0.5
								// If your block models from BlockMeshBuilder are already centered,
								// and hybrid parts are also designed to be centered or relative to center,
								// you might not need the -0.5. Test this.
								// Or, if offsets are in MC coords (0-16), divide by 16 then subtract 0.5.
							);
						}
						if (blockId !== "minecraft:lectern" && partConfig.rotation) {
							dynamicMesh.rotation.set(
								THREE.MathUtils.degToRad(partConfig.rotation[0]),
								THREE.MathUtils.degToRad(partConfig.rotation[1]),
								THREE.MathUtils.degToRad(partConfig.rotation[2])
							);
						}
						dynamicMesh.userData.isDynamicBlockPart = true;
						dynamicMesh.userData.entityType = partConfig.entityType;
						rootGroup.add(dynamicMesh);
					}
				} catch (entityError) {
					console.error(
						`Error creating dynamic part ${partConfig.entityType} for ${blockId}:`,
						entityError
					);
				}
			}
		}

		if (rootGroup.children.length === 0) {
			console.warn(
				`Cubane: No parts rendered for ${blockId} (${blockString}), returning fallback.`
			);
			// The fallback mesh is simple and has no internal rotations to worry about.
			// If you cache it, clone it.
			const fallback = this.createFallbackMesh(`block_fallback_${blockId}`);
			if (useCache) {
				this.blockMeshCache.set(cacheKey, fallback.clone());
			}
			return fallback;
		}

		if (useCache) {
			// The rootGroup now contains all parts, correctly transformed.
			// Cache a clone of this assembled rootGroup.
			this.blockMeshCache.set(cacheKey, rootGroup.clone());
		}

		// rootGroup itself is at origin (0,0,0) with no rotation.
		// Its children (the block parts) have their blockstate rotations.
		// The meshes within those children have their element rotations baked into vertices.
		return rootGroup;
	}

	/**
	 * Get an entity mesh with optional caching
	 * @param entityType The entity type
	 * @param useCache Whether to use cached meshes (default: true)
	 * @returns Promise<THREE.Object3D> The entity mesh
	 */
	public async getEntityMesh(
		entityType: string,
		useCache: boolean = true
	): Promise<THREE.Object3D> {
		if (!this.initialized) {
			await this.initPromise;
		}

		// Check cache first if enabled
		if (useCache && this.entityMeshCache.has(entityType)) {
			const cachedMesh = this.entityMeshCache.get(entityType)!;
			// Return a clone to avoid modifying the cached mesh
			const clonedMesh = cachedMesh.clone();
			clonedMesh.name = `entity_${entityType}`;
			return clonedMesh;
		}

		try {
			// console.log(`Cubane: Creating mesh for entity: ${entityType}`);
			const mesh = await this.entityRenderer.createEntityMesh(entityType);
			if (!mesh) {
				console.warn(`No mesh created by EntityRenderer for: ${entityType}`);
				const fallback = this.createFallbackMesh("entity_" + entityType);
				if (useCache) {
					this.entityMeshCache.set(entityType, fallback.clone());
				}
				return fallback;
			}
			mesh.name = `entity_${entityType}`;

			// Cache the mesh if caching is enabled
			if (useCache) {
				this.entityMeshCache.set(entityType, mesh.clone());
			}

			return mesh;
		} catch (error) {
			console.error(`Error creating entity mesh ${entityType}:`, error);
			const fallback = this.createFallbackMesh("entity_" + entityType);
			if (useCache) {
				this.entityMeshCache.set(entityType, fallback.clone());
			}
			return fallback;
		}
	}

	/**
	 * Clear all mesh caches
	 */
	public clearMeshCaches(): void {
		this.blockMeshCache.clear();
		this.entityMeshCache.clear();
		this.optimizationDataCache.clear();
		console.log("Cubane: All caches cleared");
	}

	/**
	 * Clear block mesh cache only
	 */
	public clearBlockMeshCache(): void {
		this.blockMeshCache.clear();
		console.log("Cubane: Block mesh cache cleared");
	}

	/**
	 * Clear entity mesh cache only
	 */
	public clearEntityMeshCache(): void {
		this.entityMeshCache.clear();
		console.log("Cubane: Entity mesh cache cleared");
	}

	/**
	 * Get cache statistics
	 */
	public getCacheStats(): { blockMeshCount: number; entityMeshCount: number } {
		return {
			blockMeshCount: this.blockMeshCache.size,
			entityMeshCount: this.entityMeshCache.size,
		};
	}

	/**
	 * Check if a block mesh is cached
	 */
	public isBlockMeshCached(blockString: string, biome: string = "plains"): boolean {
		const cacheKey = `${blockString}:${biome}`;
		return this.blockMeshCache.has(cacheKey);
	}

	/**
	 * Check if an entity mesh is cached
	 */
	public isEntityMeshCached(entityType: string): boolean {
		return this.entityMeshCache.has(entityType);
	}

	public registerBlockEntity(blockId: string, entityType: string): void {
		// Decide if this is a pure entity or a dynamic part of a hybrid
		// For now, this method is for pure entities. Hybrids are via hybridBlockConfig.
		this.pureBlockEntityMap[blockId] = entityType;
	}

	public registerHybridBlock(blockId: string, dynamicParts: HybridBlockDynamicPart[]): void {
		this.hybridBlockConfig[blockId] = dynamicParts;
	}

	/** True when any animated texture is registered (drives continuous rendering). */
	public hasAnimatedTextures(): boolean {
		return this.assetLoader.hasAnimatedTextures();
	}

	/** Advance animations; returns true if anything changed and a redraw is needed. */
	public updateAnimations(): boolean {
		return this.assetLoader.updateAnimations();
		// TODO: Add logic to update animations for dynamic block parts (e.g., bell swing, book page turn)
		// This would involve iterating through scene objects tagged with `isDynamicBlockPart`
		// and calling an update method on them or their controllers.
		// For example:
		// scene.traverse(object => {
		//    if (object.userData.isDynamicBlockPart) {
		//        this.entityRenderer.updateDynamicPartAnimation(object, object.userData.entityType /*, any_state_needed */);
		//    }
		// });
	}

	public parseBlockString(blockString: string): Block {
		const result: Block = { namespace: "minecraft", name: "", properties: {} };
		const namespaceParts = blockString.split(":");
		if (namespaceParts.length > 1) {
			result.namespace = namespaceParts[0];
			const remaining = namespaceParts[1];
			const propertyIndex = remaining.indexOf("[");
			if (propertyIndex !== -1) {
				result.name = remaining.substring(0, propertyIndex);
				const propertiesString = remaining.substring(propertyIndex + 1, remaining.length - 1);
				propertiesString.split(",").forEach((prop) => {
					const [key, value] = prop.split("=");
					if (key && value) result.properties[key.trim()] = value.trim();
				});
			} else {
				result.name = remaining;
			}
		} else {
			// Handle simple block names without namespace (assume minecraft) or properties
			const propertyIndex = blockString.indexOf("[");
			if (propertyIndex !== -1) {
				result.name = blockString.substring(0, propertyIndex);
				const propertiesString = blockString.substring(propertyIndex + 1, blockString.length - 1);
				propertiesString.split(",").forEach((prop) => {
					const [key, value] = prop.split("=");
					if (key && value) result.properties[key.trim()] = value.trim();
				});
			} else {
				result.name = blockString;
			}
		}
		return result;
	}

	private async analyzeModelGeometry(
		modelDataList: ModelData[],
		block: Block,
		biome: string
	): Promise<BlockOptimizationData> {
		// For now, just analyze the first model (most blocks have only one)
		const primaryModel = modelDataList[0];
		if (!primaryModel) {
			return {
				isCube: false,
				hasTransparency: false,
				hasCullableFaces: false,
				cullableFaces: new Map(),
				nonCullableFaces: [],
			};
		}

		const modelJson = await this.assetLoader.getModel(primaryModel.model);
		const faceData = await this.blockMeshBuilder.createOptimizedFaceData(
			modelJson,
			{ uvlock: primaryModel.uvlock },
			block,
			biome
		);

		// Determine if this is a cube
		const isCube = this.isModelACube(modelJson);

		return {
			isCube,
			hasTransparency: faceData.hasTransparency,
			hasCullableFaces: faceData.cullableFaces.size > 0,
			cullableFaces: faceData.cullableFaces,
			nonCullableFaces: faceData.nonCullableFaces,
			modelRotation: {
				x: primaryModel.x || 0,
				y: primaryModel.y || 0,
			},
		};
	}

	private isModelACube(model: BlockModel): boolean {
		if (!model.elements || model.elements.length !== 1) {
			return false;
		}

		const element = model.elements[0];
		if (!element.from || !element.to) {
			return false;
		}

		// Check if it's a full 16x16x16 cube
		const from = element.from;
		const to = element.to;

		return (
			from[0] === 0 &&
			from[1] === 0 &&
			from[2] === 0 &&
			to[0] === 16 &&
			to[1] === 16 &&
			to[2] === 16
		);
	}

	private async isBlockCube(block: Block): Promise<boolean> {
		try {
			const modelDataList = await this.modelResolver.resolveBlockModel(block);
			if (modelDataList.length !== 1) return false;

			const modelJson = await this.assetLoader.getModel(modelDataList[0].model);
			return this.isModelACube(modelJson);
		} catch {
			return false;
		}
	}

	private async hasBlockTransparency(block: Block): Promise<boolean> {
		try {
			const blockId = `${block.namespace}:${block.name}`;

			// Known transparent blocks
			const transparentBlocks = new Set([
				"minecraft:glass",
				"minecraft:glass_pane",
				"minecraft:ice",
				"minecraft:water",
				"minecraft:lava",
				"minecraft:slime_block",
			]);

			if (transparentBlocks.has(blockId)) return true;

			// Check if any materials in the model are transparent
			const modelDataList = await this.modelResolver.resolveBlockModel(block);
			for (const modelData of modelDataList) {
				await this.assetLoader.getModel(modelData.model);
				// Could check textures for transparency, but this is complex
				// For now, return false for unknown blocks
			}

			return false;
		} catch {
			return false;
		}
	}

	private async hasBlockCullableFaces(block: Block): Promise<boolean> {
		try {
			const modelDataList = await this.modelResolver.resolveBlockModel(block);
			for (const modelData of modelDataList) {
				const modelJson = await this.assetLoader.getModel(modelData.model);
				if (modelJson.elements) {
					for (const element of modelJson.elements) {
						if (element.faces) {
							for (const face of Object.values(element.faces)) {
								if ((face as any).cullface) {
									return true;
								}
							}
						}
					}
				}
			}
			return false;
		} catch {
			return false;
		}
	}

	/**
	 * Get optimization data for voxel rendering
	 */
	public async getBlockOptimizationData(
		blockString: string,
		biome: string = "plains",
		useCache: boolean = true
	): Promise<BlockOptimizationData> {
		if (!this.initialized) {
			await this.initPromise;
		}

		const cacheKey = `opt_${blockString}:${biome}`;

		if (useCache && this.optimizationDataCache.has(cacheKey)) {
			return this.optimizationDataCache.get(cacheKey)!;
		}

		const block = this.parseBlockString(blockString);
		const blockId = `${block.namespace}:${block.name}`;

		// Handle special cases
		if (this.pureBlockEntityMap[blockId]) {
			const entityData: BlockOptimizationData = {
				isCube: false,
				hasTransparency: false,
				hasCullableFaces: false,
				cullableFaces: new Map(),
				nonCullableFaces: [],
			};

			if (useCache) {
				this.optimizationDataCache.set(cacheKey, entityData);
			}
			return entityData;
		}

		// Get the model data
		const modelDataList = await this.modelResolver.resolveBlockModel(block);
		let optimizationData: BlockOptimizationData;

		if (modelDataList.length === 0) {
			// Fallback case
			optimizationData = {
				isCube: false,
				hasTransparency: false,
				hasCullableFaces: false,
				cullableFaces: new Map(),
				nonCullableFaces: [],
			};
		} else {
			// Analyze the resolved models
			optimizationData = await this.analyzeModelGeometry(modelDataList, block, biome);
		}

		if (useCache) {
			this.optimizationDataCache.set(cacheKey, optimizationData);
		}

		return optimizationData;
	}

	/**
	 * Quick geometry info without full optimization data
	 */
	public async getBlockGeometryInfo(blockString: string): Promise<BlockGeometryInfo> {
		const block = this.parseBlockString(blockString);
		const blockId = `${block.namespace}:${block.name}`;

		return {
			isCube: await this.isBlockCube(block),
			hasTransparency: await this.hasBlockTransparency(block),
			hasCullableFaces: await this.hasBlockCullableFaces(block),
			isEntity: !!this.pureBlockEntityMap[blockId],
			isHybrid: !!this.hybridBlockConfig[blockId],
		};
	}

	public async buildTextureAtlas(): Promise<THREE.Texture> {
		return await this.assetLoader.buildTextureAtlas();
	}

	public getTextureAtlas(): THREE.Texture | null {
		return this.assetLoader.getTextureAtlas();
	}

	public getTextureUV(
		textureName: string
	): { u: number; v: number; width: number; height: number } | null {
		return this.assetLoader.getTextureUV(textureName);
	}

	public async getMaterial(
		blockType: string,
		options: { useAtlas?: boolean } = {}
	): Promise<THREE.Material> {
		const useAtlas = options.useAtlas ?? true;

		// Resolve a sample texture for this block
		const modelDataList = await this.modelResolver.resolveBlockModel(
			this.parseBlockString(blockType)
		);
		if (modelDataList.length === 0) {
			throw new Error(`No model for ${blockType}`);
		}

		const model = await this.assetLoader.getModel(modelDataList[0].model);
		if (!model.textures) {
			throw new Error(`No textures in model for ${blockType}`);
		}

		const textureKey = Object.keys(model.textures)[0];
		const texturePath = this.assetLoader.resolveTexture(model.textures[textureKey], model);

		// NEW: Pass useAtlas to AssetLoader
		return await this.assetLoader.getMaterial(texturePath, {
			useAtlas,
		});
	}

	/**
	 * Preload all block models to populate modelCache for texture atlas
	 */
	public async preloadAllBlockModels(): Promise<void> {
		console.log("🔍 Preloading all block models...");

		const assetLoader = this.getAssetLoader();
		const blockstates = await assetLoader.listBlockstates(); // NEW helper

		let loaded = 0;
		const total = blockstates.length;

		for (const blockId of blockstates) {
			try {
				const block = this.parseBlockString(blockId);
				await this.modelResolver.resolveBlockModel(block);
				loaded++;
				if (loaded % 50 === 0) {
					console.log(`📦 Preloaded ${loaded}/${total} block models`);
				}
			} catch (error) {
				console.warn(`⚠️ Failed to preload model for ${blockId}:`, error);
			}
		}

		console.log(`✅ Preloaded ${loaded}/${total} block models`);
	}

	/**
	 * Clear optimization cache
	 */
	public clearOptimizationCache(): void {
		this.optimizationDataCache.clear();
	}

	private createFallbackMesh(name: string = "fallback"): THREE.Object3D {
		// Unhandled/unknown block or entity. By default render nothing;
		// when debug placeholders are enabled, show a magenta wireframe box.
		if (!this.showUnknownBlocks) {
			const empty = new THREE.Group();
			empty.name = name;
			return empty;
		}
		const fallback = new THREE.Mesh(
			new THREE.BoxGeometry(0.8, 0.8, 0.8), // Slightly smaller to distinguish
			new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true })
		);
		fallback.name = name;
		return fallback;
	}

	public getAssetLoader(): AssetLoader {
		return this.assetLoader;
	}
	public getBlockMeshBuilder(): BlockMeshBuilder {
		return this.blockMeshBuilder;
	}
	public getEntityRenderer(): EntityRenderer {
		return this.entityRenderer;
	}
	public dispose(): void {
		this.assetLoader.dispose();
		this.clearMeshCaches();
	}
}

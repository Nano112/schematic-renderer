import JSZip from "jszip";
import {
	ResourcePackInfo,
	PackFetchOptions,
	PackValidationResult,
	AssetConflict,
	PackAssetList,
	PackCacheInfo,
	MemoryStats,
	PackConfiguration,
	PackEventType,
	PackEventMap,
	PackEventCallback,
} from "./types";
import {
	formatPackAssetReference,
	packAssetFromFilePath,
	packPathForAsset,
} from "./ResourceLocation";

interface LoadedPack {
	info: ResourcePackInfo;
	zip: JSZip;
	blob: Blob;
}

/**
 * ResourcePackManager - Complete resource pack management with events, caching, and priority support
 */
export class ResourcePackManager {
	private packs: Map<string, LoadedPack> = new Map();
	private packOrder: string[] = []; // Sorted by priority (lowest first, highest last)
	private listeners: Map<PackEventType, Set<PackEventCallback<any>>> = new Map();

	// Database
	private db: IDBDatabase | null = null;
	private dbName = "cubane-resource-packs";
	private dbVersion = 2;

	// State
	private autoRebuild = true;
	private batchUpdateDepth = 0;
	private pendingRebuild = false;
	private initialized = false;
	private initPromise: Promise<void>;

	// Callbacks for AssetLoader integration
	private onAtlasRebuildNeeded: (() => Promise<void>) | null = null;
	private onMeshRebuildNeeded: (() => void) | null = null;

	constructor() {
		this.initPromise = this.initDatabase();
	}

	// ============================================
	// Initialization
	// ============================================

	private async initDatabase(): Promise<void> {
		if (typeof window === "undefined" || !window.indexedDB) {
			console.warn("[ResourcePackManager] IndexedDB not available");
			this.initialized = true;
			return;
		}

		return new Promise((resolve, _reject) => {
			const request = indexedDB.open(this.dbName, this.dbVersion);

			request.onerror = () => {
				console.error("[ResourcePackManager] Failed to open IndexedDB");
				this.initialized = true;
				resolve(); // Don't fail, just work without persistence
			};

			request.onsuccess = () => {
				this.db = request.result;
				this.initialized = true;
				console.log("[ResourcePackManager] Database initialized");
				resolve();
			};

			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;

				// Pack blobs store
				if (!db.objectStoreNames.contains("packBlobs")) {
					db.createObjectStore("packBlobs", { keyPath: "id" });
				}

				// Pack metadata store
				if (!db.objectStoreNames.contains("packMeta")) {
					const metaStore = db.createObjectStore("packMeta", { keyPath: "id" });
					metaStore.createIndex("priority", "priority", { unique: false });
				}

				// State store (for saving/loading session)
				if (!db.objectStoreNames.contains("state")) {
					db.createObjectStore("state", { keyPath: "key" });
				}
			};
		});
	}

	private async ensureInitialized(): Promise<void> {
		if (!this.initialized) {
			await this.initPromise;
		}
	}

	// ============================================
	// Event System
	// ============================================

	/**
	 * Subscribe to an event
	 */
	public on<T extends PackEventType>(event: T, callback: PackEventCallback<T>): void {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, new Set());
		}
		this.listeners.get(event)!.add(callback);
	}

	/**
	 * Unsubscribe from an event
	 */
	public off<T extends PackEventType>(event: T, callback: PackEventCallback<T>): void {
		const eventListeners = this.listeners.get(event);
		if (eventListeners) {
			eventListeners.delete(callback);
		}
	}

	/**
	 * Subscribe to an event once
	 */
	public once<T extends PackEventType>(event: T, callback: PackEventCallback<T>): void {
		const onceCallback: PackEventCallback<T> = (eventData) => {
			this.off(event, onceCallback);
			callback(eventData);
		};
		this.on(event, onceCallback);
	}

	/**
	 * Emit an event to all listeners
	 */
	private emit<T extends PackEventType>(event: T, data: PackEventMap[T]): void {
		const eventListeners = this.listeners.get(event);
		if (eventListeners) {
			for (const callback of eventListeners) {
				try {
					callback(data);
				} catch (error) {
					console.error(`[ResourcePackManager] Error in ${event} listener:`, error);
				}
			}
		}
	}

	// ============================================
	// Integration Callbacks
	// ============================================

	/**
	 * Set callback for when atlas needs rebuilding
	 */
	public setAtlasRebuildCallback(callback: () => Promise<void>): void {
		this.onAtlasRebuildNeeded = callback;
	}

	/**
	 * Set callback for when meshes need rebuilding
	 */
	public setMeshRebuildCallback(callback: () => void): void {
		this.onMeshRebuildNeeded = callback;
	}

	// ============================================
	// Fetching & Loading
	// ============================================

	/**
	 * Load a resource pack from a URL
	 */
	public async loadPackFromUrl(url: string, options: PackFetchOptions = {}): Promise<string> {
		await this.ensureInitialized();

		const packId = this.generatePackId();

		// Check if pack with this URL is already loaded (skip re-fetching)
		for (const [existingId, pack] of this.packs) {
			if (pack.info.sourceUrl === url) {
				console.log(`[ResourcePackManager] Pack from ${url} already loaded (id: ${existingId})`);
				return existingId;
			}
		}

		this.emit("loadStart", { packId, source: "url" });

		try {
			// Check cache first
			if (options.useCache !== false) {
				const cached = await this.getPackFromCache(url);
				if (cached) {
					const info = await this.loadPackInternal(cached, packId, {
						...options,
						sourceUrl: url,
					});
					this.emit("loadComplete", { packId, info });
					return packId;
				}
			}

			// Fetch from URL
			const response = await fetch(url, {
				headers: options.headers,
				signal: options.signal,
			});

			if (!response.ok) {
				throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
			}

			const contentLength = response.headers.get("content-length");
			const total = contentLength ? parseInt(contentLength, 10) : 0;

			// Stream with progress if possible
			let blob: Blob;
			if (response.body && total > 0 && options.onProgress) {
				blob = await this.fetchWithProgress(response, total, packId, options.onProgress);
			} else {
				blob = await response.blob();
			}

			// Cache the blob
			if (options.useCache !== false) {
				await this.cachePackBlob(url, blob);
			}

			const info = await this.loadPackInternal(blob, packId, {
				...options,
				sourceUrl: url,
			});

			this.emit("loadComplete", { packId, info });
			return packId;
		} catch (error) {
			this.emit("loadError", {
				packId,
				error: error instanceof Error ? error : new Error(String(error)),
				source: url,
			});
			throw error;
		}
	}

	/**
	 * Load a resource pack from a Blob
	 */
	public async loadPackFromBlob(blob: Blob, name?: string): Promise<string> {
		await this.ensureInitialized();

		const packId = this.generatePackId();
		this.emit("loadStart", { packId, source: "blob" });

		try {
			const info = await this.loadPackInternal(blob, packId, { name });
			this.emit("loadComplete", { packId, info });
			return packId;
		} catch (error) {
			this.emit("loadError", {
				packId,
				error: error instanceof Error ? error : new Error(String(error)),
			});
			throw error;
		}
	}

	/**
	 * Load a resource pack from a File (drag-drop, file input)
	 */
	public async loadPackFromFile(file: File): Promise<string> {
		await this.ensureInitialized();

		const packId = this.generatePackId();
		this.emit("loadStart", { packId, source: "file" });

		try {
			const info = await this.loadPackInternal(file, packId, {
				name: file.name.replace(/\.zip$/i, ""),
			});
			this.emit("loadComplete", { packId, info });
			return packId;
		} catch (error) {
			this.emit("loadError", {
				packId,
				error: error instanceof Error ? error : new Error(String(error)),
			});
			throw error;
		}
	}

	/**
	 * Internal pack loading logic
	 */
	private async loadPackInternal(
		blob: Blob,
		packId: string,
		options: PackFetchOptions & { sourceUrl?: string } = {}
	): Promise<ResourcePackInfo> {
		// Validate ZIP
		const arrayBuffer = await blob.arrayBuffer();
		const hash = await this.calculateHash(arrayBuffer);

		// Check for duplicate by hash
		for (const [existingId, pack] of this.packs) {
			if (pack.info.hash === hash) {
				console.warn(`[ResourcePackManager] Pack already loaded with id ${existingId}`);
				return pack.info;
			}
		}

		// Parse ZIP
		const zip = await JSZip.loadAsync(arrayBuffer);

		// Extract metadata
		const metadata = await this.extractPackMetadata(zip, blob.size, options.name);

		// Determine priority
		const priority = options.priority ?? this.getNextPriority();

		// Build pack info
		const info: ResourcePackInfo = {
			id: packId,
			name: metadata.name,
			description: metadata.description,
			packFormat: metadata.packFormat,
			icon: metadata.icon,
			priority,
			enabled: options.enabled ?? true,
			size: blob.size,
			assetCounts: metadata.assetCounts,
			sourceUrl: options.sourceUrl,
			loadedAt: Date.now(),
			hash,
		};

		// Store pack
		this.packs.set(packId, { info, zip, blob });
		this.insertPackByPriority(packId, priority);

		// Emit event
		this.emit("packAdded", { packId, info });

		// Trigger rebuild
		await this.triggerRebuildIfNeeded("pack added");

		return info;
	}

	/**
	 * Fetch with progress tracking
	 */
	private async fetchWithProgress(
		response: Response,
		total: number,
		packId: string,
		onProgress: (loaded: number, total: number) => void
	): Promise<Blob> {
		const reader = response.body!.getReader();
		const chunks: Uint8Array[] = [];
		let loaded = 0;

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			chunks.push(value);
			loaded += value.length;

			const percent = Math.round((loaded / total) * 100);
			onProgress(loaded, total);
			this.emit("loadProgress", { packId, loaded, total, percent });
		}

		return new Blob(chunks as BlobPart[]);
	}

	// ============================================
	// Pack Management
	// ============================================

	/**
	 * Remove a resource pack
	 */
	public async removePack(packId: string): Promise<void> {
		const pack = this.packs.get(packId);
		if (!pack) {
			console.warn(`[ResourcePackManager] Pack ${packId} not found`);
			return;
		}

		const name = pack.info.name;
		this.packs.delete(packId);
		this.packOrder = this.packOrder.filter((id) => id !== packId);

		this.emit("packRemoved", { packId, name });
		await this.triggerRebuildIfNeeded("pack removed");
	}

	/**
	 * Remove all resource packs
	 */
	public async removeAllPacks(): Promise<void> {
		this.beginBatchUpdate();

		const packIds = [...this.packs.keys()];
		for (const packId of packIds) {
			await this.removePack(packId);
		}

		await this.endBatchUpdate();
	}

	/**
	 * Enable a resource pack
	 */
	public async enablePack(packId: string): Promise<void> {
		await this.setPackEnabled(packId, true);
	}

	/**
	 * Disable a resource pack
	 */
	public async disablePack(packId: string): Promise<void> {
		await this.setPackEnabled(packId, false);
	}

	/**
	 * Toggle a resource pack's enabled state
	 */
	public async togglePack(packId: string): Promise<boolean> {
		const pack = this.packs.get(packId);
		if (!pack) {
			throw new Error(`Pack ${packId} not found`);
		}

		const newState = !pack.info.enabled;
		await this.setPackEnabled(packId, newState);
		return newState;
	}

	/**
	 * Set a pack's enabled state
	 */
	public async setPackEnabled(packId: string, enabled: boolean): Promise<void> {
		const pack = this.packs.get(packId);
		if (!pack) {
			throw new Error(`Pack ${packId} not found`);
		}

		if (pack.info.enabled === enabled) return;

		pack.info.enabled = enabled;
		this.emit("packToggled", { packId, enabled });
		await this.triggerRebuildIfNeeded("pack toggled");
	}

	/**
	 * Set a pack's priority
	 */
	public async setPackPriority(packId: string, priority: number): Promise<void> {
		const pack = this.packs.get(packId);
		if (!pack) {
			throw new Error(`Pack ${packId} not found`);
		}

		pack.info.priority = priority;

		// Re-sort pack order
		this.packOrder = this.packOrder.filter((id) => id !== packId);
		this.insertPackByPriority(packId, priority);

		this.emit("packOrderChanged", { packIds: [...this.packOrder] });
		await this.triggerRebuildIfNeeded("priority changed");
	}

	/**
	 * Move a pack up in priority (increase priority)
	 */
	public async movePackUp(packId: string): Promise<void> {
		const index = this.packOrder.indexOf(packId);
		if (index === -1 || index === this.packOrder.length - 1) return;

		const nextPackId = this.packOrder[index + 1];
		const nextPack = this.packs.get(nextPackId);
		const currentPack = this.packs.get(packId);

		if (nextPack && currentPack) {
			// Swap priorities
			const tempPriority = currentPack.info.priority;
			currentPack.info.priority = nextPack.info.priority;
			nextPack.info.priority = tempPriority;

			// Swap positions
			this.packOrder[index] = nextPackId;
			this.packOrder[index + 1] = packId;

			this.emit("packOrderChanged", { packIds: [...this.packOrder] });
			await this.triggerRebuildIfNeeded("pack moved up");
		}
	}

	/**
	 * Move a pack down in priority (decrease priority)
	 */
	public async movePackDown(packId: string): Promise<void> {
		const index = this.packOrder.indexOf(packId);
		if (index <= 0) return;

		const prevPackId = this.packOrder[index - 1];
		const prevPack = this.packs.get(prevPackId);
		const currentPack = this.packs.get(packId);

		if (prevPack && currentPack) {
			// Swap priorities
			const tempPriority = currentPack.info.priority;
			currentPack.info.priority = prevPack.info.priority;
			prevPack.info.priority = tempPriority;

			// Swap positions
			this.packOrder[index] = prevPackId;
			this.packOrder[index - 1] = packId;

			this.emit("packOrderChanged", { packIds: [...this.packOrder] });
			await this.triggerRebuildIfNeeded("pack moved down");
		}
	}

	/**
	 * Reorder packs by providing the full order array
	 */
	public async reorderPacks(packIds: string[]): Promise<void> {
		// Validate all pack IDs exist
		for (const packId of packIds) {
			if (!this.packs.has(packId)) {
				throw new Error(`Pack ${packId} not found`);
			}
		}

		// Update priorities based on new order
		packIds.forEach((packId, index) => {
			const pack = this.packs.get(packId)!;
			pack.info.priority = index;
		});

		this.packOrder = [...packIds];

		this.emit("packOrderChanged", { packIds: [...this.packOrder] });
		await this.triggerRebuildIfNeeded("packs reordered");
	}

	// ============================================
	// Querying
	// ============================================

	/**
	 * Get info for a specific pack
	 */
	public getPack(packId: string): ResourcePackInfo | null {
		return this.packs.get(packId)?.info ?? null;
	}

	/**
	 * Get all packs sorted by priority (lowest to highest)
	 */
	public getAllPacks(): ResourcePackInfo[] {
		return this.packOrder.map((id) => this.packs.get(id)!.info);
	}

	/**
	 * Get only enabled packs sorted by priority
	 */
	public getEnabledPacks(): ResourcePackInfo[] {
		return this.packOrder.map((id) => this.packs.get(id)!.info).filter((info) => info.enabled);
	}

	/**
	 * Get total pack count
	 */
	public getPackCount(): number {
		return this.packs.size;
	}

	/**
	 * Get the ZIP for a pack (for AssetLoader integration)
	 */
	public getPackZip(packId: string): JSZip | null {
		return this.packs.get(packId)?.zip ?? null;
	}

	/**
	 * Get enabled packs in priority order (for AssetLoader)
	 */
	public getEnabledPacksInOrder(): Array<{ id: string; zip: JSZip }> {
		return this.packOrder
			.map((id) => this.packs.get(id)!)
			.filter((pack) => pack.info.enabled)
			.map((pack) => ({ id: pack.info.id, zip: pack.zip }));
	}

	/**
	 * Get assets provided by a specific pack
	 */
	public async getPackAssets(packId: string): Promise<PackAssetList> {
		const pack = this.packs.get(packId);
		if (!pack) {
			throw new Error(`Pack ${packId} not found`);
		}

		const textures: string[] = [];
		const blockstates: string[] = [];
		const models: string[] = [];

		const files = Object.keys(pack.zip.files);

		for (const file of files) {
			if (pack.zip.files[file].dir) continue;

			const asset = packAssetFromFilePath(file);

			if (asset?.type === "texture") {
				textures.push(formatPackAssetReference(asset));
			} else if (asset?.type === "blockstate") {
				blockstates.push(formatPackAssetReference(asset));
			} else if (asset?.type === "model") {
				models.push(formatPackAssetReference(asset));
			}
		}

		return { textures, blockstates, models };
	}

	/**
	 * Get which pack provides a specific asset
	 */
	public getAssetSource(
		assetPath: string,
		type: "texture" | "blockstate" | "model"
	): string | null {
		const fullPath = packPathForAsset(assetPath, type);

		// Check packs in reverse priority order (highest first)
		for (let i = this.packOrder.length - 1; i >= 0; i--) {
			const packId = this.packOrder[i];
			const pack = this.packs.get(packId)!;

			if (!pack.info.enabled) continue;

			if (pack.zip.file(fullPath)) {
				return packId;
			}
		}

		return null;
	}

	/**
	 * Get all asset conflicts (assets provided by multiple packs)
	 */
	public async getAssetConflicts(): Promise<AssetConflict[]> {
		const assetProviders: Map<
			string,
			Array<{ packId: string; packName: string; priority: number }>
		> = new Map();

		// Collect all assets from all packs
		for (const [packId, pack] of this.packs) {
			if (!pack.info.enabled) continue;

			const files = Object.keys(pack.zip.files);

			for (const file of files) {
				if (pack.zip.files[file].dir) continue;

				let assetKey: string | null = null;
				const asset = packAssetFromFilePath(file);

				if (asset) {
					assetKey = `${asset.type}:${asset.namespace}:${asset.path}`;
				}

				if (assetKey) {
					if (!assetProviders.has(assetKey)) {
						assetProviders.set(assetKey, []);
					}
					assetProviders.get(assetKey)!.push({
						packId,
						packName: pack.info.name,
						priority: pack.info.priority,
					});
				}
			}
		}

		// Find conflicts (assets with multiple providers)
		const conflicts: AssetConflict[] = [];

		for (const [assetKey, providers] of assetProviders) {
			if (providers.length > 1) {
				// Sort by priority (highest first)
				providers.sort((a, b) => b.priority - a.priority);

				const [type, namespace, ...assetPathParts] = assetKey.split(":");
				const assetPath = `${namespace}:${assetPathParts.join(":")}`;

				conflicts.push({
					assetPath,
					type: type as "texture" | "blockstate" | "model",
					providers,
					activeProvider: providers[0].packId,
				});
			}
		}

		return conflicts;
	}

	/**
	 * Preview a texture from a specific pack
	 */
	public async previewTexture(packId: string, texturePath: string): Promise<string | null> {
		const pack = this.packs.get(packId);
		if (!pack) return null;

		const fullPath = packPathForAsset(texturePath, "texture");
		const file = pack.zip.file(fullPath);
		if (!file) return null;

		try {
			const blob = await file.async("blob");
			return URL.createObjectURL(blob);
		} catch {
			return null;
		}
	}

	// ============================================
	// Batch Updates & Auto Rebuild
	// ============================================

	/**
	 * Begin a batch update (pauses auto-rebuild)
	 */
	public beginBatchUpdate(): void {
		this.batchUpdateDepth++;
	}

	/**
	 * End a batch update (commits changes, triggers rebuild if needed)
	 */
	public async endBatchUpdate(): Promise<void> {
		this.batchUpdateDepth = Math.max(0, this.batchUpdateDepth - 1);

		if (this.batchUpdateDepth === 0 && this.pendingRebuild) {
			this.pendingRebuild = false;
			await this.triggerRebuild("batch update completed");
		}
	}

	/**
	 * Set auto-rebuild mode
	 */
	public setAutoRebuild(enabled: boolean): void {
		this.autoRebuild = enabled;
	}

	/**
	 * Manually trigger atlas rebuild
	 */
	public async rebuildAtlas(): Promise<void> {
		await this.triggerRebuild("manual rebuild");
	}

	/**
	 * Trigger rebuild if appropriate
	 */
	private async triggerRebuildIfNeeded(reason: string): Promise<void> {
		if (this.batchUpdateDepth > 0) {
			this.pendingRebuild = true;
			return;
		}

		if (this.autoRebuild) {
			await this.triggerRebuild(reason);
		} else {
			this.pendingRebuild = true;
		}
	}

	/**
	 * Actually trigger the rebuild
	 */
	private async triggerRebuild(reason: string): Promise<void> {
		this.emit("packsChanged", { reason });

		const enabledPacks = this.getEnabledPacks();
		const totalTextures = enabledPacks.reduce((sum, p) => sum + p.assetCounts.textures, 0);

		this.emit("atlasRebuilding", { textureCount: totalTextures });

		if (this.onAtlasRebuildNeeded) {
			await this.onAtlasRebuildNeeded();
		}

		if (this.onMeshRebuildNeeded) {
			this.onMeshRebuildNeeded();
		}
	}

	// ============================================
	// Persistence & State
	// ============================================

	/**
	 * Save current state to IndexedDB
	 */
	public async saveState(): Promise<void> {
		await this.ensureInitialized();
		if (!this.db) return;

		const state: PackConfiguration = {
			version: 1,
			packs: this.packOrder.map((id) => {
				const pack = this.packs.get(id)!;
				return {
					id: pack.info.id,
					name: pack.info.name,
					sourceUrl: pack.info.sourceUrl,
					priority: pack.info.priority,
					enabled: pack.info.enabled,
				};
			}),
		};

		// Save state
		await this.dbPut("state", { key: "packState", ...state });

		// Save blobs
		for (const [packId, pack] of this.packs) {
			await this.dbPut("packBlobs", {
				id: packId,
				blob: pack.blob,
				info: pack.info,
			});
		}

		console.log("[ResourcePackManager] State saved");
	}

	/**
	 * Load state from IndexedDB
	 */
	public async loadState(): Promise<boolean> {
		await this.ensureInitialized();
		if (!this.db) return false;

		try {
			const state = (await this.dbGet("state", "packState")) as PackConfiguration | undefined;
			if (!state || !state.packs) return false;

			this.beginBatchUpdate();

			for (const packConfig of state.packs) {
				const stored = (await this.dbGet("packBlobs", packConfig.id)) as any;
				if (stored?.blob) {
					try {
						await this.loadPackInternal(stored.blob, packConfig.id, {
							name: packConfig.name,
							priority: packConfig.priority,
							enabled: packConfig.enabled,
							sourceUrl: packConfig.sourceUrl,
						});
					} catch (error) {
						console.warn(`[ResourcePackManager] Failed to restore pack ${packConfig.id}:`, error);
					}
				}
			}

			await this.endBatchUpdate();

			console.log("[ResourcePackManager] State loaded");
			return true;
		} catch (error) {
			console.error("[ResourcePackManager] Failed to load state:", error);
			return false;
		}
	}

	/**
	 * Export configuration
	 */
	public exportConfig(): PackConfiguration {
		return {
			version: 1,
			packs: this.packOrder.map((id) => {
				const pack = this.packs.get(id)!;
				return {
					id: pack.info.id,
					name: pack.info.name,
					sourceUrl: pack.info.sourceUrl,
					priority: pack.info.priority,
					enabled: pack.info.enabled,
				};
			}),
		};
	}

	/**
	 * Import configuration (requires packs to be loaded separately)
	 */
	public async importConfig(config: PackConfiguration): Promise<void> {
		this.beginBatchUpdate();

		// Apply enabled states and order
		for (const packConfig of config.packs) {
			const pack = this.packs.get(packConfig.id);
			if (pack) {
				pack.info.enabled = packConfig.enabled;
				pack.info.priority = packConfig.priority;
			}
		}

		// Reorder based on config
		const configOrder = config.packs.map((p) => p.id).filter((id) => this.packs.has(id));
		this.packOrder = configOrder;

		await this.endBatchUpdate();
	}

	// ============================================
	// Cache Management
	// ============================================

	/**
	 * Get total cache size
	 */
	public async getCacheSize(): Promise<number> {
		await this.ensureInitialized();
		if (!this.db) return 0;

		return new Promise((resolve) => {
			const transaction = this.db!.transaction(["packBlobs"], "readonly");
			const store = transaction.objectStore("packBlobs");
			const request = store.openCursor();

			let totalSize = 0;

			request.onsuccess = () => {
				const cursor = request.result;
				if (cursor) {
					totalSize += cursor.value.blob?.size ?? 0;
					cursor.continue();
				} else {
					resolve(totalSize);
				}
			};

			request.onerror = () => resolve(0);
		});
	}

	/**
	 * Get cache info for a specific pack
	 */
	public async getPackCacheInfo(packId: string): Promise<PackCacheInfo> {
		const pack = this.packs.get(packId);

		return {
			packId,
			cached: !!pack,
			size: pack?.info.size ?? 0,
			cachedAt: pack?.info.loadedAt,
		};
	}

	/**
	 * Clear cache for a specific pack
	 */
	public async clearPackCache(packId: string): Promise<void> {
		await this.ensureInitialized();
		if (!this.db) return;

		await this.dbDelete("packBlobs", packId);
	}

	/**
	 * Clear all cache
	 */
	public async clearAllCache(): Promise<void> {
		await this.ensureInitialized();
		if (!this.db) return;

		const transaction = this.db.transaction(["packBlobs", "packMeta", "state"], "readwrite");
		transaction.objectStore("packBlobs").clear();
		transaction.objectStore("packMeta").clear();
		transaction.objectStore("state").clear();

		console.log("[ResourcePackManager] All cache cleared");
	}

	/**
	 * Check if a pack is cached
	 */
	public async isPackCached(sourceUrl: string): Promise<boolean> {
		const cached = await this.getPackFromCache(sourceUrl);
		return cached !== null;
	}

	// ============================================
	// Validation
	// ============================================

	/**
	 * Validate a pack without loading it
	 */
	public async validatePack(blob: Blob): Promise<PackValidationResult> {
		const result: PackValidationResult = {
			valid: false,
			hasIcon: false,
			errors: [],
			warnings: [],
			assetCounts: { textures: 0, blockstates: 0, models: 0 },
		};

		try {
			// Check ZIP header
			const header = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
			if (header[0] !== 0x50 || header[1] !== 0x4b || header[2] !== 0x03 || header[3] !== 0x04) {
				result.errors.push("Invalid ZIP file: missing PK header");
				return result;
			}

			// Parse ZIP
			const zip = await JSZip.loadAsync(blob);

			// Check for pack.mcmeta
			const mcmeta = zip.file("pack.mcmeta");
			if (!mcmeta) {
				result.warnings.push("Missing pack.mcmeta file");
			} else {
				try {
					const content = JSON.parse(await mcmeta.async("string"));
					result.packFormat = content.pack?.pack_format;
					result.description = content.pack?.description;

					if (!result.packFormat) {
						result.warnings.push("pack.mcmeta missing pack_format");
					}
				} catch {
					result.warnings.push("Invalid pack.mcmeta JSON");
				}
			}

			// Check for icon
			result.hasIcon = !!zip.file("pack.png");

			// Count assets
			const files = Object.keys(zip.files);
			for (const file of files) {
				if (zip.files[file].dir) continue;

				const asset = packAssetFromFilePath(file);

				if (asset?.type === "texture") {
					result.assetCounts.textures++;
				} else if (asset?.type === "blockstate") {
					result.assetCounts.blockstates++;
				} else if (asset?.type === "model") {
					result.assetCounts.models++;
				}
			}

			// Determine validity
			const hasAssets =
				result.assetCounts.textures > 0 ||
				result.assetCounts.blockstates > 0 ||
				result.assetCounts.models > 0;

			if (!hasAssets) {
				result.errors.push("No Minecraft assets found in pack");
			} else {
				result.valid = true;
			}
		} catch (error) {
			result.errors.push(`Failed to parse ZIP: ${error}`);
		}

		return result;
	}

	// ============================================
	// Memory & Stats
	// ============================================

	/**
	 * Get memory usage statistics
	 */
	public getMemoryUsage(): MemoryStats {
		let totalPacksSize = 0;
		for (const pack of this.packs.values()) {
			totalPacksSize += pack.info.size;
		}

		return {
			totalPacksSize,
			loadedPacksCount: this.packs.size,
			atlasSize: 0, // Would need AssetLoader integration
			cachedMaterials: 0,
			cachedTextures: 0,
			cachedMeshes: 0,
		};
	}

	/**
	 * Unload pack data from memory (keeps metadata)
	 */
	public unloadPackData(_packId: string): void {
		// Not implemented - would need significant restructuring
		// to load pack data on-demand
		console.warn("[ResourcePackManager] unloadPackData not yet implemented");
	}

	// ============================================
	// Cleanup
	// ============================================

	/**
	 * Dispose of all resources
	 */
	public dispose(): void {
		this.packs.clear();
		this.packOrder = [];
		this.listeners.clear();

		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}

	// ============================================
	// Private Helpers
	// ============================================

	private generatePackId(): string {
		return `pack_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
	}

	private async calculateHash(arrayBuffer: ArrayBuffer): Promise<string> {
		const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
	}

	private getNextPriority(): number {
		if (this.packs.size === 0) return 0;
		return Math.max(...Array.from(this.packs.values()).map((p) => p.info.priority)) + 1;
	}

	private insertPackByPriority(packId: string, priority: number): void {
		// Find position to insert (sorted by priority, lowest first)
		let insertIndex = 0;
		for (let i = 0; i < this.packOrder.length; i++) {
			const existingPack = this.packs.get(this.packOrder[i]);
			if (existingPack && existingPack.info.priority > priority) {
				break;
			}
			insertIndex = i + 1;
		}
		this.packOrder.splice(insertIndex, 0, packId);
	}

	private async extractPackMetadata(
		zip: JSZip,
		_size: number,
		nameOverride?: string
	): Promise<{
		name: string;
		description: string;
		packFormat: number;
		icon: string | null;
		assetCounts: { textures: number; blockstates: number; models: number };
	}> {
		let name = nameOverride || "Unknown Pack";
		let description = "";
		let packFormat = 0;
		let icon: string | null = null;

		// Read pack.mcmeta
		const mcmetaFile = zip.file("pack.mcmeta");
		if (mcmetaFile) {
			try {
				const content = JSON.parse(await mcmetaFile.async("string"));
				if (content.pack) {
					description = content.pack.description || "";
					packFormat = content.pack.pack_format || 0;
				}
			} catch (e) {
				console.warn("[ResourcePackManager] Failed to parse pack.mcmeta");
			}
		}

		// Read pack.png
		const iconFile = zip.file("pack.png");
		if (iconFile) {
			try {
				const blob = await iconFile.async("blob");
				icon = await this.blobToDataUrl(blob);
			} catch (e) {
				console.warn("[ResourcePackManager] Failed to read pack.png");
			}
		}

		// Count assets
		const assetCounts = { textures: 0, blockstates: 0, models: 0 };
		const files = Object.keys(zip.files);

		for (const file of files) {
			if (zip.files[file].dir) continue;

			const asset = packAssetFromFilePath(file);

			if (asset?.type === "texture") {
				assetCounts.textures++;
			} else if (asset?.type === "blockstate") {
				assetCounts.blockstates++;
			} else if (asset?.type === "model") {
				assetCounts.models++;
			}
		}

		return { name, description, packFormat, icon, assetCounts };
	}

	private async blobToDataUrl(blob: Blob): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result as string);
			reader.onerror = reject;
			reader.readAsDataURL(blob);
		});
	}

	// IndexedDB helpers
	private async dbPut(storeName: string, data: any): Promise<void> {
		if (!this.db) return;

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction([storeName], "readwrite");
			const store = transaction.objectStore(storeName);
			const request = store.put(data);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	private async dbGet(storeName: string, key: string): Promise<any> {
		if (!this.db) return undefined;

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction([storeName], "readonly");
			const store = transaction.objectStore(storeName);
			const request = store.get(key);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}

	private async dbDelete(storeName: string, key: string): Promise<void> {
		if (!this.db) return;

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction([storeName], "readwrite");
			const store = transaction.objectStore(storeName);
			const request = store.delete(key);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	private async cachePackBlob(sourceUrl: string, blob: Blob): Promise<void> {
		await this.dbPut("packBlobs", {
			id: `url:${sourceUrl}`,
			blob,
			cachedAt: Date.now(),
		});
	}

	private async getPackFromCache(sourceUrl: string): Promise<Blob | null> {
		const cached = await this.dbGet("packBlobs", `url:${sourceUrl}`);
		return cached?.blob ?? null;
	}
}

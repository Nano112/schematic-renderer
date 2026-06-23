// ResourcePackManager.ts - Complete Cubane-style Resource Pack Management

import JSZip from "jszip";
import {
	ResourcePackInfo,
	PackFetchOptions,
	PackValidationResult,
	PackConfig,
	AssetConflict,
	PackMemoryUsage,
	StoredResourcePack,
	PackEventMap,
	PackEventType,
	PackEventHandler,
	ResourcePackOptions,
} from "../types/resourcePack";
import { packPathForAsset } from "../cubane/ResourceLocation";

export type DefaultPackCallback = () => Promise<Blob>;

/**
 * Generate a unique pack ID
 */
function generatePackId(): string {
	return `pack_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Calculate hash of blob content for deduplication
 */
async function hashBlob(blob: Blob): Promise<string> {
	const buffer = await blob.arrayBuffer();
	const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Enhanced Resource Pack Manager with full Cubane-style API
 */
export class ResourcePackManager {
	private db: IDBDatabase | null = null;
	public initPromise: Promise<void>;

	// In-memory pack registry
	private packs: Map<string, StoredResourcePack> = new Map();

	// Event handlers
	private eventHandlers: Map<PackEventType, Set<PackEventHandler<any>>> = new Map();
	private onceHandlers: Map<PackEventType, Set<PackEventHandler<any>>> = new Map();

	// Batch mode
	private batchMode: boolean = false;
	private pendingChanges: boolean = false;

	// Auto-rebuild
	private autoRebuild: boolean = true;

	// Options
	private options: ResourcePackOptions;

	// Cache for pack downloads
	private downloadCache: Map<string, Blob> = new Map();

	// Callbacks for atlas rebuild
	private onAtlasRebuild?: () => Promise<void>;

	constructor(options: ResourcePackOptions = {}) {
		this.options = {
			enableUI: true,
			uiPosition: "top-right",
			autoRebuild: true,
			showIcons: true,
			enableDragReorder: true,
			enableKeyboardShortcuts: true,
			toggleUIShortcut: "KeyP",
			maxPacks: 0,
			...options,
		};

		this.autoRebuild = this.options.autoRebuild ?? true;
		this.initPromise = this.initDB();
	}

	/**
	 * Set the atlas rebuild callback
	 */
	public setAtlasRebuildCallback(callback: () => Promise<void>): void {
		this.onAtlasRebuild = callback;
	}

	// ==================== Database Management ====================

	private async initDB(): Promise<void> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open("ResourcePacksDB", 3);

			request.onerror = () => reject(new Error("Error opening database"));

			request.onsuccess = async (event) => {
				this.db = (event.target as IDBOpenDBRequest).result;
				// Load packs from DB into memory
				await this.loadPacksFromDB();
				resolve();
			};

			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;

				// Delete old store if upgrading
				if (db.objectStoreNames.contains("packs")) {
					db.deleteObjectStore("packs");
				}

				// Create new store with id as key
				const store = db.createObjectStore("packs", { keyPath: "id" });
				store.createIndex("priority", "priority", { unique: false });
				store.createIndex("name", "name", { unique: false });
				store.createIndex("hash", "hash", { unique: false });

				// Create cache store
				if (!db.objectStoreNames.contains("cache")) {
					db.createObjectStore("cache", { keyPath: "url" });
				}
			};
		});
	}

	private async loadPacksFromDB(): Promise<void> {
		// Note: This is called from initDB after DB is opened, so don't call ensureDbInitialized here
		return new Promise((resolve, reject) => {
			if (!this.db) {
				reject(new Error("Database not initialized"));
				return;
			}

			const transaction = this.db.transaction(["packs"], "readonly");
			const store = transaction.objectStore("packs");
			const request = store.getAll();

			request.onerror = () => reject(new Error("Error loading packs"));
			request.onsuccess = () => {
				const packs = request.result as StoredResourcePack[];
				this.packs.clear();
				for (const pack of packs) {
					this.packs.set(pack.id, pack);
				}
				resolve();
			};
		});
	}

	private async ensureDbInitialized(): Promise<void> {
		await this.initPromise;
	}

	private async savePack(pack: StoredResourcePack): Promise<void> {
		await this.ensureDbInitialized();
		return new Promise((resolve, reject) => {
			if (!this.db) {
				reject(new Error("Database not initialized"));
				return;
			}

			const transaction = this.db.transaction(["packs"], "readwrite");
			const store = transaction.objectStore("packs");
			const request = store.put(pack);

			request.onerror = () => reject(new Error("Error saving pack"));
			request.onsuccess = () => {
				this.packs.set(pack.id, pack);
				resolve();
			};
		});
	}

	private async deletePack(packId: string): Promise<void> {
		await this.ensureDbInitialized();
		return new Promise((resolve, reject) => {
			if (!this.db) {
				reject(new Error("Database not initialized"));
				return;
			}

			const transaction = this.db.transaction(["packs"], "readwrite");
			const store = transaction.objectStore("packs");
			const request = store.delete(packId);

			request.onerror = () => reject(new Error("Error deleting pack"));
			request.onsuccess = () => {
				this.packs.delete(packId);
				resolve();
			};
		});
	}

	// ==================== Event System ====================

	/**
	 * Subscribe to a pack event
	 */
	public onPackEvent<T extends PackEventType>(event: T, handler: PackEventHandler<T>): void {
		if (!this.eventHandlers.has(event)) {
			this.eventHandlers.set(event, new Set());
		}
		this.eventHandlers.get(event)!.add(handler);
	}

	/**
	 * Alias for onPackEvent for convenience
	 */
	public on<T extends PackEventType>(event: T, handler: PackEventHandler<T>): void {
		this.onPackEvent(event, handler);
	}

	/**
	 * Unsubscribe from a pack event
	 */
	public offPackEvent<T extends PackEventType>(event: T, handler: PackEventHandler<T>): void {
		this.eventHandlers.get(event)?.delete(handler);
	}

	/**
	 * Subscribe to a pack event once
	 */
	public oncePackEvent<T extends PackEventType>(event: T, handler: PackEventHandler<T>): void {
		if (!this.onceHandlers.has(event)) {
			this.onceHandlers.set(event, new Set());
		}
		this.onceHandlers.get(event)!.add(handler);
	}

	private emit<T extends PackEventType>(event: T, payload: PackEventMap[T]): void {
		// Regular handlers
		const handlers = this.eventHandlers.get(event);
		if (handlers) {
			for (const handler of handlers) {
				try {
					handler(payload);
				} catch (error) {
					console.error(`Error in pack event handler for ${event}:`, error);
				}
			}
		}

		// Once handlers
		const onceHandlers = this.onceHandlers.get(event);
		if (onceHandlers) {
			for (const handler of onceHandlers) {
				try {
					handler(payload);
				} catch (error) {
					console.error(`Error in once pack event handler for ${event}:`, error);
				}
			}
			this.onceHandlers.delete(event);
		}
	}

	// ==================== Pack Loading ====================

	/**
	 * Load a resource pack from URL
	 */
	public async loadPackFromUrl(url: string, options: PackFetchOptions = {}): Promise<string> {
		const packId = generatePackId();

		this.emit("loadStart", { packId, source: "url" });

		try {
			// Check cache first
			if (options.useCache !== false) {
				const cached = await this.getCachedDownload(url);
				if (cached) {
					this.emit("loadStart", { packId, source: "cache" });
					return await this.loadPackFromBlob(cached, options.name, {
						...options,
						sourceUrl: url,
					});
				}
			}

			// Fetch with progress
			const response = await fetch(url, {
				signal: options.signal,
				headers: options.headers,
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			const contentLength = response.headers.get("content-length");
			const total = contentLength ? parseInt(contentLength, 10) : 0;

			if (!response.body) {
				throw new Error("Response body is null");
			}

			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let loaded = 0;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				chunks.push(value);
				loaded += value.length;

				if (options.onProgress && total > 0) {
					options.onProgress(loaded, total);
				}

				this.emit("loadProgress", {
					packId,
					loaded,
					total,
					percent: total > 0 ? (loaded / total) * 100 : 0,
				});
			}

			const blob = new Blob(chunks as BlobPart[], { type: "application/zip" });

			// Cache the download
			if (options.useCache !== false) {
				await this.cacheDownload(url, blob);
			}

			return await this.loadPackFromBlob(blob, options.name, {
				...options,
				sourceUrl: url,
			});
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.emit("loadError", { packId, error: err, source: url });
			throw err;
		}
	}

	/**
	 * Load a resource pack from Blob
	 */
	public async loadPackFromBlob(
		blob: Blob,
		name?: string,
		options: PackFetchOptions & { sourceUrl?: string } = {}
	): Promise<string> {
		const packId = generatePackId();

		this.emit("loadStart", { packId, source: "blob" });

		try {
			// Parse the pack
			const packData = await this.parsePackBlob(blob, name);

			// Determine priority
			const priority = options.priority ?? this.getNextPriority();

			// Check max packs limit
			if (this.options.maxPacks && this.options.maxPacks > 0) {
				if (this.packs.size >= this.options.maxPacks) {
					throw new Error(`Maximum pack limit (${this.options.maxPacks}) reached`);
				}
			}

			const pack: StoredResourcePack = {
				id: packId,
				name: packData.name,
				description: packData.description,
				packFormat: packData.packFormat,
				icon: packData.icon,
				data: blob,
				enabled: options.enabled !== false,
				priority,
				size: blob.size,
				assetCounts: packData.assetCounts,
				sourceUrl: options.sourceUrl,
				loadedAt: Date.now(),
				hash: packData.hash,
			};

			await this.savePack(pack);

			const info = this.packToInfo(pack);
			this.emit("packAdded", { packId, info });
			this.emit("loadComplete", { packId, info });

			await this.triggerRebuild("Pack added: " + pack.name);

			return packId;
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.emit("loadError", { packId, error: err });
			throw err;
		}
	}

	/**
	 * Load a resource pack from File
	 */
	public async loadPackFromFile(file: File): Promise<string> {
		this.emit("loadStart", { packId: "", source: "file" });
		return await this.loadPackFromBlob(file, file.name);
	}

	/**
	 * Legacy method for backward compatibility
	 */
	public async uploadPack(file: File): Promise<string> {
		return await this.loadPackFromFile(file);
	}

	// ==================== Pack Parsing ====================

	private async parsePackBlob(
		blob: Blob,
		overrideName?: string
	): Promise<{
		name: string;
		description: string;
		packFormat: number;
		icon: string | null;
		assetCounts: { textures: number; blockstates: number; models: number };
		hash: string;
	}> {
		const zip = await JSZip.loadAsync(blob);
		const hash = await hashBlob(blob);

		// Parse pack.mcmeta
		const name = overrideName || "Unknown Pack";
		let description = "";
		let packFormat = 0;

		const mcmetaFile = zip.file("pack.mcmeta");
		if (mcmetaFile) {
			try {
				const content = await mcmetaFile.async("text");
				const mcmeta = JSON.parse(content);
				if (mcmeta.pack) {
					description = mcmeta.pack.description || "";
					packFormat = mcmeta.pack.pack_format || 0;
				}
			} catch (e) {
				console.warn("Failed to parse pack.mcmeta:", e);
			}
		}

		// Extract pack.png
		let icon: string | null = null;
		const iconFile = zip.file("pack.png");
		if (iconFile) {
			try {
				const iconData = await iconFile.async("base64");
				icon = `data:image/png;base64,${iconData}`;
			} catch (e) {
				console.warn("Failed to extract pack.png:", e);
			}
		}

		// Count assets
		const assetCounts = { textures: 0, blockstates: 0, models: 0 };

		zip.forEach((path) => {
			if (path.includes("textures/") && path.endsWith(".png")) {
				assetCounts.textures++;
			} else if (path.includes("blockstates/") && path.endsWith(".json")) {
				assetCounts.blockstates++;
			} else if (path.includes("models/") && path.endsWith(".json")) {
				assetCounts.models++;
			}
		});

		return {
			name: name.replace(/\.zip$/i, ""),
			description,
			packFormat,
			icon,
			assetCounts,
			hash,
		};
	}

	// ==================== Pack Management ====================

	/**
	 * Remove a pack by ID
	 */
	public async removePack(packId: string): Promise<void> {
		const pack = this.packs.get(packId);
		if (!pack) {
			// Try finding by name for legacy compatibility
			const byName = this.getPackByName(packId);
			if (byName) {
				return this.removePack(byName.id);
			}
			throw new Error(`Pack ${packId} not found`);
		}

		const name = pack.name;
		await this.deletePack(packId);

		this.emit("packRemoved", { packId, name });
		await this.triggerRebuild("Pack removed: " + name);
	}

	/**
	 * Remove all packs
	 */
	public async removeAllPacks(): Promise<void> {
		const packIds = Array.from(this.packs.keys());
		for (const packId of packIds) {
			await this.deletePack(packId);
		}

		this.emit("packsChanged", { reason: "All packs removed" });
		await this.triggerRebuild("All packs removed");
	}

	/**
	 * Enable a pack
	 */
	public async enablePack(packId: string): Promise<void> {
		const pack = this.packs.get(packId);
		if (!pack) {
			throw new Error(`Pack ${packId} not found`);
		}

		if (!pack.enabled) {
			pack.enabled = true;
			await this.savePack(pack);
			this.emit("packToggled", { packId, enabled: true });
			await this.triggerRebuild("Pack enabled: " + pack.name);
		}
	}

	/**
	 * Disable a pack
	 */
	public async disablePack(packId: string): Promise<void> {
		const pack = this.packs.get(packId);
		if (!pack) {
			throw new Error(`Pack ${packId} not found`);
		}

		if (pack.enabled) {
			pack.enabled = false;
			await this.savePack(pack);
			this.emit("packToggled", { packId, enabled: false });
			await this.triggerRebuild("Pack disabled: " + pack.name);
		}
	}

	/**
	 * Toggle pack enabled state
	 */
	public async togglePack(packId: string): Promise<boolean> {
		const pack = this.packs.get(packId);
		if (!pack) {
			throw new Error(`Pack ${packId} not found`);
		}

		pack.enabled = !pack.enabled;
		await this.savePack(pack);
		this.emit("packToggled", { packId, enabled: pack.enabled });
		await this.triggerRebuild(`Pack ${pack.enabled ? "enabled" : "disabled"}: ${pack.name}`);

		return pack.enabled;
	}

	/**
	 * Legacy method for backward compatibility
	 */
	public async togglePackEnabled(name: string, enabled: boolean): Promise<void> {
		const pack = this.getPackByName(name);
		if (!pack) {
			throw new Error(`Pack ${name} not found`);
		}

		if (enabled) {
			await this.enablePack(pack.id);
		} else {
			await this.disablePack(pack.id);
		}
	}

	// ==================== Priority Management ====================

	/**
	 * Set pack priority
	 */
	public async setPackPriority(packId: string, priority: number): Promise<void> {
		const pack = this.packs.get(packId);
		if (!pack) {
			throw new Error(`Pack ${packId} not found`);
		}

		pack.priority = priority;
		await this.savePack(pack);

		this.emit("packOrderChanged", { packIds: this.getSortedPackIds() });
		await this.triggerRebuild("Priority changed: " + pack.name);
	}

	/**
	 * Move pack up in priority
	 */
	public async movePackUp(packId: string): Promise<void> {
		const sortedPacks = this.getSortedPacks();
		const index = sortedPacks.findIndex((p) => p.id === packId);

		if (index < 0) {
			throw new Error(`Pack ${packId} not found`);
		}

		if (index < sortedPacks.length - 1) {
			// Swap priorities with the next pack
			const currentPack = sortedPacks[index];
			const nextPack = sortedPacks[index + 1];

			const tempPriority = currentPack.priority;
			currentPack.priority = nextPack.priority;
			nextPack.priority = tempPriority;

			await this.savePack(currentPack);
			await this.savePack(nextPack);

			this.emit("packOrderChanged", { packIds: this.getSortedPackIds() });
			await this.triggerRebuild("Pack moved up: " + currentPack.name);
		}
	}

	/**
	 * Move pack down in priority
	 */
	public async movePackDown(packId: string): Promise<void> {
		const sortedPacks = this.getSortedPacks();
		const index = sortedPacks.findIndex((p) => p.id === packId);

		if (index < 0) {
			throw new Error(`Pack ${packId} not found`);
		}

		if (index > 0) {
			// Swap priorities with the previous pack
			const currentPack = sortedPacks[index];
			const prevPack = sortedPacks[index - 1];

			const tempPriority = currentPack.priority;
			currentPack.priority = prevPack.priority;
			prevPack.priority = tempPriority;

			await this.savePack(currentPack);
			await this.savePack(prevPack);

			this.emit("packOrderChanged", { packIds: this.getSortedPackIds() });
			await this.triggerRebuild("Pack moved down: " + currentPack.name);
		}
	}

	/**
	 * Reorder all packs by ID array
	 */
	public async reorderPacks(packIds: string[]): Promise<void> {
		// Validate all IDs exist
		for (const id of packIds) {
			if (!this.packs.has(id)) {
				throw new Error(`Pack ${id} not found`);
			}
		}

		// Update priorities based on array order
		for (let i = 0; i < packIds.length; i++) {
			const pack = this.packs.get(packIds[i])!;
			pack.priority = i;
			await this.savePack(pack);
		}

		this.emit("packOrderChanged", { packIds });
		await this.triggerRebuild("Packs reordered");
	}

	/**
	 * Legacy method for backward compatibility
	 */
	public async reorderPack(name: string, newOrder: number): Promise<void> {
		const pack = this.getPackByName(name);
		if (!pack) {
			throw new Error(`Pack ${name} not found`);
		}
		await this.setPackPriority(pack.id, newOrder);
	}

	// ==================== Querying ====================

	/**
	 * Get pack info by ID
	 */
	public getPackInfo(packId: string): ResourcePackInfo | null {
		const pack = this.packs.get(packId);
		return pack ? this.packToInfo(pack) : null;
	}

	/**
	 * Get all packs (sorted by priority)
	 */
	public getAllPacks(): ResourcePackInfo[] {
		return this.getSortedPacks().map((p) => this.packToInfo(p));
	}

	/**
	 * Get enabled packs only
	 */
	public getEnabledPacks(): ResourcePackInfo[] {
		return this.getSortedPacks()
			.filter((p) => p.enabled)
			.map((p) => this.packToInfo(p));
	}

	/**
	 * Get enabled packs with their blob data (for loading into Cubane)
	 */
	public getEnabledPacksWithBlobs(): Array<ResourcePackInfo & { blob: Blob }> {
		return this.getSortedPacks()
			.filter((p) => p.enabled)
			.map((p) => ({
				...this.packToInfo(p),
				blob: p.data,
			}));
	}

	/**
	 * Get pack count
	 */
	public getPackCount(): number {
		return this.packs.size;
	}

	/**
	 * Legacy method for backward compatibility
	 */
	public async listPacks(): Promise<{ name: string; enabled: boolean; order: number }[]> {
		return this.getSortedPacks().map((p) => ({
			name: p.name,
			enabled: p.enabled,
			order: p.priority,
		}));
	}

	/**
	 * Get assets in a pack
	 */
	public async getPackAssets(
		packId: string
	): Promise<{ textures: string[]; blockstates: string[]; models: string[] }> {
		const pack = this.packs.get(packId);
		if (!pack) {
			throw new Error(`Pack ${packId} not found`);
		}

		const zip = await JSZip.loadAsync(pack.data);
		const textures: string[] = [];
		const blockstates: string[] = [];
		const models: string[] = [];

		zip.forEach((path) => {
			if (path.includes("textures/") && path.endsWith(".png")) {
				const match = path.match(/textures\/(.+)\.png$/);
				if (match) textures.push(match[1]);
			} else if (path.includes("blockstates/") && path.endsWith(".json")) {
				const match = path.match(/blockstates\/(.+)\.json$/);
				if (match) blockstates.push(match[1]);
			} else if (path.includes("models/") && path.endsWith(".json")) {
				const match = path.match(/models\/(.+)\.json$/);
				if (match) models.push(match[1]);
			}
		});

		return { textures, blockstates, models };
	}

	/**
	 * Get asset conflicts between packs
	 */
	public async getAssetConflicts(): Promise<AssetConflict[]> {
		const assetMap = new Map<
			string,
			{ type: "texture" | "blockstate" | "model"; providers: string[] }
		>();

		for (const pack of this.getSortedPacks()) {
			if (!pack.enabled) continue;

			const assets = await this.getPackAssets(pack.id);

			for (const tex of assets.textures) {
				const key = `texture:${tex}`;
				const entry = assetMap.get(key) || { type: "texture", providers: [] };
				entry.providers.push(pack.id);
				assetMap.set(key, entry);
			}

			for (const bs of assets.blockstates) {
				const key = `blockstate:${bs}`;
				const entry = assetMap.get(key) || { type: "blockstate", providers: [] };
				entry.providers.push(pack.id);
				assetMap.set(key, entry);
			}

			for (const model of assets.models) {
				const key = `model:${model}`;
				const entry = assetMap.get(key) || { type: "model", providers: [] };
				entry.providers.push(pack.id);
				assetMap.set(key, entry);
			}
		}

		// Filter to only conflicts (more than one provider)
		const conflicts: AssetConflict[] = [];

		for (const [key, entry] of assetMap) {
			if (entry.providers.length > 1) {
				const [type, path] = key.split(":", 2);
				conflicts.push({
					assetPath: path,
					type: type as "texture" | "blockstate" | "model",
					providers: entry.providers.map((id) => {
						const pack = this.packs.get(id)!;
						return {
							packId: id,
							packName: pack.name,
							priority: pack.priority,
						};
					}),
					activeProvider: entry.providers[entry.providers.length - 1], // Last one wins
				});
			}
		}

		return conflicts;
	}

	/**
	 * Find which pack provides an asset
	 */
	public async getAssetSource(
		path: string,
		type: "texture" | "blockstate" | "model"
	): Promise<string | null> {
		for (const pack of this.getSortedPacks().reverse()) {
			if (!pack.enabled) continue;

			const zip = await JSZip.loadAsync(pack.data);
			const filePath = packPathForAsset(path, type);

			if (zip.file(filePath)) {
				return pack.id;
			}
		}

		return null;
	}

	/**
	 * Preview a texture from a specific pack
	 */
	public async previewPackTexture(packId: string, texturePath: string): Promise<string | null> {
		const pack = this.packs.get(packId);
		if (!pack) return null;

		const zip = await JSZip.loadAsync(pack.data);
		const file =
			zip.file(packPathForAsset(texturePath, "texture")) || zip.file(`textures/${texturePath}.png`);

		if (!file) return null;

		const base64 = await file.async("base64");
		return `data:image/png;base64,${base64}`;
	}

	// ==================== Batch Operations ====================

	/**
	 * Begin batch update mode (defers rebuilds)
	 */
	public beginPackBatchUpdate(): void {
		this.batchMode = true;
		this.pendingChanges = false;
	}

	/**
	 * End batch update mode and trigger rebuild if needed
	 */
	public async endPackBatchUpdate(): Promise<void> {
		this.batchMode = false;
		if (this.pendingChanges) {
			this.pendingChanges = false;
			await this.rebuildPackAtlas();
		}
	}

	/**
	 * Set auto-rebuild mode
	 */
	public setPackAutoRebuild(enabled: boolean): void {
		this.autoRebuild = enabled;
	}

	/**
	 * Manually trigger atlas rebuild
	 */
	public async rebuildPackAtlas(): Promise<void> {
		console.log(
			"[ResourcePackManager] rebuildPackAtlas called, callback set:",
			!!this.onAtlasRebuild
		);
		if (this.onAtlasRebuild) {
			const enabledPacks = this.getEnabledPacks();
			this.emit("atlasRebuilding", {
				textureCount: enabledPacks.reduce((sum, p) => sum + p.assetCounts.textures, 0),
			});

			try {
				await this.onAtlasRebuild();
				this.emit("atlasRebuilt", {
					textureCount: enabledPacks.reduce((sum, p) => sum + p.assetCounts.textures, 0),
					efficiency: 0.85, // Placeholder
					fromCache: false,
				});
			} catch (error) {
				this.emit("error", {
					error: error instanceof Error ? error : new Error(String(error)),
					context: "Atlas rebuild",
				});
			}
		}
	}

	private async triggerRebuild(reason: string): Promise<void> {
		console.log(`[ResourcePackManager] triggerRebuild called: ${reason}`);
		this.emit("packsChanged", { reason });

		if (this.batchMode) {
			console.log("[ResourcePackManager] Batch mode - deferring rebuild");
			this.pendingChanges = true;
			return;
		}

		if (this.autoRebuild) {
			console.log("[ResourcePackManager] Auto-rebuild enabled, calling rebuildPackAtlas");
			await this.rebuildPackAtlas();
		} else {
			console.log("[ResourcePackManager] Auto-rebuild disabled");
		}
	}

	// ==================== Persistence ====================

	/**
	 * Save pack state to IndexedDB (already automatic)
	 */
	public async savePackState(): Promise<void> {
		// State is already persisted automatically
	}

	/**
	 * Load pack state from IndexedDB
	 */
	public async loadPackState(): Promise<boolean> {
		await this.ensureDbInitialized();
		return this.packs.size > 0;
	}

	/**
	 * Export pack configuration
	 */
	public exportPackConfig(): PackConfig {
		return {
			version: 1,
			packs: this.getSortedPacks().map((p) => ({
				id: p.id,
				name: p.name,
				sourceUrl: p.sourceUrl,
				priority: p.priority,
				enabled: p.enabled,
			})),
		};
	}

	/**
	 * Import pack configuration
	 */
	public async importPackConfig(config: PackConfig): Promise<void> {
		if (config.version !== 1) {
			throw new Error(`Unsupported config version: ${config.version}`);
		}

		for (const packConfig of config.packs) {
			const pack = this.packs.get(packConfig.id);
			if (pack) {
				pack.priority = packConfig.priority;
				pack.enabled = packConfig.enabled;
				await this.savePack(pack);
			} else if (packConfig.sourceUrl) {
				// Try to reload from URL
				try {
					await this.loadPackFromUrl(packConfig.sourceUrl, {
						name: packConfig.name,
						priority: packConfig.priority,
						enabled: packConfig.enabled,
					});
				} catch (error) {
					console.warn(`Failed to reload pack ${packConfig.name}:`, error);
				}
			}
		}

		await this.triggerRebuild("Config imported");
	}

	// ==================== Cache Management ====================

	/**
	 * Check if a URL is cached
	 */
	public async isPackCached(url: string): Promise<boolean> {
		const cached = await this.getCachedDownload(url);
		return cached !== null;
	}

	/**
	 * Get total cache size in bytes
	 */
	public async getPackCacheSize(): Promise<number> {
		await this.ensureDbInitialized();
		return new Promise((resolve, reject) => {
			if (!this.db || !this.db.objectStoreNames.contains("cache")) {
				resolve(0);
				return;
			}

			const transaction = this.db.transaction(["cache"], "readonly");
			const store = transaction.objectStore("cache");
			const request = store.getAll();

			request.onerror = () => reject(new Error("Error getting cache size"));
			request.onsuccess = () => {
				const items = request.result as { url: string; data: Blob }[];
				const total = items.reduce((sum, item) => sum + (item.data?.size || 0), 0);
				resolve(total);
			};
		});
	}

	/**
	 * Clear all cache
	 */
	public async clearPackCache(): Promise<void> {
		await this.ensureDbInitialized();
		this.downloadCache.clear();

		return new Promise((resolve, reject) => {
			if (!this.db || !this.db.objectStoreNames.contains("cache")) {
				resolve();
				return;
			}

			const transaction = this.db.transaction(["cache"], "readwrite");
			const store = transaction.objectStore("cache");
			const request = store.clear();

			request.onerror = () => reject(new Error("Error clearing cache"));
			request.onsuccess = () => resolve();
		});
	}

	/**
	 * Get memory usage statistics
	 */
	public getPackMemoryUsage(): PackMemoryUsage {
		let totalBytes = 0;
		const perPack = new Map<string, number>();

		for (const [id, pack] of this.packs) {
			const size = pack.size;
			perPack.set(id, size);
			totalBytes += size;
		}

		return {
			totalBytes,
			perPack,
			cachedItems: this.downloadCache.size,
		};
	}

	private async getCachedDownload(url: string): Promise<Blob | null> {
		// Check memory cache first
		const memCached = this.downloadCache.get(url);
		if (memCached) return memCached;

		// Check IndexedDB cache
		await this.ensureDbInitialized();
		return new Promise((resolve) => {
			if (!this.db || !this.db.objectStoreNames.contains("cache")) {
				resolve(null);
				return;
			}

			const transaction = this.db.transaction(["cache"], "readonly");
			const store = transaction.objectStore("cache");
			const request = store.get(url);

			request.onerror = () => resolve(null);
			request.onsuccess = () => {
				const result = request.result as { url: string; data: Blob } | undefined;
				if (result?.data) {
					this.downloadCache.set(url, result.data);
					resolve(result.data);
				} else {
					resolve(null);
				}
			};
		});
	}

	private async cacheDownload(url: string, blob: Blob): Promise<void> {
		this.downloadCache.set(url, blob);

		await this.ensureDbInitialized();
		return new Promise((resolve) => {
			if (!this.db || !this.db.objectStoreNames.contains("cache")) {
				resolve();
				return;
			}

			const transaction = this.db.transaction(["cache"], "readwrite");
			const store = transaction.objectStore("cache");
			store.put({ url, data: blob });

			transaction.oncomplete = () => resolve();
			transaction.onerror = () => resolve();
		});
	}

	// ==================== Validation ====================

	/**
	 * Validate a pack without loading it
	 */
	public async validatePack(blob: Blob): Promise<PackValidationResult> {
		const errors: string[] = [];
		const warnings: string[] = [];
		let packFormat: number | undefined;
		let hasIcon = false;
		const assetCounts = { textures: 0, blockstates: 0, models: 0 };

		try {
			const zip = await JSZip.loadAsync(blob);

			// Check for pack.mcmeta
			const mcmetaFile = zip.file("pack.mcmeta");
			if (!mcmetaFile) {
				warnings.push("Missing pack.mcmeta file");
			} else {
				try {
					const content = await mcmetaFile.async("text");
					const mcmeta = JSON.parse(content);
					if (!mcmeta.pack) {
						errors.push("Invalid pack.mcmeta: missing 'pack' object");
					} else {
						packFormat = mcmeta.pack.pack_format;
						if (!packFormat) {
							warnings.push("Missing pack_format in pack.mcmeta");
						}
					}
				} catch {
					errors.push("Invalid pack.mcmeta: failed to parse JSON");
				}
			}

			// Check for pack.png
			hasIcon = zip.file("pack.png") !== null;

			// Count assets
			zip.forEach((path) => {
				if (path.includes("textures/") && path.endsWith(".png")) {
					assetCounts.textures++;
				} else if (path.includes("blockstates/") && path.endsWith(".json")) {
					assetCounts.blockstates++;
				} else if (path.includes("models/") && path.endsWith(".json")) {
					assetCounts.models++;
				}
			});

			if (assetCounts.textures === 0 && assetCounts.blockstates === 0 && assetCounts.models === 0) {
				warnings.push("No Minecraft assets found in pack");
			}
		} catch (error) {
			errors.push(
				`Failed to read zip file: ${error instanceof Error ? error.message : String(error)}`
			);
		}

		return {
			valid: errors.length === 0,
			errors,
			warnings,
			packFormat,
			assetCounts,
			hasIcon,
		};
	}

	// ==================== Resource Pack Blobs (Legacy) ====================

	/**
	 * Get resource pack blobs for loading into Cubane (legacy compatibility)
	 */
	public async getResourcePackBlobs(
		defaultPacks: Record<string, DefaultPackCallback> = {}
	): Promise<Blob[]> {
		await this.ensureDbInitialized();

		// Load default packs that don't exist
		for (const [name, callback] of Object.entries(defaultPacks)) {
			const existingPack = this.getPackByName(name);
			if (!existingPack) {
				try {
					console.log(`Fetching default pack ${name}`);
					const blob = await callback();
					await this.loadPackFromBlob(blob, name);
				} catch (error) {
					console.error(`Failed to fetch default pack ${name}:`, error);
				}
			}
		}

		// Return enabled packs sorted by priority
		return this.getSortedPacks()
			.filter((p) => p.enabled)
			.map((p) => p.data);
	}

	/**
	 * Clear all packs (legacy compatibility)
	 */
	public async clearPacks(): Promise<void> {
		await this.removeAllPacks();
	}

	// ==================== Helpers ====================

	private getNextPriority(): number {
		if (this.packs.size === 0) return 0;
		return Math.max(...Array.from(this.packs.values()).map((p) => p.priority)) + 1;
	}

	private getSortedPacks(): StoredResourcePack[] {
		return Array.from(this.packs.values()).sort((a, b) => a.priority - b.priority);
	}

	private getSortedPackIds(): string[] {
		return this.getSortedPacks().map((p) => p.id);
	}

	private getPackByName(name: string): StoredResourcePack | undefined {
		return Array.from(this.packs.values()).find((p) => p.name === name);
	}

	private packToInfo(pack: StoredResourcePack): ResourcePackInfo {
		return {
			id: pack.id,
			name: pack.name,
			description: pack.description,
			packFormat: pack.packFormat,
			icon: pack.icon,
			priority: pack.priority,
			enabled: pack.enabled,
			size: pack.size,
			assetCounts: pack.assetCounts,
			sourceUrl: pack.sourceUrl,
			loadedAt: pack.loadedAt,
			hash: pack.hash,
		};
	}

	/**
	 * Get options
	 */
	public getOptions(): ResourcePackOptions {
		return this.options;
	}

	/**
	 * Clean up resources
	 */
	public dispose(): void {
		// Clear all event handlers
		this.eventHandlers.clear();
		this.onceHandlers.clear();

		// Clear download cache
		this.downloadCache.clear();

		// Clear in-memory packs
		this.packs.clear();

		// Close database connection
		if (this.db) {
			this.db.close();
			this.db = null;
		}

		// Clear atlas rebuild callback
		this.onAtlasRebuild = undefined;
	}
}

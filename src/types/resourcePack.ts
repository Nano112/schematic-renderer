// Resource Pack Types

/**
 * Information about a loaded resource pack
 */
export interface ResourcePackInfo {
	/** Unique identifier for the pack */
	id: string;
	/** Display name of the pack */
	name: string;
	/** Description from pack.mcmeta */
	description: string;
	/** Pack format version from pack.mcmeta */
	packFormat: number;
	/** Base64 data URL of pack.png icon, or null if not present */
	icon: string | null;
	/** Priority level (higher = applied later, overrides lower priority) */
	priority: number;
	/** Whether the pack is currently enabled */
	enabled: boolean;
	/** Size of the pack in bytes */
	size: number;
	/** Counts of different asset types in the pack */
	assetCounts: {
		textures: number;
		blockstates: number;
		models: number;
	};
	/** Original source URL if loaded from URL */
	sourceUrl?: string;
	/** Timestamp when the pack was loaded */
	loadedAt: number;
	/** Hash of the pack content for deduplication */
	hash: string;
}

/**
 * Options for loading a pack from URL
 */
export interface PackFetchOptions {
	/** Display name for the pack */
	name?: string;
	/** Priority level for the pack */
	priority?: number;
	/** Whether to enable the pack immediately (default: true) */
	enabled?: boolean;
	/** Whether to cache the download (default: true) */
	useCache?: boolean;
	/** Progress callback for download */
	onProgress?: (loaded: number, total: number) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Custom headers for the request */
	headers?: Record<string, string>;
}

/**
 * Result of pack validation
 */
export interface PackValidationResult {
	/** Whether the pack is valid */
	valid: boolean;
	/** Validation errors (if any) */
	errors: string[];
	/** Validation warnings (non-blocking) */
	warnings: string[];
	/** Pack format version (if detected) */
	packFormat?: number;
	/** Asset counts (if detected) */
	assetCounts?: {
		textures: number;
		blockstates: number;
		models: number;
	};
	/** Whether pack.png exists */
	hasIcon?: boolean;
}

/**
 * Configuration for exporting/importing pack state
 */
export interface PackConfig {
	version: number;
	packs: Array<{
		id: string;
		name: string;
		sourceUrl?: string;
		priority: number;
		enabled: boolean;
	}>;
}

/**
 * Asset conflict information
 */
export interface AssetConflict {
	/** Path to the conflicting asset */
	assetPath: string;
	/** Type of asset (texture, blockstate, model) */
	type: "texture" | "blockstate" | "model";
	/** Packs that provide this asset */
	providers: Array<{
		packId: string;
		packName: string;
		priority: number;
	}>;
	/** Pack ID of the active (highest priority) provider */
	activeProvider: string;
}

/**
 * Memory usage statistics
 */
export interface PackMemoryUsage {
	/** Total memory used by all packs */
	totalBytes: number;
	/** Memory per pack */
	perPack: Map<string, number>;
	/** Number of cached items */
	cachedItems: number;
}

// Event Types

export interface PackAddedEvent {
	packId: string;
	info: ResourcePackInfo;
}

export interface PackRemovedEvent {
	packId: string;
	name: string;
}

export interface PackToggledEvent {
	packId: string;
	enabled: boolean;
}

export interface PackOrderChangedEvent {
	packIds: string[];
}

export interface PacksChangedEvent {
	reason: string;
}

export interface AtlasRebuildingEvent {
	textureCount: number;
}

export interface AtlasRebuiltEvent {
	textureCount: number;
	efficiency: number;
	fromCache: boolean;
}

export interface LoadProgressEvent {
	packId: string;
	loaded: number;
	total: number;
	percent: number;
}

export interface LoadStartEvent {
	packId: string;
	source: "url" | "blob" | "file" | "cache";
}

export interface LoadCompleteEvent {
	packId: string;
	info: ResourcePackInfo;
}

export interface LoadErrorEvent {
	packId: string | null;
	error: Error;
	source?: string;
}

export interface PackErrorEvent {
	error: Error;
	context?: string;
}

/**
 * Map of event names to their payload types
 */
export interface PackEventMap {
	packAdded: PackAddedEvent;
	packRemoved: PackRemovedEvent;
	packToggled: PackToggledEvent;
	packOrderChanged: PackOrderChangedEvent;
	packsChanged: PacksChangedEvent;
	atlasRebuilding: AtlasRebuildingEvent;
	atlasRebuilt: AtlasRebuiltEvent;
	loadProgress: LoadProgressEvent;
	loadStart: LoadStartEvent;
	loadComplete: LoadCompleteEvent;
	loadError: LoadErrorEvent;
	error: PackErrorEvent;
}

export type PackEventType = keyof PackEventMap;
export type PackEventHandler<T extends PackEventType> = (event: PackEventMap[T]) => void;

/**
 * Options for resource pack management UI and behavior
 */
export interface ResourcePackOptions {
	/**
	 * Restore packs saved by Cubane when no explicit default pack is supplied.
	 * Defaults to true without defaults and false when defaults are provided.
	 */
	restoreCachedPacks?: boolean;
	/** Enable the resource pack management UI (default: true) */
	enableUI?: boolean;
	/** Position of the UI panel */
	uiPosition?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
	/** Auto-rebuild atlas when packs change (default: true) */
	autoRebuild?: boolean;
	/** Show pack icons in UI (default: true) */
	showIcons?: boolean;
	/** Enable drag-and-drop reordering in UI (default: true) */
	enableDragReorder?: boolean;
	/** Enable keyboard shortcuts (default: true) */
	enableKeyboardShortcuts?: boolean;
	/** Keyboard shortcut to toggle UI visibility */
	toggleUIShortcut?: string;
	/** Maximum packs allowed (0 = unlimited) */
	maxPacks?: number;
	/**
	 * Show an in-viewport notice when no resource pack is loaded, explaining the
	 * placeholder textures and how to add a pack. (default: true)
	 */
	showMissingPackNotice?: boolean;
	/** Default packs to load on init */
	defaultPacks?: Record<string, () => Promise<Blob>>;

	// Callbacks
	/** Called when any pack change occurs that affects rendering */
	onPacksChanged?: (packs: PacksChangedEvent) => void | Promise<void>;
	/** Called when atlas is rebuilt */
	onAtlasRebuilt?: () => void | Promise<void>;
	/** Called when a pack is toggled */
	onPackToggled?: (pack: string, enabled: boolean) => void | Promise<void>;
	/** Called when a pack is added */
	onPackAdded?: (pack: PackAddedEvent) => void | Promise<void>;
	/** Called when a pack is removed */
	onPackRemoved?: (packId: string) => void | Promise<void>;
	/** Called on load progress */
	onLoadProgress?: (progress: LoadProgressEvent) => void | Promise<void>;
	/** Called when a pack finishes loading */
	onLoadComplete?: (pack: LoadCompleteEvent) => void | Promise<void>;
	/** Called on load error */
	onLoadError?: (error: LoadErrorEvent) => void | Promise<void>;
	/** Called on general error */
	onError?: (error: PackErrorEvent) => void | Promise<void>;
}

/**
 * Internal stored pack data
 */
export interface StoredResourcePack {
	id: string;
	name: string;
	description: string;
	packFormat: number;
	icon: string | null;
	data: Blob;
	enabled: boolean;
	priority: number;
	size: number;
	assetCounts: {
		textures: number;
		blockstates: number;
		models: number;
	};
	sourceUrl?: string;
	loadedAt: number;
	hash: string;
}

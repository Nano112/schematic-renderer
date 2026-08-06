import { Material, BufferGeometry } from "three";

export interface ModelData {
	model: string;
	x?: number;
	y?: number;
	uvlock?: boolean;
}

export interface Block {
	namespace: string;
	name: string;
	properties: Record<string, string>;
}

export interface TextureAnimationMetadata {
	animation: {
		frametime?: number; // How long each frame lasts (in ticks, default: 1)
		frames?: number[]; // Optional custom frame order
		interpolate?: boolean; // Whether to interpolate between frames
		width?: number; // Optional frame width
		height?: number; // Optional frame height
	};
}

export interface BlockStateDefinition {
	variants?: Record<string, BlockStateModelHolder | BlockStateModelHolder[]>;
	multipart?: BlockStateMultipart[];
}

export type BlockStateCondition =
	| BlockStateDefinitionVariant<string | number>
	| { AND: BlockStateCondition[] }
	| { OR: BlockStateCondition[] };

export interface BlockStateModelHolder {
	model: string;
	x?: number;
	y?: number;
	uvlock?: boolean;
	weight?: number;
}

export interface BlockStateMultipart {
	when?: BlockStateCondition;
	apply: BlockStateModelHolder | BlockStateModelHolder[];
}

export interface BlockStateDefinitionVariant<T> {
	[property: string]: T;
}

export interface BlockModel {
	parent?: string;
	textures?: Record<string, string>;
	elements?: BlockModelElement[];
	display?: Record<string, any>;
}

export interface BlockModelElement {
	from: [number, number, number];
	to: [number, number, number];
	/** Vanilla element light emission, from 0 (normally lit) to 15 (fully emissive). */
	light_emission?: number;
	rotation?: {
		origin: [number, number, number];
		axis: "x" | "y" | "z";
		angle: number;
		rescale?: boolean;
	};
	faces?: {
		[face in "down" | "up" | "north" | "south" | "west" | "east"]?: {
			texture: string;
			cullface?: string;
			rotation?: number;
			tintindex?: number;
			uv?: [number, number, number, number];
		};
	};
}

export interface ResourcePackLoadOptions {
	/** Unique ID for this resource pack in the cache */
	packId?: string;
	/** Whether to use IndexedDB caching (default: true) */
	useCache?: boolean;
	/** Whether to ignore existing cache and force reloading (default: false) */
	forceReload?: boolean;
	/** Time in milliseconds to expire cache (default: 7 days) */
	cacheExpiration?: number | null;
}

/**
 * Callback to get the resource pack blob if not found in cache
 */
export type ResourcePackLoader = () => Promise<Blob>;

export interface BlockOptimizationData {
	isCube: boolean;
	hasTransparency: boolean;
	hasCullableFaces: boolean;

	// Face organization
	cullableFaces: Map<string, OptimizedFace[]>; // direction -> faces
	nonCullableFaces: OptimizedFace[];
	/** Blockstate rotation for the model whose faces were analyzed. */
	modelRotation?: { x: number; y: number };

	// For batching
	geometryTemplate?: GeometryTemplate;
}

export interface OptimizedFace {
	geometry: BufferGeometry;
	material: Material;
	direction: string; // face normal direction
	cullface?: string; // the cullface value from model
	elementBounds: [number[], number[]]; // from/to in block space
	canBatch: boolean;
}

export interface GeometryTemplate {
	positions: Float32Array;
	normals: Float32Array;
	uvs: Float32Array;
	indices: Uint32Array;
	materialGroups: MaterialGroup[];
}

export interface MaterialGroup {
	material: Material;
	indexRange: { start: number; count: number };
	cullface?: string;
}

export interface BlockGeometryInfo {
	isCube: boolean;
	hasTransparency: boolean;
	hasCullableFaces: boolean;
	isEntity: boolean;
	isHybrid: boolean;
}

export interface TextureInfo {
	path: string;
	image: HTMLImageElement | ImageBitmap;
	width: number;
	height: number;
	area: number;
}

export interface AtlasNode {
	x: number;
	y: number;
	width: number;
	height: number;
	used: boolean;
	right?: AtlasNode;
	down?: AtlasNode;
}

export interface PackedTexture extends TextureInfo {
	x: number;
	y: number;
	rotated?: boolean;
}

// ============================================
// Resource Pack Management Types
// ============================================

/**
 * Complete information about a loaded resource pack
 */
export interface ResourcePackInfo {
	/** Unique identifier for this pack */
	id: string;
	/** Display name (from pack.mcmeta or filename) */
	name: string;
	/** Description from pack.mcmeta */
	description: string;
	/** pack_format from pack.mcmeta */
	packFormat: number;
	/** Base64 data URL of pack.png icon, or null if not present */
	icon: string | null;
	/** Priority order (higher = applied later, overrides lower) */
	priority: number;
	/** Whether this pack is currently enabled */
	enabled: boolean;
	/** Size in bytes */
	size: number;
	/** Asset counts */
	assetCounts: {
		textures: number;
		blockstates: number;
		models: number;
	};
	/** Original source URL if loaded from URL */
	sourceUrl?: string;
	/** Timestamp when pack was loaded */
	loadedAt: number;
	/** SHA-256 hash for change detection */
	hash: string;
}

/**
 * Options for fetching resource packs
 */
export interface PackFetchOptions {
	/** Custom name override */
	name?: string;
	/** Initial priority (defaults to highest) */
	priority?: number;
	/** Progress callback */
	onProgress?: (loaded: number, total: number) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Custom headers for fetch */
	headers?: Record<string, string>;
	/** Whether to enable the pack immediately (default: true) */
	enabled?: boolean;
	/** Whether to use cache (default: true) */
	useCache?: boolean;
}

/**
 * Result of pack validation
 */
export interface PackValidationResult {
	valid: boolean;
	packFormat?: number;
	name?: string;
	description?: string;
	hasIcon: boolean;
	errors: string[];
	warnings: string[];
	assetCounts: {
		textures: number;
		blockstates: number;
		models: number;
	};
}

/**
 * Asset conflict information
 */
export interface AssetConflict {
	/** Path to the asset */
	assetPath: string;
	/** Asset type */
	type: "texture" | "blockstate" | "model";
	/** Packs that provide this asset, in priority order (highest first) */
	providers: Array<{
		packId: string;
		packName: string;
		priority: number;
	}>;
	/** Which pack is actually being used */
	activeProvider: string;
}

/**
 * List of assets in a pack
 */
export interface PackAssetList {
	textures: string[];
	blockstates: string[];
	models: string[];
}

/**
 * Cache information for a pack
 */
export interface PackCacheInfo {
	packId: string;
	cached: boolean;
	size: number;
	cachedAt?: number;
	expiresAt?: number;
}

/**
 * Memory usage statistics
 */
export interface MemoryStats {
	totalPacksSize: number;
	loadedPacksCount: number;
	atlasSize: number;
	cachedMaterials: number;
	cachedTextures: number;
	cachedMeshes: number;
}

/**
 * Resource pack configuration for export/import
 */
export interface PackConfiguration {
	version: number;
	packs: Array<{
		id: string;
		name: string;
		sourceUrl?: string;
		priority: number;
		enabled: boolean;
	}>;
}

// ============================================
// Resource Pack Events
// ============================================

export type PackEventType =
	| "packAdded"
	| "packRemoved"
	| "packToggled"
	| "packOrderChanged"
	| "packsChanged"
	| "atlasRebuilding"
	| "atlasRebuilt"
	| "loadProgress"
	| "loadStart"
	| "loadComplete"
	| "loadError"
	| "error";

export interface PackEventMap {
	packAdded: { packId: string; info: ResourcePackInfo };
	packRemoved: { packId: string; name: string };
	packToggled: { packId: string; enabled: boolean };
	packOrderChanged: { packIds: string[] };
	packsChanged: { reason: string };
	atlasRebuilding: { textureCount: number };
	atlasRebuilt: { textureCount: number; efficiency: number; fromCache: boolean };
	loadProgress: { packId: string; loaded: number; total: number; percent: number };
	loadStart: { packId: string; source: "url" | "blob" | "file" | "cache" };
	loadComplete: { packId: string; info: ResourcePackInfo };
	loadError: { packId: string | null; error: Error; source?: string };
	error: { error: Error; context?: string };
}

export type PackEventCallback<T extends PackEventType> = (event: PackEventMap[T]) => void;

import * as THREE from "three";
import JSZip from "jszip";
import { AnimatedTextureManager } from "./AnimatedTextureManager";
import { TintManager } from "./TintManager";
import { BlockModel, BlockStateDefinition } from "./types";
import { AtlasBuilder } from "./AtlasBuilder";
import { ResourcePackManager } from "./ResourcePackManager";
import {
	formatPackAssetReference,
	normalizeResourceLocation,
	packAssetFromFilePath,
	parseResourceLocation,
	resolveAssetFilePath,
} from "./ResourceLocation";

export class AssetLoader {
	private resourcePacks: Map<string, JSZip> = new Map();
	private resourcePackOrder: string[] = [];
	private animatedTextureManager: AnimatedTextureManager;
	private tintManager: TintManager;

	// ResourcePackManager integration
	private packManager: ResourcePackManager | null = null;
	private usePackManager: boolean = false;

	// Caches
	private stringCache: Map<string, string> = new Map();
	private blockStateCache: Map<string, BlockStateDefinition> = new Map();
	private modelCache: Map<string, BlockModel> = new Map();
	private textureCache: Map<string, THREE.Texture> = new Map();
	private materialCache: Map<string, THREE.Material> = new Map();

	// Texture loader
	private textureLoader = new THREE.TextureLoader();
	private textureAtlas: THREE.Texture | null = null;
	private textureUVMap: Map<string, { u: number; v: number; width: number; height: number }> =
		new Map();

	// Cache management
	private resourcePackHash: string = "";
	private cacheEnabled: boolean = true;

	constructor(enableCache: boolean = true) {
		this.animatedTextureManager = new AnimatedTextureManager(this);
		this.tintManager = new TintManager();
		this.cacheEnabled = enableCache;
	}

	/**
	 * Connect to a ResourcePackManager for managed pack loading
	 */
	public setPackManager(manager: ResourcePackManager): void {
		this.packManager = manager;
		this.usePackManager = true;

		// Set up rebuild callback - when packs change, rebuild atlas
		manager.setAtlasRebuildCallback(async () => {
			await this.rebuildFromPackManager();
		});
	}

	/**
	 * Rebuild atlas from ResourcePackManager's packs
	 */
	private async rebuildFromPackManager(): Promise<void> {
		if (!this.packManager) return;

		// Clear caches that depend on pack content
		this.stringCache.clear();
		this.blockStateCache.clear();
		this.modelCache.clear();

		this.textureCache.forEach((t) => t.dispose());
		this.textureCache.clear();

		this.materialCache.forEach((m) => m.dispose());
		this.materialCache.clear();

		// Force colormaps to reload from the newly-enabled packs.
		this.colormapsLoaded = false;

		if (this.textureAtlas) {
			this.textureAtlas.dispose();
			this.textureAtlas = null;
		}
		this.textureUVMap.clear();

		// Recalculate hash from enabled packs for cache key
		const enabledPacks = this.packManager.getEnabledPacks();
		const packHashes = enabledPacks.map((p) => p.hash);
		this.resourcePackHash = await this.hashString(packHashes.join(":"));

		// Rebuild atlas
		await this.buildTextureAtlas();
	}

	/**
	 * Hash a string using SHA-256
	 */
	private async hashString(str: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(str);
		const hashBuffer = await crypto.subtle.digest("SHA-256", data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
	}

	/**
	 * Get packs in priority order for iteration (highest priority first for overrides)
	 * Supports both ResourcePackManager and legacy direct loading
	 */
	private getOrderedPacks(): Array<{ id: string; zip: JSZip }> {
		// Try ResourcePackManager first if available and has packs
		if (this.usePackManager && this.packManager) {
			const packs = this.packManager.getEnabledPacksInOrder();
			if (packs.length > 0) {
				// Pack manager returns lowest-to-highest priority, reverse for iteration
				return [...packs].reverse();
			}
			// Fall through to legacy if pack manager has no packs
		}

		// Legacy: use internal resourcePacks Map
		return this.resourcePackOrder
			.map((id) => ({ id, zip: this.resourcePacks.get(id)! }))
			.filter((p) => p.zip);
	}

	/**
	 * Calculate hash of resource pack for cache invalidation
	 */
	private async calculateResourcePackHash(arrayBuffer: ArrayBuffer): Promise<string> {
		// Use SubtleCrypto to create a hash of the resource pack
		const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
	}

	/**
	 * Load a resource pack from a blob
	 */
	public async loadResourcePack(blob: Blob): Promise<void> {
		try {
			console.log("🔍 Loading resource pack from blob...");

			// Ensure fully loaded and safe Blob
			const arrayBuffer = await blob.arrayBuffer();
			console.log("📦 Blob size:", arrayBuffer.byteLength, "type:", blob.type);

			// Calculate hash for caching
			if (this.cacheEnabled) {
				this.resourcePackHash = await this.calculateResourcePackHash(arrayBuffer);
				console.log("🔑 Resource pack hash:", this.resourcePackHash.substring(0, 16) + "...");
			}

			// Optional: Verify ZIP signature at start
			const header = new Uint8Array(arrayBuffer.slice(0, 4));
			if (header[0] !== 0x50 || header[1] !== 0x4b || header[2] !== 0x03 || header[3] !== 0x04) {
				throw new Error("❌ Invalid ZIP: missing PK\x03\x04 header");
			}

			// Optional: Verify EOCD record at the end
			const eocdOffset = this.findEOCD(arrayBuffer);
			if (eocdOffset === -1) {
				throw new Error("❌ ZIP missing End of Central Directory (EOCD)");
			}
			console.log("📍 EOCD found at byte offset:", eocdOffset);

			// Pass raw buffer to JSZip directly
			const zip = await JSZip.loadAsync(arrayBuffer);
			console.log("✅ ZIP loaded, entries:", Object.keys(zip.files).length);

			// Filter and log structure
			const assetFiles = Object.keys(zip.files)
				.filter((path) => !zip.files[path].dir)
				.map((path) => packAssetFromFilePath(path))
				.filter((asset): asset is NonNullable<typeof asset> => !!asset);
			const blockstates = assetFiles.filter((asset) => asset.type === "blockstate");
			const models = assetFiles.filter((asset) => asset.type === "model");
			const textures = assetFiles.filter((asset) => asset.type === "texture");

			console.log("📁 blockstates:", blockstates.length);
			console.log("📁 models:", models.length);
			console.log("📁 textures:", textures.length);

			// Register pack
			const packId = `pack_${Date.now()}`;
			this.resourcePacks.set(packId, zip);
			this.resourcePackOrder.unshift(packId);
		} catch (error) {
			console.error("❌ Failed to load resource pack:", error);
			throw error;
		}
	}

	// Detect EOCD location for ZIP validity
	private findEOCD(buffer: ArrayBuffer): number {
		const view = new Uint8Array(buffer);
		for (let i = buffer.byteLength - 22; i >= 0; i--) {
			if (
				view[i] === 0x50 && // P
				view[i + 1] === 0x4b && // K
				view[i + 2] === 0x05 &&
				view[i + 3] === 0x06
			) {
				return i;
			}
		}
		return -1;
	}

	/**
	 * Get a string resource (JSON files, etc.)
	 */
	public async getResourceString(
		path: string,
		silent: boolean = true
	): Promise<string | undefined> {
		const resourcePath = resolveAssetFilePath(path);

		// Check cache first
		const cacheKey = `string:${resourcePath}`;
		if (this.stringCache.has(cacheKey)) {
			return this.stringCache.get(cacheKey);
		}

		// Try each resource pack in order of priority (highest first)
		for (const { id: packId, zip } of this.getOrderedPacks()) {
			const file = zip.file(resourcePath);
			if (file) {
				try {
					const content = await file.async("string");
					this.stringCache.set(cacheKey, content);
					return content;
				} catch (error) {
					if (!silent) {
						console.error(`Error reading ${path} from pack ${packId}:`, error);
					}
				}
			}
		}

		if (!silent) {
			console.warn(`Resource not found: ${resourcePath}`);
		}
		return undefined;
	}

	/**
	 * Get a binary resource (textures, etc.)
	 */
	public async getResourceBlob(path: string): Promise<Blob | undefined> {
		const resourcePath = resolveAssetFilePath(path);

		// Try each resource pack in order of priority (highest first)
		for (const { id: packId, zip } of this.getOrderedPacks()) {
			const file = zip.file(resourcePath);
			if (file) {
				try {
					return await file.async("blob");
				} catch (error) {
					console.warn(`Error reading ${resourcePath} from pack ${packId}:`, error);
				}
			}
		}

		// Silent fail - many textures won't exist in smaller packs
		return undefined;
	}

	/**
	 * Get a block state definition
	 */
	public async getBlockState(blockId: string): Promise<BlockStateDefinition> {
		const normalizedBlockId = normalizeResourceLocation(blockId);

		// Check cache first
		const cacheKey = `blockstate:${normalizedBlockId}`;
		if (this.blockStateCache.has(cacheKey)) {
			return this.blockStateCache.get(cacheKey)!;
		}

		// Load from resource pack
		const jsonString = await this.getResourceString(`blockstates/${normalizedBlockId}.json`);
		if (!jsonString) {
			console.warn(`Block state definition for ${normalizedBlockId} not found.`);
			return {} as BlockStateDefinition;
		}

		try {
			const blockStateDefinition = JSON.parse(jsonString) as BlockStateDefinition;
			this.blockStateCache.set(cacheKey, blockStateDefinition);
			return blockStateDefinition;
		} catch (error) {
			console.error(`Error parsing blockstate for ${normalizedBlockId}:`, error);
			return {} as BlockStateDefinition;
		}
	}

	public async getModel(modelPath: string): Promise<BlockModel> {
		const normalizedModelPath = normalizeResourceLocation(modelPath);
		const modelLocation = parseResourceLocation(normalizedModelPath);

		// Check cache first
		const cacheKey = `model:${normalizedModelPath}`;
		if (this.modelCache.has(cacheKey)) {
			return this.modelCache.get(cacheKey)!;
		}

		// Special handling for liquid models with level information
		if (
			modelLocation.namespace === "minecraft" &&
			(modelLocation.path.startsWith("block/water") || modelLocation.path.startsWith("block/lava"))
		) {
			const isWater = modelLocation.path.startsWith("block/water");

			// Extract level from model path if present
			let level = 0;
			const levelMatch = modelLocation.path.match(/_level_(\d+)/);
			if (levelMatch) {
				level = parseInt(levelMatch[1], 10);
			}

			// Calculate liquid height based on level
			// In Minecraft:
			// Level 0 = full/source block
			// Level 1-7 = progressively lower flowing blocks
			const liquidHeight = level === 0 ? 16 : 16 - level * 2;

			// Special case: water source blocks are 14px high, not 16px
			const actualHeight = isWater && level === 0 ? 14 : liquidHeight;

			// Create an enhanced liquid model
			const liquidModel: BlockModel = {
				textures: {
					particle: isWater ? "block/water_still" : "block/lava_still",
					all: isWater ? "block/water_still" : "block/lava_still",
					top: isWater ? "block/water_still" : "block/lava_still",
					bottom: isWater ? "block/water_still" : "block/lava_still",
					north: isWater ? "block/water_flow" : "block/lava_flow",
					south: isWater ? "block/water_flow" : "block/lava_flow",
					east: isWater ? "block/water_flow" : "block/lava_flow",
					west: isWater ? "block/water_flow" : "block/lava_flow",
				},
				elements: [
					{
						from: [0, 0, 0],
						to: [16, actualHeight, 16], // Dynamic height based on level
						faces: {
							down: { texture: "#bottom", cullface: "down" },
							up: { texture: "#top", cullface: "up" },
							north: { texture: "#north", cullface: "north" },
							south: { texture: "#south", cullface: "south" },
							west: { texture: "#west", cullface: "west" },
							east: { texture: "#east", cullface: "east" },
						},
					},
				],
			};

			// Try to load the original model file if it exists and merge with our enhanced one
			try {
				// First try the exact path
				let jsonString = await this.getResourceString(`models/${normalizedModelPath}.json`);

				// If not found and this is a level-specific model, try the base model
				if (!jsonString && levelMatch) {
					const baseModelPath = isWater ? "block/water" : "block/lava";
					jsonString = await this.getResourceString(`models/${baseModelPath}.json`);
				}

				if (jsonString) {
					const originalModel = JSON.parse(jsonString) as BlockModel;

					// Merge textures, keeping our specific ones if not overridden
					if (originalModel.textures) {
						Object.assign(liquidModel.textures || {}, originalModel.textures);
					}

					// If original model has elements but we're dealing with a level-specific variant,
					// don't use them since we need our custom height
					if (originalModel.elements && !levelMatch) {
						liquidModel.elements = originalModel.elements;
					}
				}
			} catch (error) {
				console.warn(`Error loading original liquid model: ${error}`);
			}

			// Cache and return the enhanced model
			this.modelCache.set(cacheKey, liquidModel);
			return liquidModel;
		}

		// For non-liquid models, load from resource pack
		const jsonString = await this.getResourceString(`models/${normalizedModelPath}.json`);
		if (!jsonString) {
			console.warn(`Model definition for ${normalizedModelPath} not found.`);
			return {} as BlockModel;
		}

		try {
			// Parse the model
			const model = JSON.parse(jsonString) as BlockModel;

			// If the model has a parent, we need to merge with it
			if (model.parent) {
				const mergedModel = await this.loadAndMergeModel(model);
				this.modelCache.set(cacheKey, mergedModel);
				return mergedModel;
			}

			this.modelCache.set(cacheKey, model);
			return model;
		} catch (error) {
			console.error(`Error parsing model for ${normalizedModelPath}:`, error);
			return {} as BlockModel;
		}
	}

	private async loadAndMergeModel(model: BlockModel): Promise<BlockModel> {
		if (!model.parent) return model;

		let currentModel = { ...model };
		let parentPath = model.parent;
		let depth = 0;
		const MAX_DEPTH = 5; // Prevent infinite loops

		while (parentPath && depth < MAX_DEPTH) {
			// Now try to load the model with the correct path
			const parentModelString = await this.getResourceString(`models/${parentPath}.json`);
			if (!parentModelString) {
				console.warn(`Parent model ${parentPath} not found`);
				break;
			}

			try {
				const parentModel = JSON.parse(parentModelString) as BlockModel;

				// Merge parent and child
				currentModel = {
					...parentModel,
					...currentModel,
					textures: {
						...parentModel.textures,
						...currentModel.textures,
					},
					// Use child elements if available, otherwise parent elements
					elements: currentModel.elements || parentModel.elements,
				};

				// Get next parent or end the loop
				parentPath = parentModel.parent || "";
				depth++;
			} catch (error) {
				console.error(`Error parsing parent model ${parentPath}:`, error);
				break;
			}
		}

		// Remove parent reference from final model
		delete currentModel.parent;

		return currentModel;
	}

	/**
	 * Resolve a texture reference in a model
	 */
	public resolveTexture(textureRef: string, model: BlockModel): string {
		if (!textureRef || textureRef === "#missing") {
			return "block/missing_texture";
		}

		// If not a reference, return as is (but handle namespace)
		if (!textureRef.startsWith("#")) {
			return normalizeResourceLocation(textureRef, {
				omitDefaultNamespace: true,
			});
		}

		// Handle reference resolution with depth limit
		const MAX_DEPTH = 5;
		let depth = 0;
		let ref = textureRef;

		while (ref.startsWith("#") && depth < MAX_DEPTH) {
			if (!model.textures) {
				console.warn(`Model has no textures defined for reference ${ref}.`);
				return "block/missing_texture";
			}

			const key = ref.substring(1);
			ref = model.textures[key] || ref;
			depth++;
		}

		if (depth >= MAX_DEPTH || ref.startsWith("#")) {
			console.warn(`Texture reference exceeded maximum depth: ${textureRef}`);
			return "block/missing_texture";
		}

		return normalizeResourceLocation(ref, {
			omitDefaultNamespace: true,
		});
	}

	/** Advance animated textures; returns true if any frame flipped (needs redraw). */
	public updateAnimations(): boolean {
		return this.animatedTextureManager.update();
	}

	public async getTexture(texturePath: string): Promise<THREE.Texture> {
		const normalizedTexturePath = normalizeResourceLocation(texturePath, {
			omitDefaultNamespace: true,
		});

		// Handle missing texture path
		if (
			!normalizedTexturePath ||
			normalizedTexturePath === "missing_texture" ||
			normalizedTexturePath === "block/missing_texture"
		) {
			console.warn("Missing texture path requested");
			return this.createMissingTexture();
		}

		// Check cache first
		const cacheKey = `texture:${normalizedTexturePath}`;
		if (this.textureCache.has(cacheKey)) {
			return this.textureCache.get(cacheKey)!;
		}

		// Check for animation
		const isAnimated = await this.animatedTextureManager.isAnimated(
			`textures/${normalizedTexturePath}`
		);

		if (isAnimated) {
			const animatedTexture =
				await this.animatedTextureManager.createAnimatedTexture(normalizedTexturePath);
			if (animatedTexture) {
				console.log(`Successfully created animated texture for ${normalizedTexturePath}`);
				this.textureCache.set(cacheKey, animatedTexture);
				return animatedTexture;
			} else {
				console.warn(
					`Failed to create animated texture for ${normalizedTexturePath}, falling back to static`
				);
			}
		}

		// If path doesn't end with .png, add it
		const fullPath = normalizedTexturePath.endsWith(".png")
			? normalizedTexturePath
			: `${normalizedTexturePath}.png`;

		// Load texture blob from resource pack
		const blob = await this.getResourceBlob(`textures/${fullPath}`);
		if (!blob) {
			console.warn(`Texture blob not found for ${normalizedTexturePath}`);

			// Special fallback for minecraft textures that might have different locations
			if (normalizedTexturePath.startsWith("block/")) {
				// Try without the "block/" prefix
				const altPath = normalizedTexturePath.replace("block/", "");
				const altBlob = await this.getResourceBlob(`textures/${altPath}.png`);
				if (altBlob) {
					// Continue with this blob
					return this.createTextureFromBlob(altBlob, cacheKey);
				}
			}

			console.error(`Texture ${normalizedTexturePath} not found, using missing texture`);
			return this.createMissingTexture();
		}

		return this.createTextureFromBlob(blob, cacheKey, normalizedTexturePath);
	}

	// Helper for creating a texture from a blob
	private async createTextureFromBlob(
		blob: Blob,
		cacheKey: string,
		texturePath: string = ""
	): Promise<THREE.Texture> {
		// Convert blob to data URL
		const url = URL.createObjectURL(blob);

		// Create texture
		try {
			const texture = await new Promise<THREE.Texture>((resolve, reject) => {
				this.textureLoader.load(
					url,
					(texture) => {
						// Configure texture
						texture.minFilter = THREE.NearestFilter;
						texture.magFilter = THREE.NearestFilter;
						texture.wrapS = THREE.RepeatWrapping;
						texture.wrapT = THREE.RepeatWrapping;

						URL.revokeObjectURL(url); // Clean up
						resolve(texture);
					},
					undefined,
					(error) => {
						URL.revokeObjectURL(url); // Clean up
						console.error(`Error loading texture ${texturePath}:`, error);
						reject(error);
					}
				);
			});

			this.textureCache.set(cacheKey, texture);

			return texture;
		} catch (error) {
			console.error(`Failed to load texture ${texturePath}:`, error);
			return this.createMissingTexture();
		}
	}

	public getTint(
		blockId: string,
		properties: Record<string, string>,
		biome: string = "plains",
		position?: THREE.Vector3
	): THREE.Color {
		return this.tintManager.getTint(blockId, properties, biome, position);
	}

	/** True when any animated texture is registered (drives continuous rendering). */
	public hasAnimatedTextures(): boolean {
		return this.animatedTextureManager.hasActiveTextures();
	}

	private colormapsLoaded = false;

	/**
	 * Load Minecraft's grass/foliage colormaps from the active resource pack and
	 * hand them to the TintManager so biome tints come from real colormap pixels.
	 * If the pack ships no colormaps the TintManager falls back to sane defaults.
	 * Guarded so it only decodes once per atlas (re)build.
	 */
	public async loadColormaps(): Promise<void> {
		if (this.colormapsLoaded) return;
		this.colormapsLoaded = true;

		const [grass, foliage] = await Promise.all([
			this.loadColormapImageData("colormap/grass"),
			this.loadColormapImageData("colormap/foliage"),
		]);
		this.tintManager.setColormaps(grass, foliage);
	}

	private async loadColormapImageData(texturePath: string): Promise<ImageData | null> {
		return this.getTexturePixels(texturePath);
	}

	/**
	 * Decode a resource-pack texture to raw RGBA pixels (top-left origin).
	 * Used by the sign renderer to read the sign-board and font textures so it can
	 * composite glyphs into an upscaled copy. `texturePath` is relative to
	 * `textures/` and without the `.png` extension (e.g. "entity/signs/oak",
	 * "font/ascii").
	 */
	public async getTexturePixels(texturePath: string): Promise<ImageData | null> {
		const blob = await this.getResourceBlob(`textures/${texturePath}.png`);
		if (!blob) return null;
		try {
			const bitmap = await createImageBitmap(blob);
			const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
			const ctx = canvas.getContext("2d");
			if (!ctx) return null;
			ctx.drawImage(bitmap, 0, 0);
			return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
		} catch (error) {
			console.warn(`Failed to decode texture ${texturePath}:`, error);
			return null;
		}
	}

	/**
	 * Analyze PNG texture transparency by examining alpha channel data
	 */
	public analyzeTextureTransparency(texture: THREE.Texture): {
		hasTransparency: boolean;
		transparencyType: "opaque" | "cutout" | "blend";
		averageAlpha: number;
		visibleAlpha: number; // Average alpha of only visible pixels
		opaquePixelCount: number;
		transparentPixelCount: number;
		semiTransparentPixelCount: number;
	} {
		const canvas = document.createElement("canvas");
		const ctx = canvas.getContext("2d");

		if (!ctx || !texture.image) {
			return {
				hasTransparency: false,
				transparencyType: "opaque",
				averageAlpha: 1.0,
				visibleAlpha: 1.0,
				opaquePixelCount: 0,
				transparentPixelCount: 0,
				semiTransparentPixelCount: 0,
			};
		}

		const image = texture.image as HTMLImageElement;
		canvas.width = image.width;
		canvas.height = image.height;
		ctx.drawImage(image, 0, 0);

		try {
			const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
			const data = imageData.data;

			let totalAlpha = 0;
			let visibleAlphaSum = 0;
			let transparentPixels = 0;
			let opaquePixels = 0;
			let semiTransparentPixels = 0;
			let visiblePixels = 0;
			let totalPixels = 0;

			// Analyze alpha values with better thresholds
			for (let i = 3; i < data.length; i += 4) {
				// Every 4th value is alpha
				const alpha = data[i] / 255;
				totalAlpha += alpha;
				totalPixels++;

				if (alpha < 0.01) {
					// Nearly fully transparent
					transparentPixels++;
				} else if (alpha > 0.99) {
					// Nearly fully opaque
					opaquePixels++;
					visibleAlphaSum += alpha;
					visiblePixels++;
				} else {
					// Semi-transparent
					semiTransparentPixels++;
					visibleAlphaSum += alpha;
					visiblePixels++;
				}
			}

			const averageAlpha = totalAlpha / totalPixels;
			const visibleAlpha = visiblePixels > 0 ? visibleAlphaSum / visiblePixels : 1.0;
			const hasTransparency = transparentPixels > 0 || semiTransparentPixels > 0;

			if (!hasTransparency) {
				console.log(`Opaque texture detected`);
				return {
					hasTransparency: false,
					transparencyType: "opaque",
					averageAlpha: 1.0,
					visibleAlpha: 1.0,
					opaquePixelCount: opaquePixels,
					transparentPixelCount: transparentPixels,
					semiTransparentPixelCount: semiTransparentPixels,
				};
			}

			// Better logic for determining transparency type
			const semiTransparentRatio = semiTransparentPixels / totalPixels;
			const transparentRatio = transparentPixels / totalPixels;

			let transparencyType: "cutout" | "blend";

			// If most pixels are either fully transparent or fully opaque, it's cutout
			if (
				semiTransparentRatio < 0.1 &&
				(transparentRatio > 0.1 || opaquePixels > totalPixels * 0.5)
			) {
				transparencyType = "cutout";
			} else {
				transparencyType = "blend";
			}

			console.log(`Texture transparency analysis: ${transparencyType}`);
			console.log(`  - Total pixels: ${totalPixels}`);
			console.log(
				`  - Transparent: ${transparentPixels} (${(transparentRatio * 100).toFixed(1)}%)`
			);
			console.log(
				`  - Semi-transparent: ${semiTransparentPixels} (${(semiTransparentRatio * 100).toFixed(
					1
				)}%)`
			);
			console.log(
				`  - Opaque: ${opaquePixels} (${((opaquePixels / totalPixels) * 100).toFixed(1)}%)`
			);
			console.log(`  - Average alpha: ${averageAlpha.toFixed(3)}`);
			console.log(`  - Visible alpha: ${visibleAlpha.toFixed(3)}`);

			return {
				hasTransparency: true,
				transparencyType,
				averageAlpha,
				visibleAlpha,
				opaquePixelCount: opaquePixels,
				transparentPixelCount: transparentPixels,
				semiTransparentPixelCount: semiTransparentPixels,
			};
		} catch (error) {
			console.warn("Could not analyze texture transparency:", error);
			return {
				hasTransparency: false,
				transparencyType: "opaque",
				averageAlpha: 1.0,
				visibleAlpha: 1.0,
				opaquePixelCount: 0,
				transparentPixelCount: 0,
				semiTransparentPixelCount: 0,
			};
		}
	}

	public getSharedAtlasTexture(): THREE.Texture | null {
		return this.textureAtlas; // Return the single shared instance
	}

	public async getMaterial(
		texturePath: string,
		options: {
			transparent?: boolean;
			tint?: THREE.Color;
			isLiquid?: boolean;
			isWater?: boolean;
			isLava?: boolean;
			isFlowing?: boolean;
			faceDirection?: string;
			forceAnimation?: boolean;
			alphaTest?: number;
			opacity?: number;
			biome?: string;
			useAtlas?: boolean;
		} = {}
	): Promise<THREE.Material> {
		const useAtlas = options.useAtlas ?? true;
		const normalizedTexturePath = normalizeResourceLocation(texturePath, {
			omitDefaultNamespace: true,
		});

		// Create cache key
		const cacheKey = `material:${normalizedTexturePath}:${useAtlas ? "atlas" : "individual"}:${JSON.stringify(
			{
				transparent: options.transparent,
				isLiquid: options.isLiquid,
				isWater: options.isWater,
				isLava: options.isLava,
				faceDirection: options.faceDirection,
				alphaTest: options.alphaTest,
				opacity: options.opacity,
				tint: options.tint?.getHexString(),
			}
		)}`;

		// Return cached material (shared instance)
		if (this.materialCache.has(cacheKey)) {
			return this.materialCache.get(cacheKey)!;
		}

		// Handle special paths for liquids.
		// A still water/lava source uses the *_still texture on every face — only
		// genuinely flowing liquid (options.isFlowing) uses the *_flow texture on
		// its sides. Previously every non-`up` face was forced to *_flow, so the
		// side faces showed the flow texture, which in many resource packs lacks an
		// .mcmeta and therefore never animated while the still top did.
		let finalTexturePath = normalizedTexturePath;
		if (options.isWater) {
			finalTexturePath =
				options.isFlowing && options.faceDirection !== "up"
					? "block/water_flow"
					: "block/water_still";
		} else if (options.isLava) {
			finalTexturePath =
				options.isFlowing && options.faceDirection !== "up"
					? "block/lava_flow"
					: "block/lava_still";
		}

		let texture: THREE.Texture;
		let atlasUVData: {
			u: number;
			v: number;
			width: number;
			height: number;
		} | null = null;
		let usingAtlas = false;

		// Any texture with an .mcmeta sidecar is animated (kelp, seagrass, sea
		// lanterns, magma, prismarine, …) — not just liquids. Liquids are always
		// treated as animated. Animated textures need per-frame UV offsets, so they
		// can't share the static atlas and must render as individual scrolling
		// textures. Non-animated textures still fall through to the atlas below so
		// batching is preserved.
		const isAnimated =
			options.isLiquid ||
			options.forceAnimation ||
			(await this.animatedTextureManager.isAnimated(`textures/${finalTexturePath}`));

		if (isAnimated) {
			const animatedTexture =
				await this.animatedTextureManager.createAnimatedTexture(finalTexturePath);
			texture = animatedTexture || (await this.getTexture(finalTexturePath));
			usingAtlas = false;
		} else if (useAtlas && this.textureAtlas) {
			// Use shared atlas texture
			texture = this.getSharedAtlasTexture()!;

			// Get UV coordinates for this texture within the atlas
			atlasUVData = this.getTextureUV(finalTexturePath);

			if (!atlasUVData) {
				// Try variations
				const variations = [
					normalizeResourceLocation(finalTexturePath, {
						omitDefaultNamespace: true,
					}),
					`block/${finalTexturePath.replace("block/", "")}`,
					normalizeResourceLocation(texturePath, {
						omitDefaultNamespace: true,
					}),
					`block/${normalizedTexturePath.replace("block/", "")}`,
					finalTexturePath.split("/").pop()
						? `block/${finalTexturePath.split("/").pop()}`
						: finalTexturePath,
					texturePath.split("/").pop() ? `block/${texturePath.split("/").pop()}` : texturePath,
				];

				for (const variation of variations) {
					atlasUVData = this.getTextureUV(variation);
					if (atlasUVData) break;
				}
			}

			if (!atlasUVData) {
				texture = await this.getTexture(finalTexturePath);
				usingAtlas = false;
			} else {
				usingAtlas = true;
			}
		} else {
			// Use individual texture
			texture = await this.getTexture(finalTexturePath);
			usingAtlas = false;
		}

		// Create material
		const materialOptions: any = {
			map: texture,
			transparent: options.transparent ?? true,
			alphaTest: options.alphaTest ?? 0.01,
			side: THREE.FrontSide,
		};

		if (options.opacity !== undefined) {
			materialOptions.opacity = options.opacity;
		}

		// Handle liquid-specific properties
		if (options.isLiquid) {
			materialOptions.transparent = true;
			materialOptions.depthWrite = false;
			materialOptions.side = THREE.FrontSide;

			if (options.isWater) {
				materialOptions.opacity = 0.8;
			} else if (options.isLava) {
				materialOptions.opacity = 0.9;
				materialOptions.emissive = new THREE.Color(0x331100);
			}
		}

		const material = new THREE.MeshStandardMaterial(materialOptions);

		// Store atlas UV data in userData
		if (usingAtlas && atlasUVData) {
			material.userData.atlasUV = atlasUVData;
			material.userData.useAtlas = true;
			material.userData.texturePath = finalTexturePath;
		} else {
			material.userData.useAtlas = false;
			material.userData.texturePath = finalTexturePath;
		}

		// Apply tinting
		if (options.tint) {
			if (usingAtlas) {
				material.userData.tint = options.tint;
			}
			material.color = options.tint;
		}

		// Liquid-specific userData
		if (options.isWater) {
			material.userData.isWater = true;
			material.userData.faceDirection = options.faceDirection;
			material.userData.renderToWaterPass = true;
		}

		if (options.isLava) {
			material.userData.isLava = true;
			material.userData.faceDirection = options.faceDirection;
			material.userData.renderToLavaPass = true;
			material.userData.lavaAnimationParams = {
				pulseSpeed: 0.4,
				pulseMin: 0.4,
				pulseMax: 0.6,
			};
		}

		if (options.isLiquid) {
			material.userData.isLiquid = true;
		}

		if (options.biome) {
			material.userData.biome = options.biome;
		}

		// Cache and return the same instance (no cloning)
		this.materialCache.set(cacheKey, material);
		return material;
	}

	public async buildTextureAtlas(): Promise<THREE.Texture> {
		// Colormaps are independent of the atlas; load them before the early-return
		// so biome tints are available even when the atlas is served from cache.
		await this.loadColormaps();

		if (this.textureAtlas) return this.textureAtlas;

		// Try to load from cache first if caching is enabled
		if (this.cacheEnabled && this.resourcePackHash) {
			const atlasBuilder = new AtlasBuilder(2048, 1);

			// Try cache with empty texture array first (just to check cache)
			try {
				const cacheResult = await atlasBuilder.buildAtlas([], this.resourcePackHash);
				if (cacheResult.fromCache) {
					console.log(
						`🎯 Atlas loaded from cache with ${cacheResult.packingEfficiency.toFixed(
							1
						)}% efficiency`
					);

					// Create THREE.js texture from cached atlas
					const atlasTexture = new THREE.CanvasTexture(cacheResult.atlas);
					atlasTexture.minFilter = THREE.NearestFilter;
					atlasTexture.magFilter = THREE.NearestFilter;
					atlasTexture.wrapS = THREE.RepeatWrapping;
					atlasTexture.wrapT = THREE.RepeatWrapping;
					atlasTexture.needsUpdate = true;

					// Store the atlas and UV mapping
					this.textureAtlas = atlasTexture;
					this.textureUVMap = cacheResult.uvMap;

					console.log(`📊 Loaded ${cacheResult.uvMap.size} textures from cache`);
					return atlasTexture;
				}
			} catch (error) {
				console.log("📦 No cache found, building atlas...");
			}
		}

		console.log("🚀 Building texture atlas...");
		const startTime = performance.now();

		// Simple whitelist - just add paths you want to include
		const allowedPaths = [
			"block/",
			// 'item/',      // Uncomment to include items
			// 'entity/',    // Uncomment to include entities
			// 'gui/',       // Uncomment to include GUI
		];

		// Collect whitelisted textures only
		const allTextures = new Set<string>();
		let totalFound = 0;

		for (const { zip } of this.getOrderedPacks()) {
			const files = Object.keys(zip.files)
				.filter((path) => !zip.files[path].dir)
				.map((path) => packAssetFromFilePath(path))
				.filter((asset): asset is NonNullable<typeof asset> => !!asset && asset.type === "texture");

			for (const file of files) {
				const texturePath = formatPackAssetReference(file);

				totalFound++;

				// Check if texture path starts with any allowed path
				if (allowedPaths.some((allowed) => file.path.startsWith(allowed))) {
					allTextures.add(texturePath);
				}
			}
		}

		const texturePaths = Array.from(allTextures);
		console.log(`🖼️ Found ${totalFound} total textures, using ${texturePaths.length} whitelisted`);

		// OPTIMIZED: Parallel texture loading with batching and ImageBitmap
		const textures: { path: string; image: ImageBitmap }[] = [];
		const BATCH_SIZE = 50; // Load 50 textures concurrently
		let loadedCount = 0;

		// Process textures in parallel batches
		for (let i = 0; i < texturePaths.length; i += BATCH_SIZE) {
			const batch = texturePaths.slice(i, i + BATCH_SIZE);

			const batchResults = await Promise.all(
				batch.map(async (path) => {
					try {
						const blob = await this.getResourceBlob(`textures/${path}.png`);
						if (!blob) return null;

						// Use createImageBitmap for faster decoding (off main thread)
						const imageBitmap = await createImageBitmap(blob);
						return { path, image: imageBitmap };
					} catch (e) {
						// Silent fail for missing textures
						return null;
					}
				})
			);

			// Filter out nulls and add to textures
			for (const result of batchResults) {
				if (result) {
					textures.push(result);
					loadedCount++;
				}
			}

			if (loadedCount > 0 && (i + BATCH_SIZE) % 200 === 0) {
				console.log(`📈 Loaded ${loadedCount}/${texturePaths.length} textures`);
			}
		}

		const loadTime = performance.now() - startTime;
		console.log(`⚡ Loaded ${textures.length} textures in ${loadTime.toFixed(0)}ms`);

		// Build atlas using the AtlasBuilder with caching
		const atlasBuilder = new AtlasBuilder(2048, 1);
		const cacheKey = this.cacheEnabled ? this.resourcePackHash : undefined;

		const { atlas, uvMap, packingEfficiency } = await atlasBuilder.buildAtlas(textures, cacheKey);

		console.log(`✅ Atlas built with ${packingEfficiency.toFixed(1)}% efficiency`);
		console.log(`📊 Packed ${uvMap.size} textures into ${atlas.width}x${atlas.height} atlas`);

		// Create THREE.js texture
		const atlasTexture = new THREE.CanvasTexture(atlas);
		atlasTexture.minFilter = THREE.NearestFilter;
		atlasTexture.magFilter = THREE.NearestFilter;
		atlasTexture.wrapS = THREE.RepeatWrapping;
		atlasTexture.wrapT = THREE.RepeatWrapping;
		atlasTexture.needsUpdate = true;

		// Store the atlas and UV mapping
		this.textureAtlas = atlasTexture;
		this.textureUVMap = uvMap;
		return atlasTexture;
	}

	/**
	 * Cache management methods
	 */
	public enableCache(): void {
		this.cacheEnabled = true;
		console.log("🔧 Atlas caching enabled");
	}

	public disableCache(): void {
		this.cacheEnabled = false;
		console.log("🔧 Atlas caching disabled");
	}

	public async clearAtlasCache(): Promise<void> {
		await AtlasBuilder.clearAllCaches();
		console.log("🗑️ All atlas caches cleared");
	}

	public async getCacheInfo(): Promise<
		{
			key: string;
			size: string;
			age: string;
			textureCount: number;
			storage: string;
		}[]
	> {
		return AtlasBuilder.getCacheInfo();
	}

	public invalidateCache(): void {
		if (this.resourcePackHash) {
			localStorage.removeItem(`atlas_${this.resourcePackHash}`);
			console.log(`🔄 Cache invalidated for current resource pack`);
		}
	}

	/**
	 * Force rebuild atlas (ignores cache)
	 */
	public async rebuildTextureAtlas(): Promise<THREE.Texture> {
		// Clear current atlas
		this.textureAtlas = null;
		this.textureUVMap.clear();

		// Temporarily disable cache
		const wasCacheEnabled = this.cacheEnabled;
		this.cacheEnabled = false;

		try {
			const result = await this.buildTextureAtlas();
			console.log("🔄 Atlas rebuilt from scratch");
			return result;
		} finally {
			// Restore cache setting
			this.cacheEnabled = wasCacheEnabled;
		}
	}

	/**
	 * List all blockstate files in the resource pack
	 */
	public async listBlockstates(): Promise<string[]> {
		const blockstatesSet = new Set<string>();

		for (const { zip } of this.getOrderedPacks()) {
			const files = Object.keys(zip.files)
				.filter((path) => !zip.files[path].dir)
				.map((path) => packAssetFromFilePath(path))
				.filter(
					(asset): asset is NonNullable<typeof asset> => !!asset && asset.type === "blockstate"
				);

			for (const file of files) {
				blockstatesSet.add(
					formatPackAssetReference(file, {
						omitDefaultNamespace: false,
					})
				);
			}
		}

		return Array.from(blockstatesSet);
	}

	public getTextureAtlas(): THREE.Texture | null {
		return this.textureAtlas;
	}

	public getTextureUV(
		path: string
	): { u: number; v: number; width: number; height: number } | null {
		const normalizedPath = normalizeResourceLocation(path, {
			omitDefaultNamespace: true,
		});

		return this.textureUVMap.get(normalizedPath) || this.textureUVMap.get(path) || null;
	}

	public async getEntityTexture(entityName: string): Promise<THREE.Texture> {
		// Specialized texture paths for known entity types
		let texturePaths: string[] = [];

		if (entityName === "chest") {
			texturePaths = [
				"entity/chest/normal",
				"entity/chest",
				"entity/chest/chest",
				"entity/chest/single",
			];
		} else if (entityName === "ender_chest") {
			texturePaths = ["entity/chest/ender", "entity/chest/ender_chest"];
		} else if (entityName === "trapped_chest") {
			texturePaths = ["entity/chest/trapped", "entity/chest/trapped_chest"];
		} else {
			// Default paths for other entity types
			texturePaths = [
				`entity/${entityName}`,
				`entity/${entityName}/${entityName}`,
				`entity/${entityName}/model`,
			];
		}

		// Try each possible path
		for (const path of texturePaths) {
			try {
				const texture = await this.getTexture(path);
				if (texture) {
					return texture;
				}
			} catch (error) {}
		}

		// If we reach here, all paths failed
		console.warn(
			`Entity texture not found for ${entityName}. Tried paths: ${texturePaths.join(", ")}`
		);
		return this.createMissingTexture();
	}

	private createMissingTexture(): THREE.Texture {
		// Create a purple/black checkerboard for missing textures
		const size = 16;

		// Create a data array for pixels
		const data = new Uint8Array(size * size * 4);

		// Fill with magenta
		for (let i = 0; i < size * size; i++) {
			data[i * 4] = 255; // R
			data[i * 4 + 1] = 0; // G
			data[i * 4 + 2] = 255; // B
			data[i * 4 + 3] = 255; // A
		}

		// Add black checkerboard pattern
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				if ((x < size / 2 && y < size / 2) || (x >= size / 2 && y >= size / 2)) {
					const i = (y * size + x) * 4;
					data[i] = 0; // R
					data[i + 1] = 0; // G
					data[i + 2] = 0; // B
					data[i + 3] = 255; // A
				}
			}
		}

		// Create texture directly from pixel data
		const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);

		texture.needsUpdate = true;
		texture.minFilter = THREE.NearestFilter;
		texture.magFilter = THREE.NearestFilter;

		return texture;
	}

	/**
	 * Clean up resources
	 */
	public dispose(): void {
		// Dispose of all textures
		this.textureCache.forEach((texture) => texture.dispose());
		this.textureCache.clear();

		// Dispose of all materials
		this.materialCache.forEach((material) => material.dispose());
		this.materialCache.clear();

		// Clear other caches
		this.blockStateCache.clear();
		this.modelCache.clear();
		this.stringCache.clear();

		// Clear resource packs
		this.resourcePacks.clear();
		this.resourcePackOrder = [];

		// Reset cache hash
		this.resourcePackHash = "";

		console.log("AssetLoader disposed");
	}
}

import * as THREE from "three";

// Sane fallback tints (vanilla plains colours) for when a resource pack ships
// no colormap textures.
const DEFAULT_GRASS = new THREE.Color(0x91bd59);
const DEFAULT_FOLIAGE = new THREE.Color(0x77ab2f);
const DEFAULT_DRY_FOLIAGE = new THREE.Color(0x5c3c32);
const DEFAULT_WATER = new THREE.Color(0x3f76e4);

// A few leaf types use a fixed colour in vanilla rather than a biome sample.
const FIXED_FOLIAGE: Record<string, number> = {
	spruce: 0x619961,
	birch: 0x80a755,
};

// Biome climate points (temperature, downfall) used to index the colormaps.
// Schematics carry no biome data, so unknown biomes fall back to plains.
const BIOME_CLIMATE: Record<string, { temperature: number; downfall: number }> = {
	plains: { temperature: 0.8, downfall: 0.4 },
	forest: { temperature: 0.7, downfall: 0.8 },
	swamp: { temperature: 0.8, downfall: 0.9 },
	jungle: { temperature: 0.95, downfall: 0.9 },
	taiga: { temperature: 0.25, downfall: 0.8 },
	savanna: { temperature: 1.2, downfall: 0.0 },
	desert: { temperature: 2.0, downfall: 0.0 },
	badlands: { temperature: 2.0, downfall: 0.0 },
};

export class TintManager {
	// Map of block IDs to their tint types
	private tintableBlocks: Map<string, string> = new Map();

	// Minecraft grass/foliage colormaps (256×256), null until a pack supplies them.
	private grassColormap: ImageData | null = null;
	private foliageColormap: ImageData | null = null;
	private dryFoliageColormap: ImageData | null = null;

	// Register built-in tintable blocks
	constructor() {
		// Redstone
		this.tintableBlocks.set("minecraft:redstone_wire", "redstone");

		// Foliage
		this.tintableBlocks.set("minecraft:grass_block", "foliage");
		this.tintableBlocks.set("minecraft:oak_leaves", "foliage");
		this.tintableBlocks.set("minecraft:vine", "foliage");
		this.tintableBlocks.set("minecraft:birch_leaves", "foliage");
		this.tintableBlocks.set("minecraft:spruce_leaves", "foliage");
		this.tintableBlocks.set("minecraft:jungle_leaves", "foliage");
		this.tintableBlocks.set("minecraft:acacia_leaves", "foliage");
		this.tintableBlocks.set("minecraft:dark_oak_leaves", "foliage");
		this.tintableBlocks.set("minecraft:azalea_leaves", "foliage");
		this.tintableBlocks.set("minecraft:flowering_azalea_leaves", "foliage");
		this.tintableBlocks.set("minecraft:oak_sapling", "foliage");
		this.tintableBlocks.set("minecraft:birch_sapling", "foliage");
		this.tintableBlocks.set("minecraft:spruce_sapling", "foliage");
		this.tintableBlocks.set("minecraft:jungle_sapling", "foliage");
		this.tintableBlocks.set("minecraft:acacia_sapling", "foliage");
		this.tintableBlocks.set("minecraft:lily_pad", "foliage");
		// Grass-type plants (tinted via the grass colormap). Includes the modern
		// `short_grass` id (1.20.3+) alongside the legacy `grass` id.
		this.tintableBlocks.set("minecraft:grass", "foliage");
		this.tintableBlocks.set("minecraft:short_grass", "foliage");
		this.tintableBlocks.set("minecraft:fern", "foliage");
		this.tintableBlocks.set("minecraft:tall_grass", "foliage");
		this.tintableBlocks.set("minecraft:large_fern", "foliage");
		this.tintableBlocks.set("minecraft:potted_fern", "foliage");
		// ...more foliage blocks

		// Water
		this.tintableBlocks.set("minecraft:water", "water");
		this.tintableBlocks.set("minecraft:flowing_water", "water");

		// Stems
		this.tintableBlocks.set("minecraft:pumpkin_stem", "stem");
		this.tintableBlocks.set("minecraft:melon_stem", "stem");
	}

	isTintable(blockId: string): boolean {
		return this.getTintType(blockId) !== null;
	}

	getTintType(blockId: string): string | null {
		return (
			this.tintableBlocks.get(blockId) ||
			(blockId === "minecraft:leaf_litter"
				? "dry_foliage"
				: blockId !== "minecraft:dead_bush" && /(?::bush|_bush|_leaves)$/.test(blockId)
					? "foliage"
					: null)
		);
	}

	// Calculate tint color based on block type and properties
	getTint(
		blockId: string,
		properties: Record<string, string>,
		biome: string = "plains",
		_position?: THREE.Vector3
	): THREE.Color {
		const tintType = this.getTintType(blockId);

		switch (tintType) {
			case "redstone":
				return this.getRedstoneTint(properties.power || "0");
			case "foliage":
				return this.getFoliageTint(blockId, biome);
			case "dry_foliage":
				return this.getDryFoliageTint(biome);
			case "water":
				return this.getWaterTint(biome);
			case "stem":
				return this.getStemTint(properties.age || "0");
			default:
				return new THREE.Color(0xffffff); // Default: no tint
		}
	}

	// Specific tint calculators
	private getRedstoneTint(power: string): THREE.Color {
		const powerLevel = parseInt(power, 10);
		// Calculate brightness based on power level (0-15)
		// Minimum brightness at power 0 (darker red)
		const brightness = 0.3 + (powerLevel / 15) * 0.7;
		return new THREE.Color(brightness, 0.0, 0.0);
	}

	/**
	 * Supply the decoded grass/foliage colormaps (or null to clear). Called by the
	 * AssetLoader once textures are available.
	 */
	public setColormaps(
		grass: ImageData | null,
		foliage: ImageData | null,
		dryFoliage: ImageData | null = null
	): void {
		this.grassColormap = grass;
		this.foliageColormap = foliage;
		this.dryFoliageColormap = dryFoliage;
	}

	/**
	 * Sample a Minecraft colormap at the biome's climate point. The colormaps are
	 * a triangular gradient indexed by adjusted temperature/downfall. Returns the
	 * fallback colour when no colormap is loaded.
	 */
	private sampleColormap(
		colormap: ImageData | null,
		biome: string,
		fallback: THREE.Color
	): THREE.Color {
		if (!colormap) return fallback;

		const climate = BIOME_CLIMATE[biome] || BIOME_CLIMATE.plains;
		const temperature = Math.max(0, Math.min(1, climate.temperature));
		const downfall = Math.max(0, Math.min(1, climate.downfall)) * temperature;

		const x = Math.floor((1 - temperature) * (colormap.width - 1));
		const y = Math.floor((1 - downfall) * (colormap.height - 1));
		const i = (y * colormap.width + x) * 4;

		const data = colormap.data;
		if (i < 0 || i + 2 >= data.length) return fallback;
		return new THREE.Color(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
	}

	private getFoliageTint(blockId: string, biome: string = "plains"): THREE.Color {
		// Some leaves use a fixed vanilla colour regardless of biome.
		for (const key in FIXED_FOLIAGE) {
			if (blockId.includes(key)) {
				return new THREE.Color(FIXED_FOLIAGE[key]);
			}
		}

		// Grass-like blocks use the grass colormap; leaves/vines use foliage.
		const isLeafLike = blockId.includes("leaves") || blockId.includes("vine");
		if (isLeafLike) {
			return this.sampleColormap(this.foliageColormap, biome, DEFAULT_FOLIAGE);
		}
		return this.sampleColormap(this.grassColormap, biome, DEFAULT_GRASS);
	}

	private getWaterTint(_biome: string = "plains"): THREE.Color {
		// Vanilla water tint is a per-biome constant (no gradient colormap). Most
		// biomes share the default; use it for all until per-biome water is needed.
		return DEFAULT_WATER.clone();
	}

	private getDryFoliageTint(biome: string = "plains"): THREE.Color {
		return this.sampleColormap(this.dryFoliageColormap, biome, DEFAULT_DRY_FOLIAGE);
	}

	private getStemTint(age: string): THREE.Color {
		const ageLevel = parseInt(age, 10);
		// Stems gradually change from green to yellow/orange as they grow
		const green = 0.8 - (ageLevel / 7) * 0.6;
		const red = 0.2 + (ageLevel / 7) * 0.6;
		return new THREE.Color(red, green, 0.0);
	}
}

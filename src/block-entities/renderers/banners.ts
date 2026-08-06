import {
	BufferGeometry,
	CanvasTexture,
	DoubleSide,
	Group,
	InstancedMesh,
	LinearSRGBColorSpace,
	Matrix4,
	MeshLambertMaterial,
	NearestFilter,
	Quaternion,
	StaticDrawUsage,
	Texture,
	Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import { asRecord, parseSchematicPosition } from "../snapshot.js";
import type {
	BlockState,
	BlockEntityResources,
	BlockEntitySchematic,
	IndexedBlockEntity,
	SchematicBlockEntitySnapshot,
	SchematicBlockEntityWrapper,
	SchematicPosition,
	UnknownRecord,
} from "../snapshot.js";

export const BANNER_ENTITY_MODEL = "banner";
export const BANNER_BASE_TEXTURE = "entity/banner/banner_base";
export const BANNER_BASE_PATTERN_TEXTURE = "entity/banner/base";

export const MAX_BANNER_BLOCKS_INSPECTED = 750_000;
export const MAX_BANNER_PALETTE_ENTRIES_INSPECTED = 65_536;
export const MAX_BANNER_ENTITIES_INSPECTED = 2_048;
export const MAX_BANNER_INSTANCES = 512;
export const MAX_BANNER_PATTERNS = 16;
export const MAX_BANNER_APPEARANCES = 128;

export const BANNER_DYE_COLOR_NAMES = [
	"white",
	"orange",
	"magenta",
	"light_blue",
	"yellow",
	"lime",
	"pink",
	"gray",
	"light_gray",
	"cyan",
	"purple",
	"blue",
	"brown",
	"green",
	"red",
	"black",
] as const;

const BANNER_BLOCK_IDS = [
	...BANNER_DYE_COLOR_NAMES.flatMap((color) => [
		`minecraft:${color}_banner`,
		`minecraft:${color}_wall_banner`,
	]),
	"minecraft:banner",
	"minecraft:standing_banner",
	"minecraft:wall_banner",
] as const;

/**
 * Minecraft 26.2 DyeColor#getTextureDiffuseColor RGB values. Banner masks are
 * multiplied by these colors, rather than replaced with flat color, so their
 * woven light/dark detail remains visible.
 */
export const BANNER_DYE_COLORS = {
	white: 0xf9fffe,
	orange: 0xf9801d,
	magenta: 0xc74ebd,
	light_blue: 0x3ab3da,
	yellow: 0xfed83d,
	lime: 0x80c71f,
	pink: 0xf38baa,
	gray: 0x474f52,
	light_gray: 0x9d9d97,
	cyan: 0x169c9c,
	purple: 0x8932b8,
	blue: 0x3c44aa,
	brown: 0x835432,
	green: 0x5e7c16,
	red: 0xb02e26,
	black: 0x1d1d21,
} as const;

export const BANNER_PATTERN_NAMES = [
	"base",
	"border",
	"bricks",
	"circle",
	"creeper",
	"cross",
	"curly_border",
	"diagonal_left",
	"diagonal_right",
	"diagonal_up_left",
	"diagonal_up_right",
	"flow",
	"flower",
	"globe",
	"gradient",
	"gradient_up",
	"guster",
	"half_horizontal",
	"half_horizontal_bottom",
	"half_vertical",
	"half_vertical_right",
	"mojang",
	"piglin",
	"rhombus",
	"skull",
	"small_stripes",
	"square_bottom_left",
	"square_bottom_right",
	"square_top_left",
	"square_top_right",
	"straight_cross",
	"stripe_bottom",
	"stripe_center",
	"stripe_downleft",
	"stripe_downright",
	"stripe_left",
	"stripe_middle",
	"stripe_right",
	"stripe_top",
	"triangle_bottom",
	"triangle_top",
	"triangles_bottom",
	"triangles_top",
] as const;

export type BannerDyeColor = (typeof BANNER_DYE_COLOR_NAMES)[number];
export type BannerPatternName = (typeof BANNER_PATTERN_NAMES)[number];
export type BannerAttachment = "standing" | "wall";

export type BannerPatternLayer = {
	pattern: BannerPatternName;
	color: BannerDyeColor;
};

export type BannerSelection = {
	position: SchematicPosition;
	attachment: BannerAttachment;
	rotationY: number;
	baseColor: BannerDyeColor;
	patterns: readonly BannerPatternLayer[];
};

export type BannerOverlay = {
	count: number;
	dispose: () => void;
};

export type BannerPixelLayer = {
	pixels: Uint8ClampedArray;
	color: number;
};

export type BannerModelGeometries = {
	standingWood: BufferGeometry;
	standingFlag: BufferGeometry;
	wallWood: BufferGeometry;
	wallFlag: BufferGeometry;
};

type ParsedBannerState = {
	attachment: BannerAttachment;
	baseColor: BannerDyeColor | null;
	state: BlockState;
};

type ParsedBannerEntity = {
	position: SchematicPosition;
	baseColor: BannerDyeColor | null;
	patterns: BannerPatternLayer[];
	hasPatternData: boolean;
};

type BannerAppearanceGroup = {
	key: string;
	baseColor: BannerDyeColor;
	patterns: readonly BannerPatternLayer[];
	banners: BannerSelection[];
};

const BANNER_PATTERN_SET = new Set<string>(BANNER_PATTERN_NAMES);
const BANNER_DYE_COLOR_SET = new Set<string>(BANNER_DYE_COLOR_NAMES);
const BANNER_TEXTURE_SIZE = 64;
const BANNER_MODEL_SCALE = 2 / 3;
const BANNER_MODEL_Y_OFFSET = -0.5;

// Cubane's embedded GLB is the standing model. These unscaled translations
// reproduce BannerModel.createBodyLayer(false) and
// BannerFlagModel.createFlagLayer(false) for wall banners.
const WALL_MODEL_Y_OFFSET = -47 / 32;
const WALL_BAR_Z_OFFSET = 21 / 32;
const WALL_FLAG_Z_OFFSET = 25 / 32;

const LEGACY_PATTERN_NAMES: Readonly<Record<string, BannerPatternName>> = {
	b: "base",
	bl: "square_bottom_left",
	br: "square_bottom_right",
	tl: "square_top_left",
	tr: "square_top_right",
	bs: "stripe_bottom",
	ts: "stripe_top",
	ls: "stripe_left",
	rs: "stripe_right",
	cs: "stripe_center",
	ms: "stripe_middle",
	drs: "stripe_downright",
	dls: "stripe_downleft",
	ss: "small_stripes",
	cr: "cross",
	sc: "straight_cross",
	ld: "diagonal_left",
	rud: "diagonal_up_right",
	lud: "diagonal_up_left",
	rd: "diagonal_right",
	vh: "half_vertical",
	vhr: "half_vertical_right",
	hh: "half_horizontal",
	hhb: "half_horizontal_bottom",
	bt: "triangle_bottom",
	tt: "triangle_top",
	bts: "triangles_bottom",
	tts: "triangles_top",
	mc: "circle",
	mr: "rhombus",
	bo: "border",
	cbo: "curly_border",
	bri: "bricks",
	gra: "gradient",
	gru: "gradient_up",
	cre: "creeper",
	sku: "skull",
	flo: "flower",
	moj: "mojang",
	glb: "globe",
	pig: "piglin",
};

const MODERN_PATTERN_ALIASES: Readonly<Record<string, BannerPatternName>> = {
	bordure_indented: "curly_border",
	field_masoned: "bricks",
	stripe_down_left: "stripe_downleft",
	stripe_down_right: "stripe_downright",
};

function firstDefined(record: Readonly<Record<string, unknown>>, keys: readonly string[]): unknown {
	for (const key of keys) {
		if (record[key] !== undefined) return record[key];
	}
	return undefined;
}

function firstRecord(
	record: Readonly<Record<string, unknown>>,
	keys: readonly string[]
): UnknownRecord | null {
	return asRecord(firstDefined(record, keys));
}

function bannerTexturePath(pattern: BannerPatternName) {
	return `entity/banner/${pattern}`;
}

export function resolveBannerDyeColor(value: unknown): BannerDyeColor | null {
	if (typeof value === "number") {
		return Number.isInteger(value) && value >= 0 && value < BANNER_DYE_COLOR_NAMES.length
			? (BANNER_DYE_COLOR_NAMES[value] ?? null)
			: null;
	}
	if (typeof value !== "string") return null;

	const normalized = value.toLowerCase().replace(/^minecraft:/, "");
	if (/^\d{1,2}$/.test(normalized)) {
		return resolveBannerDyeColor(Number(normalized));
	}
	if (normalized === "silver") return "light_gray";
	return BANNER_DYE_COLOR_SET.has(normalized) ? (normalized as BannerDyeColor) : null;
}

export function normalizeBannerPatternName(value: unknown): BannerPatternName | null {
	if (typeof value !== "string") return null;
	const lower = value.toLowerCase();
	const namespaceSeparator = lower.indexOf(":");
	if (namespaceSeparator >= 0 && lower.slice(0, namespaceSeparator) !== "minecraft") {
		return null;
	}
	const name = lower.slice(namespaceSeparator + 1);
	const aliased = LEGACY_PATTERN_NAMES[name] ?? MODERN_PATTERN_ALIASES[name] ?? name;
	return BANNER_PATTERN_SET.has(aliased) ? (aliased as BannerPatternName) : null;
}

export function parseBannerPatternLayer(value: unknown): BannerPatternLayer | null {
	const layer = asRecord(value);
	if (layer === null) return null;
	const pattern = normalizeBannerPatternName(firstDefined(layer, ["pattern", "Pattern"]));
	const color = resolveBannerDyeColor(firstDefined(layer, ["color", "Color"]));
	return pattern === null || color === null ? null : { pattern, color };
}

/**
 * Accepts modern `{pattern:"minecraft:...",color:"red"}` layers and legacy
 * `{Pattern:"bs",Color:14}` layers. Invalid/custom entries are skipped while
 * valid layers retain their saved order.
 */
export function parseBannerPatternLayers(value: unknown): BannerPatternLayer[] {
	if (!Array.isArray(value)) return [];
	const layers: BannerPatternLayer[] = [];
	const inspected = Math.min(value.length, MAX_BANNER_PATTERNS);
	for (let index = 0; index < inspected; index += 1) {
		const layer = parseBannerPatternLayer(value[index]);
		if (layer !== null) layers.push(layer);
	}
	return layers;
}

export function resolveBannerBlockState(state: BlockState): ParsedBannerState | null {
	const prefix = "minecraft:";
	const wallSuffix = "_wall_banner";
	const standingSuffix = "_banner";
	if (state.name.startsWith(prefix) && state.name.endsWith(wallSuffix)) {
		const baseColor = resolveBannerDyeColor(state.name.slice(prefix.length, -wallSuffix.length));
		if (baseColor !== null) {
			return {
				attachment: "wall",
				baseColor,
				state,
			};
		}
	} else if (state.name.startsWith(prefix) && state.name.endsWith(standingSuffix)) {
		const baseColor = resolveBannerDyeColor(
			state.name.slice(prefix.length, -standingSuffix.length)
		);
		if (baseColor !== null) {
			return {
				attachment: "standing",
				baseColor,
				state,
			};
		}
	}

	// Retain bounded compatibility for old converted Sponge/MCEdit palettes.
	switch (state.name) {
		case "minecraft:banner":
		case "minecraft:standing_banner":
			return {
				attachment: "standing",
				baseColor: null,
				state,
			};
		case "minecraft:wall_banner":
			return { attachment: "wall", baseColor: null, state };
		default:
			return null;
	}
}

export function resolveBannerRotation(
	attachment: BannerAttachment,
	properties: Readonly<Record<string, string>>
): number | null {
	if (attachment === "standing") {
		const rotation = Number(properties.rotation ?? "0");
		return Number.isInteger(rotation) && rotation >= 0 && rotation <= 15
			? (-rotation * Math.PI) / 8
			: null;
	}

	// BannerRenderer rotates by -Direction.toYRot(). The source wall geometry
	// sits against the north side of its cell before this state rotation.
	switch (properties.facing ?? "north") {
		case "south":
			return 0;
		case "west":
			return -Math.PI / 2;
		case "north":
			return Math.PI;
		case "east":
			return Math.PI / 2;
		default:
			return null;
	}
}

function componentValue(containers: readonly UnknownRecord[], key: string): unknown {
	for (const container of containers) {
		const components = firstRecord(container, ["components", "Components"]);
		if (components?.[key] !== undefined) return components[key];
	}
	return undefined;
}

function parseBannerEntity(
	value: unknown,
	fallbackPosition?: SchematicPosition
): ParsedBannerEntity | null {
	const entity = asRecord(value);
	if (entity === null) return null;
	const nbt = firstRecord(entity, ["nbt", "Nbt", "NBT"]) ?? entity;
	const data = firstRecord(nbt, ["data", "Data"]) ?? firstRecord(entity, ["data", "Data"]) ?? nbt;
	const containers =
		data === nbt
			? data === entity
				? [entity]
				: [data, entity]
			: data === entity
				? [entity, nbt]
				: [data, nbt, entity];

	const position =
		parseSchematicPosition(firstDefined(nbt, ["Pos", "pos", "position"])) ??
		parseSchematicPosition(firstDefined(entity, ["position", "Pos", "pos"])) ??
		fallbackPosition ??
		null;
	if (position === null) return null;

	let rawPatterns: unknown;
	let hasPatternData = false;
	for (const container of containers) {
		rawPatterns = firstDefined(container, ["patterns", "Patterns"]);
		if (rawPatterns !== undefined) {
			hasPatternData = true;
			break;
		}
	}
	if (!hasPatternData) {
		rawPatterns = componentValue(containers, "minecraft:banner_patterns");
		hasPatternData = rawPatterns !== undefined;
	}

	let rawBaseColor: unknown;
	for (const container of containers) {
		rawBaseColor = firstDefined(container, ["base_color", "BaseColor", "Base", "base"]);
		if (rawBaseColor !== undefined) break;
	}
	if (rawBaseColor === undefined) {
		rawBaseColor = componentValue(containers, "minecraft:base_color");
	}

	return {
		position,
		baseColor: resolveBannerDyeColor(rawBaseColor),
		patterns: parseBannerPatternLayers(rawPatterns),
		hasPatternData,
	};
}

function bannerEntityAtPosition(
	entities: readonly IndexedBlockEntity[] | undefined,
	eligibleEntities: ReadonlySet<IndexedBlockEntity>
) {
	let selected: ParsedBannerEntity | undefined;
	for (const indexedEntity of entities ?? []) {
		if (!eligibleEntities.has(indexedEntity)) continue;
		const entity = parseBannerEntity(indexedEntity.raw, indexedEntity.position ?? undefined);
		if (entity === null) continue;
		if (selected === undefined || (!selected.hasPatternData && entity.hasPatternData)) {
			selected = entity;
		}
	}
	return selected;
}

/**
 * Selects every banner from palette-backed block positions. Block-entity NBT
 * contributes only ordered pattern layers (and legacy generic-banner color);
 * a banner without NBT still renders in its block ID's base color.
 */
export function selectBanners(
	snapshot: SchematicBlockEntitySnapshot,
	wrapper?: SchematicBlockEntityWrapper
): BannerSelection[] {
	const bannerBlocks = BANNER_BLOCK_IDS.flatMap(
		(blockId) => snapshot.blocksByName.get(blockId) ?? []
	);
	if (bannerBlocks.length === 0) return [];

	const eligibleEntities = new Set(
		snapshot.indexedEntities.slice(0, MAX_BANNER_ENTITIES_INSPECTED)
	);
	const banners: BannerSelection[] = [];
	const positions = new Set<string>();
	const inspected = Math.min(bannerBlocks.length, MAX_BANNER_BLOCKS_INSPECTED);

	for (let index = 0; index < inspected && banners.length < MAX_BANNER_INSTANCES; index += 1) {
		const block = bannerBlocks[index];
		if (block === undefined) continue;
		if (block.paletteIndex >= MAX_BANNER_PALETTE_ENTRIES_INSPECTED) continue;
		const state = snapshot.paletteStates[block.paletteIndex];
		if (state === null || state === undefined) continue;
		const parsedState = resolveBannerBlockState(state);
		if (parsedState === null) continue;

		const positionKey = block.position.join(",");
		if (positions.has(positionKey)) continue;
		const rotationY = resolveBannerRotation(parsedState.attachment, parsedState.state.properties);
		if (rotationY === null) continue;

		let entity = bannerEntityAtPosition(
			snapshot.entitiesByPosition.get(positionKey),
			eligibleEntities
		);
		if (entity?.hasPatternData !== true && wrapper?.get_block_entity !== undefined) {
			try {
				const direct = parseBannerEntity(
					wrapper.get_block_entity(...block.position),
					block.position
				);
				if (
					direct !== null &&
					direct.position[0] === block.position[0] &&
					direct.position[1] === block.position[1] &&
					direct.position[2] === block.position[2] &&
					(entity === undefined || direct.hasPatternData || entity.baseColor === null)
				) {
					entity = direct;
				}
			} catch {
				// Palette color still produces a complete blank banner.
			}
		}

		positions.add(positionKey);
		banners.push({
			position: block.position,
			attachment: parsedState.attachment,
			rotationY,
			baseColor: parsedState.baseColor ?? entity?.baseColor ?? "white",
			patterns: entity?.patterns ?? [],
		});
	}

	return banners;
}

export function bannerAppearanceKey(
	baseColor: BannerDyeColor,
	patterns: readonly BannerPatternLayer[]
): string {
	return [baseColor, ...patterns.map((layer) => `${layer.pattern}:${layer.color}`)].join("|");
}

/**
 * Multiplies each mask's grayscale RGB by its dye and alpha-composites layers
 * in saved order. Input arrays are not mutated.
 */
export function compositeBannerPixels(
	basePixels: Uint8ClampedArray,
	layers: readonly BannerPixelLayer[]
): Uint8ClampedArray {
	const target = new Uint8ClampedArray(basePixels);
	for (const layer of layers) {
		const source = layer.pixels;
		if (source.length !== target.length || source.length % 4 !== 0) continue;
		const tintRed = (layer.color >>> 16) & 0xff;
		const tintGreen = (layer.color >>> 8) & 0xff;
		const tintBlue = layer.color & 0xff;

		for (let index = 0; index < source.length; index += 4) {
			const sourceAlpha = (source[index + 3] ?? 0) / 255;
			if (sourceAlpha <= 0) continue;
			const destinationAlpha = (target[index + 3] ?? 0) / 255;
			const inverseSourceAlpha = 1 - sourceAlpha;
			const outputAlpha = sourceAlpha + destinationAlpha * inverseSourceAlpha;
			if (outputAlpha <= 0) {
				target[index] = 0;
				target[index + 1] = 0;
				target[index + 2] = 0;
				target[index + 3] = 0;
				continue;
			}

			const sourceRed = ((source[index] ?? 0) * tintRed) / 255;
			const sourceGreen = ((source[index + 1] ?? 0) * tintGreen) / 255;
			const sourceBlue = ((source[index + 2] ?? 0) * tintBlue) / 255;
			target[index] = Math.round(
				(sourceRed * sourceAlpha + (target[index] ?? 0) * destinationAlpha * inverseSourceAlpha) /
					outputAlpha
			);
			target[index + 1] = Math.round(
				(sourceGreen * sourceAlpha +
					(target[index + 1] ?? 0) * destinationAlpha * inverseSourceAlpha) /
					outputAlpha
			);
			target[index + 2] = Math.round(
				(sourceBlue * sourceAlpha +
					(target[index + 2] ?? 0) * destinationAlpha * inverseSourceAlpha) /
					outputAlpha
			);
			target[index + 3] = Math.round(outputAlpha * 255);
		}
	}
	return target;
}

function createPixelCanvas(width = BANNER_TEXTURE_SIZE, height = BANNER_TEXTURE_SIZE) {
	if (typeof document === "undefined") return null;
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (context === null) return null;
	context.imageSmoothingEnabled = false;
	return { canvas, context };
}

function rawTexturePixels(source: unknown): Uint8ClampedArray | null {
	const record = asRecord(source);
	if (record === null) return null;
	const width = Number(record.width);
	const height = Number(record.height);
	const data = record.data;
	if (
		width !== BANNER_TEXTURE_SIZE ||
		height !== BANNER_TEXTURE_SIZE ||
		!ArrayBuffer.isView(data) ||
		data.byteLength !== BANNER_TEXTURE_SIZE * BANNER_TEXTURE_SIZE * 4
	) {
		return null;
	}
	const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	return new Uint8ClampedArray(bytes);
}

function texturePixels(texture: Texture): Uint8ClampedArray | null {
	const source = texture.image as unknown;
	const raw = rawTexturePixels(source);
	if (raw !== null) return raw;

	const target = createPixelCanvas();
	if (target === null || source === null || source === undefined) return null;
	try {
		target.context.clearRect(0, 0, BANNER_TEXTURE_SIZE, BANNER_TEXTURE_SIZE);
		target.context.drawImage(
			source as CanvasImageSource,
			0,
			0,
			BANNER_TEXTURE_SIZE,
			BANNER_TEXTURE_SIZE
		);
		return target.context.getImageData(0, 0, BANNER_TEXTURE_SIZE, BANNER_TEXTURE_SIZE).data;
	} catch {
		return null;
	}
}

function canvasTextureFromPixels(pixels: Uint8ClampedArray): CanvasTexture | null {
	if (pixels.length !== BANNER_TEXTURE_SIZE * BANNER_TEXTURE_SIZE * 4) {
		return null;
	}
	const target = createPixelCanvas();
	if (target === null) return null;
	const image = target.context.createImageData(BANNER_TEXTURE_SIZE, BANNER_TEXTURE_SIZE);
	image.data.set(pixels);
	target.context.putImageData(image, 0, 0);

	const texture = new CanvasTexture(target.canvas);
	// Match Schem-at's entity-texture pipeline; marking this sRGB source as
	// linear avoids a second gamma conversion in its post-processing.
	texture.colorSpace = LinearSRGBColorSpace;
	texture.flipY = false;
	texture.magFilter = NearestFilter;
	texture.minFilter = NearestFilter;
	texture.generateMipmaps = false;
	texture.needsUpdate = true;
	return texture;
}

function normalizedModelPartName(name: string) {
	return name.toLowerCase().replace(/[._]\d+$/, "");
}

/**
 * Bakes Cubane's embedded standing-banner GLB, then derives the vanilla wall
 * bar/cloth placement from that same UV-mapped geometry. The renderer's global
 * -0.5 Y centering is removed here and reapplied after the vanilla 2/3 scale in
 * per-instance matrices.
 */
export function bakeBannerGeometries(
	entityModel: Awaited<ReturnType<BlockEntityResources["getEntityMesh"]>>
): BannerModelGeometries | null {
	entityModel.updateMatrixWorld(true);
	const parts = new Map<string, BufferGeometry>();

	entityModel.traverse((object) => {
		const candidate = object as typeof object & {
			isMesh?: boolean;
			geometry?: BufferGeometry;
		};
		if (
			candidate.isMesh !== true ||
			candidate.geometry?.isBufferGeometry !== true ||
			!object.visible
		) {
			return;
		}

		const name = normalizedModelPartName(object.name);
		if (name !== "top" && name !== "slate" && name !== "stand") return;
		if (parts.has(name)) return;

		const geometry = candidate.geometry.clone().applyMatrix4(object.matrixWorld);
		geometry.translate(0, 0.5, 0);
		if (geometry.getAttribute("position")?.count === 0) {
			geometry.dispose();
			return;
		}
		parts.set(name, geometry);
	});

	const top = parts.get("top");
	const flag = parts.get("slate");
	const stand = parts.get("stand");
	if (top === undefined || flag === undefined || stand === undefined) {
		for (const geometry of parts.values()) geometry.dispose();
		return null;
	}

	const standingFlag = flag.clone();
	const wallWood = top.clone().translate(0, WALL_MODEL_Y_OFFSET, WALL_BAR_Z_OFFSET);
	const wallFlag = flag.clone().translate(0, WALL_MODEL_Y_OFFSET, WALL_FLAG_Z_OFFSET);
	const standingWood = mergeGeometries([top, stand], false) as BufferGeometry | null;
	for (const geometry of parts.values()) geometry.dispose();

	if (standingWood === null) {
		standingFlag.dispose();
		wallWood.dispose();
		wallFlag.dispose();
		return null;
	}
	return { standingWood, standingFlag, wallWood, wallFlag };
}

function disposeBannerGeometries(geometries: BannerModelGeometries) {
	geometries.standingWood.dispose();
	geometries.standingFlag.dispose();
	geometries.wallWood.dispose();
	geometries.wallFlag.dispose();
}

function emptyOverlay(): BannerOverlay {
	return { count: 0, dispose: () => undefined };
}

function configureInstancedMesh(mesh: InstancedMesh) {
	mesh.instanceMatrix.setUsage(StaticDrawUsage);
	mesh.instanceMatrix.needsUpdate = true;
	mesh.computeBoundingBox();
	mesh.computeBoundingSphere();
	mesh.castShadow = true;
	mesh.receiveShadow = true;
}

async function settleResource<T>(load: () => Promise<T>): Promise<PromiseSettledResult<T>> {
	try {
		return { status: "fulfilled", value: await load() };
	} catch (reason) {
		return { status: "rejected", reason };
	}
}

function limitBannerAppearances(banners: readonly BannerSelection[]): BannerSelection[] {
	const allowed = new Set(banners.map((banner) => bannerAppearanceKey(banner.baseColor, [])));
	return banners.map((banner) => {
		const key = bannerAppearanceKey(banner.baseColor, banner.patterns);
		if (allowed.has(key)) return banner;
		if (allowed.size < MAX_BANNER_APPEARANCES) {
			allowed.add(key);
			return banner;
		}
		// Keep every physical banner visible while bounding generated canvases and
		// draw groups. Excess unique designs degrade to their correct base color.
		return { ...banner, patterns: [] };
	});
}

function groupBannerAppearances(banners: readonly BannerSelection[]) {
	const groups = new Map<string, BannerAppearanceGroup>();
	for (const banner of banners) {
		const appearanceKey = bannerAppearanceKey(banner.baseColor, banner.patterns);
		const key = `${banner.attachment}\0${appearanceKey}`;
		const group = groups.get(key);
		if (group === undefined) {
			groups.set(key, {
				key: appearanceKey,
				baseColor: banner.baseColor,
				patterns: banner.patterns,
				banners: [banner],
			});
		} else {
			group.banners.push(banner);
		}
	}
	return groups;
}

/**
 * Renders static standing and wall banners. Wood and cloth are instanced
 * separately; cloth is grouped by bounded visual appearance so ordered
 * pattern layers are composited once and reused across duplicate banners.
 */
export async function createBannerOverlay(
	schematic: BlockEntitySchematic,
	signal: AbortSignal,
	snapshot: SchematicBlockEntitySnapshot,
	resources: BlockEntityResources
): Promise<BannerOverlay> {
	const selected = selectBanners(snapshot, schematic.schematicWrapper);
	if (selected.length === 0 || signal.aborted) return emptyOverlay();
	const banners = limitBannerAppearances(selected);
	const appearanceGroups = groupBannerAppearances(banners);

	const texturePaths = new Set<string>([BANNER_BASE_TEXTURE, BANNER_BASE_PATTERN_TEXTURE]);
	for (const group of appearanceGroups.values()) {
		for (const layer of group.patterns) {
			texturePaths.add(bannerTexturePath(layer.pattern));
		}
	}
	const orderedTexturePaths = [...texturePaths];
	const [modelResult, textureResults] = await Promise.all([
		settleResource(() => resources.getEntityMesh(BANNER_ENTITY_MODEL)),
		Promise.all(
			orderedTexturePaths.map((path) => settleResource(() => resources.getTexture(path)))
		),
	]);
	if (signal.aborted) return emptyOverlay();

	if (modelResult.status !== "fulfilled") {
		console.warn("[schematic-renderer] Banner model could not be loaded.", modelResult.reason);
		return emptyOverlay();
	}

	const sourceTextures = new Map<string, Texture>();
	orderedTexturePaths.forEach((path, index) => {
		const result = textureResults[index];
		if (result?.status === "fulfilled") {
			sourceTextures.set(path, result.value);
		} else {
			console.warn(
				`[schematic-renderer] Banner texture ${path} could not be loaded.`,
				result?.reason
			);
		}
	});
	const sourceBaseTexture = sourceTextures.get(BANNER_BASE_TEXTURE);
	if (sourceBaseTexture === undefined) {
		console.warn("[schematic-renderer] Banner base texture is unavailable.");
		return emptyOverlay();
	}

	const geometries = bakeBannerGeometries(modelResult.value);
	if (geometries === null) {
		console.warn("[schematic-renderer] Banner model parts are incomplete.");
		return emptyOverlay();
	}

	const overlay = new Group();
	overlay.name = "schematic-renderer:banners";
	const meshes: InstancedMesh[] = [];
	const materials: MeshLambertMaterial[] = [];
	const ownedTextures: Texture[] = [];
	const position = new Vector3();
	const rotation = new Quaternion();
	const scale = new Vector3(BANNER_MODEL_SCALE, BANNER_MODEL_SCALE, -BANNER_MODEL_SCALE);
	const up = new Vector3(0, 1, 0);
	const matrix = new Matrix4();

	const baseTexture = sourceBaseTexture.clone();
	baseTexture.colorSpace = LinearSRGBColorSpace;
	baseTexture.flipY = false;
	baseTexture.magFilter = NearestFilter;
	baseTexture.minFilter = NearestFilter;
	baseTexture.generateMipmaps = false;
	baseTexture.needsUpdate = true;
	ownedTextures.push(baseTexture);

	const pixelMasks = new Map<string, Uint8ClampedArray>();
	for (const [path, texture] of sourceTextures) {
		const pixels = texturePixels(texture);
		if (pixels !== null) pixelMasks.set(path, pixels);
	}
	const bodyPixels = pixelMasks.get(BANNER_BASE_TEXTURE);
	const baseMask = pixelMasks.get(BANNER_BASE_PATTERN_TEXTURE) ?? bodyPixels;
	const appearanceMaterials = new Map<string, MeshLambertMaterial>();

	const disposeCreatedResources = () => {
		overlay.clear();
		for (const mesh of meshes) mesh.dispose();
		disposeBannerGeometries(geometries);
		for (const material of materials) material.dispose();
		for (const texture of ownedTextures) texture.dispose();
	};

	const setBannerMatrix = (mesh: InstancedMesh, index: number, banner: BannerSelection) => {
		position.set(
			banner.position[0],
			banner.position[1] + BANNER_MODEL_Y_OFFSET,
			banner.position[2]
		);
		rotation.setFromAxisAngle(up, banner.rotationY);
		matrix.compose(position, rotation, scale);
		mesh.setMatrixAt(index, matrix);
	};

	try {
		const woodMaterial = new MeshLambertMaterial({
			alphaTest: 1 / 255,
			depthTest: true,
			depthWrite: true,
			map: baseTexture,
			side: DoubleSide,
		});
		materials.push(woodMaterial);

		for (const attachment of ["standing", "wall"] as const) {
			const attached = banners.filter((banner) => banner.attachment === attachment);
			if (attached.length === 0) continue;
			const geometry = attachment === "standing" ? geometries.standingWood : geometries.wallWood;
			const mesh = new InstancedMesh(geometry, woodMaterial, attached.length);
			mesh.name = `schematic-renderer:banner:${attachment}:wood`;
			attached.forEach((banner, index) => {
				setBannerMatrix(mesh, index, banner);
			});
			configureInstancedMesh(mesh);
			meshes.push(mesh);
			overlay.add(mesh);
		}

		for (const group of appearanceGroups.values()) {
			if (signal.aborted) {
				disposeCreatedResources();
				return emptyOverlay();
			}

			let material = appearanceMaterials.get(group.key);
			if (material === undefined) {
				let compositeTexture: CanvasTexture | null = null;
				if (bodyPixels !== undefined && baseMask !== undefined) {
					const layers: BannerPixelLayer[] = [
						{
							pixels: baseMask,
							color: BANNER_DYE_COLORS[group.baseColor],
						},
					];
					for (const layer of group.patterns) {
						const pixels = pixelMasks.get(bannerTexturePath(layer.pattern));
						if (pixels !== undefined) {
							layers.push({
								pixels,
								color: BANNER_DYE_COLORS[layer.color],
							});
						}
					}
					compositeTexture = canvasTextureFromPixels(compositeBannerPixels(bodyPixels, layers));
				}
				if (compositeTexture !== null) ownedTextures.push(compositeTexture);

				material = new MeshLambertMaterial({
					alphaTest: 1 / 255,
					color: compositeTexture === null ? BANNER_DYE_COLORS[group.baseColor] : 0xffffff,
					depthTest: true,
					depthWrite: true,
					map: compositeTexture ?? baseTexture,
					side: DoubleSide,
				});
				appearanceMaterials.set(group.key, material);
				materials.push(material);
			}

			const attachment = group.banners[0]?.attachment;
			if (attachment === undefined) continue;
			const geometry = attachment === "standing" ? geometries.standingFlag : geometries.wallFlag;
			const mesh = new InstancedMesh(geometry, material, group.banners.length);
			mesh.name = `schematic-renderer:banner:${attachment}:flag:${group.key}`;
			group.banners.forEach((banner, index) => {
				setBannerMatrix(mesh, index, banner);
			});
			configureInstancedMesh(mesh);
			meshes.push(mesh);
			overlay.add(mesh);
		}
	} catch (error) {
		disposeCreatedResources();
		throw error;
	}

	if (signal.aborted || appearanceGroups.size === 0) {
		disposeCreatedResources();
		return emptyOverlay();
	}

	schematic.group.add(overlay);
	let disposed = false;
	return {
		count: banners.length,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			schematic.group.remove(overlay);
			disposeCreatedResources();
		},
	};
}

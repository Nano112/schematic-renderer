import {
	BufferGeometry,
	DoubleSide,
	Group,
	InstancedMesh,
	Matrix4,
	MeshLambertMaterial,
	Quaternion,
	StaticDrawUsage,
	Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import { asRecord, parseSchematicPosition } from "../snapshot.js";
import type {
	BlockEntityResources,
	BlockEntitySchematic,
	IndexedBlockEntity,
	SchematicBlockEntitySnapshot,
	SchematicBlockEntityWrapper,
	SchematicPosition,
} from "../snapshot.js";

export const DECORATED_POT_PATTERN_NAMES = [
	"angler",
	"archer",
	"arms_up",
	"blade",
	"brewer",
	"burn",
	"danger",
	"explorer",
	"flow",
	"friend",
	"guster",
	"heart",
	"heartbreak",
	"howl",
	"miner",
	"mourner",
	"plenty",
	"prize",
	"scrape",
	"sheaf",
	"shelter",
	"skull",
	"snort",
] as const;

export const DECORATED_POT_FACE_ORDER = ["back", "left", "right", "front"] as const;

export const DECORATED_POT_BASE_TEXTURE = "entity/decorated_pot/decorated_pot_base";
export const DECORATED_POT_BLANK_SIDE_TEXTURE = "entity/decorated_pot/decorated_pot_side";

export const MAX_DECORATED_POT_BLOCKS_INSPECTED = 750_000;
export const MAX_DECORATED_POT_PALETTE_ENTRIES_INSPECTED = 65_536;
export const MAX_DECORATED_POT_ENTITIES_INSPECTED = 1_024;
export const MAX_DECORATED_POT_INSTANCES = 512;

export type DecoratedPotFace = (typeof DECORATED_POT_FACE_ORDER)[number];
export type DecoratedPotSideTextures = readonly [
	back: string,
	left: string,
	right: string,
	front: string,
];

export type DecoratedPotSelection = {
	position: SchematicPosition;
	rotationY: number;
	sideTextures: DecoratedPotSideTextures;
};

export type DecoratedPotOverlay = {
	count: number;
	dispose: () => void;
};

type DecoratedPotBlockEntity = {
	position: SchematicPosition;
	sideTextures: DecoratedPotSideTextures;
	hasSherds: boolean;
};

type DecoratedPotModelGeometries = {
	base: BufferGeometry;
	sides: Map<DecoratedPotFace, BufferGeometry>;
};

const PATTERN_NAMES = new Set<string>(DECORATED_POT_PATTERN_NAMES);
const BASE_PART_NAMES = new Set(["neck", "top", "bottom"]);
const POT_FACE_NAMES = new Set<string>(DECORATED_POT_FACE_ORDER);
const POTTERY_SHERD_PATTERN = /^minecraft:([a-z0-9_]+)_pottery_sherd$/;

function firstDefined(record: Record<string, unknown>, keys: readonly string[]) {
	for (const key of keys) {
		if (record[key] !== undefined) return record[key];
	}
	return undefined;
}

/**
 * Maps a modern pottery-sherd item ID to its entity texture. Invalid values are
 * deliberately reduced to the vanilla blank side instead of becoming paths.
 */
export function decoratedPotTextureForSherd(value: unknown): string {
	if (value === "minecraft:brick") return DECORATED_POT_BLANK_SIDE_TEXTURE;
	if (typeof value !== "string") return DECORATED_POT_BLANK_SIDE_TEXTURE;

	const patternName = POTTERY_SHERD_PATTERN.exec(value)?.[1];
	return patternName !== undefined && PATTERN_NAMES.has(patternName)
		? `entity/decorated_pot/${patternName}_pottery_pattern`
		: DECORATED_POT_BLANK_SIDE_TEXTURE;
}

/**
 * Minecraft stores decorated-pot sides in back, left, right, front order.
 * Missing values, brick, and unknown future IDs all use the blank side.
 */
export function mapDecoratedPotSherds(value: unknown): DecoratedPotSideTextures {
	const sherds = Array.isArray(value) ? value : [];
	return [
		decoratedPotTextureForSherd(sherds[0]),
		decoratedPotTextureForSherd(sherds[1]),
		decoratedPotTextureForSherd(sherds[2]),
		decoratedPotTextureForSherd(sherds[3]),
	];
}

export function decoratedPotFacingRotation(facing: unknown): number {
	switch (facing) {
		case "east":
			return -Math.PI / 2;
		case "south":
			return Math.PI;
		case "west":
			return Math.PI / 2;
		case "north":
		default:
			return 0;
	}
}

function parseDecoratedPotBlockEntity(
	value: unknown,
	fallbackPosition?: SchematicPosition
): DecoratedPotBlockEntity | null {
	const entity = asRecord(value);
	if (entity === null) return null;

	const nbt = asRecord(firstDefined(entity, ["nbt", "Nbt", "NBT"])) ?? entity;
	const data = asRecord(firstDefined(nbt, ["data", "Data"]));
	const position =
		parseSchematicPosition(firstDefined(nbt, ["Pos", "pos", "position"])) ??
		parseSchematicPosition(firstDefined(entity, ["position", "Pos", "pos"])) ??
		fallbackPosition ??
		null;
	if (position === null) return null;
	const sherds = data?.sherds ?? nbt.sherds;

	return {
		position,
		sideTextures: mapDecoratedPotSherds(sherds),
		hasSherds: Array.isArray(sherds),
	};
}

function decoratedPotEntityAtPosition(
	entities: readonly IndexedBlockEntity[] | undefined,
	eligibleEntities: ReadonlySet<IndexedBlockEntity>
) {
	for (const indexedEntity of entities ?? []) {
		if (!eligibleEntities.has(indexedEntity)) continue;
		const entity = parseDecoratedPotBlockEntity(
			indexedEntity.raw,
			indexedEntity.position ?? undefined
		);
		if (entity !== null) return entity;
	}
	return undefined;
}

/**
 * Selects pots from the block palette first, then joins visual NBT by position.
 * A pot without block-entity NBT remains visible with four blank sides.
 */
export function selectDecoratedPots(
	snapshot: SchematicBlockEntitySnapshot,
	wrapper?: SchematicBlockEntityWrapper
): DecoratedPotSelection[] {
	const potBlocks = snapshot.blocksByName.get("minecraft:decorated_pot") ?? [];
	if (potBlocks.length === 0) return [];

	const eligibleEntities = new Set(
		snapshot.indexedEntities.slice(0, MAX_DECORATED_POT_ENTITIES_INSPECTED)
	);
	const pots: DecoratedPotSelection[] = [];
	const positions = new Set<string>();
	const inspected = Math.min(potBlocks.length, MAX_DECORATED_POT_BLOCKS_INSPECTED);

	for (let index = 0; index < inspected && pots.length < MAX_DECORATED_POT_INSTANCES; index += 1) {
		const block = potBlocks[index];
		if (block === undefined) continue;
		if (block.paletteIndex >= MAX_DECORATED_POT_PALETTE_ENTRIES_INSPECTED) continue;
		const state = snapshot.paletteStates[block.paletteIndex];
		if (state?.name !== "minecraft:decorated_pot") continue;

		const key = block.position.join(",");
		if (positions.has(key)) continue;
		positions.add(key);
		let entity = decoratedPotEntityAtPosition(
			snapshot.entitiesByPosition.get(key),
			eligibleEntities
		);
		if (!entity?.hasSherds && wrapper?.get_block_entity !== undefined) {
			try {
				const direct = parseDecoratedPotBlockEntity(wrapper.get_block_entity(...block.position));
				if (
					direct?.hasSherds === true &&
					direct.position[0] === block.position[0] &&
					direct.position[1] === block.position[1] &&
					direct.position[2] === block.position[2]
				) {
					entity = direct;
				}
			} catch {
				// The blank pot remains visible when direct NBT access is unavailable.
			}
		}
		pots.push({
			position: block.position,
			rotationY: decoratedPotFacingRotation(state.properties.facing),
			sideTextures: entity?.sideTextures ?? mapDecoratedPotSherds(undefined),
		});
	}

	return pots;
}

function emptyOverlay(): DecoratedPotOverlay {
	return { count: 0, dispose: () => undefined };
}

function disposeModelGeometries(geometries: DecoratedPotModelGeometries | null) {
	if (geometries === null) return;
	geometries.base.dispose();
	for (const geometry of geometries.sides.values()) geometry.dispose();
}

function bakeDecoratedPotGeometries(
	entityModel: Awaited<ReturnType<BlockEntityResources["getEntityMesh"]>>
): DecoratedPotModelGeometries | null {
	entityModel.updateMatrixWorld(true);
	const baseParts: BufferGeometry[] = [];
	const sides = new Map<DecoratedPotFace, BufferGeometry>();

	entityModel.traverse((object) => {
		const candidate = object as typeof object & {
			isMesh?: boolean;
			geometry?: BufferGeometry;
		};
		if (candidate.isMesh !== true || candidate.geometry?.isBufferGeometry !== true) {
			return;
		}

		// GLTFLoader uniquifies duplicate node names (`neck`, `neck_1`).
		const partName = object.name.toLowerCase().replace(/[._]\d+$/, "");
		if (!BASE_PART_NAMES.has(partName) && !POT_FACE_NAMES.has(partName)) return;
		const geometry = candidate.geometry.clone().applyMatrix4(object.matrixWorld);
		if (BASE_PART_NAMES.has(partName)) {
			baseParts.push(geometry);
			return;
		}

		const face = partName as DecoratedPotFace;
		if (sides.has(face)) {
			geometry.dispose();
		} else {
			sides.set(face, geometry);
		}
	});

	let base: BufferGeometry | null = null;
	try {
		base = baseParts.length === 0 ? null : mergeGeometries(baseParts, false);
	} finally {
		for (const part of baseParts) part.dispose();
	}

	if (base === null || DECORATED_POT_FACE_ORDER.some((face) => !sides.has(face))) {
		base?.dispose();
		for (const geometry of sides.values()) geometry.dispose();
		return null;
	}
	return { base, sides };
}

function configureInstancedMesh(mesh: InstancedMesh) {
	mesh.instanceMatrix.setUsage(StaticDrawUsage);
	mesh.instanceMatrix.needsUpdate = true;
	mesh.computeBoundingBox();
	mesh.computeBoundingSphere();
	mesh.castShadow = true;
	mesh.receiveShadow = true;
}

type SideInstanceGroup = {
	face: DecoratedPotFace;
	texturePath: string;
	pots: DecoratedPotSelection[];
};

async function settleResource<T>(load: () => Promise<T>): Promise<PromiseSettledResult<T>> {
	try {
		return { status: "fulfilled", value: await load() };
	} catch (reason) {
		return { status: "rejected", reason };
	}
}

/**
 * Builds one instanced base mesh plus side meshes grouped by local face and
 * texture. Entity textures are borrowed from Cubane's cache and are never
 * disposed by this overlay.
 */
export async function createDecoratedPotOverlay(
	schematic: BlockEntitySchematic,
	signal: AbortSignal,
	snapshot: SchematicBlockEntitySnapshot,
	resources: BlockEntityResources
): Promise<DecoratedPotOverlay> {
	const pots = selectDecoratedPots(snapshot, schematic.schematicWrapper);
	if (pots.length === 0 || signal.aborted) return emptyOverlay();

	const sideTexturePaths = new Set<string>();
	for (const pot of pots) {
		for (const texturePath of pot.sideTextures) {
			sideTexturePaths.add(texturePath);
		}
	}
	sideTexturePaths.add(DECORATED_POT_BLANK_SIDE_TEXTURE);

	const texturePaths = [DECORATED_POT_BASE_TEXTURE, ...sideTexturePaths];
	const [modelResult, textureResults] = await Promise.all([
		settleResource(() => resources.getEntityMesh("decorated_pot")),
		Promise.all(texturePaths.map((path) => settleResource(() => resources.getTexture(path)))),
	]);
	if (signal.aborted) return emptyOverlay();

	if (modelResult.status !== "fulfilled") {
		console.warn(
			"[schematic-renderer] Decorated-pot model could not be loaded.",
			modelResult.reason
		);
		return emptyOverlay();
	}

	const sourceTextures = new Map<string, Awaited<ReturnType<BlockEntityResources["getTexture"]>>>();
	texturePaths.forEach((path, index) => {
		const result = textureResults[index];
		if (result?.status === "fulfilled") sourceTextures.set(path, result.value);
	});
	if (
		!sourceTextures.has(DECORATED_POT_BASE_TEXTURE) ||
		!sourceTextures.has(DECORATED_POT_BLANK_SIDE_TEXTURE)
	) {
		console.warn("[schematic-renderer] Decorated-pot base textures are unavailable.");
		return emptyOverlay();
	}

	const geometries = bakeDecoratedPotGeometries(modelResult.value);
	if (geometries === null) {
		console.warn("[schematic-renderer] Decorated-pot model parts are incomplete.");
		return emptyOverlay();
	}

	// AssetLoader textures default to flipY=true, while the baked GLB UVs expect
	// flipY=false. Clone cache-owned textures before correcting or disposing them.
	const textures = new Map<string, Awaited<ReturnType<BlockEntityResources["getTexture"]>>>();
	for (const [path, sourceTexture] of sourceTextures) {
		const texture = sourceTexture.clone();
		texture.flipY = false;
		texture.needsUpdate = true;
		textures.set(path, texture);
	}
	const baseTexture = textures.get(DECORATED_POT_BASE_TEXTURE);
	const blankTexture = textures.get(DECORATED_POT_BLANK_SIDE_TEXTURE);
	if (baseTexture === undefined || blankTexture === undefined) {
		disposeModelGeometries(geometries);
		for (const texture of textures.values()) texture.dispose();
		return emptyOverlay();
	}

	const overlay = new Group();
	overlay.name = "schematic-renderer:decorated-pots";
	const meshes: InstancedMesh[] = [];
	const materials = new Map<string, MeshLambertMaterial>();
	const position = new Vector3();
	const rotation = new Quaternion();
	const scale = new Vector3(1, 1, 1);
	const up = new Vector3(0, 1, 0);
	const matrix = new Matrix4();

	const materialFor = (texturePath: string) => {
		const resolvedPath = textures.has(texturePath) ? texturePath : DECORATED_POT_BLANK_SIDE_TEXTURE;
		let material = materials.get(resolvedPath);
		if (material === undefined) {
			material = new MeshLambertMaterial({
				alphaTest: 1 / 255,
				depthTest: true,
				depthWrite: true,
				map: textures.get(resolvedPath) ?? blankTexture,
				// Embedded pot sides are planes. Render both sides so winding changes
				// in upstream GLBs cannot make a decorated face disappear.
				side: DoubleSide,
			});
			materials.set(resolvedPath, material);
		}
		return material;
	};
	const setPotMatrix = (mesh: InstancedMesh, index: number, pot: DecoratedPotSelection) => {
		position.set(...pot.position);
		rotation.setFromAxisAngle(up, pot.rotationY);
		matrix.compose(position, rotation, scale);
		mesh.setMatrixAt(index, matrix);
	};

	const baseMaterial = new MeshLambertMaterial({
		alphaTest: 1 / 255,
		depthTest: true,
		depthWrite: true,
		map: baseTexture,
		side: DoubleSide,
	});
	materials.set(DECORATED_POT_BASE_TEXTURE, baseMaterial);
	const baseMesh = new InstancedMesh(geometries.base, baseMaterial, pots.length);
	baseMesh.name = "schematic-renderer:decorated-pot-base";
	pots.forEach((pot, index) => setPotMatrix(baseMesh, index, pot));
	configureInstancedMesh(baseMesh);
	meshes.push(baseMesh);
	overlay.add(baseMesh);

	const sideGroups = new Map<string, SideInstanceGroup>();
	for (const pot of pots) {
		DECORATED_POT_FACE_ORDER.forEach((face, faceIndex) => {
			const texturePath = pot.sideTextures[faceIndex] ?? DECORATED_POT_BLANK_SIDE_TEXTURE;
			const key = `${face}\0${texturePath}`;
			const group = sideGroups.get(key);
			if (group === undefined) {
				sideGroups.set(key, { face, texturePath, pots: [pot] });
			} else {
				group.pots.push(pot);
			}
		});
	}

	for (const group of sideGroups.values()) {
		const geometry = geometries.sides.get(group.face);
		if (geometry === undefined) continue;
		const mesh = new InstancedMesh(geometry, materialFor(group.texturePath), group.pots.length);
		mesh.name = `schematic-renderer:decorated-pot-side:${group.face}:${group.texturePath}`;
		group.pots.forEach((pot, index) => setPotMatrix(mesh, index, pot));
		configureInstancedMesh(mesh);
		meshes.push(mesh);
		overlay.add(mesh);
	}

	if (signal.aborted) {
		overlay.clear();
		for (const mesh of meshes) mesh.dispose();
		disposeModelGeometries(geometries);
		for (const material of materials.values()) material.dispose();
		for (const texture of textures.values()) texture.dispose();
		return emptyOverlay();
	}

	schematic.group.add(overlay);
	let disposed = false;
	return {
		count: pots.length,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			schematic.group.remove(overlay);
			overlay.clear();
			for (const mesh of meshes) mesh.dispose();
			disposeModelGeometries(geometries);
			for (const material of materials.values()) material.dispose();
			for (const texture of textures.values()) texture.dispose();
		},
	};
}

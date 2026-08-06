import {
	BufferGeometry,
	DoubleSide,
	Group,
	InstancedMesh,
	Matrix4,
	MeshLambertMaterial,
	Quaternion,
	StaticDrawUsage,
	Texture,
	Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type {
	BlockState,
	BlockEntityResources,
	BlockEntitySchematic,
	SchematicBlockEntitySnapshot,
	SchematicPosition,
} from "../snapshot.js";

export const MAX_COPPER_CHEST_BLOCKS_INSPECTED = 750_000;
export const MAX_COPPER_CHEST_PALETTE_ENTRIES_INSPECTED = 65_536;
export const MAX_COPPER_CHEST_INSTANCES = 1_024;

export const COPPER_CHEST_BLOCK_IDS = [
	"minecraft:copper_chest",
	"minecraft:exposed_copper_chest",
	"minecraft:weathered_copper_chest",
	"minecraft:oxidized_copper_chest",
	"minecraft:waxed_copper_chest",
	"minecraft:waxed_exposed_copper_chest",
	"minecraft:waxed_weathered_copper_chest",
	"minecraft:waxed_oxidized_copper_chest",
] as const;

export type CopperChestStage = "copper" | "exposed" | "weathered" | "oxidized";
export type CopperChestType = "single" | "left" | "right";
export type CopperChestFacing = "south" | "west" | "north" | "east";
export type CopperChestModel = "chest" | "chest_left" | "chest_right";

export type CopperChestSelection = {
	position: SchematicPosition;
	stage: CopperChestStage;
	type: CopperChestType;
	facing: CopperChestFacing;
	rotationY: number;
	model: CopperChestModel;
	texturePath: string;
};

export type CopperChestOverlay = {
	count: number;
	dispose: () => void;
};

const STAGE_BY_BLOCK_ID: Readonly<Record<string, CopperChestStage>> = {
	"minecraft:copper_chest": "copper",
	"minecraft:exposed_copper_chest": "exposed",
	"minecraft:weathered_copper_chest": "weathered",
	"minecraft:oxidized_copper_chest": "oxidized",
	"minecraft:waxed_copper_chest": "copper",
	"minecraft:waxed_exposed_copper_chest": "exposed",
	"minecraft:waxed_weathered_copper_chest": "weathered",
	"minecraft:waxed_oxidized_copper_chest": "oxidized",
};

const TEXTURE_PREFIX_BY_STAGE: Readonly<Record<CopperChestStage, string>> = {
	copper: "copper",
	exposed: "copper_exposed",
	weathered: "copper_weathered",
	oxidized: "copper_oxidized",
};

/**
 * Waxing does not change a copper chest's entity texture, so waxed and
 * unwaxed IDs deliberately resolve to the same oxidation stage.
 */
export function resolveCopperChestStage(blockName: unknown): CopperChestStage | null {
	return typeof blockName === "string" ? (STAGE_BY_BLOCK_ID[blockName] ?? null) : null;
}

export function resolveCopperChestModel(type: unknown): CopperChestModel | null {
	switch (type) {
		case "single":
			return "chest";
		case "left":
			return "chest_left";
		case "right":
			return "chest_right";
		default:
			return null;
	}
}

export function resolveCopperChestTexture(stage: CopperChestStage, type: CopperChestType): string {
	const suffix = type === "single" ? "" : `_${type}`;
	return `entity/chest/${TEXTURE_PREFIX_BY_STAGE[stage]}${suffix}`;
}

export function resolveCopperChestRotation(facing: unknown): number | null {
	// Cubane's closed chest GLBs point north at their zero rotation.
	switch (facing) {
		case "north":
			return 0;
		case "east":
			return -Math.PI / 2;
		case "south":
			return Math.PI;
		case "west":
			return Math.PI / 2;
		default:
			return null;
	}
}

export function resolveCopperChest(
	state: BlockState,
	position: SchematicPosition
): CopperChestSelection | null {
	const stage = resolveCopperChestStage(state.name);
	const type = (state.properties.type ?? "single") as CopperChestType;
	const facing = (state.properties.facing ?? "north") as CopperChestFacing;
	const model = resolveCopperChestModel(type);
	const rotationY = resolveCopperChestRotation(facing);
	if (stage === null || model === null || rotationY === null) return null;

	return {
		position,
		stage,
		type,
		facing,
		rotationY,
		model,
		texturePath: resolveCopperChestTexture(stage, type),
	};
}

/**
 * Copper chests are selected from palette-backed block positions. Their
 * block-entity payload is ordinary `minecraft:chest` NBT and is not needed for
 * the closed preview model.
 */
export function selectCopperChests(snapshot: SchematicBlockEntitySnapshot): CopperChestSelection[] {
	const chestBlocks = COPPER_CHEST_BLOCK_IDS.flatMap(
		(blockId) => snapshot.blocksByName.get(blockId) ?? []
	);
	if (chestBlocks.length === 0) return [];

	const chests: CopperChestSelection[] = [];
	const positions = new Set<string>();
	const inspected = Math.min(chestBlocks.length, MAX_COPPER_CHEST_BLOCKS_INSPECTED);

	for (let index = 0; index < inspected && chests.length < MAX_COPPER_CHEST_INSTANCES; index += 1) {
		const block = chestBlocks[index];
		if (block === undefined) continue;
		if (block.paletteIndex >= MAX_COPPER_CHEST_PALETTE_ENTRIES_INSPECTED) continue;
		const state = snapshot.paletteStates[block.paletteIndex];
		if (state === null || state === undefined) continue;

		const positionKey = block.position.join(",");
		if (positions.has(positionKey)) continue;
		const chest = resolveCopperChest(state, block.position);
		if (chest === null) continue;

		positions.add(positionKey);
		chests.push(chest);
	}

	return chests;
}

/**
 * Cubane's GLB hierarchy carries the chest part transforms on child objects.
 * Bake those world transforms before merging or lids and locks collapse onto
 * the untransformed source geometry.
 */
export function bakeCopperChestGeometry(
	entityModel: Awaited<ReturnType<BlockEntityResources["getEntityMesh"]>>
): BufferGeometry | null {
	entityModel.updateMatrixWorld(true);
	const parts: BufferGeometry[] = [];

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

		const geometry = candidate.geometry.clone();
		geometry.applyMatrix4(object.matrixWorld);
		if (geometry.getAttribute("position")?.count === 0) {
			geometry.dispose();
		} else {
			parts.push(geometry);
		}
	});

	if (parts.length === 0) return null;
	if (parts.length === 1) return parts[0] ?? null;

	let merged: BufferGeometry | null = null;
	try {
		merged = mergeGeometries(parts, false) as BufferGeometry | null;
	} finally {
		for (const part of parts) part.dispose();
	}
	return merged;
}

function emptyOverlay(): CopperChestOverlay {
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

type CopperChestInstanceGroup = {
	model: CopperChestModel;
	texturePath: string;
	chests: CopperChestSelection[];
};

/**
 * Adds copper chests in at most twelve instanced draw groups: one per
 * oxidation-stage and single/left/right model combination.
 */
export async function createCopperChestOverlay(
	schematic: BlockEntitySchematic,
	signal: AbortSignal,
	snapshot: SchematicBlockEntitySnapshot,
	resources: BlockEntityResources
): Promise<CopperChestOverlay> {
	const chests = selectCopperChests(snapshot);
	if (chests.length === 0 || signal.aborted) return emptyOverlay();

	const instanceGroups = new Map<string, CopperChestInstanceGroup>();
	for (const chest of chests) {
		const key = `${chest.model}\0${chest.texturePath}`;
		const group = instanceGroups.get(key);
		if (group === undefined) {
			instanceGroups.set(key, {
				model: chest.model,
				texturePath: chest.texturePath,
				chests: [chest],
			});
		} else {
			group.chests.push(chest);
		}
	}

	const modelNames = [...new Set([...instanceGroups.values()].map((group) => group.model))];
	const texturePaths = [...new Set([...instanceGroups.values()].map((group) => group.texturePath))];
	const [modelResults, textureResults] = await Promise.all([
		Promise.allSettled(modelNames.map((model) => resources.getEntityMesh(model))),
		Promise.allSettled(texturePaths.map((texturePath) => resources.getTexture(texturePath))),
	]);
	if (signal.aborted) return emptyOverlay();

	const geometries = new Map<CopperChestModel, BufferGeometry>();
	modelNames.forEach((model, index) => {
		const result = modelResults[index];
		if (result?.status !== "fulfilled") {
			console.warn(
				`[schematic-renderer] Copper-chest model ${model} could not be loaded.`,
				result?.reason
			);
			return;
		}
		const geometry = bakeCopperChestGeometry(result.value);
		if (geometry === null) {
			console.warn(`[schematic-renderer] Copper-chest model ${model} has no usable geometry.`);
			return;
		}
		geometries.set(model, geometry);
	});

	const sourceTextures = new Map<string, Texture>();
	texturePaths.forEach((texturePath, index) => {
		const result = textureResults[index];
		if (result?.status === "fulfilled") {
			sourceTextures.set(texturePath, result.value);
		} else {
			console.warn(
				`[schematic-renderer] Copper-chest texture ${texturePath} could not be loaded.`,
				result?.reason
			);
		}
	});

	const overlay = new Group();
	overlay.name = "schematic-renderer:copper-chests";
	const meshes: InstancedMesh[] = [];
	const materials: MeshLambertMaterial[] = [];
	const ownedTextures: Texture[] = [];
	const position = new Vector3();
	const rotation = new Quaternion();
	const scale = new Vector3(1, 1, 1);
	const up = new Vector3(0, 1, 0);
	const matrix = new Matrix4();
	let renderedCount = 0;

	for (const group of instanceGroups.values()) {
		const geometry = geometries.get(group.model);
		const sourceTexture = sourceTextures.get(group.texturePath);
		if (geometry === undefined || sourceTexture === undefined) continue;

		// GLB UVs expect unflipped textures. Clone the cache-owned Cubane texture
		// so correcting flipY never mutates or disposes the shared source.
		const texture = sourceTexture.clone();
		texture.flipY = false;
		texture.needsUpdate = true;
		ownedTextures.push(texture);
		const material = new MeshLambertMaterial({
			alphaTest: 1 / 255,
			depthTest: true,
			depthWrite: true,
			map: texture,
			side: DoubleSide,
		});
		materials.push(material);
		const mesh = new InstancedMesh(geometry, material, group.chests.length);
		mesh.name = `schematic-renderer:copper-chest:${group.model}:${group.texturePath}`;

		group.chests.forEach((chest, index) => {
			position.set(...chest.position);
			rotation.setFromAxisAngle(up, chest.rotationY);
			matrix.compose(position, rotation, scale);
			mesh.setMatrixAt(index, matrix);
		});
		configureInstancedMesh(mesh);
		meshes.push(mesh);
		overlay.add(mesh);
		renderedCount += group.chests.length;
	}

	const disposeCreatedResources = () => {
		overlay.clear();
		for (const mesh of meshes) mesh.dispose();
		for (const geometry of geometries.values()) geometry.dispose();
		for (const material of materials) material.dispose();
		for (const texture of ownedTextures) texture.dispose();
	};
	if (signal.aborted || renderedCount === 0) {
		disposeCreatedResources();
		return emptyOverlay();
	}

	schematic.group.add(overlay);
	let disposed = false;
	return {
		count: renderedCount,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			schematic.group.remove(overlay);
			disposeCreatedResources();
		},
	};
}

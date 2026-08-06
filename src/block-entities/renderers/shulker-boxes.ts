import {
	BufferGeometry,
	DoubleSide,
	Euler,
	Group,
	InstancedMesh,
	LinearSRGBColorSpace,
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

export const MAX_SHULKER_BOX_BLOCKS_INSPECTED = 750_000;
export const MAX_SHULKER_BOX_PALETTE_ENTRIES_INSPECTED = 65_536;
export const MAX_SHULKER_BOX_INSTANCES = 1_024;

export const SHULKER_BOX_VARIANTS = [
	"undyed",
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

export const SHULKER_BOX_BLOCK_IDS = [
	"minecraft:shulker_box",
	"minecraft:white_shulker_box",
	"minecraft:orange_shulker_box",
	"minecraft:magenta_shulker_box",
	"minecraft:light_blue_shulker_box",
	"minecraft:yellow_shulker_box",
	"minecraft:lime_shulker_box",
	"minecraft:pink_shulker_box",
	"minecraft:gray_shulker_box",
	"minecraft:light_gray_shulker_box",
	"minecraft:cyan_shulker_box",
	"minecraft:purple_shulker_box",
	"minecraft:blue_shulker_box",
	"minecraft:brown_shulker_box",
	"minecraft:green_shulker_box",
	"minecraft:red_shulker_box",
	"minecraft:black_shulker_box",
] as const;

export const SHULKER_BOX_FACINGS = ["up", "down", "north", "south", "east", "west"] as const;

export const SHULKER_BOX_ENTITY_MODEL = "shulker_box";

export type ShulkerBoxVariant = (typeof SHULKER_BOX_VARIANTS)[number];
export type ShulkerBoxFacing = (typeof SHULKER_BOX_FACINGS)[number];
export type ShulkerBoxRotation = readonly [xRadians: number, yRadians: number, zRadians: number];

export type ShulkerBoxSelection = {
	position: SchematicPosition;
	variant: ShulkerBoxVariant;
	facing: ShulkerBoxFacing;
	rotationEuler: ShulkerBoxRotation;
	texturePath: string;
};

export type ShulkerBoxOverlay = {
	count: number;
	dispose: () => void;
};

const VARIANT_BY_BLOCK_ID = new Map<string, ShulkerBoxVariant>(
	SHULKER_BOX_BLOCK_IDS.map((blockId, index) => [
		blockId,
		SHULKER_BOX_VARIANTS[index] as ShulkerBoxVariant,
	])
);

/**
 * Cubane's closed shulker-box GLB opens along +Y. These rotations point that
 * axis at the block state's facing direction while preserving vanilla's roll.
 * Minecraft/Three coordinates use +X east and +Z south.
 */
const ROTATION_BY_FACING: Readonly<Record<ShulkerBoxFacing, ShulkerBoxRotation>> = {
	up: [0, 0, 0],
	down: [Math.PI, 0, 0],
	north: [-Math.PI / 2, 0, 0],
	south: [Math.PI / 2, 0, 0],
	east: [0, 0, -Math.PI / 2],
	west: [0, 0, Math.PI / 2],
};

export function resolveShulkerBoxVariant(blockName: unknown): ShulkerBoxVariant | null {
	return typeof blockName === "string" ? (VARIANT_BY_BLOCK_ID.get(blockName) ?? null) : null;
}

export function resolveShulkerBoxTexture(variant: ShulkerBoxVariant): string {
	const suffix = variant === "undyed" ? "" : `_${variant}`;
	return `entity/shulker/shulker${suffix}`;
}

export function resolveShulkerBoxRotation(facing: unknown): ShulkerBoxRotation | null {
	return typeof facing === "string" &&
		Object.prototype.hasOwnProperty.call(ROTATION_BY_FACING, facing)
		? ROTATION_BY_FACING[facing as ShulkerBoxFacing]
		: null;
}

export function resolveShulkerBox(
	state: BlockState,
	position: SchematicPosition
): ShulkerBoxSelection | null {
	const variant = resolveShulkerBoxVariant(state.name);
	const facing = (state.properties.facing ?? "up") as ShulkerBoxFacing;
	const rotationEuler = resolveShulkerBoxRotation(facing);
	if (variant === null || rotationEuler === null) return null;

	return {
		position,
		variant,
		facing,
		rotationEuler,
		texturePath: resolveShulkerBoxTexture(variant),
	};
}

/**
 * Closed previews need only palette-backed positions and facing properties.
 * Shulker-box inventory NBT is intentionally neither read nor retained.
 */
export function selectShulkerBoxes(snapshot: SchematicBlockEntitySnapshot): ShulkerBoxSelection[] {
	const shulkerBlocks = SHULKER_BOX_BLOCK_IDS.flatMap(
		(blockId) => snapshot.blocksByName.get(blockId) ?? []
	);
	if (shulkerBlocks.length === 0) return [];

	const boxes: ShulkerBoxSelection[] = [];
	const positions = new Set<string>();
	const inspected = Math.min(shulkerBlocks.length, MAX_SHULKER_BOX_BLOCKS_INSPECTED);

	for (let index = 0; index < inspected && boxes.length < MAX_SHULKER_BOX_INSTANCES; index += 1) {
		const block = shulkerBlocks[index];
		if (block === undefined) continue;
		if (block.paletteIndex >= MAX_SHULKER_BOX_PALETTE_ENTRIES_INSPECTED) continue;
		const state = snapshot.paletteStates[block.paletteIndex];
		if (state === null || state === undefined) continue;

		const positionKey = block.position.join(",");
		if (positions.has(positionKey)) continue;
		const box = resolveShulkerBox(state, block.position);
		if (box === null) continue;

		positions.add(positionKey);
		boxes.push(box);
	}

	return boxes;
}

/**
 * EntityRenderer centers the source GLB at the block origin. Bake every visible
 * lid/base world transform before merging, then reuse this one geometry for all
 * texture variants and facings.
 */
export function bakeShulkerBoxGeometry(
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

function emptyOverlay(): ShulkerBoxOverlay {
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

/**
 * Adds shulker boxes in at most seventeen instanced draw groups, one per entity
 * texture. All groups share one baked closed-box geometry; facing is per-instance.
 */
export async function createShulkerBoxOverlay(
	schematic: BlockEntitySchematic,
	signal: AbortSignal,
	snapshot: SchematicBlockEntitySnapshot,
	resources: BlockEntityResources
): Promise<ShulkerBoxOverlay> {
	const boxes = selectShulkerBoxes(snapshot);
	if (boxes.length === 0 || signal.aborted) return emptyOverlay();

	const instanceGroups = new Map<string, ShulkerBoxSelection[]>();
	for (const box of boxes) {
		const group = instanceGroups.get(box.texturePath);
		if (group === undefined) {
			instanceGroups.set(box.texturePath, [box]);
		} else {
			group.push(box);
		}
	}

	const texturePaths = [...instanceGroups.keys()];
	const [modelResult, textureResults] = await Promise.all([
		settleResource(() => resources.getEntityMesh(SHULKER_BOX_ENTITY_MODEL)),
		Promise.all(
			texturePaths.map((texturePath) => settleResource(() => resources.getTexture(texturePath)))
		),
	]);
	if (signal.aborted) return emptyOverlay();

	if (modelResult.status !== "fulfilled") {
		console.warn("[schematic-renderer] Shulker-box model could not be loaded.", modelResult.reason);
		return emptyOverlay();
	}

	const sourceTextures = new Map<string, Texture>();
	texturePaths.forEach((texturePath, index) => {
		const result = textureResults[index];
		if (result?.status === "fulfilled") {
			sourceTextures.set(texturePath, result.value);
		} else {
			console.warn(
				`[schematic-renderer] Shulker-box texture ${texturePath} could not be loaded.`,
				result?.reason
			);
		}
	});
	if (sourceTextures.size === 0) return emptyOverlay();

	const geometry = bakeShulkerBoxGeometry(modelResult.value);
	if (geometry === null) {
		console.warn("[schematic-renderer] Shulker-box model has no usable geometry.");
		return emptyOverlay();
	}

	const overlay = new Group();
	overlay.name = "schematic-renderer:shulker-boxes";
	const meshes: InstancedMesh[] = [];
	const materials: MeshLambertMaterial[] = [];
	const ownedTextures: Texture[] = [];
	const position = new Vector3();
	const euler = new Euler(0, 0, 0, "XYZ");
	const rotation = new Quaternion();
	const scale = new Vector3(1, 1, 1);
	const matrix = new Matrix4();
	let renderedCount = 0;

	const disposeCreatedResources = () => {
		overlay.clear();
		for (const mesh of meshes) mesh.dispose();
		geometry.dispose();
		for (const material of materials) material.dispose();
		for (const texture of ownedTextures) texture.dispose();
	};

	try {
		for (const [texturePath, group] of instanceGroups) {
			const sourceTexture = sourceTextures.get(texturePath);
			if (sourceTexture === undefined) continue;

			// GLB UVs expect unflipped, linear entity textures. Clone cache-owned
			// Cubane textures before changing metadata or later disposing them.
			const texture = sourceTexture.clone();
			texture.colorSpace = LinearSRGBColorSpace;
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

			const mesh = new InstancedMesh(geometry, material, group.length);
			mesh.name = `schematic-renderer:shulker-box:${texturePath}`;
			group.forEach((box, index) => {
				position.set(...box.position);
				euler.set(...box.rotationEuler, "XYZ");
				rotation.setFromEuler(euler);
				matrix.compose(position, rotation, scale);
				mesh.setMatrixAt(index, matrix);
			});
			configureInstancedMesh(mesh);
			meshes.push(mesh);
			overlay.add(mesh);
			renderedCount += group.length;
		}
	} catch (error) {
		disposeCreatedResources();
		throw error;
	}

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

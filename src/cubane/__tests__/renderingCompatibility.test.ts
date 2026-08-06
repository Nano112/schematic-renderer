import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { AssetLoader } from "../AssetLoader";
import { BlockMeshBuilder } from "../BlockMeshBuilder";
import { ModelResolver } from "../ModelResolver";
import { TintManager } from "../TintManager";
import type { BlockModel } from "../types";
import { WorldMeshBuilder } from "../../WorldMeshBuilder";

function imageData(red: number, green: number, blue: number): ImageData {
	return {
		data: new Uint8ClampedArray([red, green, blue, 255]),
		width: 1,
		height: 1,
		colorSpace: "srgb",
	} as ImageData;
}

function createAssetLoaderStub() {
	const getTint = vi.fn(() => new THREE.Color(0x3f76e4));
	return {
		getTint,
		resolveTexture: (texture: string, model: BlockModel) => {
			const key = texture.startsWith("#") ? texture.slice(1) : texture;
			return model.textures?.[key] || texture;
		},
		getTextureAtlas: () => null,
		getMaterial: async (_texture: string, options: { tint?: THREE.Color }) =>
			new THREE.MeshStandardMaterial({
				color: options.tint || 0xffffff,
				transparent: true,
				alphaTest: 0.01,
			}),
	};
}

describe("resource-pack compatibility fixes", () => {
	it("uses inferred foliage and the dedicated dry-foliage colormap", () => {
		const manager = new TintManager();
		manager.setColormaps(imageData(10, 20, 30), imageData(40, 50, 60), imageData(70, 80, 90));

		const foliage = manager.getTint("minecraft:pale_oak_leaves", {}, "plains");
		const dryFoliage = manager.getTint("minecraft:leaf_litter", {}, "plains");
		expect([foliage.r, foliage.g, foliage.b]).toEqual([40 / 255, 50 / 255, 60 / 255]);
		expect([dryFoliage.r, dryFoliage.g, dryFoliage.b]).toEqual([70 / 255, 80 / 255, 90 / 255]);
		expect(manager.isTintable("minecraft:bush")).toBe(true);
		expect(manager.isTintable("minecraft:dead_bush")).toBe(false);
	});

	it("resolves symbolic texture keys even when a model omits #", () => {
		const loader = new AssetLoader(false);
		const model: BlockModel = {
			textures: { side: "#base", base: "minecraft:block/oak_planks" },
		};

		expect(loader.resolveTexture("side", model)).toBe("block/oak_planks");
	});

	it("does not mistake water cauldron models for synthetic water models", async () => {
		const loader = new AssetLoader(false);
		vi.spyOn(loader, "getResourceString").mockResolvedValue(
			JSON.stringify({ textures: { all: "block/cauldron_inner" } })
		);

		const model = await loader.getModel("block/water_cauldron");
		expect(model.textures?.all).toBe("block/cauldron_inner");
	});

	it("supports recursively nested multipart AND/OR conditions", async () => {
		const assetLoader = {
			getBlockState: vi.fn().mockResolvedValue({
				multipart: [
					{
						when: {
							AND: [
								{ facing: "north|south" },
								{ OR: [{ powered: "true" }, { waterlogged: "true" }] },
							],
						},
						apply: { model: "block/nested_match" },
					},
				],
			}),
		};
		const resolver = new ModelResolver(assetLoader as unknown as AssetLoader);

		await expect(
			resolver.resolveBlockModel({
				namespace: "minecraft",
				name: "test",
				properties: { facing: "north", powered: "false", waterlogged: "true" },
			})
		).resolves.toEqual([
			{ model: "block/nested_match", x: undefined, y: undefined, uvlock: undefined },
		]);
	});
});

describe("block model geometry compatibility fixes", () => {
	it("uses vanilla implicit UVs in indexed and optimized geometry", async () => {
		const builder = new BlockMeshBuilder(createAssetLoaderStub() as unknown as AssetLoader);
		const model: BlockModel = {
			elements: [
				{
					from: [2, 4, 6],
					to: [10, 12, 14],
					faces: { north: { texture: "block/stone" } },
				},
			],
		};
		const expected = [0.375, 0.75, 0.875, 0.75, 0.375, 0.25, 0.875, 0.25];

		const optimized = await builder.createOptimizedFaceData(model);
		expect(Array.from(optimized.nonCullableFaces[0].geometry.attributes.uv.array)).toEqual(
			expected
		);

		const indexed = await builder.createBlockMeshNoWater(model);
		const indexedMesh = indexed.children[0] as THREE.Mesh;
		expect(Array.from(indexedMesh.geometry.attributes.uv.array)).toEqual(expected);
	});

	it("keeps paired planes single-sided and unpaired cutouts double-sided", async () => {
		const builder = new BlockMeshBuilder(createAssetLoaderStub() as unknown as AssetLoader);
		const paired = await builder.createOptimizedFaceData({
			elements: [
				{
					from: [0, 8, 0],
					to: [16, 8, 16],
					faces: {
						up: { texture: "block/oak_planks" },
						down: { texture: "block/oak_planks" },
					},
				},
			],
		});
		const unpaired = await builder.createOptimizedFaceData({
			elements: [
				{
					from: [0, 8, 0],
					to: [16, 8, 16],
					faces: { up: { texture: "block/oak_planks" } },
				},
			],
		});

		expect(paired.nonCullableFaces.every((face) => face.material.side === THREE.FrontSide)).toBe(
			true
		);
		expect(unpaired.nonCullableFaces[0].material.side).toBe(THREE.DoubleSide);
	});

	it("propagates light emission through optimized and indexed materials", async () => {
		const builder = new BlockMeshBuilder(createAssetLoaderStub() as unknown as AssetLoader);
		const model: BlockModel = {
			elements: [
				{
					from: [0, 0, 0],
					to: [16, 16, 16],
					light_emission: 15,
					faces: { up: { texture: "block/lamp" } },
				},
			],
		};

		const optimized = await builder.createOptimizedFaceData(model);
		const optimizedMaterial = optimized.nonCullableFaces[0].material as THREE.MeshStandardMaterial;
		expect(optimizedMaterial.emissiveIntensity).toBe(1);
		expect(optimizedMaterial.depthWrite).toBe(true);

		const indexed = await builder.createBlockMeshNoWater(model);
		const indexedMaterial = (indexed.children[0] as THREE.Mesh)
			.material as THREE.MeshStandardMaterial;
		expect(indexedMaterial.emissiveIntensity).toBe(1);
		expect(indexedMaterial.depthWrite).toBe(true);
	});

	it("applies water tint to water textures inside cauldron models", async () => {
		const assets = createAssetLoaderStub();
		const builder = new BlockMeshBuilder(assets as unknown as AssetLoader);
		await builder.createOptimizedFaceData(
			{
				elements: [
					{
						from: [2, 4, 2],
						to: [14, 8, 14],
						faces: { up: { texture: "block/water_still", tintindex: 0 } },
					},
				],
			},
			{},
			{ namespace: "minecraft", name: "water_cauldron", properties: { level: "3" } }
		);

		expect(assets.getTint).toHaveBeenCalledWith("minecraft:water", { level: "3" }, "plains");
	});

	it("forces mangrove log root textures into the opaque queue", async () => {
		const builder = new BlockMeshBuilder(createAssetLoaderStub() as unknown as AssetLoader);
		const result = await builder.createOptimizedFaceData({
			elements: [
				{
					from: [0, 0, 0],
					to: [16, 16, 16],
					faces: { up: { texture: "block/mangrove_log_top" } },
				},
			],
		});

		expect(result.nonCullableFaces[0].material.transparent).toBe(false);
		expect(result.nonCullableFaces[0].material.alphaTest).toBe(0);
	});
});

describe("occlusion rotation compatibility", () => {
	it("rotates face flags for blockstate x/y rotations", () => {
		const builder = Object.create(WorldMeshBuilder.prototype) as WorldMeshBuilder;
		const rotate = (
			builder as unknown as {
				rotateOcclusionFlags(flags: number, rotation: { x?: number; y?: number }): number;
			}
		).rotateOcclusionFlags.bind(builder);

		expect(rotate(1 << 4, { y: 90 })).toBe(1 << 1);
		expect(rotate(1 << 3, { x: 90 })).toBe(1 << 4);
		expect(rotate(1 << 4, { y: 45 })).toBe(0);
	});
});

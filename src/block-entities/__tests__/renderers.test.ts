import { Group } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	normalizeBannerPatternName,
	resolveBannerDyeColor,
	selectBanners,
} from "../renderers/banners.js";
import {
	resolveCopperChest,
	resolveCopperChestStage,
	selectCopperChests,
} from "../renderers/copper-chests.js";
import {
	decoratedPotFacingRotation,
	decoratedPotTextureForSherd,
	mapDecoratedPotSherds,
	selectDecoratedPots,
} from "../renderers/decorated-pots.js";
import {
	createCustomPlayerHeadOverlay,
	CUSTOM_HEAD_TEXTURE_LOAD_BUDGET_MS,
	selectCustomPlayerHeadsFromSchematic,
} from "../renderers/player-heads.js";
import {
	resolveShulkerBox,
	resolveShulkerBoxTexture,
	selectShulkerBoxes,
} from "../renderers/shulker-boxes.js";
import { captureSchematicBlockEntitySnapshot } from "../snapshot.js";

afterEach(() => {
	vi.useRealTimers();
});

function playerHeadWrapper() {
	return {
		get_palette: () => ["minecraft:player_head[rotation=4]"],
		blocks_indices: () => [[4, 5, 6, 0]],
		get_all_block_entities: () => [
			{
				NBT: {
					id: "minecraft:skull",
					Pos: [4, 5, 6],
					profile: { name: "Builder" },
				},
			},
		],
	};
}

describe("block-entity renderer selectors", () => {
	it("maps waxed copper chests to oxidation textures and double models", () => {
		expect(resolveCopperChestStage("minecraft:waxed_weathered_copper_chest")).toBe("weathered");
		expect(
			resolveCopperChest(
				{
					name: "minecraft:waxed_weathered_copper_chest",
					properties: { type: "left", facing: "east" },
				},
				[1, 2, 3]
			)
		).toMatchObject({
			model: "chest_left",
			texturePath: "entity/chest/copper_weathered_left",
			rotationY: -Math.PI / 2,
		});
	});

	it("keeps undyed shulkers distinct and resolves every facing", () => {
		expect(resolveShulkerBoxTexture("undyed")).toBe("entity/shulker/shulker");
		expect(
			resolveShulkerBox(
				{ name: "minecraft:red_shulker_box", properties: { facing: "west" } },
				[0, 0, 0]
			)
		).toMatchObject({
			variant: "red",
			texturePath: "entity/shulker/shulker_red",
			rotationEuler: [0, 0, Math.PI / 2],
		});
	});

	it("maps decorated-pot sherds with bounded vanilla names", () => {
		expect(decoratedPotTextureForSherd("minecraft:angler_pottery_sherd")).toBe(
			"entity/decorated_pot/angler_pottery_pattern"
		);
		expect(mapDecoratedPotSherds(["minecraft:brick"])).toHaveLength(4);
		expect(decoratedPotFacingRotation("west")).toBe(Math.PI / 2);
	});

	it("normalizes banner dye and namespaced pattern values", () => {
		expect(resolveBannerDyeColor("light_blue")).toBe("light_blue");
		expect(normalizeBannerPatternName("minecraft:stripe_top")).toBe("stripe_top");
		expect(normalizeBannerPatternName("../../bad")).toBeNull();
	});

	it("selects built-ins from shared normalized indexes without rescanning raw collections", () => {
		const snapshot = captureSchematicBlockEntitySnapshot({
			get_palette: () => [
				"minecraft:red_banner[rotation=2]",
				"minecraft:decorated_pot[facing=west]",
				"minecraft:waxed_weathered_copper_chest[type=left,facing=east]",
				"minecraft:red_shulker_box[facing=west]",
			],
			blocks_indices: () => [
				[1, 2, 3, 0],
				[4, 5, 6, 1],
				[7, 8, 9, 2],
				[10, 11, 12, 3],
			],
			get_all_block_entities: () => [
				{
					Nbt: {
						Id: "minecraft:banner",
						Pos: [1, 2, 3],
						Patterns: [{ Pattern: "bs", Color: 14 }],
					},
				},
				{
					Nbt: {
						id: "minecraft:decorated_pot",
						Pos: [4, 5, 6],
						sherds: ["minecraft:angler_pottery_sherd"],
					},
				},
			],
		});

		// Renderer selectors must use indexes captured once, not rescan these raw arrays.
		snapshot.palette = [];
		snapshot.blocks = [];
		snapshot.entities = [];

		expect(selectBanners(snapshot)).toEqual([
			expect.objectContaining({
				position: [1, 2, 3],
				baseColor: "red",
				patterns: [{ pattern: "stripe_bottom", color: "red" }],
			}),
		]);
		expect(selectDecoratedPots(snapshot)).toEqual([
			expect.objectContaining({
				position: [4, 5, 6],
				rotationY: Math.PI / 2,
				sideTextures: [
					"entity/decorated_pot/angler_pottery_pattern",
					"entity/decorated_pot/decorated_pot_side",
					"entity/decorated_pot/decorated_pot_side",
					"entity/decorated_pot/decorated_pot_side",
				],
			}),
		]);
		expect(selectCopperChests(snapshot)).toEqual([
			expect.objectContaining({
				position: [7, 8, 9],
				stage: "weathered",
				model: "chest_left",
			}),
		]);
		expect(selectShulkerBoxes(snapshot)).toEqual([
			expect.objectContaining({
				position: [10, 11, 12],
				variant: "red",
				rotationEuler: [0, 0, Math.PI / 2],
			}),
		]);
	});

	it("selects player heads from normalized uppercase NBT", () => {
		const wrapper = playerHeadWrapper();
		const snapshot = captureSchematicBlockEntitySnapshot(wrapper);
		const inaccessible = new Proxy([], {
			get() {
				throw new Error("raw snapshot array was read");
			},
		});
		Object.assign(snapshot, {
			palette: inaccessible,
			blocks: inaccessible,
			entities: inaccessible,
		});

		expect(selectCustomPlayerHeadsFromSchematic(wrapper, snapshot)).toEqual([
			expect.objectContaining({
				position: [4, 5, 6],
				profileIdentifier: "Builder",
				rotationY: -Math.PI / 2,
			}),
		]);
	});

	it("stops waiting when a player-head resolver ignores its timeout signal", async () => {
		vi.useFakeTimers();
		const wrapper = playerHeadWrapper();
		const group = new Group();
		const lateResolvers: Array<(value: Blob | null) => void> = [];
		const resolver = vi.fn(
			() =>
				new Promise<Blob | null>((resolve) => {
					lateResolvers.push(resolve);
				})
		);

		const pending = createCustomPlayerHeadOverlay(
			{ group, schematicWrapper: wrapper },
			new AbortController().signal,
			captureSchematicBlockEntitySnapshot(wrapper),
			{ resolveTexture: resolver }
		);
		await vi.advanceTimersByTimeAsync(CUSTOM_HEAD_TEXTURE_LOAD_BUDGET_MS);
		const overlay = await pending;

		expect(resolver).toHaveBeenCalledTimes(2);
		expect(overlay.count).toBe(1);
		expect(group.children).toHaveLength(1);
		lateResolvers.forEach((resolve) => resolve(new Blob(["late"], { type: "image/png" })));
		await Promise.resolve();
		expect(group.children).toHaveLength(1);
		overlay.dispose();
		expect(group.children).toHaveLength(0);
	});

	it("stops waiting when a player-head resolver ignores parent cancellation", async () => {
		const wrapper = playerHeadWrapper();
		const group = new Group();
		const controller = new AbortController();
		const resolver = vi.fn(() => new Promise<Blob | null>(() => undefined));
		const pending = createCustomPlayerHeadOverlay(
			{ group, schematicWrapper: wrapper },
			controller.signal,
			captureSchematicBlockEntitySnapshot(wrapper),
			{ resolveTexture: resolver }
		);

		controller.abort();
		const overlay = await pending;
		expect(overlay.count).toBe(0);
		expect(group.children).toHaveLength(0);
	});
});

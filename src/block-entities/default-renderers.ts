import type { BlockEntityRenderer } from "./registry.js";
import { createBannerOverlay, BANNER_DYE_COLOR_NAMES } from "./renderers/banners.js";
import { COPPER_CHEST_BLOCK_IDS, createCopperChestOverlay } from "./renderers/copper-chests.js";
import { createDecoratedPotOverlay } from "./renderers/decorated-pots.js";
import {
	createCustomPlayerHeadOverlay,
	type CustomPlayerHeadRendererOptions,
} from "./renderers/player-heads.js";
import { createShulkerBoxOverlay, SHULKER_BOX_BLOCK_IDS } from "./renderers/shulker-boxes.js";

export interface DefaultBlockEntityRendererOptions {
	playerHeads?: CustomPlayerHeadRendererOptions;
}

const BANNER_BLOCK_IDS = BANNER_DYE_COLOR_NAMES.flatMap((color) => [
	`minecraft:${color}_banner`,
	`minecraft:${color}_wall_banner`,
]);

export function createDefaultBlockEntityRenderers(
	options: DefaultBlockEntityRendererOptions = {}
): BlockEntityRenderer[] {
	return [
		{
			id: "player-heads",
			blockIds: ["minecraft:player_head", "minecraft:player_wall_head"],
			blockEntityIds: ["minecraft:skull", "minecraft:player_head"],
			render: ({ schematic, signal, snapshot }) =>
				createCustomPlayerHeadOverlay(schematic, signal, snapshot, options.playerHeads),
		},
		{
			id: "decorated-pots",
			blockIds: ["minecraft:decorated_pot"],
			blockEntityIds: ["minecraft:decorated_pot"],
			render: ({ schematic, signal, snapshot, resources }) =>
				createDecoratedPotOverlay(schematic, signal, snapshot, resources),
		},
		{
			id: "copper-chests",
			blockIds: COPPER_CHEST_BLOCK_IDS,
			render: ({ schematic, signal, snapshot, resources }) =>
				createCopperChestOverlay(schematic, signal, snapshot, resources),
		},
		{
			id: "shulker-boxes",
			blockIds: SHULKER_BOX_BLOCK_IDS,
			blockEntityIds: ["minecraft:shulker_box"],
			render: ({ schematic, signal, snapshot, resources }) =>
				createShulkerBoxOverlay(schematic, signal, snapshot, resources),
		},
		{
			id: "banners",
			blockIds: BANNER_BLOCK_IDS,
			blockEntityIds: ["minecraft:banner"],
			render: ({ schematic, signal, snapshot, resources }) =>
				createBannerOverlay(schematic, signal, snapshot, resources),
		},
	];
}

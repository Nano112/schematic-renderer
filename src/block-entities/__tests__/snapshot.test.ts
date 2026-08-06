import { describe, expect, it, vi } from "vitest";

import { captureSchematicBlockEntitySnapshot, parsePaletteBlockState } from "../snapshot.js";

describe("captureSchematicBlockEntitySnapshot", () => {
	it("reads each wrapper collection once and builds shared indexes", () => {
		const wrapper = {
			get_palette: vi.fn(() => ["minecraft:stone", "minecraft:red_banner[rotation=3]"]),
			blocks_indices: vi.fn(() => [[0, 0, 0, 0], new Int32Array([2, 3, 4, 1])]),
			get_all_block_entities: vi.fn(() => [
				{
					id: "minecraft:banner",
					position: [2, 3, 4],
					nbt: { Id: "minecraft:banner", Pos: [2, 3, 4] },
				},
			]),
		};

		const snapshot = captureSchematicBlockEntitySnapshot(wrapper);

		expect(wrapper.get_palette).toHaveBeenCalledOnce();
		expect(wrapper.blocks_indices).toHaveBeenCalledOnce();
		expect(wrapper.get_all_block_entities).toHaveBeenCalledOnce();
		expect(snapshot.indexedBlocks).toHaveLength(2);
		expect(snapshot.indexedEntities).toHaveLength(1);
		expect(snapshot.hasBlockId("minecraft:red_banner")).toBe(true);
		expect(snapshot.hasEntityId("minecraft:banner")).toBe(true);
		expect(snapshot.blockStateAt([2, 3, 4])).toEqual({
			name: "minecraft:red_banner",
			properties: { rotation: "3" },
		});
		expect(snapshot.entitiesByPosition.get("2,3,4")).toHaveLength(1);
	});

	it("isolates wrapper read failures and enforces capture limits", () => {
		const errors: string[] = [];
		const snapshot = captureSchematicBlockEntitySnapshot(
			{
				get_palette: () => {
					throw new Error("bad palette");
				},
				blocks_indices: () => [[0, 0, 0, 0]],
				get_all_block_entities: () => [{ id: "one" }, { id: "two" }],
			},
			{
				maxBlockEntities: 1,
				onReadError: (label) => errors.push(label),
			}
		);

		expect(errors).toEqual(["Block palette"]);
		expect(snapshot.palette).toEqual([]);
		expect(snapshot.entities).toHaveLength(1);
		expect(snapshot.indexedBlocks).toEqual([]);
	});

	it("normalizes uppercase NBT wrappers and NBT-only positions", () => {
		const snapshot = captureSchematicBlockEntitySnapshot({
			get_all_block_entities: () => [
				{
					NBT: {
						id: "minecraft:skull",
						Pos: [4, 5, 6],
						profile: { name: "Builder" },
					},
				},
			],
		});

		expect(snapshot.indexedEntities).toHaveLength(1);
		expect(snapshot.indexedEntities[0]).toMatchObject({
			id: "minecraft:skull",
			position: [4, 5, 6],
			nbt: { profile: { name: "Builder" } },
		});
		expect(snapshot.entitiesByPosition.get("4,5,6")).toHaveLength(1);
	});
});

describe("parsePaletteBlockState", () => {
	it("normalizes string and object palette formats", () => {
		expect(parsePaletteBlockState("minecraft:oak_log[axis=x]")).toEqual({
			name: "minecraft:oak_log",
			properties: { axis: "x" },
		});
		expect(
			parsePaletteBlockState({
				Name: "minecraft:chest",
				Properties: { facing: "west", waterlogged: false },
			})
		).toEqual({
			name: "minecraft:chest",
			properties: { facing: "west", waterlogged: "false" },
		});
	});
});

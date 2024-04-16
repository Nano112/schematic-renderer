import * as THREE from "three";

import { BlockMeshBuilder } from "./block_mesh_builder";
import { INVISIBLE_BLOCKS, TRANSPARENT_BLOCKS } from "./utils";

export class WorldMeshBuilder {
	schematic: any;
	blockMeshBuilder: any;
	ressourceLoader: any;
	progressController: any;

	constructor(ressourceLoader: any, progressController: any) {
		this.ressourceLoader = ressourceLoader;
		this.progressController = progressController;
		this.blockMeshBuilder = new BlockMeshBuilder(ressourceLoader);
	}

	public setSchematic(schematic: any) {
		this.schematic = schematic;
		this.blockMeshBuilder.setSchematic(schematic);
	}

	public splitSchemaIntoChunks(
		dimensions = { chunkWidth: 64, chunkHeight: 64, chunkLength: 64 }
	) {
		const chunks: any[] = [];
		const { chunkWidth, chunkHeight, chunkLength } = dimensions;
		const { width, height, length } = this.schematic;
		const chunkCountX = Math.ceil(width / chunkWidth);
		const chunkCountY = Math.ceil(height / chunkHeight);
		const chunkCountZ = Math.ceil(length / chunkLength);
		for (const pos of this.schematic) {
			const { x, y, z } = pos;
			const chunkX = Math.floor(x / chunkWidth);
			const chunkY = Math.floor(y / chunkHeight);
			const chunkZ = Math.floor(z / chunkLength);
			const chunkIndex =
				chunkX + chunkY * chunkCountX + chunkZ * chunkCountX * chunkCountY;
			if (!chunks[chunkIndex]) {
				chunks[chunkIndex] = [];
			}
			chunks[chunkIndex].push(pos);
		}
		return chunks;
	}

	public async processChunkBlocks(
		materialGroups: any,
		chunk: any,
		chunkDimensions: any,
		offset: { x: number; y: number; z: number }
	) {
		const maxBlocksAllowed = 1000000;
		let count = 0;
		for (const pos of chunk) {
			if (count > maxBlocksAllowed) {
				break;
			}
			const { x, y, z } = pos;
			const block = this.schematic.getBlock(pos);
			if (INVISIBLE_BLOCKS.has(block.type)) {
				continue;
			}
			//console.log("position", pos, " block", block);

			const blockComponents = await this.blockMeshBuilder.getBlockMeshFromCache(
				block
			);
			const rotatedBlockComponents =
				this.blockMeshBuilder.rotateBlockComponents(
					blockComponents,
					block.properties?.["facing"]
				);

			const occludedFaces = this.blockMeshBuilder.getOccludedFacesForBlock(
				block.type,
				pos
			);

			for (const key in rotatedBlockComponents) {
				this.ressourceLoader.addBlockToMaterialGroup(
					materialGroups,
					rotatedBlockComponents[key],
					occludedFaces,
					x,
					y,
					z,
					offset ?? { x: 0, y: 0, z: 0 }
				);
			}
			count++;
		}
	}

	public isSolid(x: number, y: number, z: number) {
		const block = this.schematic.getBlock(new THREE.Vector3(x, y, z));
		return block && !TRANSPARENT_BLOCKS.has(block.type);
	}

	public initializeMeshCreation() {
		if (this.schematic === undefined) {
			return { materialGroups: null };
		}
		const worldWidth = this.schematic.width;
		const worldHeight = this.schematic.height;
		const worldLength = this.schematic.length;
		// const offset = new THREE.Vector3(-worldWidth / 2, 0, -worldLength / 2);
		const offset = { x: 0, y: 0, z: 0 };
		return { worldWidth, worldHeight, worldLength, offset };
	}

	public async getSchematicMeshes(
		chunkDimensions = { chunkWidth: 16, chunkHeight: 16, chunkLength: 16 }
	) {
		const { worldWidth, worldHeight, worldLength, offset } =
			this.initializeMeshCreation();
		const chunks = await this.splitSchemaIntoChunks({
			chunkWidth: 64,
			chunkHeight: 64,
			chunkLength: 64,
		});
		const chunkMeshes = [];
		const totalChunks = chunks.length;
		let currentChunk = 0;
		for (const chunk of chunks) {
			//console.log(`Processing chunk ${currentChunk} of ${totalChunks}`);
			this.progressController?.setProgress((currentChunk / totalChunks) * 100);
			this.progressController?.setProgressMessage(
				`Processing chunk ${currentChunk} of ${totalChunks}`
			);
			currentChunk++;
			const materialGroups = {};
			await this.processChunkBlocks(
				materialGroups,
				chunk,
				chunkDimensions,
				offset ?? { x: 0, y: 0, z: 0 }
			);
			chunkMeshes.push(
				...this.ressourceLoader.createMeshesFromMaterialGroups(materialGroups)
			);
		}
		return chunkMeshes;
	}
}
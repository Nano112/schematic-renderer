// tests/mesh_builder_benchmark.ts
import * as THREE from "three";
import { loadSchematic } from "@enginehub/schematicjs";
import { parseNbtFromBase64 } from "../src/utils";
import { ResourceLoader } from "../src/resource_loader";
import { WorldMeshBuilder } from "../src/world_mesh_builder";
import { performance } from "perf_hooks";

async function runMeshBuildingBenchmark(schematicData: string, jarFilePath: string) {
  const parsedNbt = parseNbtFromBase64(schematicData);
  const loadedSchematic = loadSchematic(parsedNbt);

  const materialMap = new Map<string, THREE.Material>();
  const resourceLoader = new ResourceLoader(jarFilePath, undefined, materialMap);
  await resourceLoader.initialize();

  const worldMeshBuilder = new WorldMeshBuilder(resourceLoader, undefined, materialMap);
  resourceLoader.setSchematic(loadedSchematic);
  worldMeshBuilder.setSchematic(loadedSchematic);

  const startTime = performance.now();
  const schematicMeshes = await worldMeshBuilder.getSchematicMeshes();
  const endTime = performance.now();

  const buildTime = endTime - startTime;
  console.log(`Mesh building time: ${buildTime} milliseconds`);
  console.log(`Number of meshes built: ${schematicMeshes.length}`);
}




const jarFilePath = "./client.jar";

runMeshBuildingBenchmark(schematicData, jarFilePath)
  .then(() => {
    console.log("Benchmark completed.");
  })
  .catch((error) => {
    console.error("Error running benchmark:", error);
  });
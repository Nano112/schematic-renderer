import type {
	BlockEntityResources,
	BlockEntitySchematic,
	CaptureSnapshotOptions,
	SchematicBlockEntitySnapshot,
} from "./snapshot.js";
import { captureSchematicBlockEntitySnapshot } from "./snapshot.js";

export interface BlockEntityOverlay {
	count: number;
	dispose(): void;
}

export interface BlockEntityRenderContext {
	schematic: BlockEntitySchematic;
	snapshot: SchematicBlockEntitySnapshot;
	resources: BlockEntityResources;
	signal: AbortSignal;
}

export interface BlockEntityRenderer {
	/** Stable extension identifier, not a Minecraft block ID. */
	id: string;
	/** Renderer runs when at least one listed palette ID is present. */
	blockIds?: readonly string[];
	/** Renderer runs when at least one listed normalized block-entity ID is present. */
	blockEntityIds?: readonly string[];
	/** Optional matcher for families or NBT-dependent support. */
	matches?: (snapshot: SchematicBlockEntitySnapshot) => boolean;
	render(context: BlockEntityRenderContext): Promise<BlockEntityOverlay | null | void>;
}

export interface RenderBlockEntitiesOptions {
	snapshot?: SchematicBlockEntitySnapshot;
	snapshotOptions?: CaptureSnapshotOptions;
	onError?: (rendererId: string, error: unknown) => void;
}

const EMPTY_OVERLAY: BlockEntityOverlay = Object.freeze({
	count: 0,
	dispose: () => undefined,
});

function rendererMatches(
	renderer: BlockEntityRenderer,
	snapshot: SchematicBlockEntitySnapshot
): boolean {
	const hasDeclaredIds =
		(renderer.blockIds?.length ?? 0) > 0 || (renderer.blockEntityIds?.length ?? 0) > 0;
	const idMatch =
		renderer.blockIds?.some((id) => snapshot.hasBlockId(id)) === true ||
		renderer.blockEntityIds?.some((id) => snapshot.hasEntityId(id)) === true;
	if (hasDeclaredIds && !idMatch) return false;
	return renderer.matches?.(snapshot) ?? true;
}

function reportError(
	onError: RenderBlockEntitiesOptions["onError"],
	rendererId: string,
	error: unknown
): void {
	if (onError === undefined) {
		console.warn(`[schematic-renderer] Block-entity renderer ${rendererId} failed.`, error);
		return;
	}
	try {
		onError(rendererId, error);
	} catch (callbackError) {
		console.warn(
			`[schematic-renderer] Block-entity error callback failed for ${rendererId}.`,
			callbackError
		);
	}
}

/**
 * Registry is intentionally independent from SchematicRenderer lifecycle.
 * Integration can create one registry per renderer/context and call render()
 * after the block mesh is ready.
 */
export class BlockEntityRendererRegistry {
	private readonly renderers = new Map<string, BlockEntityRenderer>();

	public constructor(renderers: readonly BlockEntityRenderer[] = []) {
		for (const renderer of renderers) this.register(renderer);
	}

	public register(renderer: BlockEntityRenderer): () => void {
		if (renderer.id.trim().length === 0) {
			throw new Error("Block-entity renderer id must not be empty");
		}
		if (this.renderers.has(renderer.id)) {
			throw new Error(`Block-entity renderer "${renderer.id}" is already registered`);
		}
		this.renderers.set(renderer.id, renderer);
		return () => {
			if (this.renderers.get(renderer.id) === renderer) this.renderers.delete(renderer.id);
		};
	}

	public unregister(rendererId: string): boolean {
		return this.renderers.delete(rendererId);
	}

	public has(rendererId: string): boolean {
		return this.renderers.has(rendererId);
	}

	public get size(): number {
		return this.renderers.size;
	}

	public async render(
		schematic: BlockEntitySchematic,
		resources: BlockEntityResources,
		signal: AbortSignal,
		options: RenderBlockEntitiesOptions = {}
	): Promise<BlockEntityOverlay> {
		if (signal.aborted) return EMPTY_OVERLAY;
		const snapshot =
			options.snapshot ??
			captureSchematicBlockEntitySnapshot(schematic.schematicWrapper, options.snapshotOptions);
		const selected = [...this.renderers.values()].filter((renderer) => {
			try {
				return rendererMatches(renderer, snapshot);
			} catch (error) {
				reportError(options.onError, renderer.id, error);
				return false;
			}
		});
		if (selected.length === 0) return EMPTY_OVERLAY;

		type OverlayEntry = { rendererId: string; overlay: BlockEntityOverlay };
		const overlays: OverlayEntry[] = [];
		const disposedOverlays = new Set<BlockEntityOverlay>();
		let disposed = false;
		let resolveAbort!: () => void;
		const aborted = new Promise<void>((resolve) => {
			resolveAbort = resolve;
		});
		const disposeOverlay = (entry: OverlayEntry) => {
			if (disposedOverlays.has(entry.overlay)) return;
			disposedOverlays.add(entry.overlay);
			try {
				entry.overlay.dispose();
			} catch (error) {
				reportError(options.onError, entry.rendererId, error);
			}
		};
		const dispose = () => {
			if (disposed) return;
			disposed = true;
			signal.removeEventListener("abort", abort);
			for (let index = overlays.length - 1; index >= 0; index -= 1) {
				const entry = overlays[index];
				if (entry !== undefined) disposeOverlay(entry);
			}
		};
		const abort = () => {
			dispose();
			resolveAbort();
		};
		signal.addEventListener("abort", abort, { once: true });
		// The signal can flip between the initial check and listener registration.
		if (signal.aborted) abort();

		const renderersFinished = Promise.all(
			selected.map(async (renderer) => {
				if (signal.aborted || disposed) return;
				try {
					const overlay = await renderer.render({
						schematic,
						snapshot,
						resources,
						signal,
					});
					if (overlay === undefined || overlay === null) return;
					const entry = { rendererId: renderer.id, overlay };
					if (signal.aborted || disposed) disposeOverlay(entry);
					else overlays.push(entry);
				} catch (error) {
					if (!signal.aborted && !disposed) reportError(options.onError, renderer.id, error);
				}
			})
		);

		// Abort must not depend on third-party renderers honoring the signal. Their
		// promises retain a completion handler that disposes any eventual late result.
		const outcome = await Promise.race([
			renderersFinished.then(() => "complete" as const),
			aborted.then(() => "aborted" as const),
		]);
		if (outcome === "aborted" || signal.aborted) {
			dispose();
			return EMPTY_OVERLAY;
		}

		return {
			count: overlays.reduce((total, entry) => total + entry.overlay.count, 0),
			dispose,
		};
	}
}

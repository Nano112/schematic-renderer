export { SchematicRenderer } from "./SchematicRenderer";
export { SchematicRendererContext } from "./SchematicRendererContext";
export { DiffViewer } from "./diff/DiffViewer";
export type {
	DiffMode,
	DiffViewMode,
	DiffState,
	DiffStats,
	DiffViewerColors,
	DiffViewerOptions,
} from "./diff/DiffViewer";
export { KeyframeTrack } from "./camera/KeyframeTrack";
export type { InterpolationMode, CameraKeyframe, KeyframeResult } from "./camera/KeyframeTrack";
export { SimulationManager } from "./managers/SimulationManager";
export { SimulationLogger } from "./utils/SimulationLogger";
export { CustomIoHighlight } from "./managers/highlight/CustomIoHighlight";
export { InsignManager } from "./managers/InsignManager";
export { InsignIoManager } from "./managers/InsignIoManager";
export { OverlayManager } from "./managers/OverlayManager";
export { InsignRegionHighlight } from "./managers/highlight/InsignRegionHighlight";
export { InsignIoHoverHandler } from "./managers/highlight/InsignIoHoverHandler";
export { KeyboardControls } from "./managers/KeyboardControls";
export type { KeybindConfig } from "./managers/KeyboardControls";
export { FlyControls } from "./managers/FlyControls";
export type { FlyControlsOptions, FlyControlsKeybinds } from "./managers/FlyControls";
export { InspectorManager } from "./managers/InspectorManager";
export { ResourcePackManagerProxy } from "./managers/ResourcePackManagerProxy";
export * from "./block-entities/index";
// Sidebar UI exports
export { SidebarManager } from "./ui/sidebar/SidebarManager";
export { UnifiedSidebar } from "./ui/sidebar/UnifiedSidebar";
export { KeyboardShortcutManager } from "./ui/sidebar/KeyboardShortcutManager";
export { UIColors, UIStyles } from "./ui/UIComponents";

// Panel exports
export { BasePanel } from "./ui/panels/BasePanel";
export { ControlsPanel } from "./ui/panels/ControlsPanel";
export { RenderSettingsPanel } from "./ui/panels/RenderSettingsPanel";
export { CapturePanel } from "./ui/panels/CapturePanel";
export { ExportPanel } from "./ui/panels/ExportPanel";
export { ResourcePackPanel } from "./ui/panels/ResourcePackPanel";
export { PerformancePanel } from "./ui/panels/PerformancePanel";
export { SchematicExporter } from "./export/SchematicExporter";
export type { SimulationConfig, SimulationState, SyncMode } from "./managers/SimulationManager";
export type {
	SchematicRendererOptions,
	KeyboardControlsOptions,
	DebugOptions,
	GPUComputeOptions,
	WasmMeshBuilderOptions,
	BlockEntityRenderingOptions,
} from "./SchematicRendererOptions";
export type {
	InsignRegionStyle,
	InsignRegionOptions,
} from "./managers/highlight/InsignRegionHighlight";
export type { InsignRegionFilter } from "./managers/InsignManager";
export type { InsignIoRegion, InsignIoFilter } from "./managers/InsignIoManager";
export type { InsignIoStyle } from "./managers/highlight/InsignIoHighlight";
export { InsignIoHighlight } from "./managers/highlight/InsignIoHighlight";
export type {
	OverlayContent,
	OverlaySection,
	OverlayItem,
	OverlayPosition,
} from "./managers/OverlayManager";
export type { DslMap, DslEntry, BoxPair } from "./types/insign";

// Export types
export type {
	ExportFormat,
	ExportQuality,
	ExportOptions,
	ExportProgress,
	ExportResult,
	ExportError,
	ExportErrorCode,
	ExportUIOptions,
	ExportPreset,
	ExportEventType,
	ExportEventMap,
	ExportEventHandler,
	ExportProgressCallback,
	ExportCompleteCallback,
	ExportErrorCallback,
	NormalMode,
	TextureMode,
	QualityPreset,
} from "./types/export";

// Sidebar types
export type {
	SidebarOptions,
	SidebarTabId,
	SidebarAction,
	SidebarPosition,
	SidebarTabConfig,
	KeyboardShortcut,
	KeyboardShortcutMap,
} from "./ui/sidebar/types";

// UI component types
export type { UIPosition } from "./ui/UIComponents";

// Resource pack types
export type {
	ResourcePackInfo,
	PackFetchOptions,
	PackValidationResult,
	PackConfig,
	AssetConflict,
	PackMemoryUsage,
	StoredResourcePack,
	PackEventMap as ResourcePackEventMap,
	PackEventType as ResourcePackEventType,
	PackEventHandler as ResourcePackEventHandler,
	ResourcePackOptions,
	PackAddedEvent,
	PackRemovedEvent,
	PackToggledEvent,
	PackOrderChangedEvent,
	PacksChangedEvent,
	AtlasRebuildingEvent,
	AtlasRebuiltEvent,
	LoadProgressEvent,
	LoadStartEvent,
	LoadCompleteEvent,
	LoadErrorEvent,
	PackErrorEvent,
} from "./types/resourcePack";

// Re-export nucleation to provide single WASM instance across the app
export * from "./nucleationExports";

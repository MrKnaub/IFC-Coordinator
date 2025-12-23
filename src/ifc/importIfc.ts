// src/ifc/importIfc.ts
import type { IfcViewerAPI } from "web-ifc-viewer";

export type NodeKind =
  | "Root"
  | "Project"
  | "Site"
  | "Building"
  | "Storey"
  | "ClassGroup"
  | "Object";

export type Pset = { name: string; props: Record<string, string> };

export type TreeNode = {
  id: string;
  kind: NodeKind;
  name: string;
  parentId?: string;
  children: string[];
  ifcClass?: string;
  tag?: string;
  psets?: Pset[];
  ifc?: {
    modelID: number;
    expressID: number;
    globalId?: string;
    type?: string; // e.g. IFCPROJECT
  };
};

type SpatialNode = {
  expressID: number;
  type: string; // "IFCPROJECT", "IFCSITE", ...
  children?: SpatialNode[];
};

function cloneNodes(nodes: Record<string, TreeNode>): Record<string, TreeNode> {
  // structuredClone is great, but not always available depending on target
  try {
    return structuredClone(nodes);
  } catch {
    return JSON.parse(JSON.stringify(nodes)) as Record<string, TreeNode>;
  }
}

function ensureNode(draft: Record<string, TreeNode>, id: string, fallback: TreeNode) {
  if (!draft[id]) draft[id] = fallback;
  if (!draft[id].children) draft[id].children = [];
}

function ensureChild(draft: Record<string, TreeNode>, parentId: string, childId: string) {
  const p = draft[parentId];
  if (!p) return;
  if (!p.children.includes(childId)) p.children.push(childId);
}

function mergePsets(oldPsets: Pset[], newPsets: Pset[]) {
  const map = new Map<string, Pset>();
  for (const p of oldPsets) map.set(p.name, { name: p.name, props: { ...(p.props ?? {}) } });
  for (const p of newPsets) {
    const cur = map.get(p.name);
    if (!cur) map.set(p.name, { name: p.name, props: { ...(p.props ?? {}) } });
    else map.set(p.name, { name: p.name, props: { ...cur.props, ...(p.props ?? {}) } });
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function upsertNode(draft: Record<string, TreeNode>, node: TreeNode) {
  const existing = draft[node.id];
  if (!existing) {
    draft[node.id] = node;
    return;
  }

  // Merge: keep user edits where possible
  draft[node.id] = {
    ...existing,
    ...node,
    name: existing.name || node.name,
    tag: existing.tag ?? node.tag,
    ifcClass: existing.ifcClass ?? node.ifcClass,
    psets: mergePsets(existing.psets ?? [], node.psets ?? []),
    // prefer existing children if they already exist (user might have reorganized)
    children: existing.children?.length ? existing.children : node.children,
  };
}

function asStringValue(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    if ("value" in v) return String((v as any).value ?? "");
    if ("Name" in v) return String((v as any).Name ?? "");
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

async function safeGetItemProps(mgr: any, modelID: number, expressID: number) {
  try {
    return await mgr.getItemProperties(modelID, expressID, true);
  } catch {
    return undefined;
  }
}

async function safeGetGlobalId(mgr: any, modelID: number, expressID: number): Promise<string | undefined> {
  const props = await safeGetItemProps(mgr, modelID, expressID);
  return props?.GlobalId?.value ?? props?.GlobalId;
}

async function safeGetName(mgr: any, modelID: number, expressID: number): Promise<string | undefined> {
  const props = await safeGetItemProps(mgr, modelID, expressID);
  return props?.Name?.value ?? props?.Name;
}

async function safeGetTag(mgr: any, modelID: number, expressID: number): Promise<string | undefined> {
  const props = await safeGetItemProps(mgr, modelID, expressID);
  return props?.Tag?.value ?? props?.Tag;
}

async function safeGetPsets(mgr: any, modelID: number, expressID: number): Promise<Pset[]> {
  try {
    const psets = await mgr.getPropertySets(modelID, expressID, true);
    const out: Pset[] = [];

    for (const ps of psets ?? []) {
      const psetName = asStringValue(ps?.Name) || asStringValue(ps?.Name?.value) || "Pset";
      const props: Record<string, string> = {};

      for (const p of ps?.HasProperties ?? []) {
        const key = asStringValue(p?.Name) || asStringValue(p?.Name?.value);
        if (!key) continue;

        const val =
          asStringValue(p?.NominalValue?.value) ||
          asStringValue(p?.NominalValue) ||
          asStringValue(p?.Description?.value) ||
          "";

        props[key] = val;
      }

      if (Object.keys(props).length) out.push({ name: psetName, props });
    }

    return out;
  } catch {
    return [];
  }
}

/**
 * Spatial types we keep as "spatial" nodes in our tree.
 */
function spatialKindFromIfcType(typeUpper: string): NodeKind | null {
  if (typeUpper === "IFCPROJECT") return "Project";
  if (typeUpper === "IFCSITE") return "Site";
  if (typeUpper === "IFCBUILDING") return "Building";
  if (typeUpper === "IFCBUILDINGSTOREY") return "Storey";
  return null;
}

/**
 * For MVP: keep good class names for the most common, fallback to IfcBuildingElementProxy.
 * Reason: IFC types are ALLCAPS without separators; converting to proper schema casing robustly
 * needs a dictionary or schema metadata.
 */
function ifcClassForElement(typeUpper: string): string {
  if (typeUpper === "IFCBUILDINGELEMENTPROXY") return "IfcBuildingElementProxy";
  // add more mappings here as you need them
  return "IfcBuildingElementProxy";
}

function stableSpatialId(kind: NodeKind, globalId: string | undefined, expressID: number) {
  const key = globalId ?? String(expressID);
  if (kind === "Project") return `ifc:project:${key}`;
  if (kind === "Site") return `ifc:site:${key}`;
  if (kind === "Building") return `ifc:building:${key}`;
  if (kind === "Storey") return `ifc:storey:${key}`;
  return `ifc:item:${key}`;
}

// --- public API ---
export async function importIfcIntoCoordinator(
  viewer: IfcViewerAPI,
  modelID: number,
  nodes: Record<string, TreeNode>
): Promise<Record<string, TreeNode>> {
  const mgr = (viewer as any)?.IFC?.loader?.ifcManager;
  if (!mgr) throw new Error("IfcManager not available: viewer.IFC.loader.ifcManager missing");

  const draft: Record<string, TreeNode> = cloneNodes(nodes);

  ensureNode(draft, "root", { id: "root", kind: "Root", name: "Workspace", children: [] });

  const spatial: SpatialNode = await mgr.getSpatialStructure(modelID);
  if (!spatial) return draft;

  async function ensureSyntheticStorey(buildingId: string) {
    const synthStoreyId = `ifc:storey:synthetic:${buildingId}`;
    if (!draft[synthStoreyId]) {
      upsertNode(draft, {
        id: synthStoreyId,
        kind: "Storey",
        name: "Storey 0",
        parentId: buildingId,
        children: [],
      });
      ensureChild(draft, buildingId, synthStoreyId);
    }
    return synthStoreyId;
  }

  async function ensureFallbackSpatialContainers() {
    const defaultProjectId = "ifc:project:default";
    if (!draft[defaultProjectId]) {
      upsertNode(draft, {
        id: defaultProjectId,
        kind: "Project",
        name: "Imported Project",
        parentId: "root",
        children: [],
      });
      ensureChild(draft, "root", defaultProjectId);
    }

    const synthBuildingId = `ifc:building:synthetic:${defaultProjectId}`;
    if (!draft[synthBuildingId]) {
      upsertNode(draft, {
        id: synthBuildingId,
        kind: "Building",
        name: "Building 0",
        parentId: defaultProjectId,
        children: [],
      });
      ensureChild(draft, defaultProjectId, synthBuildingId);
    }

    const synthStoreyId = await ensureSyntheticStorey(synthBuildingId);
    return { defaultProjectId, synthBuildingId, synthStoreyId };
  }

  async function walk(sp: SpatialNode, parentId: string | undefined, currentStoreyId?: string) {
    const typeUpper = (sp.type || "").toUpperCase();
    const expressID = sp.expressID;

    const globalId = await safeGetGlobalId(mgr, modelID, expressID);
    const name = (await safeGetName(mgr, modelID, expressID)) ?? typeUpper;
    const tag = await safeGetTag(mgr, modelID, expressID);
    const psets = await safeGetPsets(mgr, modelID, expressID);

    const kind = spatialKindFromIfcType(typeUpper);

    // parent defaults
    let resolvedParentId = parentId ?? "root";

    // Spatial nodes
    if (kind) {
      const myId = stableSpatialId(kind, globalId, expressID);

      // special: project always under root
      if (kind === "Project") resolvedParentId = "root";

      ensureNode(draft, resolvedParentId, { id: resolvedParentId, kind: "Root", name: "Workspace", children: [] });

      upsertNode(draft, {
        id: myId,
        kind,
        name: name || kind,
        parentId: resolvedParentId,
        children: [],
        ifc: { modelID, expressID, globalId, type: typeUpper },
      });

      ensureChild(draft, resolvedParentId, myId);

      const nextStoreyId = kind === "Storey" ? myId : currentStoreyId;

      for (const ch of sp.children ?? []) {
        await walk(ch, myId, nextStoreyId);
      }
      return;
    }

    // Non-spatial items -> create Object under current storey (or synthesize one)
    let storeyId = currentStoreyId;

    if (!storeyId) {
      const parent = resolvedParentId ? draft[resolvedParentId] : undefined;

      const buildingId =
        parent?.kind === "Building"
          ? parent.id
          : parent?.parentId && draft[parent.parentId]?.kind === "Building"
            ? parent.parentId
            : undefined;

      if (buildingId) {
        storeyId = await ensureSyntheticStorey(buildingId);
      } else {
        const fallback = await ensureFallbackSpatialContainers();
        storeyId = fallback.synthStoreyId;
      }
    }

    // ClassGroup inside storey
    const className = ifcClassForElement(typeUpper);
    const classGroupId = `${storeyId}__${className}`;

    if (!draft[classGroupId]) {
      upsertNode(draft, {
        id: classGroupId,
        kind: "ClassGroup",
        name: className,
        parentId: storeyId,
        children: [],
        ifcClass: className,
      });
      ensureChild(draft, storeyId, classGroupId);
    }

    // Stable object id
    const objId = `ifc:obj:${globalId ?? `${modelID}:${expressID}`}`;

    upsertNode(draft, {
      id: objId,
      kind: "Object",
      name: name || className,
      parentId: classGroupId,
      children: [],
      ifcClass: className,
      tag: tag || globalId,
      psets,
      ifc: { modelID, expressID, globalId, type: typeUpper },
    });

    ensureChild(draft, classGroupId, objId);

    // continue walking in case the spatial structure contains nested leaves
    for (const ch of sp.children ?? []) {
      await walk(ch, resolvedParentId, storeyId);
    }
  }

  await walk(spatial, "root", undefined);
  return draft;
}

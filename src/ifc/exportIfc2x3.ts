// src/ifc/exportIfc2x3.ts
// Minimal IFC2x3 (SPF) exporter: Spatial structure + elements (no geometry)

export type NodeKind =
  | "Root"
  | "Project"
  | "Site"
  | "Building"
  | "Storey"
  | "ClassGroup"
  | "Object";

export type IfcRef = { modelID: number; expressID: number; guid?: string };

export type TreeNode = {
  id: string;
  kind: NodeKind;
  name: string;
  parentId?: string;
  children: string[];
  ifcClass?: string; // for Object (e.g. IfcValve, IfcPump, ...)
  tag?: string; // for Object (map to IFC Tag)
  psets?: { name: string; props: Record<string, string> }[];
  ifc?: IfcRef;
};

function nowIso() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}`;
}

// ---------- IFC GUID (22 chars) ----------
function toBase64Chars(n: number) {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
  return chars[n] ?? "0";
}

// NOTE: simplified GUID compression (works for many viewers; not a strict official implementation)
export function ifcGuidFromUuid(uuid: string) {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) throw new Error("UUID must be 32 hex chars");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);

  let num = BigInt(0);
  for (let i = 0; i < 16; i++) num = (num << BigInt(8)) + BigInt(bytes[i]);

  let result = "";
  const mask = BigInt(0x3f); // 6 bits
  for (let i = 0; i < 22; i++) {
    const shift = BigInt((21 - i) * 6);
    const v = Number((num >> shift) & mask);
    result += toBase64Chars(v);
  }
  return result;
}

function uuidv4() {
  const cryptoObj = crypto as Crypto;
  const buf = new Uint8Array(16);
  cryptoObj.getRandomValues(buf);
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const hex = [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function ifcGuid() {
  return ifcGuidFromUuid(uuidv4());
}

// ---------- SPF helpers ----------
function s(v: string | undefined | null) {
  if (!v) return "$";
  const escaped = v.replace(/\\/g, "\\\\").replace(/'/g, "''");
  return `'${escaped}'`;
}

function ifcValue(v: string) {
  const raw = (v ?? "").trim();
  if (raw === "") return "$";

  if (/^(true|false)$/i.test(raw)) {
    return `IFCBOOLEAN(${raw.toLowerCase() === "true" ? ".T." : ".F."})`;
  }

  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    if (raw.includes(".")) return `IFCREAL(${Number(raw)})`;
    return `IFCINTEGER(${Number(raw)})`;
  }

  const escaped = raw.replace(/\\/g, "\\\\").replace(/'/g, "''");
  return `IFCTEXT('${escaped}')`;
}

// ---------- IFC Writer ----------
type Line = { id: number; text: string };

class IfcWriter {
  private _nextId = 1;
  lines: Line[] = [];

  id() {
    return this._nextId++;
  }

  add(text: string) {
    const id = this.id();
    this.lines.push({ id, text: `#${id}=${text};` });
    return id;
  }

  ref(id: number | null | undefined) {
    return id ? `#${id}` : "$";
  }

  out() {
    return this.lines.map((l) => l.text).join("\n");
  }
}

// ---------- Export ----------
export function exportIfc2x3FromTree(nodes: Record<string, TreeNode>, fileName = "template.ifc") {
  const project = Object.values(nodes).find((n) => n.kind === "Project") ?? nodes["project"];
  if (!project) throw new Error("No Project node found (kind=Project or id='project').");

  const w = new IfcWriter();

  // --- minimal "common" objects ---
  const nowEpoch = Math.floor(Date.now() / 1000);
  const ownerHistory = w.add(`IFCOWNERHISTORY($,$,$,.ADDED.,${nowEpoch},$,$,${nowEpoch})`);

  const originPoint = w.add(`IFCCARTESIANPOINT((0.,0.,0.))`);
  const axis2p3d = w.add(`IFCAXIS2PLACEMENT3D(#${originPoint},$,$)`);
  const worldPlacement = w.add(`IFCLOCALPLACEMENT($,#${axis2p3d})`);

  const context = w.add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#${axis2p3d},$)`);

  // IFC2x3: IFCSIUNIT(Dimensions, UnitType, Prefix, Name)
  const lengthUnit = w.add(`IFCSIUNIT($,.LENGTHUNIT.,$,.METRE.)`);
  const units = w.add(`IFCUNITASSIGNMENT((#${lengthUnit}))`);

  // --- Project ---
  const ifcProject = w.add(
    `IFCPROJECT('${ifcGuid()}',#${ownerHistory},${s(project.name ?? "IfcProject")},$,$,$,$,(#${context}),#${units})`
  );

  const nodeToIfcId = new Map<string, number>();
  nodeToIfcId.set(project.id, ifcProject);

  function addPsetsForElement(elementIfcId: number, obj: TreeNode) {
    const psets = obj.psets ?? [];
    if (psets.length === 0) return;

    for (const pset of psets) {
      const psetName = (pset.name ?? "").trim();
      if (!psetName) continue;

      const entries = Object.entries(pset.props ?? {}).filter(([k]) => k.trim().length > 0);
      if (entries.length === 0) continue;

      const propIds = entries.map(([k, v]) =>
        w.add(`IFCPROPERTYSINGLEVALUE(${s(k)},$,${ifcValue(String(v ?? ""))},$)`)
      );

      const psetId = w.add(
        `IFCPROPERTYSET('${ifcGuid()}',#${ownerHistory},${s(psetName)},$,(${propIds.map((id) => `#${id}`).join(",")}))`
      );

      w.add(`IFCRELDEFINESBYPROPERTIES('${ifcGuid()}',#${ownerHistory},$,$,(#${elementIfcId}),#${psetId})`);
    }
  }

  function createLocalPlacement(relativeTo: number) {
    const p = w.add(`IFCCARTESIANPOINT((0.,0.,0.))`);
    const ax = w.add(`IFCAXIS2PLACEMENT3D(#${p},$,$)`);
    return w.add(`IFCLOCALPLACEMENT(#${relativeTo},#${ax})`);
  }

  function createSite(node: TreeNode, parentPlacement: number) {
    const placement = createLocalPlacement(parentPlacement);
    const siteId = w.add(
      `IFCSITE('${ifcGuid()}',#${ownerHistory},${s(node.name)},$,$,#${placement},$,$,.ELEMENT.,$,$,$,$,$)`
    );
    nodeToIfcId.set(node.id, siteId);
    return siteId;
  }

  function createBuilding(node: TreeNode, parentPlacement: number) {
    const placement = createLocalPlacement(parentPlacement);
    const bldgId = w.add(
      `IFCBUILDING('${ifcGuid()}',#${ownerHistory},${s(node.name)},$,$,#${placement},$,$,.ELEMENT.,$,$,$)`
    );
    nodeToIfcId.set(node.id, bldgId);
    return bldgId;
  }

  function createStorey(node: TreeNode, parentPlacement: number) {
    const placement = createLocalPlacement(parentPlacement);
    const stId = w.add(
      `IFCBUILDINGSTOREY('${ifcGuid()}',#${ownerHistory},${s(node.name)},$,$,#${placement},$,$,.ELEMENT.,$)`
    );
    nodeToIfcId.set(node.id, stId);
    return stId;
  }

  function createRelAggregates(parentIfc: number, childrenIfc: number[]) {
    if (!childrenIfc.length) return;
    w.add(
      `IFCRELAGGREGATES('${ifcGuid()}',#${ownerHistory},$,$,#${parentIfc},(${childrenIfc
        .map((id) => `#${id}`)
        .join(",")}))`
    );
  }

  // --- Spatial structure ---
  const siteNodes = project.children
    .map((id) => nodes[id])
    .filter(Boolean)
    .filter((n) => n.kind === "Site") as TreeNode[];

  const ifcSites: number[] = [];
  for (const sNode of siteNodes) {
    const ifcSite = createSite(sNode, worldPlacement);
    ifcSites.push(ifcSite);

    const buildingNodes = sNode.children
      .map((id) => nodes[id])
      .filter(Boolean)
      .filter((n) => n.kind === "Building") as TreeNode[];

    const ifcBuildings: number[] = [];
    for (const bNode of buildingNodes) {
      const ifcBldg = createBuilding(bNode, nodeToIfcId.get(sNode.id)!); // parent: site
      ifcBuildings.push(ifcBldg);

      const storeyNodes = bNode.children
        .map((id) => nodes[id])
        .filter(Boolean)
        .filter((n) => n.kind === "Storey") as TreeNode[];

      const ifcStoreys: number[] = [];
      for (const stNode of storeyNodes) {
        const ifcSt = createStorey(stNode, nodeToIfcId.get(bNode.id)!); // parent: building
        ifcStoreys.push(ifcSt);
      }
      createRelAggregates(ifcBldg, ifcStoreys);
    }
    createRelAggregates(ifcSite, ifcBuildings);
  }
  createRelAggregates(ifcProject, ifcSites);

  // --- Elements: export Objects as their IFC class (fallback to IfcBuildingElementProxy) and contain them in storeys ---
  const storeyNodesAll = Object.values(nodes).filter((n) => n.kind === "Storey") as TreeNode[];

  function getObjectsUnderStorey(storeyNode: TreeNode) {
    const out: TreeNode[] = [];
    for (const cgId of storeyNode.children) {
      const cg = nodes[cgId];
      if (!cg || cg.kind !== "ClassGroup") continue;
      for (const objId of cg.children) {
        const obj = nodes[objId];
        if (obj && obj.kind === "Object") out.push(obj);
      }
    }
    return out;
  }

  // A small allow-list to avoid emitting entities that a viewer rejects.
  // If you add more classes in the UI, add them here too (or it will fallback to Proxy).
  const IFC2X3_SAFE_ENTITIES = new Set<string>([
    "IFCBUILDINGELEMENTPROXY",
    "IFCVALVE",
    "IFCPUMP",
    "IFCTANK",
    "IFCPIPESEGMENT",
    "IFCPIPEFITTING",
    "IFCFLOWMETER",
    "IFCACTUATOR",
    "IFCSENSOR",
    "IFCCABLECARRIERSEGMENT",
  ]);

  function normalizeEntityName(ifcClass?: string) {
    const raw = (ifcClass ?? "").trim();
    if (!raw) return "IFCBUILDINGELEMENTPROXY";
    // expect "IfcValve" -> "IFCVALVE"
    const ent = raw.toUpperCase();
    if (!ent.startsWith("IFC")) return "IFCBUILDINGELEMENTPROXY";
    return IFC2X3_SAFE_ENTITIES.has(ent) ? ent : "IFCBUILDINGELEMENTPROXY";
  }

  function emitElement(entity: string, obj: TreeNode, placementRef: number) {
    const tag = obj.tag ? s(obj.tag) : "$";
    const objectType = obj.ifcClass ? s(obj.ifcClass) : "$";

    // common signature for most IfcElement subclasses in IFC2x3:
    // (GlobalId, OwnerHistory, Name, Description, ObjectType, ObjectPlacement, Representation, Tag)
    return w.add(
      `${entity}('${ifcGuid()}',#${ownerHistory},${s(obj.name)},$,${objectType},#${placementRef},$,${tag})`
    );
  }

  for (const stNode of storeyNodesAll) {
    const ifcStorey = nodeToIfcId.get(stNode.id);
    if (!ifcStorey) continue;

    const objs = getObjectsUnderStorey(stNode);
    if (!objs.length) continue;

    const elementIfcIds: number[] = [];
    for (const obj of objs) {
      // place relative to the storey placement (cleaner hierarchy)
      const placement = createLocalPlacement(ifcStorey);

      const entity = normalizeEntityName(obj.ifcClass);
      const el = emitElement(entity, obj, placement);

      elementIfcIds.push(el);
      addPsetsForElement(el, obj);
    }

    w.add(
      `IFCRELCONTAINEDINSPATIALSTRUCTURE('${ifcGuid()}',#${ownerHistory},$,$,(${elementIfcIds
        .map((id) => `#${id}`)
        .join(",")}),#${ifcStorey})`
    );
  }

  const header = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME(${s(fileName)},${s(nowIso())},('IFC-Coordinator'),('Viktor Knaub'),'IFC-Coordinator','IFC-Coordinator','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;`;

  const footer = `ENDSEC;
END-ISO-10303-21;`;

  const ifcText = `${header}\n${w.out()}\n${footer}`;

  // download in browser
  const blob = new Blob([ifcText], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);

  return ifcText;
}

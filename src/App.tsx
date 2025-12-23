// src/App.tsx
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import IfcViewer from "./components/IfcViewer";

import { putBlob, getBlob, deleteBlob } from "./storage/idb";

import { exportIfc2x3FromTree } from "./ifc/exportIfc2x3";

import type { IfcViewerAPI } from "web-ifc-viewer";
import { importIfcIntoCoordinator } from "./ifc/importIfc";

import {
  AppShell,
  Header,
  Navbar,
  Group,
  Title,
  Button,
  TextInput,
  Stack,
  Paper,
  Text,
  Divider,
  ScrollArea,
  Modal,
  Select,
  Badge,
  NumberInput,
  Checkbox,
  FileButton,
} from "@mantine/core";
import {
  IconBuilding,
  IconPlus,
  IconPencil,
  IconLayoutGrid,
  IconCube,
  IconMapPin,
} from "@tabler/icons-react";

type NodeKind =
  | "Root"
  | "Project"
  | "Site"
  | "Building"
  | "Storey"
  | "ClassGroup"
  | "Object";

type DocCategory =
  | "Manual"
  | "Datasheet"
  | "Certificate"
  | "Report"
  | "Model"
  | "Other";

type AssetDocument = {
  id: string;
  name: string; // Dateiname
  category: DocCategory;
  mime: string;
  version: string; // z.B. "A"
  createdAt: number; // timestamp
  blobKey: string; // Key in IndexedDB
  url?: string; // nur zur Laufzeit (nicht dauerhaft speichern)
};

type Pset = {
  name: string; // z.B. "Pset_AssetCustom"
  props: Record<string, string>;
};

type TreeNode = {
  id: string;
  kind: NodeKind;
  name: string;
  parentId?: string;
  children: string[];
  ifcClass?: string;
  tag?: string;
  psets?: Pset[];
  docs?: AssetDocument[];
};

type DragPayload =
  | { type: "Object"; ids: string[] }
  | { type: "Building"; id: string }
  | { type: "Storey"; id: string };

function uid(prefix: string) {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

const IFC_CLASS_OPTIONS = [
  "IfcBuildingElementProxy",
  "IfcValve",
  "IfcPump",
  "IfcTank",
  "IfcPipeSegment",
  "IfcPipeFitting",
  "IfcFlowMeter",
  "IfcActuator",
  "IfcSensor",
  "IfcCableCarrierSegment",
] as const;

function safeParseDragPayload(raw: string): DragPayload | null {
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") return null;

    if (
      j.type === "Object" &&
      Array.isArray(j.ids) &&
      j.ids.every((x: any) => typeof x === "string")
    )
      return j;
    if (
      (j.type === "Building" || j.type === "Storey") &&
      typeof j.id === "string"
    )
      return j;

    return null;
  } catch {
    return null;
  }
}

const LS_NODES_KEY = "ifcCoordinator.nodes.v1";

function sanitizeNodes(input: Record<string, TreeNode>) {
  const out: Record<string, TreeNode> = { ...input };

  // 1) dangling refs + self refs + parentId check
  for (const [id, n] of Object.entries(out)) {
    const children = (n.children ?? []).filter((cid) => !!out[cid] && cid !== id);
    out[id] = { ...n, children };

    if (out[id].parentId && !out[out[id].parentId!]) {
      out[id] = { ...out[id], parentId: undefined };
    }
  }

  // 2) ensure root exists
  if (!out.root) out.root = { id: "root", kind: "Root", name: "Workspace", children: [] };

  // 3) ensure root has at least one Project as child
  const root = out.root;
  const validRootChildren = (root.children ?? []).filter((cid) => out[cid]?.kind === "Project");

  if (validRootChildren.length === 0) {
    const projects = Object.values(out).filter((n) => n.kind === "Project").map((n) => n.id);
    out.root = { ...root, children: projects };
  } else {
    out.root = { ...root, children: validRootChildren };
  }

  return out;
}



export default function App() {
  const [nodes, setNodes] = useState<Record<string, TreeNode>>(() => {
    const raw = localStorage.getItem(LS_NODES_KEY);
    if (raw) {
      try {
        return sanitizeNodes(JSON.parse(raw));
      } catch {}
    }


    const projectId = "project";
    const site1 = "site_1";
    const b1 = "building_1";
    const s1 = "storey_1";
    const g1 = `${s1}__IfcBuildingElementProxy`;

    return {
      root: { id: "root", kind: "Root", name: "Workspace", children: [projectId] },

      [projectId]: {
        id: projectId,
        kind: "Project",
        name: "IfcProject",
        parentId: "root",
        children: [site1],
      },

      [site1]: { id: site1, kind: "Site", name: "Site A", parentId: projectId, children: [b1] },
      [b1]: { id: b1, kind: "Building", name: "Building A", parentId: site1, children: [s1] },
      [s1]: { id: s1, kind: "Storey", name: "Storey 0", parentId: b1, children: [g1] },

      [g1]: {
        id: g1,
        kind: "ClassGroup",
        name: "IfcBuildingElementProxy",
        ifcClass: "IfcBuildingElementProxy",
        parentId: s1,
        children: [],
      },
    };
  });

  const [selectedId, setSelectedId] = useState<string>("root");
    useEffect(() => {
    if (!nodes[selectedId]) {
      setSelectedId("root");
      setSelectedObjectIds([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes]);

  const [viewer, setViewer] = useState<any>(null);

  const [activePsetName, setActivePsetName] = useState<string>("Pset_AssetCustom");
  const [newPsetName, setNewPsetName] = useState<string>("");

  const [propKeyInput, setPropKeyInput] = useState("");
  const [propValueInput, setPropValueInput] = useState("");

  const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>([]);
  const lastObjectClickIdRef = useRef<string | null>(null);

  const selected = nodes[selectedId];
  const treeRootId = "root";

  function getSelectedProjectIdFrom(nodes: Record<string, TreeNode>, startId: string): string {
    const sel = nodes[startId];
    if (!sel) return "project";
    if (sel.kind === "Project") return sel.id;

    let cur: TreeNode | undefined = sel;
    while (cur?.parentId) {
      const p = nodes[cur.parentId];
      if (!p) break;
      if (p.kind === "Project") return p.id;
      cur = p;
    }
    return "project";
  }

  function getSelectedProjectId() {
    return getSelectedProjectIdFrom(nodes, selectedId);
  }

  const [addObjectOpen, setAddObjectOpen] = useState(false);

  const [deleteDocOpen, setDeleteDocOpen] = useState(false);
  const [deleteDocTarget, setDeleteDocTarget] =
    useState<{ assetId: string; docId: string } | null>(null);

  const [targetSiteId, setTargetSiteId] = useState<string | null>(null);
  const [targetBuildingId, setTargetBuildingId] = useState<string | null>(null);
  const [targetStoreyId, setTargetStoreyId] = useState<string | null>(null);

  const [newObjName, setNewObjName] = useState("");
  const [newObjTag, setNewObjTag] = useState("");

  const [newObjIfcClass, setNewObjIfcClass] =
    useState<string>("IfcBuildingElementProxy");

  const [createMode, setCreateMode] = useState<"single" | "batch">("single");
  const [batchCount, setBatchCount] = useState<number>(10);
  const [batchNamePattern, setBatchNamePattern] = useState<string>("Pump {N}");

  const [batchGenerateTags, setBatchGenerateTags] = useState<boolean>(true);
  const [batchTagPattern, setBatchTagPattern] = useState<string>("{CLASS}-{N:3}");
  const [batchTagStart, setBatchTagStart] = useState<number>(1);
  const [batchTagStep, setBatchTagStep] = useState<number>(1);

  const bulkCount = selectedObjectIds.length;
  const [bulkIfcClass, setBulkIfcClass] =
    useState<string>("IfcBuildingElementProxy");

  const [tagCounterMode, setTagCounterMode] = useState<"global" | "perClass">("perClass");

  const [tagPattern, setTagPattern] = useState<string>("{CLASS}-{N:4}");
  const [tagStart, setTagStart] = useState<number>(1);
  const [tagStep, setTagStep] = useState<number>(1);

  const [tagCustom, setTagCustom] = useState<string>("X");
  const [tagSkipExisting, setTagSkipExisting] = useState<boolean>(true);

  const [bulkFind, setBulkFind] = useState<string>("");
  const [bulkReplace, setBulkReplace] = useState<string>("");
  const [bulkUseRegex, setBulkUseRegex] = useState<boolean>(false);

  const [bulkPropKey, setBulkPropKey] = useState<string>("System");
  const [bulkPropValue, setBulkPropValue] = useState<string>("Piping");

  useEffect(() => {
    // urls dürfen nicht persistiert werden (blob: URLs sind nur Laufzeit)
    const cleaned: Record<string, TreeNode> = {};
    for (const [id, n] of Object.entries(nodes)) {
      if (n.kind !== "Object" || !n.docs) {
        cleaned[id] = n;
        continue;
      }
      cleaned[id] = {
        ...n,
        docs: n.docs.map((d) => {
          const { url, ...rest } = d;
          return rest;
        }),
      };
    }

    localStorage.setItem(LS_NODES_KEY, JSON.stringify(cleaned));
  }, [nodes]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateDocUrls() {
      for (const node of Object.values(nodes)) {
        if (node.kind !== "Object") continue;
        const docs = node.docs ?? [];
        for (const d of docs) {
          if (d.url) continue; // schon vorhanden
          const blob = await getBlob(d.blobKey);
          if (!blob) continue;

          const url = URL.createObjectURL(blob);
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }

          setNodes((prev) => {
            const cur = prev[node.id];
            if (!cur || cur.kind !== "Object") return prev;
            const nextDocs = (cur.docs ?? []).map((x) =>
              x.id === d.id ? { ...x, url } : x
            );
            return { ...prev, [node.id]: { ...cur, docs: nextDocs } };
          });
        }
      }
    }

    hydrateDocUrls();

    return () => {
      cancelled = true;
    };
    // bewusst nur beim Mount starten:
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedSiteId = useMemo(() => {
    if (!selected) return undefined;
    if (selected.kind === "Site") return selected.id;
    let cur: TreeNode | undefined = selected;
    while (cur?.parentId) {
      const p = nodes[cur.parentId];
      if (!p) break;
      if (p.kind === "Site") return p.id;
      cur = p;
    }
    return undefined;
  }, [selected?.id, selected?.kind, nodes]);

  const selectedBuildingId = useMemo(() => {
    if (!selected) return undefined;
    if (selected.kind === "Building") return selected.id;
    let cur: TreeNode | undefined = selected;
    while (cur?.parentId) {
      const p = nodes[cur.parentId];
      if (!p) break;
      if (p.kind === "Building") return p.id;
      cur = p;
    }
    return undefined;
  }, [selected?.id, selected?.kind, nodes]);

  const selectedStoreyId = useMemo(() => {
    if (!selected) return undefined;
    if (selected.kind === "Storey") return selected.id;

    if (selected.kind === "ClassGroup") {
      const storey = selected.parentId ? nodes[selected.parentId] : undefined;
      if (storey?.kind === "Storey") return storey.id;
    }

    if (selected.kind === "Object") {
      const group = selected.parentId ? nodes[selected.parentId] : undefined;
      const storey = group?.parentId ? nodes[group.parentId] : undefined;
      if (storey?.kind === "Storey") return storey.id;
    }

    return undefined;
  }, [selected?.id, selected?.kind, nodes]);

  function getSitesOfProject(projectId?: string) {
    const pid = projectId ?? getSelectedProjectId();
    const project = nodes[pid];
    if (!project) return [];
    return project.children.filter((cid) => nodes[cid]?.kind === "Site");
  }

  function getBuildingsOfSite(siteId: string) {
    const s = nodes[siteId];
    if (!s) return [];
    return s.children.filter((cid) => nodes[cid]?.kind === "Building");
  }

  function getStoreysOfBuilding(buildingId: string) {
    const b = nodes[buildingId];
    if (!b) return [];
    return b.children.filter((cid) => nodes[cid]?.kind === "Storey");
  }

  function getAllSites() {
    return getSitesOfProject();
  }

  function getAllBuildings() {
    const sites = getAllSites();
    const all: string[] = [];
    for (const sid of sites) all.push(...getBuildingsOfSite(sid));
    return all;
  }

  function getAllStoreys() {
    const buildings = getAllBuildings();
    const all: string[] = [];
    for (const bid of buildings) all.push(...getStoreysOfBuilding(bid));
    return all;
  }

  const visibleNodeOrder = useMemo(() => {
    const order: string[] = [];
    function walk(id: string) {
      order.push(id);
      const n = nodes[id];
      if (!n) return;
      for (const c of n.children) walk(c);
    }
    walk(treeRootId);
    return order;
  }, [nodes]);

  function isObject(id: string) {
    return nodes[id]?.kind === "Object";
  }

  function objectRange(a: string, b: string) {
    const ia = visibleNodeOrder.indexOf(a);
    const ib = visibleNodeOrder.indexOf(b);
    if (ia < 0 || ib < 0) return [];
    const [from, to] = ia <= ib ? [ia, ib] : [ib, ia];
    return visibleNodeOrder.slice(from, to + 1).filter(isObject);
  }

  async function handleImportIfc(file: File) {
    if (!viewer) {
      alert("Viewer not ready yet");
      return;
    }

    console.log("[IFC] importing file:", file.name, file.size);

    const url = URL.createObjectURL(file);

    try {
      const model = await viewer.IFC.loadIfcUrl(url);
      console.log("[IFC] loaded model:", model);
      alert("Viewer load OK");
    } catch (e) {
      console.error("[IFC] viewer load failed:", e);
      alert("Viewer load FAILED (see console)");
    } finally {
      URL.revokeObjectURL(url);
    }


    try {
      let model: any = null;

      // Manche Versionen haben loadIfcUrl, manche loadIfc (File)
      if (viewer.IFC?.loadIfcUrl) {
        model = await viewer.IFC.loadIfcUrl(url);
      } else if (viewer.IFC?.loadIfc) {
        model = await viewer.IFC.loadIfc(file);
      } else {
        throw new Error("No IFC loader found on viewer.IFC (loadIfcUrl/loadIfc missing).");
      }

      console.log("[IFC] loaded model:", model);
      const modelID = model?.modelID ?? model?.id ?? model?.ifcModelID;

      if (modelID == null) {
        console.warn("[IFC] Could not detect modelID from model:", model);
        // Versuch: manche Versionen nutzen viewer.IFC.loader.ifcManager
      }

      try {
        viewer.context?.ifcCamera?.fitToFrame?.(modelID);
        viewer.context?.fitToFrame?.();
      } catch (e) {
        console.warn("[IFC] fitToFrame not available:", e);
      }

      console.log("[IFC] importing into tree with modelID:", modelID);

      const mergedRaw = await importIfcIntoCoordinator(viewer, modelID, nodes);
      const merged = sanitizeNodes(mergedRaw);

      console.log("[IFC] nodes before:", Object.keys(nodes).length, "after:", Object.keys(merged).length);

      setNodes(merged);

      // auf importiertes Project springen
      const importedProjects = Object.values(merged).filter(
        (n) => n.kind === "Project" && n.id.startsWith("ifc:project:")
      );
      const newest = importedProjects[importedProjects.length - 1];
      if (newest) setSelectedId(newest.id);
    } catch (err) {
      console.error("[IFC] Import failed:", err);
      alert("Import failed. Check console for [IFC] logs.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }


  function ensureSite(projectId?: string) {
    const pid = projectId ?? getSelectedProjectId();
    const sites = getSitesOfProject(pid);
    if (sites.length > 0) return sites[0];

    const sid = uid("site");
    setNodes((prev) => {
      const next = { ...prev };
      const p = next[pid];
      if (!p || p.kind !== "Project") return prev;

      next[sid] = { id: sid, kind: "Site", name: "Site A", parentId: pid, children: [] };
      next[pid] = { ...p, children: [...p.children, sid] };
      return next;
    });
    return sid;
  }

  function ensureBuilding(siteId: string) {
    const buildings = getBuildingsOfSite(siteId);
    if (buildings.length > 0) return buildings[0];

    const bid = uid("building");
    setNodes((prev) => {
      const next = { ...prev };
      next[bid] = { id: bid, kind: "Building", name: "Building 0", parentId: siteId, children: [] };
      next[siteId] = { ...next[siteId], children: [...next[siteId].children, bid] };
      return next;
    });
    return bid;
  }

  function ensureStorey(buildingId: string) {
    const storeys = getStoreysOfBuilding(buildingId);
    if (storeys.length > 0) return storeys[0];

    const sid = uid("storey");
    const defaultGroupId = `${sid}__IfcBuildingElementProxy`;

    setNodes((prev) => {
      const next = { ...prev };
      next[sid] = { id: sid, kind: "Storey", name: "Storey 0", parentId: buildingId, children: [defaultGroupId] };
      next[defaultGroupId] = {
        id: defaultGroupId,
        kind: "ClassGroup",
        name: "IfcBuildingElementProxy",
        ifcClass: "IfcBuildingElementProxy",
        parentId: sid,
        children: [],
      };
      next[buildingId] = { ...next[buildingId], children: [...next[buildingId].children, sid] };
      return next;
    });

    return sid;
  }

  function groupId(storeyId: string, ifcClass: string) {
    return `${storeyId}__${ifcClass}`;
  }

  function ensureClassGroup(storeyId: string, ifcClass: string) {
    const gid = groupId(storeyId, ifcClass);
    setNodes((prev) => {
      if (prev[gid]) return prev;
      const next = { ...prev };
      next[gid] = { id: gid, kind: "ClassGroup", name: ifcClass, ifcClass, parentId: storeyId, children: [] };
      next[storeyId] = { ...next[storeyId], children: [...next[storeyId].children, gid] };
      return next;
    });
    return gid;
  }

  function detachFromParent(childId: string, parentId: string | undefined, draft: Record<string, TreeNode>) {
    if (!parentId) return;
    const p = draft[parentId];
    if (!p) return;
    draft[parentId] = { ...p, children: p.children.filter((c) => c !== childId) };
  }

  function attachToParent(childId: string, parentId: string, draft: Record<string, TreeNode>) {
    const p = draft[parentId];
    if (!p) return;
    draft[parentId] = { ...p, children: [...p.children, childId] };
  }

  function moveBuildingToSite(buildingId: string, targetSiteId: string) {
    setNodes((prev) => {
      const next = { ...prev };
      const b = next[buildingId];
      const targetSite = next[targetSiteId];
      if (!b || b.kind !== "Building") return prev;
      if (!targetSite || targetSite.kind !== "Site") return prev;

      const oldSiteId = b.parentId;
      if (oldSiteId === targetSiteId) return prev;

      detachFromParent(buildingId, oldSiteId, next);
      attachToParent(buildingId, targetSiteId, next);
      next[buildingId] = { ...b, parentId: targetSiteId };
      return next;
    });
  }

  function moveStoreyToBuilding(storeyId: string, targetBuildingId: string) {
    setNodes((prev) => {
      const next = { ...prev };
      const s = next[storeyId];
      const targetBuilding = next[targetBuildingId];
      if (!s || s.kind !== "Storey") return prev;
      if (!targetBuilding || targetBuilding.kind !== "Building") return prev;

      const oldBuildingId = s.parentId;
      if (oldBuildingId === targetBuildingId) return prev;

      detachFromParent(storeyId, oldBuildingId, next);
      attachToParent(storeyId, targetBuildingId, next);
      next[storeyId] = { ...s, parentId: targetBuildingId };
      return next;
    });
  }

  function ensureObjectHasPset(objectId: string, psetName: string) {
    setNodes((prev) => {
      const cur = prev[objectId];
      if (!cur || cur.kind !== "Object") return prev;

      const psets = cur.psets ?? [];
      if (psets.some((p) => p.name === psetName)) return prev;

      return {
        ...prev,
        [objectId]: {
          ...cur,
          psets: [...psets, { name: psetName, props: {} }],
        },
      };
    });
  }

  function addPsetToObject(objectId: string, psetName: string) {
    const name = psetName.trim();
    if (!name) return;
    ensureObjectHasPset(objectId, name);
    setActivePsetName(name);
    setNewPsetName("");
  }

  function setPsetProperty(objectId: string, psetName: string, key: string, value: string) {
    const k = key.trim();
    if (!k) return;

    setNodes((prev) => {
      const cur = prev[objectId];
      if (!cur || cur.kind !== "Object") return prev;

      const psets = cur.psets ?? [];
      const idx = psets.findIndex((p) => p.name === psetName);
      const nextPsets = [...psets];

      if (idx < 0) {
        nextPsets.push({ name: psetName, props: { [k]: value } });
      } else {
        const existing = nextPsets[idx];
        nextPsets[idx] = { ...existing, props: { ...(existing.props ?? {}), [k]: value } };
      }

      return { ...prev, [objectId]: { ...cur, psets: nextPsets } };
    });
  }

  function deletePsetProperty(objectId: string, psetName: string, key: string) {
    const k = key.trim();
    if (!k) return;

    setNodes((prev) => {
      const cur = prev[objectId];
      if (!cur || cur.kind !== "Object") return prev;

      const psets = cur.psets ?? [];
      const idx = psets.findIndex((p) => p.name === psetName);
      if (idx < 0) return prev;

      const existing = psets[idx];
      const props = { ...(existing.props ?? {}) };
      delete props[k];

      const nextPsets = [...psets];
      nextPsets[idx] = { ...existing, props };

      return { ...prev, [objectId]: { ...cur, psets: nextPsets } };
    });
  }

  function moveStoreyToSite(storeyId: string, targetSiteId: string) {
    const targetBuildingId = ensureBuilding(targetSiteId);
    moveStoreyToBuilding(storeyId, targetBuildingId);
  }

  function moveObjectToGroup(objectId: string, targetGroupId: string) {
    setNodes((prev) => {
      const next = { ...prev };
      const obj = next[objectId];
      const targetGroup = next[targetGroupId];

      if (!obj || obj.kind !== "Object") return prev;
      if (!targetGroup || targetGroup.kind !== "ClassGroup") return prev;

      const oldGroupId = obj.parentId;
      if (!oldGroupId) return prev;

      const oldGroup = next[oldGroupId];
      if (oldGroup?.kind === "ClassGroup") {
        next[oldGroupId] = { ...oldGroup, children: oldGroup.children.filter((c) => c !== objectId) };
      }

      next[targetGroupId] = { ...targetGroup, children: [...targetGroup.children, objectId] };
      next[objectId] = { ...obj, parentId: targetGroupId, ifcClass: targetGroup.ifcClass };

      return next;
    });
  }

  function moveObjectToStorey(objectId: string, targetStoreyId: string) {
    const obj = nodes[objectId];
    if (!obj || obj.kind !== "Object") return;

    const ifcClass = obj.ifcClass || "IfcBuildingElementProxy";
    const gid = ensureClassGroup(targetStoreyId, ifcClass);
    moveObjectToGroup(objectId, gid);
  }

  function moveObjectToBuilding(objectId: string, targetBuildingId: string) {
    const storeyId = ensureStorey(targetBuildingId);
    moveObjectToStorey(objectId, storeyId);
  }

  function moveObjectToSite(objectId: string, targetSiteId: string) {
    const buildingId = ensureBuilding(targetSiteId);
    moveObjectToBuilding(objectId, buildingId);
  }

  function requestDeleteDocument(assetId: string, docId: string) {
    setDeleteDocTarget({ assetId, docId });
    setDeleteDocOpen(true);
  }

  async function addDocumentToAsset(assetId: string, file: File) {
    const docId = crypto.randomUUID();
    const blobKey = `doc:${docId}`;

    await putBlob(blobKey, file);

    const doc: AssetDocument = {
      id: docId,
      blobKey,
      name: file.name,
      category: "Other",
      mime: file.type || "application/octet-stream",
      version: "A",
      createdAt: Date.now(),
      url: URL.createObjectURL(file),
    };

    setNodes((prev) => {
      const cur = prev[assetId];
      if (!cur) return prev;

      return {
        ...prev,
        [assetId]: {
          ...cur,
          docs: [...(cur.docs ?? []), doc],
        },
      };
    });
  }

  async function deleteDocumentFromAsset(assetId: string, docId: string) {
    // 1) doc aus dem aktuellen State finden (für blobKey + url)
    const asset = nodes[assetId];
    if (!asset || asset.kind !== "Object") return;

    const doc = (asset.docs ?? []).find((d) => d.id === docId);
    if (!doc) return;

    // 2) blob aus IndexedDB löschen
    await deleteBlob(doc.blobKey);

    // 3) objectURL freigeben (wichtig für Speicher)
    if (doc.url) URL.revokeObjectURL(doc.url);

    // 4) aus State entfernen
    setNodes((prev) => {
      const cur = prev[assetId];
      if (!cur || cur.kind !== "Object") return prev;

      return {
        ...prev,
        [assetId]: {
          ...cur,
          docs: (cur.docs ?? []).filter((d) => d.id !== docId),
        },
      };
    });
  }

  function moveManyObjectsToSite(objectIds: string[], targetSiteId: string) {
    for (const id of objectIds) moveObjectToSite(id, targetSiteId);
  }
  function moveManyObjectsToBuilding(objectIds: string[], targetBuildingId: string) {
    for (const id of objectIds) moveObjectToBuilding(id, targetBuildingId);
  }
  function moveManyObjectsToStorey(objectIds: string[], targetStoreyId: string) {
    for (const id of objectIds) moveObjectToStorey(id, targetStoreyId);
  }
  function moveManyObjectsToGroup(objectIds: string[], targetGroupId: string) {
    for (const id of objectIds) moveObjectToGroup(id, targetGroupId);
  }

  function selectSingle(nodeId: string) {
    setSelectedId(nodeId);
    if (nodes[nodeId]?.kind === "Object") {
      setSelectedObjectIds([nodeId]);
      lastObjectClickIdRef.current = nodeId;
    } else {
      setSelectedObjectIds([]);
      lastObjectClickIdRef.current = null;
    }
  }

  function toggleObject(nodeId: string) {
    setSelectedId(nodeId);
    setSelectedObjectIds((prev) => {
      const has = prev.includes(nodeId);
      return has ? prev.filter((x) => x !== nodeId) : [...prev, nodeId];
    });
    lastObjectClickIdRef.current = nodeId;
  }

  function rangeSelectObject(nodeId: string) {
    setSelectedId(nodeId);
    const anchor = lastObjectClickIdRef.current;
    if (!anchor) {
      setSelectedObjectIds([nodeId]);
      lastObjectClickIdRef.current = nodeId;
      return;
    }
    const range = objectRange(anchor, nodeId);
    setSelectedObjectIds(range.length ? range : [nodeId]);
  }

  function handleNodeClick(e: MouseEvent, nodeId: string) {
    const n = nodes[nodeId];
    if (!n) return;

    if (n.kind !== "Object") {
      selectSingle(nodeId);
      return;
    }

    const isCtrl = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;

    if (isShift) return rangeSelectObject(nodeId);
    if (isCtrl) return toggleObject(nodeId);
    return selectSingle(nodeId);
  }

  function renameSelected(newName: string) {
    if (!selected) return;
    setNodes((prev) => ({ ...prev, [selected.id]: { ...prev[selected.id], name: newName } }));
  }

  function setSelectedTag(tag: string) {
    if (!selected) return;
    setNodes((prev) => ({ ...prev, [selected.id]: { ...prev[selected.id], tag } }));
  }

  function setSelectedIfcClass(newIfcClass: string) {
    if (!selected || selected.kind !== "Object") return;
    const storeyId = selectedStoreyId;
    if (!storeyId) return;
    const gid = ensureClassGroup(storeyId, newIfcClass);
    moveObjectToGroup(selected.id, gid);
  }

  function addSite() {
    const projectId = getSelectedProjectId();
    const sid = uid("site");
    const siteCount = getSitesOfProject(projectId).length;

    setNodes((prev) => {
      const next = { ...prev };
      const p = next[projectId];
      if (!p || p.kind !== "Project") return prev;

      next[sid] = { id: sid, kind: "Site", name: `Site ${siteCount}`, parentId: projectId, children: [] };
      next[projectId] = { ...p, children: [...p.children, sid] };
      return next;
    });

    setSelectedId(sid);
    setSelectedObjectIds([]);
  }

  function addBuilding() {
    const siteId = selectedSiteId ?? ensureSite();
    const id = uid("building");

    setNodes((prev) => {
      const next = { ...prev };
      next[id] = { id, kind: "Building", name: "New Building", parentId: siteId, children: [] };
      next[siteId] = { ...next[siteId], children: [...next[siteId].children, id] };
      return next;
    });

    setSelectedId(id);
    setSelectedObjectIds([]);
    setTimeout(() => ensureStorey(id), 0);
  }

  function addStorey() {
    const buildingId = selectedBuildingId;
    if (!buildingId) return;

    const sid = uid("storey");
    const defaultGroupId = `${sid}__IfcBuildingElementProxy`;
    const storeyCount = getStoreysOfBuilding(buildingId).length;

    setNodes((prev) => {
      const next = { ...prev };
      next[sid] = {
        id: sid,
        kind: "Storey",
        name: `Storey ${storeyCount}`,
        parentId: buildingId,
        children: [defaultGroupId],
      };
      next[defaultGroupId] = {
        id: defaultGroupId,
        kind: "ClassGroup",
        name: "IfcBuildingElementProxy",
        ifcClass: "IfcBuildingElementProxy",
        parentId: sid,
        children: [],
      };
      next[buildingId] = { ...next[buildingId], children: [...next[buildingId].children, sid] };
      return next;
    });

    setSelectedId(sid);
    setSelectedObjectIds([]);
  }

  function openAddObject() {
    const sid = selectedSiteId ?? ensureSite();
    const bid = selectedBuildingId ?? ensureBuilding(sid);
    const stid = selectedStoreyId ?? ensureStorey(bid);

    setTargetSiteId(sid);
    setTargetBuildingId(bid);
    setTargetStoreyId(stid);

    setCreateMode("single");
    setNewObjName("");
    setNewObjTag("");
    setNewObjIfcClass("IfcBuildingElementProxy");

    setBatchCount(10);
    setBatchNamePattern("Pump {N}");
    setBatchGenerateTags(true);
    setBatchTagPattern("{CLASS}-{N:3}");
    setBatchTagStart(1);
    setBatchTagStep(1);

    ensureClassGroup(stid, "IfcBuildingElementProxy");
    setAddObjectOpen(true);
  }

  function normalizeClassShort(ifcClass?: string) {
    const c = (ifcClass ?? "IfcBuildingElementProxy").replace(/^Ifc/i, "");
    if (c.toLowerCase().includes("pump")) return "PUMP";
    if (c.toLowerCase().includes("valve")) return "VALVE";
    if (c.toLowerCase().includes("tank")) return "TANK";
    if (c.toLowerCase().includes("pipe")) return "PIPE";
    if (c.toLowerCase().includes("proxy")) return "PROXY";
    return c.toUpperCase();
  }

  function pad(num: number, width: number) {
    const w = Math.max(1, width);
    return String(num).padStart(w, "0");
  }

  function parseNWidth(pattern: string) {
    const m = pattern.match(/\{N(?::(\d+))?\}/);
    const w = m?.[1] ? Number(m[1]) : 0;
    return Number.isFinite(w) ? w : 0;
  }

  function applyPattern(pattern: string, tokenMap: Record<string, string>, nValue: number) {
    let out = pattern;

    out = out.replace(/\{CLASS\}/g, tokenMap.CLASS);
    out = out.replace(/\{SITE\}/g, tokenMap.SITE);
    out = out.replace(/\{BLDG\}/g, tokenMap.BLDG);
    out = out.replace(/\{STRY\}/g, tokenMap.STRY);
    out = out.replace(/\{CUSTOM\}/g, tokenMap.CUSTOM);

    const width = parseNWidth(pattern);
    const nStr = width > 0 ? pad(nValue, width) : String(nValue);
    out = out.replace(/\{N(?::\d+)?\}/g, nStr);

    return out;
  }

  function existingTagsSet() {
    const s = new Set<string>();
    Object.values(nodes).forEach((n) => {
      if (n.kind === "Object" && n.tag) s.add(n.tag);
    });
    return s;
  }

  function createObject() {
    const sid = targetSiteId ?? selectedSiteId ?? ensureSite();
    const bid = targetBuildingId ?? selectedBuildingId ?? ensureBuilding(sid);
    const stid = targetStoreyId ?? selectedStoreyId ?? ensureStorey(bid);

    const ifcClass = newObjIfcClass;
    const gid = ensureClassGroup(stid, ifcClass);

    const replN = (pattern: string, n: number) => pattern.replace(/\{N\}/g, String(n));

    if (createMode === "single") {
      const name = newObjName.trim();
      const tag = newObjTag.trim() || undefined;
      if (!name) return;

      const id = uid("obj");

      setNodes((prev) => {
        const next: Record<string, TreeNode> = { ...prev };
        next[id] = {
          id,
          kind: "Object",
          name,
          tag,
          ifcClass,
          parentId: gid,
          children: [],
          psets: [{ name: "Pset_AssetCustom", props: {} }],
        };
        const group = next[gid];
        if (group && group.kind === "ClassGroup")
          next[gid] = { ...group, children: [...group.children, id] };
        return next;
      });

      setSelectedId(id);
      setSelectedObjectIds([id]);
      lastObjectClickIdRef.current = id;
      setAddObjectOpen(false);
      return;
    }

    const count = Math.max(1, Math.floor(batchCount || 1));
    const baseStart = Number.isFinite(batchTagStart) ? batchTagStart : 1;
    const step = Number.isFinite(batchTagStep) ? batchTagStep : 1;

    const used = tagSkipExisting ? existingTagsSet() : new Set<string>();
    const createdIds: string[] = [];

    setNodes((prev) => {
      const next: Record<string, TreeNode> = { ...prev };
      const group = next[gid];

      let nCounter = baseStart;

      for (let i = 0; i < count; i++) {
        const id = uid("obj");
        const name = replN(batchNamePattern, i + 1).trim() || `Object ${i + 1}`;

        let tag: string | undefined = undefined;

        if (batchGenerateTags) {
          const tokenMap = {
            CLASS: normalizeClassShort(ifcClass),
            SITE: (prev[sid]?.name ?? "SITE").replace(/\s+/g, ""),
            BLDG: (prev[bid]?.name ?? "BLDG").replace(/\s+/g, ""),
            STRY: (prev[stid]?.name ?? "STRY").replace(/\s+/g, ""),
            CUSTOM: (tagCustom ?? "").replace(/\s+/g, ""),
          };

          let candidate = applyPattern(batchTagPattern, tokenMap, nCounter);
          while (tagSkipExisting && used.has(candidate)) {
            nCounter += step;
            candidate = applyPattern(batchTagPattern, tokenMap, nCounter);
          }
          used.add(candidate);
          tag = candidate;
          nCounter += step;
        }

        next[id] = {
          id,
          kind: "Object",
          name,
          tag,
          ifcClass,
          parentId: gid,
          children: [],
          psets: [{ name: "Pset_AssetCustom", props: {} }],
        };
        createdIds.push(id);
      }

      if (group && group.kind === "ClassGroup") {
        next[gid] = { ...group, children: [...group.children, ...createdIds] };
      }

      return next;
    });

    setSelectedObjectIds(createdIds);
    setSelectedId(createdIds[0] ?? selectedId);
    lastObjectClickIdRef.current = createdIds[0] ?? null;

    setAddObjectOpen(false);
  }

  function buildTokenMapForObject(oid: string) {
    const obj = nodes[oid];
    const group = obj?.parentId ? nodes[obj.parentId] : undefined;
    const storey = group?.parentId ? nodes[group.parentId] : undefined;
    const building = storey?.parentId ? nodes[storey.parentId] : undefined;
    const site = building?.parentId ? nodes[building.parentId] : undefined;

    const cls = normalizeClassShort(obj?.ifcClass);
    const siteName = (site?.name ?? "SITE").replace(/\s+/g, "");
    const bldgName = (building?.name ?? "BLDG").replace(/\s+/g, "");
    const stryName = (storey?.name ?? "STRY").replace(/\s+/g, "");

    return {
      CLASS: cls,
      SITE: siteName,
      BLDG: bldgName,
      STRY: stryName,
      CUSTOM: (tagCustom ?? "").replace(/\s+/g, ""),
    };
  }

  function bulkApplyIfcClass() {
    const ids = selectedObjectIds;
    if (ids.length === 0) return;

    for (const oid of ids) {
      const obj = nodes[oid];
      if (!obj || obj.kind !== "Object") continue;

      const group = obj.parentId ? nodes[obj.parentId] : undefined;
      const storeyId = group?.parentId;
      if (!storeyId) continue;

      const gid = ensureClassGroup(storeyId, bulkIfcClass);
      moveObjectToGroup(oid, gid);
    }
  }

  function bulkApplyTags() {
    const ids = selectedObjectIds;
    if (ids.length === 0) return;

    const pattern = tagPattern.trim();
    if (!pattern) return;

    const start = Number.isFinite(tagStart) ? tagStart : 1;
    const step = Number.isFinite(tagStep) ? tagStep : 1;

    const used = tagSkipExisting ? existingTagsSet() : new Set<string>();

    setNodes((prev) => {
      const next = { ...prev };

      let globalCounter = start;
      const classCounters = new Map<string, number>();

      const nextNumberFor = (cls: string) => {
        if (tagCounterMode === "global") {
          const n = globalCounter;
          globalCounter += step;
          return n;
        }
        const cur = classCounters.get(cls) ?? start;
        classCounters.set(cls, cur + step);
        return cur;
      };

      ids.forEach((oid) => {
        const n = next[oid];
        if (!n || n.kind !== "Object") return;

        const tokenMap = buildTokenMapForObject(oid);
        const cls = tokenMap.CLASS;

        let num = nextNumberFor(cls);
        let candidate = applyPattern(pattern, tokenMap, num);

        if (tagSkipExisting) {
          while (used.has(candidate)) {
            num = nextNumberFor(cls);
            candidate = applyPattern(pattern, tokenMap, num);
          }
          used.add(candidate);
        }

        next[oid] = { ...n, tag: candidate };
      });

      return next;
    });
  }

  function bulkFindReplaceNames() {
    const ids = selectedObjectIds;
    if (ids.length === 0) return;
    if (!bulkFind) return;

    setNodes((prev) => {
      const next = { ...prev };

      ids.forEach((oid) => {
        const n = next[oid];
        if (!n || n.kind !== "Object") return;

        let newName = n.name;
        if (bulkUseRegex) {
          try {
            const re = new RegExp(bulkFind, "g");
            newName = newName.replace(re, bulkReplace);
          } catch {
            return;
          }
        } else {
          newName = newName.split(bulkFind).join(bulkReplace);
        }

        next[oid] = { ...n, name: newName };
      });

      return next;
    });
  }

  function bulkAddProperty() {
    const ids = selectedObjectIds;
    if (ids.length === 0) return;

    const key = bulkPropKey.trim();
    if (!key) return;
    const value = bulkPropValue ?? "";

    setNodes((prev) => {
      const next = { ...prev };
      ids.forEach((oid) => {
        const n = next[oid];
        if (!n || n.kind !== "Object") return;
        const psets = n.psets ?? [{ name: "Pset_AssetCustom", props: {} }];
        const idx = psets.findIndex((p) => p.name === "Pset_AssetCustom");
        const nextPsets = [...psets];

        if (idx < 0) {
          nextPsets.push({ name: "Pset_AssetCustom", props: { [key]: value } });
        } else {
          const existing = nextPsets[idx];
          nextPsets[idx] = { ...existing, props: { ...(existing.props ?? {}), [key]: value } };
        }

        next[oid] = { ...n, psets: nextPsets };
      });
      return next;
    });
  }

  function onDragStart(e: React.DragEvent, nodeId: string) {
    const n = nodes[nodeId];
    if (!n) return;

    if (n.kind === "Object") {
      const ids =
        selectedObjectIds.includes(nodeId) && selectedObjectIds.length > 0
          ? selectedObjectIds
          : [nodeId];
      const payload: DragPayload = { type: "Object", ids };
      e.dataTransfer.setData("application/json", JSON.stringify(payload));
      e.dataTransfer.effectAllowed = "move";
      return;
    }

    if (n.kind === "Building") {
      const payload: DragPayload = { type: "Building", id: nodeId };
      e.dataTransfer.setData("application/json", JSON.stringify(payload));
      e.dataTransfer.effectAllowed = "move";
      return;
    }

    if (n.kind === "Storey") {
      const payload: DragPayload = { type: "Storey", id: nodeId };
      e.dataTransfer.setData("application/json", JSON.stringify(payload));
      e.dataTransfer.effectAllowed = "move";
      return;
    }
  }

  function allowDrop(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }

  function getDragPayload(e: React.DragEvent): DragPayload | null {
    const json = e.dataTransfer.getData("application/json");
    return json ? safeParseDragPayload(json) : null;
  }

  function onDrop(e: React.DragEvent, targetId: string) {
    e.preventDefault();
    const payload = getDragPayload(e);
    if (!payload) return;

    const target = nodes[targetId];
    if (!target) return;

    if (payload.type === "Object") {
      const ids = payload.ids;

      if (target.kind === "Site") moveManyObjectsToSite(ids, target.id);
      else if (target.kind === "Building") moveManyObjectsToBuilding(ids, target.id);
      else if (target.kind === "Storey") moveManyObjectsToStorey(ids, target.id);
      else if (target.kind === "ClassGroup") moveManyObjectsToGroup(ids, target.id);

      setSelectedObjectIds(ids);
      setSelectedId(ids[0] ?? selectedId);
      return;
    }

    if (payload.type === "Building") {
      if (target.kind === "Site") moveBuildingToSite(payload.id, target.id);
      return;
    }

    if (payload.type === "Storey") {
      if (target.kind === "Building") moveStoreyToBuilding(payload.id, target.id);
      if (target.kind === "Site") moveStoreyToSite(payload.id, target.id);
      return;
    }
  }

  const tree = useMemo(() => {
    function iconFor(n: TreeNode) {
      if (n.kind === "Site") return <IconMapPin size={16} />;
      if (n.kind === "Building") return <IconBuilding size={16} />;
      if (n.kind === "Storey") return <IconLayoutGrid size={16} />;
      if (n.kind === "ClassGroup") return <IconCube size={16} />;
      if (n.kind === "Object") return <IconCube size={16} />;
      return <span style={{ width: 16 }} />;
    }

    function metaFor(n: TreeNode) {
      if (n.kind === "Object") {
        return (
          <Group spacing={6} noWrap>
            {n.ifcClass ? (
              <Badge size="xs" variant="light">
                {n.ifcClass}
              </Badge>
            ) : null}
            {n.tag ? (
              <Badge size="xs" variant="outline">
                {n.tag}
              </Badge>
            ) : null}
          </Group>
        );
      }
      if (n.kind === "ClassGroup") return <Text color="dimmed" size="xs">Class</Text>;
      return <Text color="dimmed" size="xs">{n.kind}</Text>;
    }

    function isDropTarget(n: TreeNode) {
      return n.kind === "Site" || n.kind === "Building" || n.kind === "Storey" || n.kind === "ClassGroup";
    }

    function isDraggable(n: TreeNode) {
      return n.kind === "Object" || n.kind === "Building" || n.kind === "Storey";
    }

    function renderNode(id: string, depth = 0) {
      const n = nodes[id];
      if (!n) {
        // dangling reference -> ignore
        return null;
      }

      const isSelected = id === selectedId;
      const isObjSelected = n.kind === "Object" && selectedObjectIds.includes(id);

      const droppable = isDropTarget(n);
      const draggable = isDraggable(n);

      return (
        <div key={id} style={{ paddingLeft: depth * 12 }}>
          <Paper
            withBorder
            p="xs"
            style={{
              cursor: "pointer",
              borderColor: isSelected ? "black" : undefined,
              outline: droppable ? "1px dashed rgba(0,0,0,0.15)" : undefined,
              background: isObjSelected ? "rgba(0,0,0,0.06)" : undefined,
            }}
            onClick={(e) => handleNodeClick(e, id)}
            draggable={draggable}
            onDragStart={draggable ? (e) => onDragStart(e, id) : undefined}
            onDragOver={droppable ? allowDrop : undefined}
            onDrop={droppable ? (e) => onDrop(e, id) : undefined}
          >
            <Group spacing="xs" noWrap position="apart">
              <Group spacing="xs" noWrap>
                {iconFor(n)}
                <Text weight={isSelected ? 700 : 500} lineClamp={1}>
                  {n.name}
                </Text>
              </Group>
              {metaFor(n)}
            </Group>
          </Paper>

          <div style={{ marginTop: 6, marginBottom: 6 }}>
            {n.children          
              .filter((cid) => !!nodes[cid]) // <— wichtig
              .map((c) => renderNode(c, depth + 1))}
          </div>
        </div>
      );
    }

    return renderNode(treeRootId);
  }, [nodes, selectedId, selectedObjectIds]);

  const isRealObject = selected?.kind === "Object";
  const inspectorTitle = isRealObject && selected?.ifcClass ? `Inspector — ${selected.ifcClass}` : "Inspector";

  const activeContext = useMemo(() => {
    const site = selectedSiteId ? nodes[selectedSiteId] : undefined;
    const building = selectedBuildingId ? nodes[selectedBuildingId] : undefined;
    const storey = selectedStoreyId ? nodes[selectedStoreyId] : undefined;
    return { site, building, storey };
  }, [selectedSiteId, selectedBuildingId, selectedStoreyId, nodes]);

  return (
    <>
      <AppShell
        padding="md"
        navbar={
          <Navbar width={{ base: 360 }} p="md">
            <Group position="apart">
              <Text weight={700}>Spatial Tree</Text>
              {selectedObjectIds.length > 0 ? (
                <Badge variant="filled">{selectedObjectIds.length} selected</Badge>
              ) : null}
            </Group>
            <Divider my="sm" />
            <ScrollArea style={{ height: "calc(100vh - 140px)" }}>{tree}</ScrollArea>
          </Navbar>
        }
        header={
          <Header height={56} p="md">
            <Group position="apart" style={{ height: "100%" }}>
              <Title order={4}>IFC Coordinator (UI-first MVP)</Title>
              <Group>
                <Button variant="default" leftIcon={<IconPlus size={16} />} onClick={addSite}>
                  Add Site
                </Button>
                <Button variant="default" leftIcon={<IconPlus size={16} />} onClick={addBuilding}>
                  Add Building
                </Button>

                <FileButton onChange={(file) => file && handleImportIfc(file)} accept=".ifc">
                  {(props) => (
                    <Button variant="default" {...props}>
                      Import IFC
                    </Button>
                  )}
                </FileButton>

                <Button variant="light" onClick={() => exportIfc2x3FromTree(nodes, "template.ifc")}>
                  Export IFC2X3
                </Button>

                <Button
                  variant="default"
                  leftIcon={<IconPlus size={16} />}
                  onClick={addStorey}
                  disabled={!selectedBuildingId}
                >
                  Add Storey
                </Button>
                <Button leftIcon={<IconPlus size={16} />} onClick={openAddObject}>
                  Add Object
                </Button>
              </Group>
            </Group>
          </Header>
        }
      >
        <Group align="flex-start" grow>
          <Paper withBorder p="md" style={{ height: "70vh" }}>
            <Text weight={700}>IFC Viewer</Text>
            <Divider my="sm" />
            <div style={{ height: "calc(70vh - 60px)" }}>
              <IfcViewer onViewerReady={setViewer} />
            </div>
          </Paper>

          <Paper withBorder p="md">
            <Divider my="sm" />

            <Text size="sm">
              Selected: <b>{selected?.name ?? "-"}</b>
            </Text>

            <Divider my="sm" />
            <Text size="sm" weight={600}>
              Active context
            </Text>
            <Text size="sm">Site: {activeContext.site?.name ?? "—"}</Text>
            <Text size="sm">Building: {activeContext.building?.name ?? "—"}</Text>
            <Text size="sm">Storey: {activeContext.storey?.name ?? "—"}</Text>

            <Text size="xs" color="dimmed" mt="sm">
              Multi-Select: Ctrl/⌘ + Click (toggle), Shift + Click (range). Dragging moves all selected Objects.
            </Text>
          </Paper>

          <Paper withBorder p="md">
            <Group position="apart">
              <Text weight={700}>{inspectorTitle}</Text>
              <IconPencil size={16} />
            </Group>
            <Divider my="sm" />

            {bulkCount >= 2 ? (
              <>
                <Text weight={700}>Bulk Edit</Text>
                <Text size="sm" color="dimmed">
                  Applies to <b>{bulkCount}</b> Objects.
                </Text>

                <Divider my="sm" />

                <Stack spacing="sm">
                  <Select
                    label="Set IFC Class (all selected)"
                    data={IFC_CLASS_OPTIONS.map((x) => ({ value: x, label: x }))}
                    value={bulkIfcClass}
                    onChange={(v) => v && setBulkIfcClass(v)}
                    searchable
                  />
                  <Group position="right">
                    <Button onClick={bulkApplyIfcClass}>Apply Class</Button>
                  </Group>

                  <Divider my="sm" />

                  <Text weight={600}>Tag Generator</Text>

                  <Select
                    label="Counter mode"
                    data={[
                      { value: "global", label: "Global counter (1..n across all selected)" },
                      { value: "perClass", label: "Per-class counter (each IFC class starts at Start)" },
                    ]}
                    value={tagCounterMode}
                    onChange={(v) => v && setTagCounterMode(v as "global" | "perClass")}
                  />

                  <TextInput
                    label="Pattern"
                    value={tagPattern}
                    onChange={(e) => setTagPattern(e.currentTarget.value)}
                    placeholder="{CLASS}-{N:4}"
                    description="Tokens: {CLASS} {SITE} {BLDG} {STRY} {CUSTOM} and {N} or {N:4}"
                  />

                  <Group grow>
                    <NumberInput
                      label="Start"
                      value={tagStart}
                      onChange={(v) => setTagStart(Number(v ?? 1))}
                      min={0}
                    />
                    <NumberInput
                      label="Step"
                      value={tagStep}
                      onChange={(v) => setTagStep(Number(v ?? 1))}
                      min={1}
                    />
                  </Group>

                  <TextInput
                    label="CUSTOM token"
                    value={tagCustom}
                    onChange={(e) => setTagCustom(e.currentTarget.value)}
                    placeholder="z.B. DL oder System"
                    description="Wird nur genutzt, wenn {CUSTOM} im Pattern vorkommt."
                  />

                  <Checkbox
                    checked={tagSkipExisting}
                    onChange={(e) => setTagSkipExisting(e.currentTarget.checked)}
                    label="Skip existing tags (unique)"
                  />

                  <Group position="right">
                    <Button onClick={bulkApplyTags} disabled={!tagPattern.trim()}>
                      Generate Tags
                    </Button>
                  </Group>

                  <Divider my="sm" />

                  <Text weight={600}>Find & Replace Names</Text>
                  <Group grow>
                    <TextInput label="Find" value={bulkFind} onChange={(e) => setBulkFind(e.currentTarget.value)} />
                    <TextInput
                      label="Replace"
                      value={bulkReplace}
                      onChange={(e) => setBulkReplace(e.currentTarget.value)}
                    />
                  </Group>
                  <Group align="flex-end">
                    <Checkbox
                      checked={bulkUseRegex}
                      onChange={(e) => setBulkUseRegex(e.currentTarget.checked)}
                      label="Regex"
                    />
                    <Button
                      onClick={bulkFindReplaceNames}
                      disabled={!bulkFind}
                      style={{ marginLeft: "auto" }}
                    >
                      Apply Rename
                    </Button>
                  </Group>

                  <Divider my="sm" />

                  <Text weight={600}>Add / Overwrite Property</Text>
                  <Group grow>
                    <TextInput
                      label="Key"
                      value={bulkPropKey}
                      onChange={(e) => setBulkPropKey(e.currentTarget.value)}
                    />
                    <TextInput
                      label="Value"
                      value={bulkPropValue}
                      onChange={(e) => setBulkPropValue(e.currentTarget.value)}
                    />
                  </Group>
                  <Group position="right">
                    <Button onClick={bulkAddProperty} disabled={!bulkPropKey.trim()}>
                      Apply Property
                    </Button>
                  </Group>
                </Stack>
              </>
            ) : !selected ? (
              <Text color="dimmed">Nothing selected</Text>
            ) : (
              <Stack spacing="sm">
                <TextInput
                  label="Name"
                  value={selected.name}
                  onChange={(e) => renameSelected(e.currentTarget.value)}
                  disabled={selected.kind === "Project"}
                />

                <TextInput label="Kind" value={selected.kind} readOnly />

                {isRealObject ? (
                  <>
                    <Select
                      label="IFC Class"
                      data={IFC_CLASS_OPTIONS.map((x) => ({ value: x, label: x }))}
                      value={selected.ifcClass ?? "IfcBuildingElementProxy"}
                      onChange={(v) => v && setSelectedIfcClass(v)}
                      searchable
                    />
                    <TextInput
                      label="Tag / AssetId"
                      placeholder="z.B. P-101"
                      value={selected.tag ?? ""}
                      onChange={(e) => setSelectedTag(e.currentTarget.value)}
                    />

                    <Divider my="sm" />
                    <Text weight={600}>Property Sets (Psets)</Text>

                    {/* Sicherstellen, dass wenigstens ein Default-Pset existiert */}
                    {(() => {
                      const psets = selected.psets ?? [];
                      if (psets.length === 0) {
                        ensureObjectHasPset(selected.id, "Pset_AssetCustom");
                        return <Text size="sm" color="dimmed">Initializing Pset...</Text>;
                      }

                      const psetNames = psets.map((p) => p.name);
                      const activeName = psetNames.includes(activePsetName) ? activePsetName : psetNames[0];
                      const active = psets.find((p) => p.name === activeName)!;

                      return (
                        <Stack spacing="sm">
                          <Select
                            label="Active Pset"
                            data={psetNames.map((n) => ({ value: n, label: n }))}
                            value={activeName}
                            onChange={(v) => v && setActivePsetName(v)}
                            searchable
                          />

                          <Group grow align="flex-end">
                            <TextInput
                              label="New Pset name"
                              placeholder="z.B. Pset_ManufacturerTypeInformation"
                              value={newPsetName}
                              onChange={(e) => setNewPsetName(e.currentTarget.value)}
                            />
                            <Button
                              onClick={() => addPsetToObject(selected.id, newPsetName)}
                              disabled={!newPsetName.trim()}
                            >
                              Add Pset
                            </Button>
                          </Group>

                          <Divider my="sm" />
                          <Text weight={600}>Properties in {active.name}</Text>

                          {Object.keys(active.props ?? {}).length === 0 ? (
                            <Text size="sm" color="dimmed">No properties yet.</Text>
                          ) : (
                            <Stack spacing={6}>
                              {Object.entries(active.props)
                                .sort(([a], [b]) => a.localeCompare(b))
                                .map(([k, v]) => (
                                  <Group key={k} position="apart" noWrap>
                                    <Text size="sm" lineClamp={1}>
                                      <b>{k}:</b> {v}
                                    </Text>
                                    <Button
                                      size="xs"
                                      color="red"
                                      variant="light"
                                      onClick={() => deletePsetProperty(selected.id, active.name, k)}
                                    >
                                      Delete
                                    </Button>
                                  </Group>
                                ))}
                            </Stack>
                          )}

                          <Group grow align="flex-end">
                            <TextInput
                              label="Key"
                              placeholder="z.B. System"
                              value={propKeyInput}
                              onChange={(e) => setPropKeyInput(e.currentTarget.value)}
                            />
                            <TextInput
                              label="Value"
                              placeholder="z.B. Piping"
                              value={propValueInput}
                              onChange={(e) => setPropValueInput(e.currentTarget.value)}
                            />
                          </Group>

                          <Group position="right">
                            <Button
                              onClick={() => {
                                setPsetProperty(selected.id, active.name, propKeyInput, propValueInput);
                                setPropKeyInput("");
                                setPropValueInput("");
                              }}
                              disabled={!propKeyInput.trim()}
                            >
                              Add / Update
                            </Button>
                          </Group>
                        </Stack>
                      );
                    })()}

                    <Divider my="sm" />
                    <Text weight={600}>Documents</Text>

                    {(selected.docs ?? []).length === 0 ? (
                      <Text size="sm" color="dimmed">
                        No documents attached.
                      </Text>
                    ) : (
                      <Stack spacing={6}>
                        {(selected.docs ?? []).map((doc) => (
                          <Group key={doc.id} position="apart">
                            <Text size="sm" lineClamp={1}>
                              {doc.name} <Text span color="dimmed">({doc.version})</Text>
                            </Text>

                            <Button size="xs" variant="light" component="a" href={doc.url} download={doc.name}>
                              Download
                            </Button>

                            <Button
                              size="xs"
                              color="red"
                              variant="light"
                              onClick={() => requestDeleteDocument(selected.id, doc.id)}
                            >
                              Delete
                            </Button>
                          </Group>
                        ))}
                      </Stack>
                    )}

                    <FileButton onChange={(file) => file && void addDocumentToAsset(selected.id, file)}>
                      {(props) => (
                        <Button {...props} mt="xs" size="xs">
                          Upload document
                        </Button>
                      )}
                    </FileButton>
                  </>
                ) : null}
              </Stack>
            )}
          </Paper>
        </Group>
      </AppShell>

      <Modal opened={addObjectOpen} onClose={() => setAddObjectOpen(false)} title="Add Object" centered>
        <Stack spacing="sm">
          <Select
            label="Mode"
            data={[
              { value: "single", label: "Single object" },
              { value: "batch", label: "Batch create" },
            ]}
            value={createMode}
            onChange={(v) => v && setCreateMode(v as "single" | "batch")}
          />

          <Select
            label="Target Site"
            data={getAllSites().map((id) => ({ value: id, label: nodes[id]?.name ?? id }))}
            value={targetSiteId}
            onChange={(v) => {
              setTargetSiteId(v);
              setTargetBuildingId(null);
              setTargetStoreyId(null);
            }}
            searchable
            clearable
          />

          <Select
            label="Target Building"
            data={(targetSiteId ? getBuildingsOfSite(targetSiteId) : getAllBuildings()).map((id) => ({
              value: id,
              label: nodes[id]?.name ?? id,
            }))}
            value={targetBuildingId}
            onChange={(v) => {
              setTargetBuildingId(v);
              setTargetStoreyId(null);
            }}
            searchable
            clearable
          />

          <Select
            label="Target Storey"
            data={(targetBuildingId ? getStoreysOfBuilding(targetBuildingId) : getAllStoreys()).map((id) => ({
              value: id,
              label: nodes[id]?.name ?? id,
            }))}
            value={targetStoreyId}
            onChange={(v) => setTargetStoreyId(v)}
            searchable
            clearable
          />

          <Select
            label="IFC Class"
            data={IFC_CLASS_OPTIONS.map((x) => ({ value: x, label: x }))}
            value={newObjIfcClass}
            onChange={(v) => v && setNewObjIfcClass(v)}
            searchable
          />

          {createMode === "single" ? (
            <>
              <TextInput
                label="Name"
                placeholder="z.B. Pump P-101"
                value={newObjName}
                onChange={(e) => setNewObjName(e.currentTarget.value)}
                autoFocus
              />
              <TextInput
                label="Tag / AssetId"
                placeholder="optional"
                value={newObjTag}
                onChange={(e) => setNewObjTag(e.currentTarget.value)}
              />
            </>
          ) : (
            <>
              <NumberInput label="Count" value={batchCount} onChange={(v) => setBatchCount(Number(v ?? 1))} min={1} />

              <TextInput
                label="Name pattern"
                value={batchNamePattern}
                onChange={(e) => setBatchNamePattern(e.currentTarget.value)}
                placeholder="Pump {N}"
                description="Use {N} for 1..count"
              />

              <Checkbox
                checked={batchGenerateTags}
                onChange={(e) => setBatchGenerateTags(e.currentTarget.checked)}
                label="Generate tags on create"
              />

              {batchGenerateTags ? (
                <>
                  <TextInput
                    label="Tag pattern"
                    value={batchTagPattern}
                    onChange={(e) => setBatchTagPattern(e.currentTarget.value)}
                    placeholder="{CLASS}-{N:3}"
                    description="Tokens: {CLASS} {SITE} {BLDG} {STRY} {CUSTOM} and {N} or {N:4}"
                  />
                  <Group grow>
                    <NumberInput
                      label="Start"
                      value={batchTagStart}
                      onChange={(v) => setBatchTagStart(Number(v ?? 1))}
                      min={0}
                    />
                    <NumberInput
                      label="Step"
                      value={batchTagStep}
                      onChange={(v) => setBatchTagStep(Number(v ?? 1))}
                      min={1}
                    />
                  </Group>
                </>
              ) : null}
            </>
          )}

          <Group position="right" mt="sm">
            <Button variant="default" onClick={() => setAddObjectOpen(false)}>
              Cancel
            </Button>
            <Button onClick={createObject} disabled={createMode === "single" ? !newObjName.trim() : batchCount < 1}>
              Create
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={deleteDocOpen} onClose={() => setDeleteDocOpen(false)} title="Delete document?" centered>
        {(() => {
          const assetId = deleteDocTarget?.assetId;
          const docId = deleteDocTarget?.docId;

          const asset = assetId ? nodes[assetId] : undefined;
          const doc = asset?.kind === "Object" ? (asset.docs ?? []).find((d) => d.id === docId) : undefined;

          return (
            <Stack spacing="sm">
              <Text size="sm">Do you really want to delete this document?</Text>

              <Paper withBorder p="sm">
                <Text size="sm">
                  <b>{doc?.name ?? "Unknown document"}</b>
                </Text>
                <Text size="xs" color="dimmed">
                  This will permanently remove the file from local storage (IndexedDB).
                </Text>
              </Paper>

              <Group position="right" mt="sm">
                <Button variant="default" onClick={() => setDeleteDocOpen(false)}>
                  Cancel
                </Button>

                <Button
                  color="red"
                  onClick={() => {
                    if (deleteDocTarget) {
                      void deleteDocumentFromAsset(deleteDocTarget.assetId, deleteDocTarget.docId);
                    }
                    setDeleteDocOpen(false);
                    setDeleteDocTarget(null);
                  }}
                >
                  Delete
                </Button>
              </Group>
            </Stack>
          );
        })()}
      </Modal>
    </>
  );
}

// src/components/IfcViewer.tsx
import { useEffect, useRef } from "react";
import { IfcViewerAPI } from "web-ifc-viewer";
import * as THREE from "three";

type Props = { onViewerReady?: (viewer: IfcViewerAPI) => void };

export default function IfcViewer({ onViewerReady }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // prevents double-init in React 18 StrictMode (dev)
  const viewerRef = useRef<IfcViewerAPI | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // already initialized
    if (viewerRef.current) return;

    const viewer = new IfcViewerAPI({
      container,
      backgroundColor: new THREE.Color(0xf0f0f0),
    });

    viewerRef.current = viewer;

    // WASM files in public/wasm
    viewer.IFC.setWasmPath("/wasm/");

    // Worker (file must exist in public/wasm/IFCWorker.js)
    try {
      (viewer.IFC.loader.ifcManager as any).useWebWorkers(true, "/wasm/IFCWorker.js");
    } catch (e) {
      console.warn("WebWorkers not available / not supported by this web-ifc-viewer version:", e);
    }

    viewer.axes.setAxes();
    viewer.grid.setGrid();

    // handle resize
    const resize = () => {
      try {
        const w = Math.max(1, container.clientWidth);
        const h = Math.max(1, container.clientHeight);

        // renderer
        const renderer = viewer.context?.renderer;
        if (renderer) renderer.setSize(w, h);

        // camera (avoid optional chaining on assignment)
        const cam = viewer.context?.camera as THREE.PerspectiveCamera | undefined;
        if (cam && "aspect" in cam) {
          cam.aspect = w / h;
          cam.updateProjectionMatrix();
        }
      } catch {
        // ignore
      }
    };

    const ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();

    onViewerReady?.(viewer);

    return () => {
      ro.disconnect();

      // dispose viewer
      try {
        viewer.dispose();
      } catch {
        // ignore
      }

      viewerRef.current = null;
    };
  }, [onViewerReady]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}

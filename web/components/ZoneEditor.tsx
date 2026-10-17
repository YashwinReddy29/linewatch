"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Zone } from "@/lib/types";

import { apiFetch, errorMessage } from "./api";
import { Header } from "./Header";
import { useLive } from "./useLive";

type Pt = [number, number];
type FrameState = "loading" | "ready" | "missing";

const clamp = (v: number) => Math.min(1, Math.max(0, v));

export function ZoneEditor() {
  const { status, statusError } = useLive();
  const [frameKey, setFrameKey] = useState(0);
  const [frame, setFrame] = useState<FrameState>("loading");
  const [aspect, setAspect] = useState(16 / 9);
  const [points, setPoints] = useState<Pt[]>([]);
  const [closed, setClosed] = useState(false);
  const [name, setName] = useState("");
  const [loadedZone, setLoadedZone] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [history, setHistory] = useState<{ points: Pt[]; closed: boolean }[]>([]);

  // Start from the zone that is active now, so editing is the default rather than redrawing.
  // (Adjusting state during render when new data arrives, instead of in an effect.)
  if (!loadedZone && status) {
    const zone: Zone | null = status.zone;
    if (zone) {
      setPoints(zone.points);
      setClosed(true);
      setName(zone.name);
    }
    setLoadedZone(true);
  }

  const onFrameLoaded = useCallback((img: HTMLImageElement) => {
    if (img.naturalWidth && img.naturalHeight) setAspect(img.naturalWidth / img.naturalHeight);
    setFrame("ready");
  }, []);

  // The frame can finish loading before React hydrates, in which case onLoad never fires.
  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete) {
      if (img.naturalWidth > 0) onFrameLoaded(img);
      else setFrame("missing");
    }
  }, [frameKey, onFrameLoaded]);

  const remember = () => {
    setHistory((h) => [...h, { points, closed }]);
    setDirty(true);
  };

  const undo = useCallback(() => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory(history.slice(0, -1));
    setPoints(prev.points);
    setClosed(prev.closed);
  }, [history]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      } else if (e.key === "Escape" && !closed) {
        remember();
        setPoints([]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undo, closed, points]);

  function toPoint(e: React.PointerEvent): Pt {
    const box = svgRef.current!.getBoundingClientRect();
    return [clamp((e.clientX - box.left) / box.width), clamp((e.clientY - box.top) / box.height)];
  }

  function onCanvasClick(e: React.PointerEvent<SVGSVGElement>) {
    if (closed || frame !== "ready" || dragIndex !== null) return;
    remember();
    setPoints((p) => [...p, toPoint(e)]);
    setMessage(null);
  }

  function onVertexDown(e: React.PointerEvent, index: number) {
    e.stopPropagation();
    if (!closed && index === 0 && points.length >= 3) {
      remember();
      setClosed(true);
      return;
    }
    remember();
    setDragIndex(index);
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function onMove(e: React.PointerEvent) {
    if (dragIndex === null) return;
    const p = toPoint(e);
    setPoints((pts) => pts.map((q, i) => (i === dragIndex ? p : q)));
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await apiFetch("/api/zones", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // 4 decimals is sub-pixel at 4K; keeps stored zones readable.
        body: JSON.stringify({
          name: name.trim(),
          points: points.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(errorMessage(body, res.status));
      setDirty(false);
      setMessage({ tone: "ok", text: `Saved ${body.zone.name}. The camera worker switches to it within a few seconds.` });
    } catch (err) {
      setMessage({ tone: "error", text: `Zone not saved: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSaving(false);
    }
  }

  async function removeZone() {
    if (!window.confirm("Stop monitoring and remove this zone?")) return;
    const res = await apiFetch("/api/zones", { method: "DELETE" });
    if (res.ok) {
      setPoints([]);
      setClosed(false);
      setName("");
      setMessage({ tone: "ok", text: "Zone removed. Nothing is monitored until you draw a new one." });
    }
  }

  const hint = frame !== "ready"
    ? ""
    : !closed
      ? points.length === 0
        ? "Click on the frame to place the first corner of the zone."
        : points.length < 3
          ? `Keep clicking to add corners. A zone needs at least 3.`
          : "Click the first corner to close the zone."
      : dirty
        ? "Drag any corner to adjust. Name the zone and save it."
        : "Drag any corner to change the zone.";

  // Draw in a coordinate space with the frame's aspect ratio so corner handles stay round.
  const W = 1000;
  const H = 1000 / aspect;
  const svgPoints = points.map(([x, y]) => `${x * W},${y * H}`).join(" ");

  const canSave = dirty && closed && points.length >= 3 && name.trim().length > 0 && !saving;

  return (
    <>
      <Header status={status} statusError={statusError} />
      <main className="zone-page">
        <div className="zone-intro">
          <h1>Zone</h1>
          <p>
            Outline the floor area where hi-vis vests are required. A person counts as inside when their feet are inside
            the outline.
          </p>
        </div>

        <div className="zone-canvas">
          {frame !== "missing" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={frameKey}
              ref={imgRef}
              src={`/api/frame?k=${frameKey}`}
              alt="Still frame from the camera"
              onLoad={(e) => onFrameLoaded(e.currentTarget)}
              onError={() => setFrame("missing")}
              draggable={false}
            />
          )}
          {frame === "loading" && (
            <div className="canvas-msg">
              <span className="spinner" aria-hidden="true" />
              Getting a still frame from the camera
            </div>
          )}
          {frame === "missing" && (
            <div className="canvas-msg is-down">
              <p>No camera frame yet. The camera worker needs to be running to draw a zone on its view.</p>
              <button
                className="btn btn-quiet"
                onClick={() => {
                  setFrame("loading");
                  setFrameKey((k) => k + 1);
                }}
              >
                Try again
              </button>
            </div>
          )}
          {frame === "ready" && (
            <svg
              ref={svgRef}
              className={`zone-svg ${closed ? "" : "is-drawing"}`}
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              onPointerDown={onCanvasClick}
              onPointerMove={onMove}
              onPointerUp={() => setDragIndex(null)}
              role="application"
              aria-label="Zone drawing area"
            >
              {points.length > 1 &&
                (closed ? (
                  <polygon className="zone-shape" points={svgPoints} />
                ) : (
                  <polyline className="zone-line" points={svgPoints} />
                ))}
              {points.map(([x, y], i) => (
                <circle
                  key={i}
                  cx={x * W}
                  cy={y * H}
                  r={11}
                  className={`vertex ${!closed && i === 0 && points.length >= 3 ? "is-closer" : ""}`}
                  onPointerDown={(e) => onVertexDown(e, i)}
                />
              ))}
            </svg>
          )}
        </div>

        <div className="zone-tools">
          <p className="hint" aria-live="polite">
            {hint}
          </p>
          <div className="tool-row">
            <button className="btn btn-quiet" onClick={undo} disabled={history.length === 0}>
              Undo <kbd>Ctrl Z</kbd>
            </button>
            <button
              className="btn btn-quiet"
              onClick={() => {
                remember();
                setPoints([]);
                setClosed(false);
              }}
              disabled={points.length === 0}
            >
              Start over
            </button>
          </div>
          <label className="field">
            <span>Zone name</span>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setDirty(true);
              }}
              placeholder="Loading bay 2"
              maxLength={60}
              aria-describedby="zone-name-help"
            />
            <small id="zone-name-help">Name the place. Alerts read &ldquo;No vest in {name.trim() || "Loading bay 2"}&rdquo;.</small>
          </label>
          <div className="tool-row">
            <button className="btn btn-primary" onClick={save} disabled={!canSave}>
              {saving ? "Saving zone" : "Save zone"}
            </button>
            {status?.zone && (
              <button className="btn-link danger" onClick={removeZone}>
                Remove zone
              </button>
            )}
          </div>
          {message && (
            <p className={message.tone === "ok" ? "notice" : "inline-error"} role="status">
              {message.text} {message.tone === "ok" && <Link href="/">Back to live view</Link>}
            </p>
          )}
        </div>
      </main>
    </>
  );
}

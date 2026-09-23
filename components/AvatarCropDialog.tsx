"use client";

import { useEffect, useRef, useState } from "react";
import { avatarCropLayout, type CropCenter } from "@/lib/avatarCrop";
import styles from "./AvatarCropDialog.module.css";

type Props = {
  photoUrl: string;
  uploading: boolean;
  uploadError: string | null;
  onCancel: () => void;
  onSave: (croppedPhoto: Blob) => Promise<void>;
};

const OUTPUT_SIZE = 512;

export default function AvatarCropDialog({ photoUrl, uploading, uploadError, onCancel, onSave }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; center: CropCenter } | null>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [frameSize, setFrameSize] = useState(256);
  const [center, setCenter] = useState<CropCenter>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => setFrameSize(frame.clientWidth || frame.getBoundingClientRect().width || 256);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const layout = dimensions.width && dimensions.height
    ? avatarCropLayout(dimensions.width, dimensions.height, frameSize, zoom, center)
    : null;

  function moveTo(next: CropCenter) {
    if (!dimensions.width || !dimensions.height) return;
    setCenter(avatarCropLayout(dimensions.width, dimensions.height, frameSize, zoom, next).center);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId || !layout) return;
    moveTo({
      x: drag.center.x - (e.clientX - drag.x) / layout.scale,
      y: drag.center.y - (e.clientY - drag.y) / layout.scale,
    });
  }

  async function saveCrop() {
    if (!layout || !imageRef.current || uploading || preparing) return;
    setPreparing(true);
    setError(null);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = OUTPUT_SIZE;
      canvas.height = OUTPUT_SIZE;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not prepare this photo. Please try another image.");
      context.drawImage(
        imageRef.current,
        layout.center.x - layout.sourceSize / 2,
        layout.center.y - layout.sourceSize / 2,
        layout.sourceSize,
        layout.sourceSize,
        0,
        0,
        OUTPUT_SIZE,
        OUTPUT_SIZE,
      );
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Could not prepare this photo.")), "image/png");
      });
      await onSave(blob);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not prepare this photo.");
    } finally {
      setPreparing(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="avatar-crop-title"
      onCancel={(e) => { e.preventDefault(); if (!uploading && !preparing) onCancel(); }}
    >
      <h2 id="avatar-crop-title" className={styles.title}>Adjust profile photo</h2>
      <p className={styles.hint}>Move and zoom the photo to choose what appears in your profile circle.</p>
      <div
        ref={frameRef}
        className={styles.frame}
        tabIndex={0}
        role="group"
        aria-label="Photo preview. Drag to move the photo, or use the arrow keys."
        onPointerDown={(e) => {
          if (!layout || uploading || preparing) return;
          dragRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, center: layout.center };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={() => { dragRef.current = null; }}
        onPointerCancel={() => { dragRef.current = null; }}
        onKeyDown={(e) => {
          if (!layout || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
          e.preventDefault();
          const step = (e.shiftKey ? 30 : 10) / layout.scale;
          moveTo({
            x: layout.center.x + (e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0),
            y: layout.center.y + (e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0),
          });
        }}
      >
        {photoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={imageRef}
            src={photoUrl}
            alt=""
            draggable={false}
            className={styles.cropImage}
            style={layout ? {
              width: dimensions.width * layout.scale,
              height: dimensions.height * layout.scale,
              left: layout.left,
              top: layout.top,
            } : { visibility: "hidden" }}
            onLoad={(e) => {
              const { naturalWidth: width, naturalHeight: height } = e.currentTarget;
              if (!width || !height) { setError("Could not read this photo. Please choose another image."); return; }
              setDimensions({ width, height });
              setCenter({ x: width / 2, y: height / 2 });
            }}
            onError={() => setError("Could not read this photo. Please choose another image.")}
          />
        )}
      </div>
      <label className={styles.zoomLabel} htmlFor="avatar-zoom">Zoom</label>
      <input
        id="avatar-zoom"
        className={styles.zoom}
        type="range"
        min="1"
        max="3"
        step="0.01"
        value={zoom}
        disabled={!layout || uploading || preparing}
        onChange={(e) => {
          const nextZoom = Number(e.target.value);
          setZoom(nextZoom);
          if (dimensions.width && dimensions.height) {
            setCenter(avatarCropLayout(dimensions.width, dimensions.height, frameSize, nextZoom, center).center);
          }
        }}
      />
      {error || uploadError ? <p role="alert" className={styles.error}>{error || uploadError}</p> : null}
      <div className={styles.actions}>
        <button type="button" className={styles.cancel} disabled={uploading || preparing} onClick={onCancel}>Cancel</button>
        <button type="button" className={styles.save} disabled={!layout || !!error || uploading || preparing} onClick={saveCrop}>
          {uploading || preparing ? "Saving…" : "Save photo"}
        </button>
      </div>
    </dialog>
  );
}

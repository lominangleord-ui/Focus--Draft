import type { FaceBounds } from "./types";

export type PreviewRect = FaceBounds;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * Maps normalized camera-frame bounds into the visible viewport of an
 * object-fit: cover preview, including the crop and the mirrored selfie view.
 */
export function mapFaceBoundsToPreview(
  bounds: FaceBounds | null,
  videoWidth: number,
  videoHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): PreviewRect | null {
  if (!bounds
    || ![bounds.x, bounds.y, bounds.width, bounds.height, videoWidth, videoHeight, viewportWidth, viewportHeight].every(Number.isFinite)
    || videoWidth <= 0
    || videoHeight <= 0
    || viewportWidth <= 0
    || viewportHeight <= 0
    || bounds.width <= 0
    || bounds.height <= 0) return null;

  const sourceAspect = videoWidth / videoHeight;
  const viewportAspect = viewportWidth / viewportHeight;
  let visibleLeft = 0;
  let visibleTop = 0;
  let visibleWidth = 1;
  let visibleHeight = 1;

  if (sourceAspect > viewportAspect) {
    visibleWidth = viewportAspect / sourceAspect;
    visibleLeft = (1 - visibleWidth) / 2;
  } else if (sourceAspect < viewportAspect) {
    visibleHeight = sourceAspect / viewportAspect;
    visibleTop = (1 - visibleHeight) / 2;
  }

  const sourceLeft = clamp(bounds.x, 0, 1);
  const sourceTop = clamp(bounds.y, 0, 1);
  const sourceRight = clamp(bounds.x + bounds.width, 0, 1);
  const sourceBottom = clamp(bounds.y + bounds.height, 0, 1);
  const cropRight = visibleLeft + visibleWidth;
  const cropBottom = visibleTop + visibleHeight;
  const leftInCrop = clamp((sourceLeft - visibleLeft) / visibleWidth, 0, 1);
  const rightInCrop = clamp((sourceRight - visibleLeft) / visibleWidth, 0, 1);
  const topInCrop = clamp((sourceTop - visibleTop) / visibleHeight, 0, 1);
  const bottomInCrop = clamp((sourceBottom - visibleTop) / visibleHeight, 0, 1);

  // Reject faces entirely hidden by the cover crop (touching edges is valid).
  if (sourceRight <= visibleLeft || sourceLeft >= cropRight || sourceBottom <= visibleTop || sourceTop >= cropBottom) return null;

  const x = 1 - rightInCrop;
  const y = topInCrop;
  const width = rightInCrop - leftInCrop;
  const height = bottomInCrop - topInCrop;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

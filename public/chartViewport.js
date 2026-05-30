export function clampViewport(viewport, totalBuckets) {
  const total = Math.max(0, totalBuckets);
  const size = Math.max(1, Math.min(Math.round(viewport.size), Math.max(total, 1)));
  const maxStart = Math.max(0, total - size);
  const start = Math.max(0, Math.min(Math.round(viewport.start), maxStart));

  return { start, size };
}

export function panViewport(viewport, totalBuckets, deltaBuckets) {
  return clampViewport(
    {
      start: viewport.start + deltaBuckets,
      size: viewport.size
    },
    totalBuckets
  );
}

export function zoomViewport(viewport, totalBuckets, zoomFactor, anchorRatio = 0.5) {
  const clampedAnchor = Math.max(0, Math.min(anchorRatio, 1));
  const nextSize = Math.round(viewport.size * zoomFactor);
  const anchorIndex = viewport.start + viewport.size * clampedAnchor;

  return clampViewport(
    {
      start: anchorIndex - nextSize * clampedAnchor,
      size: nextSize
    },
    totalBuckets
  );
}

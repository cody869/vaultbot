// logoTransparency.js
//
// Some team logo assets in the klunn91/team-logos source repo (see
// teamLogos.js) are flat opaque PNGs with a solid white square baked in,
// instead of a transparent background like the rest of the set -- the
// Miami Dolphins logo is the confirmed case, found when its scorebug card
// showed a white box instead of blending into the card background.
//
// Fix: if a logo's four corners are opaque near-white, flood-fill inward
// from the border (BFS, 4-connected) erasing only the white region that's
// actually connected to the edge. That protects white pixels that are part
// of the artwork itself (e.g. the dolphin's belly highlight, the sun's
// inner ring) since they aren't reachable from the border without crossing
// a non-white pixel first.
//
// Pure JS (pngjs) -- no native build step, safe for a Railway deploy.

import { PNG } from 'pngjs';

const WHITE_THRESHOLD = 18; // 255 - channel value; higher = more lenient

function isNearWhite(data, idx, threshold) {
  return (
    255 - data[idx] <= threshold &&
    255 - data[idx + 1] <= threshold &&
    255 - data[idx + 2] <= threshold
  );
}

/**
 * @param {Buffer} buf - raw PNG bytes
 * @returns {Buffer} PNG bytes, background-stripped if it needed it, or the
 *   original buffer untouched (and un-re-encoded) if it didn't.
 */
function stripWhiteBackground(buf, { threshold = WHITE_THRESHOLD } = {}) {
  let png;
  try {
    png = PNG.sync.read(buf);
  } catch {
    return buf; // not decodable by pngjs (shouldn't happen, PNG signature already verified) -- leave as-is
  }

  const { width, height, data } = png;

  const corners = [
    0,
    (width - 1) * 4,
    (height - 1) * width * 4,
    ((height - 1) * width + width - 1) * 4
  ];
  const needsWork = corners.every(
    (idx) => data[idx + 3] === 255 && isNearWhite(data, idx, threshold)
  );
  if (!needsWork) return buf;

  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let tail = 0;

  const tryPush = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (visited[p]) return;
    const idx = p * 4;
    if (data[idx + 3] !== 0 && isNearWhite(data, idx, threshold)) {
      visited[p] = 1;
      queue[tail++] = p;
    }
  };

  for (let x = 0; x < width; x++) {
    tryPush(x, 0);
    tryPush(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    tryPush(0, y);
    tryPush(width - 1, y);
  }

  let head = 0;
  while (head < tail) {
    const p = queue[head++];
    const x = p % width;
    const y = (p / width) | 0;
    data[p * 4 + 3] = 0;
    tryPush(x + 1, y);
    tryPush(x - 1, y);
    tryPush(x, y + 1);
    tryPush(x, y - 1);
  }

  return PNG.sync.write(png);
}

export { stripWhiteBackground };

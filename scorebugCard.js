// scorebugCard.js
//
// Renders a diagonal-split final-score card (Satori -> PNG via resvg).
// No headless browser -- fast enough to call once per completed game.
//
// Usage:
//   const { renderScorebugCard } = require('./scorebugCard');
//   const png = await renderScorebugCard({
//     week: 5,
//     teamA: { abbr: 'NE',  score: 27, record: '3-1' }, // left side
//     teamB: { abbr: 'JAX', score: 20, record: '2-2' }, // right side
//   });
//   fs.writeFileSync('out.png', png);
//
// Convention: pass the WINNER as teamA (left side gets the bolder
// treatment implicitly via card order) -- sort by score before calling.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { getTeam } from './teamLogos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const W = 900;
const H = 200;
const SEAM_ANGLE = 10;
const LOGO_SIZE = 480;

let fontsCache = null;
async function loadFonts() {
  if (fontsCache) return fontsCache;
  const anton = fs.readFileSync(path.join(__dirname, 'Anton-Regular.ttf'));
  const barlow = fs.readFileSync(path.join(__dirname, 'Barlow-Bold.ttf'));
  fontsCache = [
    { name: 'Anton', data: anton, weight: 400, style: 'normal' },
    { name: 'Barlow', data: barlow, weight: 700, style: 'normal' }
  ];
  return fontsCache;
}

// small in-memory cache so repeated calls in the same process don't
// re-fetch the same team's logo every time
const logoCache = new Map();
async function loadLogoDataUri(url) {
  if (logoCache.has(url)) return logoCache.get(url);

  let buf;
  if (/^https?:\/\//.test(url)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Logo fetch failed (${res.status}): ${url}`);
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    buf = fs.readFileSync(url);
  }
  const dataUri = 'data:image/png;base64,' + buf.toString('base64');
  logoCache.set(url, dataUri);
  return dataUri;
}

function seamRectGeometry(angleDeg, size = 700) {
  const rad = (angleDeg * Math.PI) / 180;
  const cx = W / 2 + (size / 2) * Math.cos(rad);
  const cy = H / 2 + (size / 2) * Math.sin(rad);
  return { left: cx - size / 2, top: cy - size / 2, size };
}

/**
 * @param {object} game
 * @param {number} game.week
 * @param {{abbr: string, score: number, record?: string, logoUrl?: string}} game.teamA - left side
 * @param {{abbr: string, score: number, record?: string, logoUrl?: string}} game.teamB - right side
 * @returns {Promise<Buffer>} PNG bytes
 */
async function renderScorebugCard(game) {
  const { week, teamA, teamB } = game;
  const A = { ...getTeam(teamA.abbr), ...teamA };
  const B = { ...getTeam(teamB.abbr), ...teamB };

  const [fonts, logoA, logoB] = await Promise.all([
    loadFonts(),
    loadLogoDataUri(A.logoUrl),
    loadLogoDataUri(B.logoUrl)
  ]);

  const seam = seamRectGeometry(SEAM_ANGLE);

  const tree = {
    type: 'div',
    props: {
      style: {
        width: W, height: H, display: 'flex', position: 'relative',
        overflow: 'hidden', borderRadius: 10,
        border: '3px solid #D4A843', background: A.color
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex',
              width: seam.size, height: seam.size,
              top: seam.top, left: seam.left,
              transform: `rotate(${SEAM_ANGLE}deg)`,
              background: B.color
            }
          }
        },
        {
          type: 'img',
          props: {
            src: logoA, width: LOGO_SIZE, height: LOGO_SIZE,
            style: {
              position: 'absolute',
              top: (H - LOGO_SIZE) / 2, left: -LOGO_SIZE * 0.15,
              opacity: 0.2
            }
          }
        },
        {
          type: 'img',
          props: {
            src: logoB, width: LOGO_SIZE, height: LOGO_SIZE,
            style: {
              position: 'absolute',
              top: (H - LOGO_SIZE) / 2, right: -LOGO_SIZE * 0.15,
              opacity: 0.2
            }
          }
        },
        A.record && {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', top: 14, left: 14,
              background: '#C60C30', color: '#FFFFFF', fontFamily: 'Barlow',
              fontSize: 20, padding: '4px 10px', borderRadius: 4
            },
            children: A.record
          }
        },
        B.record && {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', bottom: 14, right: 14,
              background: '#FFB612', color: '#111111', fontFamily: 'Barlow',
              fontSize: 20, padding: '4px 10px', borderRadius: 4
            },
            children: B.record
          }
        },
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', top: 40, left: 110,
              fontSize: 92, fontFamily: 'Anton', color: '#FFFFFF'
            },
            children: String(A.score)
          }
        },
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', top: 40, right: 90,
              fontSize: 92, fontFamily: 'Anton', color: '#FFFFFF'
            },
            children: String(B.score)
          }
        },
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex',
              top: '50%', left: '50%',
              transform: 'translate(-50%, -50%)'
            },
            children: {
              type: 'div',
              props: {
                style: {
                  display: 'flex',
                  background: '#D4A843', color: '#0C2340',
                  fontFamily: 'Barlow', fontSize: 22,
                  padding: '6px 16px', letterSpacing: 1
                },
                children: 'FINAL'
              }
            }
          }
        },
        week != null && {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', top: 14, left: '50%',
              transform: 'translateX(-50%)',
              color: 'rgba(255,255,255,0.75)', fontFamily: 'Barlow', fontSize: 16,
              letterSpacing: 2
            },
            children: `WEEK ${week}`
          }
        }
      ].filter(Boolean)
    }
  };

  const svg = await satori(tree, { width: W, height: H, fonts });
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: W * 2 } });
  return resvg.render().asPng();
}

export { renderScorebugCard };

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
//     contributors: [                                    // optional
//       { name: 'J. Allen', team: 'NE', line: '312 yds · 3 TD · 1 INT' },
//       { name: 'I. Pacheco', team: 'JAX', line: '63 yds · 1 TD · 17 car' },
//     ],
//   });
//   fs.writeFileSync('out.png', png);
//
// Convention: pass the WINNER as teamA (left side gets the bolder
// treatment implicitly via card order) -- sort by score before calling.
// When `contributors` is present (1-3 entries), the card grows a footer
// strip below the scorebug with a name/team/stat-line chip per entry. With
// no contributors, the card is just the original compact scorebug.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { getTeam } from './teamLogos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const W = 900;
const CARD_H = 200; // height of the scorebug portion itself, always this
const STRIP_H = 92;  // added height when contributors are present
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

// PNG files start with this exact 8-byte signature -- cheap, reliable way
// to catch "the request succeeded but what came back wasn't really a PNG"
// (an HTML error page, a truncated response, etc.), which a bare `res.ok`
// check doesn't catch since the HTTP status can still be 200.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

  if (buf.length < 512 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(
      `Logo at ${url} doesn't look like a real PNG (${buf.length} bytes) -- ` +
      `request likely succeeded with a non-image response instead of failing outright.`
    );
  }

  const dataUri = 'data:image/png;base64,' + buf.toString('base64');
  logoCache.set(url, dataUri);
  return dataUri;
}

function seamRectGeometry(angleDeg, size = 700) {
  const rad = (angleDeg * Math.PI) / 180;
  const cx = W / 2 + (size / 2) * Math.cos(rad);
  const cy = CARD_H / 2 + (size / 2) * Math.sin(rad);
  return { left: cx - size / 2, top: cy - size / 2, size };
}

// Lays out however many contributor chips are given (1-3) into evenly
// spaced columns across the strip width.
function contributorChips(contributors) {
  const margin = 24;
  const usable = W - margin * 2;
  const colWidth = usable / contributors.length;
  return contributors.map((c, i) => ({
    type: 'div',
    props: {
      style: {
        position: 'absolute', display: 'flex', flexDirection: 'column',
        top: 20, left: margin + i * colWidth, width: colWidth - 16
      },
      children: [
        {
          type: 'div',
          props: {
            style: { display: 'flex', color: '#FFFFFF', fontFamily: 'Barlow', fontSize: 17 },
            children: `${c.name} — ${c.team}`
          }
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', color: 'rgba(255,255,255,0.6)', fontFamily: 'Barlow', fontSize: 15, marginTop: 4 },
            children: c.line
          }
        }
      ]
    }
  }));
}

/**
 * @param {object} game
 * @param {number} game.week
 * @param {{abbr: string, score: number, record?: string, logoUrl?: string}} game.teamA - left side
 * @param {{abbr: string, score: number, record?: string, logoUrl?: string}} game.teamB - right side
 * @param {{name: string, team: string, line: string}[]} [game.contributors] - optional, 1-3 entries
 * @returns {Promise<Buffer>} PNG bytes
 */
async function renderScorebugCard(game) {
  const { week, teamA, teamB, contributors } = game;
  const A = { ...getTeam(teamA.abbr), ...teamA };
  const B = { ...getTeam(teamB.abbr), ...teamB };
  const hasStrip = Array.isArray(contributors) && contributors.length > 0;
  const H = hasStrip ? CARD_H + STRIP_H : CARD_H;

  const [fonts, logoA, logoB] = await Promise.all([
    loadFonts(),
    loadLogoDataUri(A.logoUrl),
    loadLogoDataUri(B.logoUrl)
  ]);

  const seam = seamRectGeometry(SEAM_ANGLE);

  const scorebug = {
    type: 'div',
    props: {
      style: {
        width: W, height: CARD_H, display: 'flex', position: 'relative',
        overflow: 'hidden', background: A.color
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
              top: (CARD_H - LOGO_SIZE) / 2, left: -LOGO_SIZE * 0.15,
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
              top: (CARD_H - LOGO_SIZE) / 2, right: -LOGO_SIZE * 0.15,
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

  const children = [scorebug];
  if (hasStrip) {
    children.push({
      type: 'div',
      props: {
        style: { width: W, height: STRIP_H, display: 'flex', position: 'relative', background: '#12161C' },
        children: [
          {
            type: 'div',
            props: {
              style: {
                position: 'absolute', display: 'flex', top: 0, left: 0,
                width: W, height: 1, background: 'rgba(212,168,67,0.4)'
              }
            }
          },
          ...contributorChips(contributors)
        ]
      }
    });
  }

  const tree = {
    type: 'div',
    props: {
      style: {
        width: W, height: H, display: 'flex', flexDirection: 'column',
        position: 'relative', overflow: 'hidden', borderRadius: 10,
        border: '3px solid #D4A843'
      },
      children
    }
  };

  const svg = await satori(tree, { width: W, height: H, fonts });
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: W * 2 } });
  return resvg.render().asPng();
}

export { renderScorebugCard };

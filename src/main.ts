import './index.css';
import * as d3 from 'd3';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, User } from 'firebase/auth';
import { getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, getDocFromServer } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

// --- Types ---
interface Stroke {
  id: string;
  timestamp: number;
  color: string;
  points: [number, number][]; 
}

// --- Brush Cache for Sand Rendering ---
const brushCanvases: Record<string, HTMLCanvasElement> = {};
const brushSize = 30;

function getBrush(color: string): HTMLCanvasElement {
  if (brushCanvases[color]) return brushCanvases[color];

  const cvs = document.createElement('canvas');
  cvs.width = brushSize;
  cvs.height = brushSize;
  const brushCtx = cvs.getContext('2d')!;
  
  let r = 61, g = 58, b = 51; 
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    if (hex.length === 6) {
      r = parseInt(hex.substring(0, 2), 16) || 0;
      g = parseInt(hex.substring(2, 4), 16) || 0;
      b = parseInt(hex.substring(4, 6), 16) || 0;
    }
  }
  
  const rad = brushSize / 2;
  const grad = brushCtx.createRadialGradient(rad, rad, 0, rad, rad, rad);
  grad.addColorStop(0, `rgba(${r},${g},${b}, 0.8)`);
  grad.addColorStop(0.3, `rgba(${r},${g},${b}, 0.4)`);
  grad.addColorStop(0.6, `rgba(${r},${g},${b}, 0.1)`);
  grad.addColorStop(1, `rgba(${r},${g},${b}, 0)`);
  
  brushCtx.fillStyle = grad;
  brushCtx.fillRect(0, 0, brushSize, brushSize);
  
  brushCanvases[color] = cvs;
  return cvs;
}

function pseudoRandom(seed: number) {
    let x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
}

// --- Firebase Initialization ---
const app = initializeApp(firebaseConfig);
const db = getFirestore(app, firebaseConfig.firestoreDatabaseId); // Use specified DB
const auth = getAuth();

// Test Connection per Firebase Skill instructions
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration.");
    }
  }
}
testConnection();

// --- Firestore Error Handling (Skill Requirement) ---
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// --- Application State ---
let canvasWidth = 0;
let canvasHeight = 0;

let isTestMode = false;
let strokes: Map<string, Stroke> = new Map();
let currentStroke: Stroke | null = null;
let currentColor = '#0047AB';

// Three Spatial Mandalas defined in absolute World Coordinates
// Center is (0, y). Radius is always 450 world units.
const TABLE_RADIUS = 450;
const MANDALAS = [
  { id: 'now', y: 0, maxAge: 6 * 60 * 1000 },                 // 6 Minutes
  { id: 'day', y: 1500, maxAge: 24 * 60 * 60 * 1000 },        // 24 Hours
  { id: 'week', y: 3000, maxAge: 7 * 24 * 60 * 60 * 1000 }    // 7 Days
];

function getMandalaForY(y: number) {
  if (y < 750) return MANDALAS[0];
  if (y < 2250) return MANDALAS[1];
  return MANDALAS[2];
}

// Transform logic
let d3Transform = d3.zoomIdentity;
let customRotation = 0; // in radians

// Networking
let viewUid: string | null = new URLSearchParams(window.location.search).get('uid');
let isViewOnly = !!viewUid;
// For writing to DB
let unsubscribeSnapshot: (() => void) | null = null;

// The current user
let currentUser: User | null = null;

// Rate limiting DB updates
let lastUpdate = 0;
const SYNC_INTERVAL_MS = 41; // ~24fps

// DOM Elements
const canvas = document.getElementById('mandala-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { alpha: true })!;
const container = document.getElementById('canvas-container')!;
const btnAuth = document.getElementById('btn-auth') as HTMLButtonElement;
const btnShare = document.getElementById('btn-share') as HTMLButtonElement;
const liveIndicator = document.getElementById('live-indicator')!;

// Navigate to Mandalas from UI
document.querySelectorAll('.selector-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const target = (e.currentTarget as HTMLElement).dataset.target;
    const m = MANDALAS.find(x => x.id === target);
    if (!m) return;
    d3.select(canvas).transition().duration(1200).ease(d3.easeCubicInOut).call(zoom.translateTo, 0, m.y);
  });
});

// Resize observer for crisp canvas logic
const resizeObserver = new ResizeObserver(entries => {
  for (let entry of entries) {
    const { width, height } = entry.contentRect;
    const dpr = window.devicePixelRatio || 1;
    const oldW = canvasWidth;
    canvasWidth = width;
    canvasHeight = height;
    canvas.width = canvasWidth * dpr;
    canvas.height = canvasHeight * dpr;
    ctx.scale(dpr, dpr);
    
    if (oldW === 0) {
      // Initialize view to center the 'Now' mandala (0, 0)
      const initScale = Math.min(canvasWidth, canvasHeight) * 0.45 / TABLE_RADIUS;
      const tx = canvasWidth / 2;
      const ty = canvasHeight / 2;
      d3.select(canvas).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(initScale));
    }
  }
});
resizeObserver.observe(container);

// --- Auth Handling ---
onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (user) {
    btnAuth.textContent = 'Sign Out';
    if (!isViewOnly) {
      viewUid = user.uid;
      attachLiveListener(user.uid);
    }
  } else {
    btnAuth.textContent = 'Sign In';
    if (!isViewOnly) {
      viewUid = null;
      if (unsubscribeSnapshot) unsubscribeSnapshot();
      strokes.clear();
    }
  }
});

btnAuth.addEventListener('click', () => {
  if (currentUser) {
    signOut(auth);
  } else {
    const provider = new GoogleAuthProvider();
    signInWithPopup(auth, provider).catch(console.error);
  }
});

btnShare.addEventListener('click', async () => {
  if (!currentUser) return alert('You must be signed in to share.');
  const url = new URL(window.location.href);
  url.searchParams.set('uid', currentUser.uid);
  try {
    await navigator.clipboard.writeText(url.toString());
    const originalText = btnShare.innerText;
    btnShare.innerText = 'Copied!';
    setTimeout(() => btnShare.innerText = originalText, 2000);
  } catch(e) {
    console.error('Clipboard copy failed:', e);
  }
});

// --- Live View Synchronization ---
function attachLiveListener(uid: string) {
  if (unsubscribeSnapshot) unsubscribeSnapshot();
  const path = `users/${uid}/strokes`;
  liveIndicator.style.opacity = '1';
  unsubscribeSnapshot = onSnapshot(collection(db, path), (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      const data = change.doc.data() as Stroke;
      if (change.type === 'added' || change.type === 'modified') {
        // If we're drawing this stroke currently, only accept DB version if not the author
        // Actually for simplicity, author updates memory, then DB. Don't overwrite author's buffer.
        if (isViewOnly || data.id !== currentStroke?.id) {
          strokes.set(data.id, data);
        }
      }
      if (change.type === 'removed') {
        strokes.delete(change.doc.id);
      }
    });
  }, (error) => {
    handleFirestoreError(error, OperationType.GET, path);
  });
}

// Check viewer status on load
if (isViewOnly && viewUid) {
  attachLiveListener(viewUid);
}

// --- D3 Zoom & Transform ---
const zoom = d3.zoom<HTMLCanvasElement, unknown>()
  .scaleExtent([0.1, 10])
  .filter((event) => {
    // Left-click and single-finger touch reserved for drawing.
    // Right-click drag and two-finger touch/pinch reserved for zooming.
    if (event.type === 'touchstart' && event.touches && event.touches.length === 1) return false;
    if (event.type === 'mousedown' && event.button === 0) return false;
    
    // Check if it's a pointer event (like Apple Pencil)
    if (event.pointerType === 'pen' && event.button === 0) return false;

    // Default D3 filtering for the rest (ctrl+scroll, right-click, multi-touch)
    return true;
  })
  .on('zoom', (event) => {
    d3Transform = event.transform;
    
    // Scroll Spy for Selectors
    if (canvasHeight > 0) {
      const worldCenterY = (canvasHeight / 2 - d3Transform.y) / d3Transform.k;
      const activeMandala = getMandalaForY(worldCenterY);
      
      document.querySelectorAll('.selector-btn').forEach(btn => {
        const target = (btn as HTMLElement).dataset.target;
        const ind = btn.querySelector('.active-indicator');
        const span = btn.querySelector('span');
        if (target === activeMandala.id) {
           span?.classList.add('opacity-100', 'font-normal');
           span?.classList.remove('opacity-30', 'font-light');
           ind?.classList.remove('opacity-0');
        } else {
           span?.classList.remove('opacity-100', 'font-normal');
           span?.classList.add('opacity-30', 'font-light');
           ind?.classList.add('opacity-0');
        }
      });
    }
  });

d3.select(canvas).call(zoom).on('dblclick.zoom', null);

// --- Drawing Mechanics ---
function generateId() {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
}

function getPointFromEvent(e: PointerEvent): [number, number] {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  // Inverse Math: Map screen coordinate to canvas coordinate based on D3 center & scale
  const tx = (x - d3Transform.x) / d3Transform.k;
  const ty = (y - d3Transform.y) / d3Transform.k;

  const m = getMandalaForY(ty);

  const cx = 0;
  const cy = m.y; // Rotate around the nearest active mandala's center
  
  // Translate to center
  const dx = tx - cx;
  const dy = ty - cy;

  // Rotate backwards
  const rCos = Math.cos(-customRotation);
  const rSin = Math.sin(-customRotation);

  const finalX = dx * rCos - dy * rSin + cx;
  const finalY = dx * rSin + dy * rCos + cy;

  return [finalX, finalY];
}

d3.select(canvas)
  .on('pointerdown', (e: PointerEvent) => {
    if (isViewOnly || e.button !== 0) return; // Only primary button/pen
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);

    const pt = getPointFromEvent(e);
    currentStroke = {
      id: generateId(),
      timestamp: Date.now(),
      color: currentColor,
      points: [pt]
    };
    strokes.set(currentStroke.id, currentStroke);
    syncStroke(currentStroke);
  })
  .on('pointermove', (e: PointerEvent) => {
    if (!currentStroke) return;
    const pt = getPointFromEvent(e);
    currentStroke.points.push(pt);
    strokes.set(currentStroke.id, currentStroke);

    const now = Date.now();
    if (now - lastUpdate > SYNC_INTERVAL_MS) {
      lastUpdate = now;
      syncStroke(currentStroke);
    }
  })
  .on('pointerup', endDrawing)
  .on('pointercancel', endDrawing)
  .on('contextmenu', (e) => e.preventDefault()); // prevent right click menu

function endDrawing(e: PointerEvent) {
  if (currentStroke) {
    syncStroke(currentStroke);
    currentStroke = null;
  }
}

async function syncStroke(stroke: Stroke) {
  if (!currentUser || isViewOnly) return;
  const path = `users/${currentUser.uid}/strokes/${stroke.id}`;
  try {
    await setDoc(doc(db, 'users', currentUser.uid, 'strokes', stroke.id), stroke);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

async function deleteStroke(strokeId: string) {
  if (!currentUser || isViewOnly) return;
  const path = `users/${currentUser.uid}/strokes/${strokeId}`;
  try {
    await deleteDoc(doc(db, 'users', currentUser.uid, 'strokes', strokeId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

// --- Keyboard & UI Controls ---
document.addEventListener('keydown', (e) => {
  if (['w', 'a', 's', 'd', 'q', 'e'].includes(e.key.toLowerCase())) {
    // Only apply if we have focus outside inputs
    if (document.activeElement?.tagName === 'INPUT') return;
    
    const moveStep = 20;
    const rotStep = 5 * (Math.PI / 180);

    let tX = d3Transform.x;
    let tY = d3Transform.y;
    let tK = d3Transform.k;

    switch (e.key.toLowerCase()) {
      case 'w': tY += moveStep; break;
      case 's': tY -= moveStep; break;
      case 'a': tX += moveStep; break;
      case 'd': tX -= moveStep; break;
      case 'q': customRotation -= rotStep; break;
      case 'e': customRotation += rotStep; break;
    }

    if (['w','a','s','d'].includes(e.key.toLowerCase())) {
      d3.select(canvas).call(zoom.transform, d3.zoomIdentity.translate(tX, tY).scale(tK));
    }
  }
});

document.getElementById('btn-rotate-ccw')?.addEventListener('click', () => {
  customRotation -= 15 * (Math.PI / 180);
});
document.getElementById('btn-rotate-cw')?.addEventListener('click', () => {
  customRotation += 15 * (Math.PI / 180);
});

document.querySelectorAll('#swatches button').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const b = e.target as HTMLButtonElement;
    currentColor = b.dataset.color || '#0047AB';
    // Remove glow from others
    document.querySelectorAll('#swatches button').forEach(bc => bc.classList.replace('ring-[#3D3A33]', 'ring-transparent'));
    b.classList.replace('ring-transparent', 'ring-[#3D3A33]');
  });
});
// Set default active
document.querySelector('#swatches button')?.classList.replace('ring-transparent', 'ring-[#3D3A33]');

document.getElementById('test-mode-toggle')?.addEventListener('change', (e) => {
  isTestMode = (e.target as HTMLInputElement).checked;
});

// --- Render Loop (Canvas & Expiration Physics) ---
function drawMandalaTable(cx: number, cy: number) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(customRotation);
  ctx.translate(-cx, -cy);

  // Draw circular drawing boundary / table
  ctx.beginPath();
  ctx.arc(cx, cy, TABLE_RADIUS, 0, Math.PI * 2);
  
  ctx.fillStyle = '#F0EDE4';
  ctx.fill();

  // Add a very subtle inner ridge border to the table
  ctx.strokeStyle = 'rgba(61, 58, 51, 0.05)';
  ctx.lineWidth = 1 / d3Transform.k; // Ensure 1 physical pixel width
  ctx.stroke();

  // -- Draw Reference Marks --
  ctx.save();
  ctx.lineWidth = 1 / d3Transform.k;
  const gridGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, TABLE_RADIUS);
  const gradSteps = 20;
  for (let s = 0; s <= gradSteps; s++) {
    const t = s / gradSteps;
    const alpha = 1.0 - d3.easeCubicIn(t);
    gridGrad.addColorStop(t, `rgba(61, 58, 51, ${alpha * 0.2})`);
  }
  ctx.strokeStyle = gridGrad;
  ctx.fillStyle = gridGrad;

  ctx.beginPath();
  ctx.arc(cx, cy, 3 / d3Transform.k, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const ang = i * (Math.PI / 3);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(ang) * TABLE_RADIUS, cy + Math.sin(ang) * TABLE_RADIUS);
  }
  ctx.stroke();
  ctx.restore();
  
  ctx.restore();
}

function render() {
  requestAnimationFrame(render);
  if (!canvasWidth || !canvasHeight) return;

  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  ctx.save();
  
  // Transform space based on D3 zoom
  ctx.translate(d3Transform.x, d3Transform.y);
  ctx.scale(d3Transform.k, d3Transform.k);
  
  // Expiration settings logic
  const now = Date.now();
  const strokesToDelete: string[] = [];
  const sortedStrokes = Array.from(strokes.values()).sort((a, b) => a.timestamp - b.timestamp);
  
  // No scale correction: Let the dots scale natively with the D3 zoom transform
  // (Previously we multiplied drawRad by 1/k to keep them constant physical size)

  for (let m of MANDALAS) {
    drawMandalaTable(0, m.y);

    ctx.save();
    
    // Clip all strokes inside the table
    ctx.beginPath();
    ctx.arc(0, m.y, TABLE_RADIUS, 0, Math.PI * 2);
    ctx.clip();
    
    // Setup rotation
    ctx.translate(0, m.y);
    ctx.rotate(customRotation);
    ctx.translate(0, -m.y);
    
    const mStrokes = sortedStrokes.filter(s => {
       if (s.points.length === 0) return false;
       return getMandalaForY(s.points[0][1]).id === m.id;
    });

    for (const stroke of mStrokes) {
      const age = now - stroke.timestamp;
      
      let life = m.maxAge;
      if (isTestMode) {
        if (m.id === 'now') life = 14000;
        else if (m.id === 'day') life = 20000;
        else life = 30000;
      }
      
      let alpha = 1.0;
      if (age >= 0) {
        const rawProgress = Math.max(0, Math.min(1, age / life));
        alpha = 1.0 - d3.easeCubicIn(rawProgress);
      }

      if (alpha <= 0) {
        strokesToDelete.push(stroke.id);
        continue;
      }

      ctx.globalAlpha = alpha;
      const brush = getBrush(stroke.color);

      if (stroke.points.length < 2) {
         if (stroke.points.length === 1) {
            const p = stroke.points[0];
            for (let k = 0; k < 6; k++) {
                const currentAngle = k * (Math.PI / 3);
                const dx = p[0] - 0;
                const dy = p[1] - m.y;
                const rx = dx * Math.cos(currentAngle) - dy * Math.sin(currentAngle) + 0;
                const ry = dx * Math.sin(currentAngle) + dy * Math.cos(currentAngle) + m.y;
                
                const mx = (pseudoRandom(stroke.timestamp + k) - 0.5) * 4;
                const my = (pseudoRandom(stroke.timestamp + k + 1) - 0.5) * 4;
                
                const drawRad = 8; // Native world scale width
                ctx.drawImage(brush, rx + mx - drawRad, ry + my - drawRad, drawRad*2, drawRad*2);
            }
         }
         continue;
      }

      for(let i=1; i<stroke.points.length; i++) {
          const p1 = stroke.points[i-1];
          const p2 = stroke.points[i];
          
          const dist = Math.hypot(p2[0]-p1[0], p2[1]-p1[1]);
          const inferredScreenR = Math.max(1.5, 4.0 - (dist * 0.1)); 
          const drawRad = inferredScreenR * 1.5;
          
          const steps = Math.max(1, Math.floor(dist / 1.5));
          
          for (let k=0; k<6; k++) {
              const currentAngle = k * (Math.PI / 3);

              let jx1 = 0, jy1 = 0, jx2 = 0, jy2 = 0;
              if (k > 0) {
                  const s1 = stroke.timestamp + (i-1)*10 + k;
                  jx1 = (pseudoRandom(s1) - 0.5) * 5; 
                  jy1 = (pseudoRandom(s1 + 1) - 0.5) * 5;

                  const s2 = stroke.timestamp + i*10 + k;
                  jx2 = (pseudoRandom(s2) - 0.5) * 5;
                  jy2 = (pseudoRandom(s2 + 1) - 0.5) * 5;
              }

              const dx1 = p1[0] - 0 + jx1;
              const dy1 = p1[1] - m.y + jy1;
              const rx1 = dx1 * Math.cos(currentAngle) - dy1 * Math.sin(currentAngle) + 0;
              const ry1 = dx1 * Math.sin(currentAngle) + dy1 * Math.cos(currentAngle) + m.y;

              const dx2 = p2[0] - 0 + jx2;
              const dy2 = p2[1] - m.y + jy2;
              const rx2 = dx2 * Math.cos(currentAngle) - dy2 * Math.sin(currentAngle) + 0;
              const ry2 = dx2 * Math.sin(currentAngle) + dy2 * Math.cos(currentAngle) + m.y;
              
              for (let s = 0; s <= steps; s++) {
                 const t = steps === 0 ? 1 : s / steps;
                 const bx = rx1 + (rx2 - rx1) * t;
                 const by = ry1 + (ry2 - ry1) * t;
                 
                 const microSeed = stroke.timestamp + i*100 + s*10 + k;
                 const microJitterX = (pseudoRandom(microSeed) - 0.5) * 1.5;
                 const microJitterY = (pseudoRandom(microSeed + 1) - 0.5) * 1.5;
                 
                 ctx.drawImage(brush, bx + microJitterX - drawRad, by + microJitterY - drawRad, drawRad*2, drawRad*2);
              }
          }
      }
    }
    
    ctx.restore();
  }
  
  ctx.restore();

  for (const s of strokesToDelete) {
     strokes.delete(s);
     if (s !== currentStroke?.id) { 
       deleteStroke(s);
     }
  }
}

requestAnimationFrame(render);

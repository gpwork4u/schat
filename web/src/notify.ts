// Desktop notifications + a synthesized, Slack-ish notification chime.
// The sound is generated with the Web Audio API (no bundled file / no copyright
// concern, works offline): two soft, descending marimba taps in the spirit of
// Slack's "Knock Brush" default.

let audioCtx: AudioContext | null = null;
function ctx(): AudioContext | null {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return audioCtx;
  } catch { return null; }
}

// A soft marimba-like mallet hit: a sine fundamental + a quieter octave for
// "wood" timbre, through a gentle low-pass so it reads warm/muted (Slack's
// "Knock Brush" vibe) rather than a sharp beep. Fast attack, short decay.
function note(ac: AudioContext, freq: number, start: number, dur: number, gain: number, lp: BiquadFilterNode) {
  const env = ac.createGain();
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(gain, start + 0.008);   // quick mallet attack
  env.gain.exponentialRampToValueAtTime(0.0001, start + dur);   // short percussive decay
  env.connect(lp);
  // fundamental (sine) + soft octave overtone (triangle) → marimba-ish wood
  const f0 = ac.createOscillator(); f0.type = 'sine'; f0.frequency.setValueAtTime(freq, start);
  const f1 = ac.createOscillator(); f1.type = 'triangle'; f1.frequency.setValueAtTime(freq * 2, start);
  const og = ac.createGain(); og.gain.setValueAtTime(0.35, start);
  f0.connect(env); f1.connect(og).connect(env);
  f0.start(start); f1.start(start);
  f0.stop(start + dur + 0.05); f1.stop(start + dur + 0.05);
}

// Slack-style notification: two quick, soft, descending mallet taps ("ba-dum").
export function playChime() {
  const ac = ctx();
  if (!ac) return;
  const t = ac.currentTime + 0.01;
  const lp = ac.createBiquadFilter();   // soften: cut the harsh highs
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(2600, t);
  lp.Q.setValueAtTime(0.6, t);
  lp.connect(ac.destination);
  note(ac, 659.25, t, 0.16, 0.20, lp);          // E5
  note(ac, 493.88, t + 0.11, 0.30, 0.20, lp);   // B4 — descending tap, longer tail
}

export function notificationsSupported(): boolean {
  return typeof Notification !== 'undefined';
}

export async function ensurePermission(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try { return (await Notification.requestPermission()) === 'granted'; } catch { return false; }
}

// Show a desktop notification; clicking it runs onClick (e.g. focus the channel).
export function showNotification(title: string, body: string, tag: string, onClick: () => void) {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag, renotify: false } as NotificationOptions);
    n.onclick = () => { window.focus(); onClick(); n.close(); };
  } catch { /* notification construction can throw in some contexts */ }
}

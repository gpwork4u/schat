// Desktop notifications + a synthesized, Slack-ish notification chime.
// The sound is generated with the Web Audio API (no bundled file / no copyright
// concern, works offline): a quick two-note marimba-like "ding-dong".

let audioCtx: AudioContext | null = null;
function ctx(): AudioContext | null {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return audioCtx;
  } catch { return null; }
}

// One plucked note: triangle tone with a fast attack + exponential decay so it
// reads as a soft mallet hit rather than a beep.
function note(ac: AudioContext, freq: number, start: number, dur: number, gain: number) {
  const osc = ac.createOscillator();
  const env = ac.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, start);
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(gain, start + 0.012);   // quick attack
  env.gain.exponentialRampToValueAtTime(0.0001, start + dur);    // decay tail
  osc.connect(env).connect(ac.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

// Slack-like two-tone notification: a higher note resolving to a lower one.
export function playChime() {
  const ac = ctx();
  if (!ac) return;
  const t = ac.currentTime + 0.01;
  note(ac, 880.0, t, 0.18, 0.16);          // A5
  note(ac, 1174.7, t + 0.085, 0.22, 0.14); // D6 (slightly later → "di-ding")
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

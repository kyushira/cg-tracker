// Sound + vibration cues so the receiver doesn't have to look at the screen.
// The AudioContext is created lazily on the first scan (a key press or tap
// counts as the user gesture browsers require before playing audio).

export type Cue = 'pending' | 'complete' | 'warn';

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(ac: AudioContext, freq: number, start: number, dur: number, type: OscillatorType = 'square') {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t = ac.currentTime + start;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

const PATTERNS: Record<Cue, { tones: [number, number, number][]; vibrate: number[] }> = {
  // [frequency Hz, start s, duration s]
  pending: { tones: [[880, 0, 0.12]], vibrate: [60] },
  complete: {
    tones: [
      [988, 0, 0.12],
      [1319, 0.13, 0.12],
      [1760, 0.26, 0.25],
    ],
    vibrate: [120, 60, 120, 60, 200],
  },
  warn: {
    tones: [
      [220, 0, 0.25],
      [220, 0.3, 0.25],
    ],
    vibrate: [400, 100, 400],
  },
};

export function cue(kind: Cue): void {
  const p = PATTERNS[kind];
  const ac = audio();
  if (ac) for (const [f, s, d] of p.tones) tone(ac, f, s, d, kind === 'warn' ? 'sawtooth' : 'square');
  try {
    navigator.vibrate?.(p.vibrate);
  } catch {
    /* not supported (iOS Safari) */
  }
}

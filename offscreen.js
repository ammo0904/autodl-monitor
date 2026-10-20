/*
 * offscreen 音效播放器
 * ---------------------------------------------------------------
 * MV3 的 service worker 不能直接播放音效，所以用 offscreen document
 * （AUDIO_PLAYBACK）來播。所有聲音都用 WebAudio 合成，不需要外部檔案。
 */

const SOUNDS = {
  classic: { wave: 'sine', gain: 0.30, pattern: [[880, 0.18], [0, 0.09], [880, 0.18], [0, 0.60]] },
  double: { wave: 'square', gain: 0.18, pattern: [[1046, 0.12], [0, 0.07], [1046, 0.12], [0, 0.80]] },
  digital: { wave: 'square', gain: 0.16, pattern: [[1200, 0.06], [0, 0.06], [1500, 0.06], [0, 0.06], [1800, 0.06], [0, 0.70]] },
  gentle: { wave: 'sine', gain: 0.22, pattern: [[523, 0.35], [659, 0.35], [784, 0.50], [0, 0.90]] },
  urgent: { wave: 'sawtooth', gain: 0.16, pattern: [[1400, 0.10], [0, 0.05], [1400, 0.10], [0, 0.05], [1400, 0.10], [0, 0.35]] }
};

let audioContext = null;
let masterGain = null;
let stopTimer = null;

async function ensureAudio() {
  if (!audioContext) {
    audioContext = new AudioContext();
    masterGain = audioContext.createGain();
    masterGain.gain.value = 1;
    masterGain.connect(audioContext.destination);
  }
  if (audioContext.state === 'suspended') await audioContext.resume();
  return audioContext;
}

function tone(context, frequency, startAt, duration, wave, gainValue) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = wave;
  oscillator.frequency.value = frequency;
  const attack = 0.012;
  const release = Math.min(0.08, duration / 3);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.linearRampToValueAtTime(gainValue, startAt + attack);
  gain.gain.setValueAtTime(gainValue, startAt + Math.max(attack, duration - release));
  gain.gain.linearRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gain);
  gain.connect(masterGain);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.03);
}

function silence() {
  if (!audioContext || !masterGain) return;
  const now = audioContext.currentTime;
  try {
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setValueAtTime(0.0001, now);
  } catch (_error) { /* 忽略 */ }
}

async function play(soundName, durationMs) {
  await stopAll();
  const context = await ensureAudio();
  const spec = SOUNDS[soundName] || SOUNDS.classic;
  const now = context.currentTime;
  masterGain.gain.cancelScheduledValues(now);
  masterGain.gain.setValueAtTime(1, now);

  const total = Math.max(600, Math.min(60000, Number(durationMs) || 15000)) / 1000;
  const start = now + 0.03;
  const end = start + total;
  let cursor = start;
  let guard = 0;
  while (cursor < end - 0.05 && guard < 600) {
    for (const step of spec.pattern) {
      const [frequency, duration] = step;
      if (cursor + duration > end) { guard = 600; break; }
      if (frequency > 0) tone(context, frequency, cursor, duration * 0.92, spec.wave, spec.gain);
      cursor += duration;
    }
    guard += 1;
  }
  stopTimer = setTimeout(() => { silence(); }, (end - context.currentTime + 0.25) * 1000);
}

function stopAll() {
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  silence();
  return Promise.resolve();
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === 'OFFSCREEN_PLAY_TONE') {
    play(message.sound, message.durationMs).catch((error) => console.warn('[AutoDL 主機監控] 播音失敗：', error));
  }
  if (message.type === 'OFFSCREEN_STOP') {
    stopAll();
  }
});

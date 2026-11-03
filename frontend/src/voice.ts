/// Browser voice helpers: mic recording (converted to 16 kHz mono WAV for the
/// transcription API) and spoken replies via the built-in speech synthesizer.

export interface Recorder {
  /** Elapsed seconds, updated while recording. */
  elapsed: () => number;
  /** Stop recording and resolve with a 16 kHz mono 16-bit WAV blob. */
  stop: () => Promise<Blob>;
  /** Abort without producing audio. */
  cancel: () => void;
}

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", ""];
  for (const t of candidates) {
    try {
      if (!t || MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* try next */
    }
  }
  return "";
}

/** Record from the mic, then convert to 16 kHz mono WAV on stop. */
export async function startRecording(): Promise<Recorder> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser cannot access the microphone.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const startedAt = Date.now();
  const mimeType = pickMimeType();
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: BlobPart[] = [];
  const done = new Promise<Blob>((resolve, reject) => {
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onerror = () => reject(new Error("Recording failed."));
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      try {
        resolve(await toWav16k(new Blob(chunks, { type: rec.mimeType || "audio/webm" })));
      } catch (err) {
        reject(err instanceof Error ? err : new Error("Could not convert audio."));
      }
    };
  });
  rec.start();
  let settled = false;
  return {
    elapsed: () => (Date.now() - startedAt) / 1000,
    stop: () => {
      if (settled) throw new Error("Already stopped.");
      settled = true;
      rec.stop();
      return done;
    },
    cancel: () => {
      if (settled) return;
      settled = true;
      try {
        rec.onstop = null;
        rec.stop();
      } catch {
        /* ignore */
      }
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

async function toWav16k(input: Blob): Promise<Blob> {
  const ctx = new AudioContext();
  try {
    const raw = await input.arrayBuffer();
    const decoded = await ctx.decodeAudioData(raw);
    const targetRate = 16000;
    const offline = new OfflineAudioContext(
      1,
      Math.max(1, Math.ceil(decoded.duration * targetRate)),
      targetRate,
    );
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    return encodeWav(rendered.getChannelData(0), targetRate);
  } finally {
    void ctx.close().catch(() => {});
  }
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Speak text with the built-in synthesizer, preferring an Indonesian voice. */
export function speak(text: string): void {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "id-ID";
  utter.rate = 1;
  const voices = window.speechSynthesis.getVoices();
  const idVoice =
    voices.find((v) => v.lang.toLowerCase().startsWith("id")) ??
    voices.find((v) => v.lang.toLowerCase().startsWith("ms"));
  if (idVoice) {
    utter.voice = idVoice;
    utter.lang = idVoice.lang;
  }
  window.speechSynthesis.speak(utter);
}

export function stopSpeaking(): void {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

/** Warm up the (async) voice list so a preferred voice exists on first use. */
export function warmUpVoices(): void {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.getVoices();
}

let transcriberPromise = null;

function mixToMono(audioBuffer) {
  const length = audioBuffer.length;
  const mixed = new Float32Array(length);
  const channels = audioBuffer.numberOfChannels;
  for (let channel = 0; channel < channels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let index = 0; index < length; index += 1) mixed[index] += data[index] / channels;
  }
  return mixed;
}

function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.round(samples.length / ratio));
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const fraction = position - left;
    output[index] = samples[left] * (1 - fraction) + samples[right] * fraction;
  }
  return output;
}

async function audioTo16k(blob) {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    return resample(mixToMono(decoded), decoded.sampleRate, 16000);
  } finally {
    await context.close();
  }
}

function loadTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1").then(
      async ({ pipeline, env }) => {
        env.allowLocalModels = false;
        env.useBrowserCache = true;
        env.backends.onnx.wasm.numThreads = 1;
        return pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en", { dtype: "q8" });
      }
    );
  }
  return transcriberPromise;
}

export async function transcribeBlob(blob) {
  const audio = await audioTo16k(blob);
  const transcriber = await loadTranscriber();
  const result = await transcriber(audio);
  return (result.text || "").trim();
}

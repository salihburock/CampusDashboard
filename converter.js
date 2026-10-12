// ── File conversion ───────────────────────────────────────────
// Used by /conversion and by uploads/Moodle sync that turn Office files into
// PDFs. Tools: ffmpeg/ffprobe (video, audio), ImageMagick `convert`
// (images), LibreOffice `soffice` (documents), pdftotext (PDF → text).
//
// convertFile(inputPath, targetExt, outDir) resolves to the path of
// <outDir>/<input base name>.<targetExt>, or rejects with a ConversionError
// whose message is short enough to show to the user.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SUPPORTED_CONVERSIONS = {
  // ── Video (ffmpeg) ─────────────────────────────────────────
  mp4:  ['mkv', 'webm', 'avi', 'mov', 'gif', 'mp3'],
  mkv:  ['mp4', 'webm', 'avi', 'mov', 'mp3'],
  webm: ['mp4', 'mkv', 'gif', 'mp3'],
  avi:  ['mp4', 'mkv', 'webm', 'mov', 'mp3'],
  mov:  ['mp4', 'mkv', 'webm', 'gif', 'mp3'],
  wmv:  ['mp4', 'mkv', 'webm', 'mp3'],
  flv:  ['mp4', 'mkv', 'webm', 'mp3'],
  ts:   ['mp4', 'mkv', 'mp3'],
  m4v:  ['mp4', 'mkv', 'mp3'],
  mpg:  ['mp4', 'mkv', 'mp3'],
  mpeg: ['mp4', 'mkv', 'mp3'],
  '3gp': ['mp4', 'mkv', 'mp3'],
  ogv:  ['mp4', 'mkv', 'webm', 'mp3'],
  vob:  ['mp4', 'mkv', 'mp3'],

  // ── Audio (ffmpeg) ─────────────────────────────────────────
  mp3:  ['wav', 'ogg', 'm4a', 'flac', 'aac', 'opus'],
  wav:  ['mp3', 'ogg', 'm4a', 'flac', 'aac'],
  ogg:  ['mp3', 'wav', 'flac', 'opus'],
  m4a:  ['mp3', 'wav', 'ogg', 'flac'],
  flac: ['mp3', 'wav', 'ogg', 'm4a'],
  aac:  ['mp3', 'wav', 'm4a'],
  wma:  ['mp3', 'wav', 'm4a'],
  opus: ['mp3', 'wav', 'ogg'],
  aiff: ['mp3', 'wav', 'flac'],
  amr:  ['mp3', 'wav'],

  // ── Image (imagemagick) ────────────────────────────────────
  jpg:  ['png', 'webp', 'gif', 'bmp', 'tiff', 'ico', 'pdf'],
  jpeg: ['png', 'webp', 'gif', 'bmp', 'tiff', 'ico', 'pdf'],
  png:  ['jpg', 'webp', 'gif', 'bmp', 'tiff', 'ico', 'pdf'],
  gif:  ['png', 'jpg', 'webp', 'mp4'],
  bmp:  ['jpg', 'png', 'webp', 'gif'],
  webp: ['jpg', 'png', 'gif', 'bmp'],
  tiff: ['jpg', 'png', 'webp', 'pdf'],
  tif:  ['jpg', 'png', 'webp', 'pdf'],
  ico:  ['png', 'jpg'],
  svg:  ['png', 'jpg', 'webp', 'pdf'],

  // ── Document / spreadsheet / presentation (soffice) ───────
  doc:  ['pdf', 'docx', 'odt', 'rtf', 'txt', 'html', 'epub'],
  docx: ['pdf', 'doc', 'odt', 'rtf', 'txt', 'html', 'epub'],
  odt:  ['pdf', 'docx', 'doc', 'rtf', 'txt', 'html'],
  rtf:  ['pdf', 'docx', 'odt', 'txt'],
  txt:  ['pdf', 'docx', 'odt', 'html'],
  pdf:  ['docx', 'txt', 'html'],
  html: ['pdf', 'docx', 'odt', 'txt'],
  epub: ['pdf', 'html', 'txt'],
  ppt:  ['pdf', 'pptx', 'odp'],
  pptx: ['pdf', 'ppt', 'odp'],
  odp:  ['pdf', 'pptx', 'ppt'],
  xls:  ['pdf', 'csv', 'xlsx', 'ods'],
  xlsx: ['pdf', 'csv', 'xls', 'ods', 'tsv'],
  ods:  ['pdf', 'xlsx', 'xls', 'csv'],
  csv:  ['xlsx', 'xls', 'ods', 'tsv'],
  tsv:  ['csv', 'xlsx', 'xls'],
};

const VIDEO_EXTS = new Set(['mp4', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'flv', 'ts', 'm4v', 'mpg', 'mpeg', '3gp', 'ogv', 'vob']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma', 'opus', 'aiff', 'amr']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tiff', 'tif', 'ico', 'svg']);

class ConversionError extends Error {}

// Runs a tool; on failure rejects with the last meaningful line of its
// output (the actual reason) instead of the whole command line.
function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout, stderr });
      if (err.code === 'ENOENT') return reject(new ConversionError(`${cmd} is not installed on the server`));
      if (err.killed) return reject(new ConversionError('Took too long and was stopped'));
      const lines = String(stderr || err.message).split('\n').map(l => l.trim())
        .filter(l => l && !/^(Conversion failed!|Command failed:)/.test(l));
      reject(new ConversionError(lines.slice(-1)[0] || `${cmd} failed`));
    });
  });
}

// ── Video / audio ─────────────────────────────────────────────

async function probe(inputPath) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', inputPath], 60000);
  const streams = JSON.parse(stdout).streams || [];
  const isCover = s => s.disposition && s.disposition.attached_pic;
  return {
    video: streams.find(s => s.codec_type === 'video' && !isCover(s)),
    audio: streams.find(s => s.codec_type === 'audio'),
  };
}

// What each target container can hold as-is (stream copy), and what to
// encode to when it can't. null = any codec (Matroska holds anything).
const CONTAINERS = {
  mkv:  { video: null, audio: null,
          venc: 'h264', aenc: ['-c:a', 'aac', '-b:a', '192k'], extra: [] },
  mp4:  { video: ['h264', 'hevc', 'mpeg4', 'av1'], audio: ['aac', 'mp3', 'ac3'],
          venc: 'h264', aenc: ['-c:a', 'aac', '-b:a', '192k'], extra: ['-movflags', '+faststart'] },
  mov:  { video: ['h264', 'hevc', 'mpeg4', 'prores', 'mjpeg'], audio: ['aac', 'mp3', 'alac', 'pcm_s16le'],
          venc: 'h264', aenc: ['-c:a', 'aac', '-b:a', '192k'], extra: ['-movflags', '+faststart'] },
  avi:  { video: ['mpeg4', 'h264', 'mjpeg', 'msmpeg4v3'], audio: ['mp3', 'ac3', 'pcm_s16le'],
          venc: 'mpeg4', aenc: ['-c:a', 'libmp3lame', '-q:a', '2'], extra: [] },
  webm: { video: ['vp8', 'vp9', 'av1'], audio: ['opus', 'vorbis'],
          venc: 'vp9', aenc: ['-c:a', 'libopus', '-b:a', '128k'], extra: [] },
};

// Encoders need even width/height for 4:2:0 video ("width not divisible
// by 2" on e.g. 641x361); round down by one pixel where needed.
const EVEN = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';

function videoEncodeArgs(enc) {
  switch (enc) {
    case 'h264':  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', EVEN];
    case 'mpeg4': return ['-c:v', 'mpeg4', '-q:v', '3', '-pix_fmt', 'yuv420p', '-vf', EVEN];
    case 'vp9':   return ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-deadline', 'good', '-cpu-used', '4',
                          '-row-mt', '1', '-pix_fmt', 'yuv420p', '-vf', EVEN];
  }
}

// Video is only copied when it is already 4:2:0 -- screen recordings and
// some cameras produce 4:4:4 or RGB, which most players can't open.
const PLAYABLE_PIX = new Set(['yuv420p', 'yuvj420p', 'yuv420p10le']);

function canCopyVideo(target, v) {
  const c = CONTAINERS[target];
  return (!c.video || c.video.includes(v.codec_name)) && PLAYABLE_PIX.has(v.pix_fmt);
}

function canCopyAudio(target, a) {
  const c = CONTAINERS[target];
  return !c.audio || c.audio.includes(a.codec_name);
}

// Picks stream copy or re-encode per stream. forceEncode re-encodes
// everything (used as a retry when a copy turns out not to work).
function videoArgs(info, target, forceEncode) {
  const c = CONTAINERS[target];
  const args = ['-map', '0:v:0'];
  if (info.audio) args.push('-map', '0:a:0');
  args.push(...(!forceEncode && canCopyVideo(target, info.video) ? ['-c:v', 'copy'] : videoEncodeArgs(c.venc)));
  if (info.video.codec_name === 'hevc' && (target === 'mp4' || target === 'mov')) args.push('-tag:v', 'hvc1');
  if (info.audio) {
    args.push(...(!forceEncode && canCopyAudio(target, info.audio) ? ['-c:a', 'copy'] : c.aenc));
  }
  return [...args, '-sn', '-dn', ...c.extra];
}

const AUDIO_ENC = {
  mp3:  ['-c:a', 'libmp3lame', '-q:a', '2'],
  wav:  ['-c:a', 'pcm_s16le'],
  ogg:  ['-c:a', 'libvorbis', '-q:a', '5'],
  m4a:  ['-c:a', 'aac', '-b:a', '192k'],
  aac:  ['-c:a', 'aac', '-b:a', '192k'],
  flac: ['-c:a', 'flac'],
  opus: ['-c:a', 'libopus', '-b:a', '128k'],
};

async function convertMedia(inputPath, srcExt, targetExt, outputPath) {
  const ff = args => run('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', inputPath, ...args, outputPath], 30 * 60000);
  const info = await probe(inputPath).catch(() => {
    throw new ConversionError('The file could not be read; it may be damaged or not really a .' + srcExt);
  });

  if (AUDIO_ENC[targetExt]) {
    if (!info.audio) throw new ConversionError('This file has no audio track');
    return ff(['-map', '0:a:0', '-vn', ...AUDIO_ENC[targetExt]]);
  }
  if (!info.video) throw new ConversionError('This file has no video track');

  if (targetExt === 'gif') {
    // Palette pass keeps colors right; width capped at 480, height even.
    return ff(['-filter_complex',
      '[0:v]fps=12,scale=\'min(480,iw)\':-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse',
      '-loop', '0']);
  }
  if (!CONTAINERS[targetExt]) throw new ConversionError(`Cannot convert to .${targetExt}`);

  try {
    await ff(videoArgs(info, targetExt, false));
  } catch (e) {
    // A copied stream can still be rejected by the muxer (odd timestamps,
    // unusual profiles); encoding everything is slower but reliable.
    await ff(videoArgs(info, targetExt, true));
  }
}

// ── Images ────────────────────────────────────────────────────

async function convertImage(inputPath, srcExt, targetExt, outputPath) {
  const single = ['jpg', 'jpeg', 'png', 'bmp', 'ico'].includes(targetExt);
  // Animated GIFs / multi-page TIFFs: one-image formats take the first
  // frame (else ImageMagick writes name-0.png, name-1.png, …).
  const input = single && ['gif', 'tiff', 'tif', 'webp', 'ico'].includes(srcExt) ? `${inputPath}[0]` : inputPath;
  const args = [input];
  // Animated output: frames must be full-size, not GIF-optimized deltas.
  if (targetExt === 'webp' || targetExt === 'gif') args.push('-coalesce');
  args.push('-auto-orient');
  if (['jpg', 'jpeg', 'bmp'].includes(targetExt)) args.push('-background', 'white', '-flatten');
  // ICO holds at most 256x256; include the usual smaller sizes too.
  if (targetExt === 'ico') args.push('-background', 'none', '-resize', '256x256>', '-define', 'icon:auto-resize=256,128,64,48,32,16');
  args.push(outputPath);
  try {
    await run('convert', args, 5 * 60000);
  } catch (e) {
    if (/not authorized/i.test(e.message)) {
      throw new ConversionError('ImageMagick\'s security policy blocks this format on the server (see /etc/ImageMagick-6/policy.xml)');
    }
    throw e;
  }
}

// ── Documents ─────────────────────────────────────────────────

// LibreOffice allows one running instance per profile, and a second call
// while one runs exits without converting. Give it its own profile and run
// one conversion at a time.
const LO_PROFILE = 'file://' + path.join(os.tmpdir(), 'campus-dashboard-lo-profile');
let soffice = Promise.resolve();
function queueSoffice(fn) {
  const job = soffice.then(fn, fn);
  soffice = job.catch(() => {});
  return job;
}

// Text-CSV options: separator (44 = comma, 9 = tab), quote ("), UTF-8, first line.
const CSV = 'Text - txt - csv (StarCalc):44,34,76,1';
const TSV = 'Text - txt - csv (StarCalc):9,34,76,1';

function sofficeArgs(srcExt, targetExt) {
  const inFilter = { csv: CSV, tsv: TSV }[srcExt] || (srcExt === 'pdf' ? 'writer_pdf_import' : null);
  const outFilter = {
    csv: `csv:${CSV}`,
    tsv: `csv:${TSV}`,
    txt: 'txt:Text (encoded):UTF8',
    html: srcExt === 'pdf' ? 'html:XHTML Writer File:UTF8' : 'html',
  }[targetExt] || targetExt;
  return [...(inFilter ? [`--infilter=${inFilter}`] : []), '--convert-to', outFilter];
}

async function convertDocument(inputPath, srcExt, targetExt, outputPath) {
  if (srcExt === 'pdf' && targetExt === 'txt') {
    return run('pdftotext', ['-layout', '-enc', 'UTF-8', inputPath, outputPath], 5 * 60000);
  }
  // Separate output dir: soffice names the result after the input, which
  // would overwrite it for e.g. csv → "tsv" (written as .csv).
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv_lo_'));
  try {
    await queueSoffice(() => run('soffice', [
      `-env:UserInstallation=${LO_PROFILE}`, '--headless', '--norestore',
      ...sofficeArgs(srcExt, targetExt), '--outdir', workDir, inputPath,
    ], 5 * 60000));
    const produced = fs.readdirSync(workDir)[0];
    if (!produced) throw new ConversionError(`LibreOffice could not convert this .${srcExt} to .${targetExt}`);
    fs.copyFileSync(path.join(workDir, produced), outputPath);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// ── Entry point ───────────────────────────────────────────────

async function convertFile(inputPath, targetExt, outDir) {
  targetExt = targetExt.toLowerCase();
  const srcExt = path.extname(inputPath).slice(1).toLowerCase();
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(outDir, `${baseName}.${targetExt}`);

  if (VIDEO_EXTS.has(srcExt) || AUDIO_EXTS.has(srcExt) || (srcExt === 'gif' && targetExt === 'mp4')) {
    await convertMedia(inputPath, srcExt, targetExt, outputPath);
  } else if (IMAGE_EXTS.has(srcExt)) {
    await convertImage(inputPath, srcExt, targetExt, outputPath);
  } else {
    await convertDocument(inputPath, srcExt, targetExt, outputPath);
  }

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    try { fs.unlinkSync(outputPath); } catch {}
    throw new ConversionError(`Converting .${srcExt} to .${targetExt} produced no output`);
  }
  return outputPath;
}

module.exports = { SUPPORTED_CONVERSIONS, ConversionError, convertFile };

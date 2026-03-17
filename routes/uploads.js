module.exports = function createUploadRoutes({ config, requireAuth }) {
  const router = require('express').Router();
  const multer = require('multer');
  const crypto = require('crypto');
  const { spawn } = require('child_process');
  const fs = require('fs');
  const path = require('path');

  // ===== Transcription =====

  const audioDashboardDir = path.join(__dirname, '..', '.dashboard', 'audio');
  if (!fs.existsSync(audioDashboardDir)) fs.mkdirSync(audioDashboardDir, { recursive: true });

  const transcribeUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }
  });

  router.post('/api/transcribe', requireAuth, transcribeUpload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

    const apiKey = process.env.OPENAI_API_KEY;
    const uuid = crypto.randomUUID();
    const ext = req.file.mimetype.includes('ogg') ? 'ogg' : 'webm';
    const filename = `${uuid}.${ext}`;
    const audioFilePath = path.join(audioDashboardDir, filename);
    const audioUrl = `/audio/${filename}`;

    // Save audio file to .dashboard/audio/
    fs.writeFileSync(audioFilePath, req.file.buffer);

    // Try OpenAI Whisper API first
    if (apiKey) {
      try {
        const { OpenAI, toFile } = require('openai');
        const openai = new OpenAI({ apiKey });
        const audioFile = await toFile(req.file.buffer, `recording.${ext}`, { type: req.file.mimetype });
        const transcription = await openai.audio.transcriptions.create({
          file: audioFile,
          model: 'whisper-1'
        });
        return res.json({ text: transcription.text, audioUrl });
      } catch (err) {
        console.warn(`OpenAI transcription failed, falling back to local whisper: ${err.message}`);
      }
    }

    // Fall back to local whisper CLI
    try {
      const whisperBin = '/home/openclaw/.local/bin/whisper';
      const outDir = '/tmp/whisper-out';
      fs.mkdirSync(outDir, { recursive: true });

      await new Promise((resolve, reject) => {
        const proc = spawn(whisperBin, [
          audioFilePath,
          '--model', 'base',
          '--language', 'fr',
          '--output_format', 'txt',
          '--output_dir', outDir
        ]);

        const timer = setTimeout(() => {
          proc.kill();
          reject(new Error('Local whisper timed out after 30s'));
        }, 30000);

        proc.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`whisper exited with code ${code}`));
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      // whisper names the output file after the input file basename
      const baseName = path.basename(audioFilePath, path.extname(audioFilePath));
      const outFile = path.join(outDir, `${baseName}.txt`);
      const text = fs.readFileSync(outFile, 'utf8').trim();
      fs.unlinkSync(outFile);

      return res.json({ text, audioUrl });
    } catch (err) {
      return res.status(500).json({ error: `Transcription failed: ${err.message}` });
    }
  });

  // ===== File Upload =====

  function makeAttachmentStorage() {
    return multer.diskStorage({
      destination: (req, file, cb) => {
        const project = config.projects.find(p => p.id === req.params.id);
        if (!project) return cb(new Error('Project not found'));
        const dir = path.join(project.path, '.claude', 'uploads');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const ts = Date.now();
        const ext = path.extname(file.originalname);
        const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_.-]/g, '_');
        cb(null, `${ts}_${base}${ext}`);
      }
    });
  }

  const attachmentUpload = multer({
    storage: makeAttachmentStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
  });

  router.post('/api/projects/:id/upload', requireAuth, attachmentUpload.single('file'), (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    res.json({
      ok: true,
      filename: req.file.filename,
      originalname: req.file.originalname,
      filePath: req.file.path,
      relativePath: path.relative(project.path, req.file.path),
      size: req.file.size,
      mimetype: req.file.mimetype
    });
  });

  // Export audioDashboardDir for the static middleware in server.js
  router.audioDashboardDir = audioDashboardDir;

  return router;
};

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const unzipper = require('unzipper');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const compression = require('compression');
const { body, validationResult } = require('express-validator');
const bodyParser = require('body-parser');
const cors = require('cors'); // Adicione esta linha
const sizeOf = require('image-size');

// Carrega INTERNAL_SERVICE_KEY e CDN_TOKEN_SECRET do .env (Node 20.12+)
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (e) { /* sem .env: escrita fica bloqueada */ }
const { requireAuth, requireStaff, requireAdmin } = require('./auth');

const app = express();

const possibleExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.txt', '.pdf', '.zip'];
const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

const PUBLIC_DIR = path.join(__dirname, 'public');
const TEMP_DIR = path.join(PUBLIC_DIR, 'temp');
const MAX_FILE_SIZE = 100 * 1024 * 1024;     // equipe
const MAX_USER_FILE_SIZE = 5 * 1024 * 1024;  // avatar/fundo de usuário comum
const MAX_ZIP_ENTRIES = 1000;
const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

// Nomes e ids vindos do cliente: só letras, números, "-", "_" e "."; nunca "/" ou ".."
const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,119}$/;
const isSafeSegment = (v) => typeof v === 'string' && SAFE_SEGMENT.test(v) && !v.includes('..');
const isSafeNumber = (v) => /^[0-9]{1,9}(\.[0-9]{1,4})?$/.test(String(v));

// Garante que o caminho final está dentro de public/ (e fora de public/temp), inclusive via symlinks
const insidePublic = (p) => {
  const resolved = path.resolve(p);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) || resolved.startsWith(TEMP_DIR + path.sep) || resolved === TEMP_DIR) {
    return false;
  }
  let current = resolved;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  try {
    const real = fs.realpathSync(current);
    const realPublic = fs.realpathSync(PUBLIC_DIR);
    const realTemp = fs.existsSync(TEMP_DIR) ? fs.realpathSync(TEMP_DIR) : path.join(realPublic, 'temp');
    return (real === realPublic || real.startsWith(realPublic + path.sep))
      && real !== realTemp
      && !real.startsWith(realTemp + path.sep);
  } catch {
    return false;
  }
};

const stripAllowedExtension = (name) => {
  const ext = path.extname(name);
  if (ext && possibleExtensions.includes(ext.toLowerCase())) {
    return name.slice(0, -ext.length);
  }
  return name;
};

const aplicarHeadersArquivo = (res, filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.svg') {
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  } else if (!imageExtensions.includes(ext)) {
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
};

const removerTemp = (file) => {
  if (file && file.path) fs.unlink(file.path, () => {});
};

// Configurar CORS
app.use(cors()); // Adicione esta linha

const criarDiretoriosRecursivamente = (diretorio) => {
  if (!diretorio) return;
  fs.mkdirSync(diretorio, { recursive: true });
};

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    let pastaBase = 'public/temp';
    if (!fs.existsSync(pastaBase)) {
      fs.mkdirSync(pastaBase, { recursive: true });
    }
    cb(null, pastaBase);
  },
  filename: function (req, file, cb) {
    // Nome temporário aleatório: nunca usa o nome enviado pelo cliente
    cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (req, file, cb) => {
    const fileExt = path.extname(file.originalname).toLowerCase();
    if (!possibleExtensions.includes(fileExt)) {
      return cb(new Error('Tipo de arquivo não permitido'), false);
    }
    cb(null, true);
  }
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // ou 'https://mahoureader.com' se quiser restringir
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); // opcional, mas evita bugs com embed
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); // se usar canvas ou WebAssembly
  res.setHeader(
    'Content-Security-Policy',
    "default-src *; img-src * data: blob: 'unsafe-inline';"
  );
  next();
});

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
}));
app.use(compression());

app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

app.use((err, req, res, next) => {
  if (err.status === 413) {
      console.error('Payload muito grande:', err);
      return res.status(413).json({ error: 'Payload muito grande' });
  }
  next(err);
});

const moveFile = (tempFilePath, finalDir, name, res) => {
  const baseName = stripAllowedExtension(name);
  const newFileExtension = path.extname(tempFilePath);
  const finalFilePath = path.join(finalDir, `${baseName}${newFileExtension}`);
  const fileName = `${baseName}${newFileExtension}`;

  if (!insidePublic(finalFilePath)) {
    fs.unlink(tempFilePath, () => {});
    return res.status(400).json({ error: 'Caminho inválido.' });
  }

  for (const ext of possibleExtensions) {
    const oldFilePath = path.join(finalDir, `${baseName}${ext}`);
    if (fs.existsSync(oldFilePath)) {
      try {
        fs.unlinkSync(oldFilePath);
      } catch (err) {
        console.error(`Erro ao remover o arquivo antigo: ${oldFilePath}`, err);
      }
    }
  }

  criarDiretoriosRecursivamente(finalDir);

  fs.rename(tempFilePath, finalFilePath, (err) => {
    if (err) {
      fs.unlink(tempFilePath, () => {});
      return res.status(500).json({ error: 'Erro ao mover o arquivo.' });
    }
    res.json({
      message: 'Upload realizado com sucesso!',
      file: fileName
    });
  });
};

const obterDiretorioDestino = (tipo, id) => {
  if (id !== undefined && id !== null && id !== '' && !isSafeSegment(String(id))) {
    throw new Error('O campo "id" é inválido.');
  }
  switch (tipo) {
    case 'user':
      if (!id) throw new Error('O campo "id" é obrigatório para o tipo "user".');
      return `public/user/${id}`;
    case 'assets':
      return 'public/assets';
    case 'series':
      if (!id) throw new Error('O campo "id" é obrigatório para o tipo "novel".');
      return `public/series/${id}`;
    case 'series-assets':
      if (!id) throw new Error('O campo "id" é obrigatório para o tipo "novel-assets".');
      return `public/series/${id}/assets`;
    case 'stickers':
      if (id) {
        return `public/stickers/${id}`;
      }
      return 'public/stickers';
    default:
      throw new Error('Tipo de upload inválido.');
  }
};

// ADMIN/DONO/serviço escrevem tudo; UPLOADER só series/series-assets; usuário comum só seu avatar/fundo.
const podeEscrever = (auth, type, id, name) => {
  if (auth.admin) return true;
  if (auth.staff && ['series', 'series-assets'].includes(type)) return true;
  return type === 'user' && id === auth.username && ['avatar', 'background'].includes(name);
};

app.post('/upload',
  requireAuth,
  upload.single('imagem'),
  body('name').notEmpty().withMessage('O campo "name" é obrigatório.'),
  body('type').notEmpty().withMessage('O campo "type" é obrigatório.'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      removerTemp(req.file);
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, type, id } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'O campo "imagem" é obrigatório.' });
    }

    if (!isSafeSegment(name)) {
      removerTemp(req.file);
      return res.status(400).json({ error: 'O campo "name" é inválido.' });
    }

    const baseName = stripAllowedExtension(name);
    if (!isSafeSegment(baseName)) {
      removerTemp(req.file);
      return res.status(400).json({ error: 'O campo "name" é inválido.' });
    }

    if (!podeEscrever(req.auth, type, id, baseName)) {
      removerTemp(req.file);
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    if (!req.auth.admin && !['series', 'series-assets'].includes(type)) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (!imageExtensions.includes(ext) || req.file.size > MAX_USER_FILE_SIZE) {
        removerTemp(req.file);
        return res.status(400).json({ error: 'Envie uma imagem (jpg, png, gif ou webp) de até 5 MB.' });
      }
    }

    let finalDir;
    try {
      finalDir = path.join(__dirname, obterDiretorioDestino(type, id));
    } catch (error) {
      removerTemp(req.file);
      return res.status(400).json({ error: error.message });
    }

    moveFile(req.file.path, finalDir, baseName, res);
  }
);

const zipStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const pastaBase = 'public/temp';
    criarDiretoriosRecursivamente(pastaBase);
    cb(null, pastaBase);
  },
  filename: function (req, file, cb) {
    cb(null, `${uuidv4()}.zip`); // Nome temporário aleatório
  }
});

const uploadZip = multer({
  storage: zipStorage,
  limits: { fileSize: 1024 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.zip') {
      return cb(new Error('Apenas arquivos ZIP são permitidos'), false);
    }
    cb(null, true);
  }
});

app.post('/upload-zip', requireStaff, uploadZip.single('zipFile'), async (req, res) => {
  const { serieID, index, volume } = req.body || {};

  if (!serieID || !index) {
    removerTemp(req.file);
    return res.status(400).json({ error: 'ID da obra e capítulo são obrigatórios.' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  if (!isSafeNumber(serieID) || !isSafeNumber(index) || !isSafeNumber(volume)) {
    removerTemp(req.file);
    return res.status(400).json({ error: 'serieID, index e volume precisam ser numéricos.' });
  }

  const zipFilePath = req.file.path;
  const extractionPath = path.join(__dirname, `public/series/${serieID}/chapters/vol-${volume}-cap-${index}`);

  if (!insidePublic(extractionPath)) {
    removerTemp(req.file);
    return res.status(400).json({ error: 'Caminho inválido.' });
  }

  // Remover imagens antigas
  if (fs.existsSync(extractionPath)) {
    fs.readdirSync(extractionPath).forEach(file => {
      const filePath = path.join(extractionPath, file);
      if (fs.lstatSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
      }
    });
  } else {
    fs.mkdirSync(extractionPath, { recursive: true });
  }

  const extractedImages = [];
  const createdFiles = [];
  const activeWriteStreams = new Set();
  const writePromises = [];
  let entryCount = 0;
  let totalBytes = 0;
  let abortError = null;

  const readStream = fs.createReadStream(zipFilePath);
  const parser = unzipper.Parse();

  const abortExtraction = (err) => {
    if (!abortError) abortError = err;
    readStream.destroy();
    parser.destroy();
    for (const ws of activeWriteStreams) {
      ws.destroy();
    }
  };

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      readStream.on('error', (err) => {
        abortExtraction(err);
        done(err);
      });

      parser.on('error', (err) => {
        abortExtraction(err);
        done(err);
      });

      parser.on('entry', (entry) => {
        if (abortError) {
          entry.autodrain();
          return;
        }

        entryCount += 1;
        if (entryCount > MAX_ZIP_ENTRIES) {
          entry.autodrain();
          const err = new Error('ZIP excede o limite máximo de 1000 entradas.');
          err.status = 400;
          abortExtraction(err);
          return done(err);
        }

        const fileName = entry.path;
        const fileExt = path.extname(fileName).toLowerCase();
        // Só imagens entram; pastas e qualquer outro tipo de arquivo são ignorados
        if (entry.type !== 'File' || !imageExtensions.includes(fileExt)) {
          entry.autodrain();
          return;
        }

        const newFileName = `${uuidv4()}${fileExt}`;
        const newFilePath = path.join(extractionPath, newFileName);
        createdFiles.push(newFilePath);

        const writeStream = fs.createWriteStream(newFilePath);
        activeWriteStreams.add(writeStream);

        entry.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_ZIP_BYTES && !abortError) {
            const err = new Error('ZIP excede o limite máximo de 2 GB extraídos.');
            err.status = 400;
            entry.unpipe(writeStream);
            entry.autodrain();
            abortExtraction(err);
            done(err);
          }
        });

        entry.on('error', (err) => {
          abortExtraction(err);
          done(err);
        });

        const writePromise = new Promise((resWrite, rejWrite) => {
          writeStream.on('finish', () => {
            activeWriteStreams.delete(writeStream);
            if (abortError) return resWrite();
            try {
              const fileStats = fs.statSync(newFilePath);
              let dimensions = {};
              if (imageExtensions.includes(fileExt)) {
                try {
                  dimensions = sizeOf(newFilePath);
                } catch (err) {
                  console.error(`Erro ao obter dimensões da imagem: ${newFilePath}`, err);
                }
              }

              extractedImages.push({
                order: extractedImages.length + 1,
                originalName: fileName,
                imageURL: newFileName,
                width: dimensions.width || null,
                height: dimensions.height || null,
                fileSize: fileStats.size
              });
              resWrite();
            } catch (err) {
              rejWrite(err);
            }
          });

          writeStream.on('error', (err) => {
            activeWriteStreams.delete(writeStream);
            if (abortError) return resWrite();
            rejWrite(err);
          });

          // Garante resolução se o stream for destruído durante abort
          writeStream.on('close', () => {
            activeWriteStreams.delete(writeStream);
            resWrite();
          });
        });

        writePromises.push(writePromise);
        entry.pipe(writeStream);
      });

      parser.on('close', () => done(abortError));
      readStream.pipe(parser);
    });

    await Promise.all(writePromises);

    return res.json({
      message: 'Arquivos extraídos e renomeados com sucesso!',
      images: extractedImages
    });
  } catch (err) {
    await Promise.allSettled(writePromises);
    for (const f of createdFiles) {
      try { fs.unlinkSync(f); } catch {}
    }
    if (err && err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    console.error('Erro ao extrair o arquivo:', err);
    return res.status(500).json({ error: 'Erro ao extrair o arquivo.' });
  } finally {
    fs.unlink(zipFilePath, () => {});
  }
});

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString()
  },
  limit: "100mb"
}));

app.post('/analyze-pages', requireStaff, async (req, res, next) => {
  try {
    const { pages, index, serieID, volume } = req.body || {};

    if (!isSafeNumber(serieID) || !isSafeNumber(index) || !isSafeNumber(volume)) {
      return res.status(400).json({ error: 'serieID, index e volume precisam ser numéricos.' });
    }
    if (!Array.isArray(pages)) {
      return res.status(400).json({ error: 'pages precisa ser uma lista.' });
    }
    for (const page of pages) {
      if (!page || typeof page !== 'object' || Array.isArray(page)) {
        return res.status(400).json({ error: 'Cada item de pages precisa ser um objeto.' });
      }
      if (page.imageData) {
        const m = typeof page.imageData === 'string' && page.imageData.match(/^data:image\/(\w+);base64,/);
        if (!m || !imageExtensions.includes(`.${m[1].toLowerCase()}`)) {
          return res.status(400).json({ error: 'Formato de imagem não permitido.' });
        }
      } else if (!isSafeSegment(page.imageURL)) {
        return res.status(400).json({ error: 'imageURL inválido.' });
      }
    }

    const chapterDir = path.join(__dirname, `public/series/${serieID}/chapters/vol-${volume}-cap-${index}`);
    if (!insidePublic(chapterDir)) {
      return res.status(400).json({ error: 'Caminho inválido.' });
    }

    // Verifica se o diretório existe, caso contrário, cria-o
    if (!fs.existsSync(chapterDir)) {
      fs.mkdirSync(chapterDir, { recursive: true });
      console.log('ue');
    }

    // Lê todos os arquivos da pasta do capítulo
    const existingFiles = fs.readdirSync(chapterDir);

    // Verifica as páginas que precisam ser removidas
    const filesToDelete = existingFiles.filter(file => {
      return !pages.some(page => page.imageURL === file);
    });

    console.log(filesToDelete);

    // Remove as páginas que não estão na lista fornecida
    filesToDelete.forEach(file => {
      const filePath = path.join(chapterDir, file);
      if (fs.lstatSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
      }
    });

    // Processa as novas páginas
    const updatedPages = await Promise.all(pages.map(async (page) => {
      if (page.imageData) {
        const base64Data = page.imageData.replace(/^data:image\/\w+;base64,/, '');
        const extension = page.imageData.match(/^data:image\/(\w+);base64,/)[1].toLowerCase();
        const fileName = `${uuidv4()}.${extension}`;
        const filePath = path.join(chapterDir, fileName);

        // Salva a nova imagem no servidor
        await fs.promises.writeFile(filePath, base64Data, { encoding: 'base64' });

        // Obtém as informações de dimensões e tamanho do arquivo
        let dimensions;
        try {
          dimensions = sizeOf(filePath);
        } catch {
          dimensions = null;
        }
        if (!dimensions || !dimensions.width || !dimensions.height) {
          fs.unlink(filePath, () => {});
          const invalidErr = new Error('Imagem inválida ou corrompida.');
          invalidErr.status = 400;
          throw invalidErr;
        }
        const fileStats = fs.statSync(filePath);

        return {
          id: page.id,
          imageURL: fileName,
          order: page.order,
          width: dimensions.width,
          height: dimensions.height,
          fileSize: fileStats.size,
        };
      } else {
        // Para imagens existentes, obtém as dimensões e tamanho
        const filePath = path.join(chapterDir, page.imageURL);
        let dimensions = {};
        let fileSize = 0;

        if (insidePublic(filePath) && fs.existsSync(filePath)) {
          try {
            dimensions = sizeOf(filePath);
          } catch (err) {
            console.error(`Erro ao obter dimensões da imagem: ${filePath}`, err);
          }
          fileSize = fs.statSync(filePath).size;
        }

        return {
          id: page.id,
          imageURL: page.imageURL,
          order: page.order,
          width: dimensions.width || null,
          height: dimensions.height || null,
          fileSize: fileSize || 0,
        };
      }
    }));

    // Atualiza a ordem das páginas e retorna todas as páginas (existentes e novas)
    const sortedPages = updatedPages.sort((a, b) => a.order - b.order);

    res.json({
      status: 200,
      pages: sortedPages,
    });
  } catch (err) {
    if (err && err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

const handleRemove = (req, res) => {
  const { name, type, id } = req.body || {};

  if (!type) {
    return res.status(400).json({ error: 'O campo "tipo" é obrigatório.' });
  }

  if (!name) {
    return res.status(400).json({ error: 'O campo "name" é obrigatório.' });
  }

  if (!isSafeSegment(name)) {
    return res.status(400).json({ error: 'O campo "name" é inválido.' });
  }

  const baseName = stripAllowedExtension(name);
  if (!isSafeSegment(baseName)) {
    return res.status(400).json({ error: 'O campo "name" é inválido.' });
  }

  if (!podeEscrever(req.auth, type, id, baseName)) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  let finalDir;
  try {
    finalDir = path.join(__dirname, obterDiretorioDestino(type, id));
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  let fileFound = false;

  for (const ext of possibleExtensions) {
    const filePath = path.join(finalDir, `${baseName}${ext}`);
    if (!insidePublic(filePath)) continue;
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      fileFound = true;
    }
  }

  if (!fileFound) {
    return res.status(404).json({ error: 'Arquivo não encontrado.' });
  }

  res.json({ message: 'Arquivo removido com sucesso.' });
};

app.delete('/remove', requireAuth, handleRemove);
app.post('/remove', requireAuth, handleRemove);

const USERNAME_FOLDER_RE = /^[A-Za-z0-9]{3,30}$/;

app.post('/rename-user-folder', requireAuth, (req, res) => {
  if (!req.auth || req.auth.service !== true) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  try {
    const { from, to } = req.body || {};

    if (
      typeof from !== 'string' ||
      typeof to !== 'string' ||
      !/^[A-Za-z0-9]{1,40}$/.test(from) || // contas antigas têm nomes com menos de 3 letras
      !USERNAME_FOLDER_RE.test(to)
    ) {
      return res.status(400).json({ error: 'Nomes de usuário inválidos.' });
    }

    const fromDir = path.join(PUBLIC_DIR, 'user', from);
    const toDir = path.join(PUBLIC_DIR, 'user', to);

    if (!insidePublic(fromDir) || !insidePublic(toDir)) {
      return res.status(400).json({ error: 'Caminho inválido.' });
    }

    if (from === to) {
      return res.status(200).json({ moved: false });
    }

    if (!fs.existsSync(fromDir)) {
      return res.status(200).json({ moved: false });
    }

    if (fs.existsSync(toDir)) {
      // Em sistemas case-insensitive, fromDir e toDir podem apontar para o mesmo inode ao trocar só a caixa
      const sameInode =
        from.toLowerCase() === to.toLowerCase() &&
        fs.statSync(fromDir).ino === fs.statSync(toDir).ino;
      if (!sameInode) {
        return res.status(409).json({ error: 'Pasta de destino já existe.' });
      }
    }

    fs.renameSync(fromDir, toDir);
    return res.status(200).json({ moved: true });
  } catch (err) {
    console.error('Erro ao renomear pasta do usuário:', err);
    return res.status(500).json({ error: 'Erro ao renomear pasta do usuário.' });
  }
});

// Parâmetros de URL (:id, :name, :cap) nunca podem sair da pasta
['id', 'name', 'cap'].forEach((param) => {
  app.param(param, (req, res, next, value) => {
    if (!isSafeSegment(value)) return res.status(400).json({ error: 'Parâmetro inválido.' });
    next();
  });
});

const listarArquivos = (directory) => {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs.readdirSync(directory).map(file => {
    const filePath = path.join(directory, file);
    const stats = fs.statSync(filePath);
    const fileExtension = path.extname(file);
    const fileName = path.basename(file, fileExtension);
    let dimensions = {};

    // Verificar se o arquivo é uma imagem para obter suas dimensões
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(fileExtension.toLowerCase())) {
      try {
        dimensions = sizeOf(filePath);
      } catch (err) {
        console.error(`Erro ao obter dimensões da imagem: ${filePath}`, err);
      }
    }

    return {
      name: fileName,       // Nome do arquivo sem a extensão
      archive: file,        // Nome completo do arquivo com a extensão
      size: stats.size,     // Tamanho do arquivo
      width: dimensions.width, // Largura da imagem
      height: dimensions.height, // Altura da imagem
      created: stats.birthtime, // Data de criação
      modified: stats.mtime // Data de modificação
    };
  });
};


app.get('/user/:id/files', requireAdmin, (req, res) => {
  const directoryPath = path.join(__dirname, `public/user/${req.params.id}`);
  const files = listarArquivos(directoryPath);
  res.json(files);
});

app.get('/assets/files', requireAdmin, (req, res) => {
  const directoryPath = path.join(__dirname, 'public/assets');
  const files = listarArquivos(directoryPath);
  res.json(files);
});

app.get('/series/:id/files', requireStaff, (req, res) => {
  const directoryPath = path.join(__dirname, `public/series/${req.params.id}`);
  const files = listarArquivos(directoryPath);
  res.json(files);
});

app.get('/series/:id/assets/files', requireStaff, (req, res) => {
  const directoryPath = path.join(__dirname, `public/series/${req.params.id}/assets`);
  const files = listarArquivos(directoryPath);
  res.json(files);
});

app.get('/stickers/files', requireAdmin, (req, res) => {
  const directoryPath = path.join(__dirname, 'public/stickers');
  const files = listarArquivos(directoryPath);
  res.json(files);
});

app.get('/stickers/:id/files', requireAdmin, (req, res) => {
  const directoryPath = path.join(__dirname, `public/stickers/${req.params.id}`);
  const files = listarArquivos(directoryPath);
  res.json(files);
});

const servirArquivos = (directory, req, res, next) => {
  const name = stripAllowedExtension(req.params.name);

  for (const ext of possibleExtensions) {
    const filePath = path.join(directory, `${name}${ext}`);
    if (!insidePublic(filePath)) continue;
    if (fs.existsSync(filePath)) {
      aplicarHeadersArquivo(res, filePath);
      return res.sendFile(filePath);
    }
  }
  
  // Se não encontrou, passa para o próximo middleware (estático)
  next();
};

/*app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});*/

app.get('/image/:name', (req, res, next) => {
  const directoryPath = path.join(__dirname, 'public/image');
  servirArquivos(directoryPath, req, res, next);
});

app.get('/user/:id/:name', (req, res, next) => {
  const directoryPath = path.join(__dirname, `public/user/${req.params.id}`);
  servirArquivos(directoryPath, req, res, next);
});

app.get('/assets/:name', (req, res, next) => {
  const directoryPath = path.join(__dirname, 'public/assets');
  servirArquivos(directoryPath, req, res, next);
});

app.get('/series/:id/:name', (req, res, next) => {
  const directoryPath = path.join(__dirname, `public/series/${req.params.id}`);
  servirArquivos(directoryPath, req, res, next);
});

app.get('/series/:id/assets/:name', (req, res, next) => {
  const directoryPath = path.join(__dirname, `public/series/${req.params.id}/assets`);
  servirArquivos(directoryPath, req, res, next);
});

app.get('/series/:id/chapters/:cap/:name', (req, res, next) => {
  const directoryPath = path.join(__dirname, `public/series/${req.params.id}/chapters/${req.params.cap}`);
  servirArquivos(directoryPath, req, res, next);
});

app.get('/stickers/:id/:name', (req, res, next) => {
  const directoryPath = path.join(__dirname, `public/stickers/${req.params.id}`);
  servirArquivos(directoryPath, req, res, next);
});

app.get('/stickers/:name', (req, res, next) => {
  const directoryPath = path.join(__dirname, 'public/stickers');
  servirArquivos(directoryPath, req, res, next);
});

// Bloqueia acesso público aos arquivos temporários do multer em public/temp
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    let decodedPath = req.path;
    try {
      decodedPath = decodeURIComponent(req.path);
    } catch {}
    const normalized = path.posix.normalize(decodedPath);
    if (normalized === '/temp' || normalized.startsWith('/temp/')) {
      return res.status(404).json({ error: 'Não encontrado.' });
    }
  }
  next();
});

// Middleware estático movido para depois das rotas dinâmicas
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    aplicarHeadersArquivo(res, filePath);
  }
}));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'Upload inválido: ' + err.code });
  }
  if (/não permitido|permitidos/.test(err.message || '')) {
    return res.status(400).json({ error: err.message });
  }
  console.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

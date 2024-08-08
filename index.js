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

const app = express();

const possibleExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.txt', '.pdf', '.zip'];

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
    const nome = req.body.name || file.originalname;
    cb(null, nome);
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const fileExt = path.extname(file.originalname).toLowerCase();
    if (!possibleExtensions.includes(fileExt)) {
      return cb(new Error('Tipo de arquivo não permitido'), false);
    }
    cb(null, true);
  }
});

app.use(helmet());
app.use(compression());
app.use(express.static(path.join(__dirname, 'public')));
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


app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https://cdn.mahoureader.com data:;");
  next();
});

const moveFile = (tempFilePath, finalDir, name, res) => {
  const newFileExtension = path.extname(tempFilePath);
  const finalFilePath = path.join(finalDir, `${name}${newFileExtension}`);

  for (const ext of possibleExtensions) {
    const oldFilePath = path.join(finalDir, `${name}${ext}`);
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
      return res.status(500).json({ error: 'Erro ao mover o arquivo.' + err });
    }
    res.json({
      message: 'Upload realizado com sucesso!',
      file: finalFilePath
    });
  });
};

const obterDiretorioDestino = (tipo, id) => {
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
    default:
      throw new Error('Tipo de upload inválido.');
  }
};

app.post('/upload',
  upload.single('imagem'),
  body('name').notEmpty().withMessage('O campo "name" é obrigatório.'),
  body('type').notEmpty().withMessage('O campo "type" é obrigatório.'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, type, id } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'O campo "imagem" é obrigatório.' });
    }

    let finalDir;
    try {
      finalDir = path.join(__dirname, obterDiretorioDestino(type, id));
      console.log(finalDir)
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const tempFilePath = path.join(__dirname, 'public/temp', req.file.originalname);

    moveFile(tempFilePath, finalDir, name, res);
  }
);

const zipStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const pastaBase = 'public/temp';
    criarDiretoriosRecursivamente(pastaBase);
    cb(null, pastaBase);
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname); // Mantém o nome original do arquivo ZIP
  }
});

const uploadZip = multer({
  storage: zipStorage,
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.zip') {
      return cb(new Error('Apenas arquivos ZIP são permitidos'), false);
    }
    cb(null, true);
  }
});

app.post('/upload-zip', uploadZip.single('zipFile'), async (req, res) => {
  const { serieID, index, volume } = req.body;

  if (!serieID || !index) {
    return res.status(400).json({ error: 'ID da obra e capítulo são obrigatórios.' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  const zipFilePath = path.join(__dirname, 'public/temp', req.file.originalname);
  const extractionPath = path.join(__dirname, `public/series/${serieID}/chapters/vol-${volume}-cap-${index}`);

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

  fs.createReadStream(zipFilePath)
    .pipe(unzipper.Parse())
    .on('entry', function (entry) {
      const fileName = entry.path;
      const fileExt = path.extname(fileName).toLowerCase();
      const newFileName = `${uuidv4()}${fileExt}`;
      const newFilePath = path.join(extractionPath, newFileName);

      entry.pipe(fs.createWriteStream(newFilePath)).on('finish', () => {
        const fileStats = fs.statSync(newFilePath);
        let dimensions = {};
        
        // Verificar se o arquivo é uma imagem para obter suas dimensões
        if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(fileExt)) {
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
      });
    })
    .on('close', function () {
      // Após a extração, pode remover o arquivo ZIP temporário
      fs.unlinkSync(zipFilePath);

      res.json({
        message: 'Arquivos extraídos e renomeados com sucesso!',
        images: extractedImages
      });
    })
    .on('error', function (err) {
      console.error('Erro ao extrair o arquivo:', err);
      res.status(500).json({ error: 'Erro ao extrair o arquivo.' });
    });
});

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString()
  },
  limit: "100mb"
}));

app.post('/analyze-pages', async (req, res) => {
  const { pages, index, serieID, volume } = req.body;
  const chapterDir = path.join(__dirname, `public/series/${serieID}/chapters/vol-${volume}-cap-${index}`);


  // Verifica se o diretório existe, caso contrário, cria-o
  if (!fs.existsSync(chapterDir)) {
    fs.mkdirSync(chapterDir, { recursive: true });
    console.log('ue')
  }

  // Lê todos os arquivos da pasta do capítulo
  const existingFiles = fs.readdirSync(chapterDir);

  // Verifica as páginas que precisam ser removidas
  const filesToDelete = existingFiles.filter(file => {
    return !pages.some(page => page.imageURL === file);
  });

  console.log(filesToDelete)

  // Remove as páginas que não estão na lista fornecida
  filesToDelete.forEach(file => {
    const filePath = path.join(chapterDir, file);
    fs.unlinkSync(filePath);
  });

  // Processa as novas páginas
  const updatedPages = await Promise.all(pages.map(async (page) => {
    if (page.imageData) {
      const base64Data = page.imageData.replace(/^data:image\/\w+;base64,/, '');
      const extension = page.imageData.match(/data:image\/(\w+);base64,/)[1];
      const fileName = `${uuidv4()}.${extension}`;
      const filePath = path.join(chapterDir, fileName);
      
      // Salva a nova imagem no servidor
      await fs.writeFileSync(filePath, base64Data, { encoding: 'base64' });
  
      // Obtém as informações de dimensões e tamanho do arquivo
      const dimensions = sizeOf(filePath);
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
  
      if (fs.existsSync(filePath)) {
        dimensions = sizeOf(filePath);
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
});

// Rota para remover arquivos
app.delete('/remove', (req, res) => {
  const { name, type, id } = req.body;

  // Verificação do campo "tipo"
  if (!type) {
    return res.status(400).json({ error: 'O campo "tipo" é obrigatório.' });
  }

  // Verificação do campo "name"
  if (!name) {
    return res.status(400).json({ error: 'O campo "name" é obrigatório.' });
  }

  let finalDir;
  try {
    finalDir = path.join(__dirname, obterDiretorioDestino(type, id));
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  let fileFound = false;

  for (const ext of possibleExtensions) {
    const filePath = path.join(finalDir, `${name}${ext}`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath); // Remove o arquivo
      fileFound = true;
    }
  }

  if (!fileFound) {
    return res.status(404).json({ error: 'Arquivo não encontrado.' });
  }

  res.json({ message: 'Arquivo removido com sucesso.' });
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


app.get('/user/:id/files', (req, res) => {
  const directoryPath = path.join(__dirname, `public/user/${req.params.id}`);
  const files = listarArquivos(directoryPath);
  res.json(files);
});

app.get('/assets/files', (req, res) => {
  const directoryPath = path.join(__dirname, 'public/assets');
  const files = listarArquivos(directoryPath);
  res.json(files);
});

app.get('/series/:id/files', (req, res) => {
  const directoryPath = path.join(__dirname, `public/series/${req.params.id}`);
  const files = listarArquivos(directoryPath);
  res.json(files);
});

app.get('/series/:id/assets/files', (req, res) => {
  const directoryPath = path.join(__dirname, `public/series/${req.params.id}/assets`);
  const files = listarArquivos(directoryPath);
  res.json(files);
});

const servirArquivos = (directory, req, res) => {
  const name = req.params.name;
  for (const ext of possibleExtensions) {
    const filePath = path.join(directory, `${name}${ext}`);
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }
  }
  res.status(404).send('Arquivo não encontrado');
};

/*app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});*/

app.get('/image/:name', (req, res) => {
  const directoryPath = path.join(__dirname, 'public/image');
  servirArquivos(directoryPath, req, res);
});

app.get('/user/:id/:name', (req, res) => {
  const directoryPath = path.join(__dirname, `public/user/${req.params.id}`);
  servirArquivos(directoryPath, req, res);
});

app.get('/assets/:name', (req, res) => {
  const directoryPath = path.join(__dirname, 'public/assets');
  servirArquivos(directoryPath, req, res);
});

app.get('/series/:id/:name', (req, res) => {
  const directoryPath = path.join(__dirname, `public/series/${req.params.id}`);
  servirArquivos(directoryPath, req, res);
});

app.get('/series/:id/assets/:name', (req, res) => {
  const directoryPath = path.join(__dirname, `public/series/${req.params.id}/assets`);
  servirArquivos(directoryPath, req, res);
});

app.get('/series/:id/chapters/:cap/:name', (req, res) => {
  const directoryPath = path.join(__dirname, `public/series/${req.params.id}/chapters/${req.params.cap}`);
  servirArquivos(directoryPath, req, res);
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
